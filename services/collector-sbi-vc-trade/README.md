# SBI VC Trade collector Worker PoC

Cloudflare Workerだけで既存Bitwarden passkeyからVCTRADEへloginし、sessionをrolling更新してread-only dataをR2へ保存する一時PoC。外部Bun process、Container、Chromeは使わない。

## Secretと永続化

- `SESSION_SEED`: 8個の観測済みsession Cookieと`secureKey`のJSON。`wrangler secret put`だけで投入する。
- `SESSION_ENCRYPTION_KEY`: 32 byteのrandom keyをbase64化した値。Durable Objectに保存する可変sessionをAES-256-GCMで暗号化する。
- `ADMIN_TOKEN`: `/run`と`/health`を保護するrandom bearer token。
- `PASSKEY_CREDENTIAL`: Bitwarden CLIからtmpfsを介して抽出した既存FIDO2 credentialの必要fieldだけ。Gitへ保存しない。
- Durable Objectには暗号化sessionと、status・Cookie更新数・最終成功時刻だけを保存する。
- `__cf_bm`は保存しない。金融responseは共有DATA bucket（`kogane-raw-evidence`）へ保存するが、`meta.secureKey`は保存前に除去する。

Bitwarden内の既存passkeyをWorkers Web Cryptoで使い、`initiateLoginWithPasskey`と`loginWithPasskey`から新しい8 Cookieと`secureKey`を再構成する。通常は15分keepaliveだけを実行し、HTTP 401/403、gateway拒否、seed欠落時だけ6時間cooldown付きで再認証する。`/reauth`はadmin bearerを持つ手動検証用で、規約同意が必要な場合は`setAgreement`を送らず停止する。

## 収集

- `*/15 * * * *`: `informationTitle`だけを送りsessionを維持する。
- `5 21 * * *`: 毎日06:05 JSTに固定read allowlistを取得する。
- 手動検証: admin bearer付き`POST /collect`。
- 保存先: 共有DATA bucketのcontent-addressed object（`objects/<2 hex>/<sha256>`）と、最後に書くterminal manifest（`runs/sbi-vc-trade/<run-id>/terminal.json`）。
- 保存対象: 残高、口座詳細、position summary、約定recent page 0、約定historical全page、JPY入出金historical全page、manifest。
- page sizeは公式Web clientと同じ30、上限100 page。write eventを指定できるgeneric senderは公開しない。
- 各response直後にrotation後sessionを暗号化保存する。`meta.secureKey`除去済みのartifactはterminalを書くまでmemoryに保持し、staging用のR2 objectは書かない。
- objectと最後のterminalは`packages/collection`が`etagDoesNotMatch: "*"`とR2 native SHA-256付きで書く。terminalはすべてのobjectの後に書くため、terminalのないrunは保存完了として扱わない。
- 中央importer、そのService Binding、`POST /backfill-raw-evidence`は2026-09-13に廃止した（[legacy-retirement.md](../../docs/legacy-retirement.md)）。data artifactが12件以上のrunもdeferせず、その場でterminalまで書く。ProcessorがDATAのterminalをin-processで登録する（[processor.md](../../docs/processor.md)）。

## 検証

```sh
bun install --frozen-lockfile
mise run //services/collector-sbi-vc-trade:test
mise run //services/collector-sbi-vc-trade:typecheck
mise run //services/collector-sbi-vc-trade:dry-run
```

deployはProcessorを先、collectorを後にする（[rollout.md](../../docs/rollout.md#4-deployment-order)）。旧private R2 bucketのobjectは中央DATAへコピー・検証した後に削除済みであり、再送するoutboxはない（[legacy-retirement.md](../../docs/legacy-retirement.md)）。

## 一時Cloudflare resourceとcleanup

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- R2 binding: `DATA` → `kogane-raw-evidence`（全collector共有。このWorker専用のbucketはない）
- Cron: `*/15 * * * *`, `5 21 * * *`
- Worker Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `PASSKEY_CREDENTIAL`

検証終了後は次でまとめて削除する。

```sh
npx wrangler delete --name kogane-sbi-vc-session-poc
```

上記は共有DATA bucketのdataを削除しない。旧source専用bucket `kogane-sbi-vc-trade-poc`は2026-09-13に削除済み（[legacy-retirement.md](../../docs/legacy-retirement.md)）。
