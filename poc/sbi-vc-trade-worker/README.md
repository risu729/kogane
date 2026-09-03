# SBI VC Trade collector Worker PoC

Cloudflare Workerだけで既存Bitwarden passkeyからVCTRADEへloginし、sessionをrolling更新してread-only dataをR2へ保存する一時PoC。外部Bun process、Container、Chromeは使わない。

## Secretと永続化

- `SESSION_SEED`: 8個の観測済みsession Cookieと`secureKey`のJSON。`wrangler secret put`だけで投入する。
- `SESSION_ENCRYPTION_KEY`: 32 byteのrandom keyをbase64化した値。Durable Objectに保存する可変sessionをAES-256-GCMで暗号化する。
- `ADMIN_TOKEN`: `/run`と`/health`を保護するrandom bearer token。
- `PASSKEY_CREDENTIAL`: Bitwarden CLIからtmpfsを介して抽出した既存FIDO2 credentialの必要fieldだけ。Gitへ保存しない。
- Durable Objectには暗号化sessionと、status・Cookie更新数・最終成功時刻だけを保存する。
- `__cf_bm`は保存しない。金融responseはprivate R2 bucketへ保存するが、`meta.secureKey`は保存前に除去する。

Bitwarden内の既存passkeyをWorkers Web Cryptoで使い、`initiateLoginWithPasskey`と`loginWithPasskey`から新しい8 Cookieと`secureKey`を再構成する。通常は15分keepaliveだけを実行し、HTTP 401/403、gateway拒否、seed欠落時だけ6時間cooldown付きで再認証する。`/reauth`はadmin bearerを持つ手動検証用で、規約同意が必要な場合は`setAgreement`を送らず停止する。

## 収集

- `*/15 * * * *`: `informationTitle`だけを送りsessionを維持する。
- `5 21 * * *`: 毎日06:05 JSTに固定read allowlistを取得する。
- 手動検証: admin bearer付き`POST /collect`。
- 保存先: `raw/sbi-vc-trade/YYYY/MM/DD/<run-id>/`。
- 保存対象: 残高、口座詳細、position summary、約定recent page 0、約定historical全page、JPY入出金historical全page、manifest。
- page sizeは公式Web clientと同じ30、上限100 page。write eventを指定できるgeneric senderは公開しない。
- 各response直後にrotation後sessionを暗号化保存し、各artifactは即時R2へ書く。全responseをmemoryへ蓄積しない。
- artifactと最後のmanifestは`etagDoesNotMatch: "*"`で同一keyへの上書きを拒否し、R2 native SHA-256も指定する。UUID run IDのprefixをcommit marker後に変更しない。
- `manifest.json`保存後、data artifactが11件以下なら内部Service Bindingで中央raw-evidence importerへ即時転送する。12件以上は32 Worker invocation上限を避けてdeferし、private R2を後続Queue reconcilerのdurable outboxとして残す。
- 過去runはadmin bearer付き`POST /backfill-raw-evidence?limit=1`をcursorで繰り返す。1 requestで走査するR2 objectと転送するmanifestは最大1件。

## 検証

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run cf:check
```

中央schema `0006`、`kogane-ingest`、`kogane-collector-r2-importer`の順に反映し、importerのsource専用credentialを同期してからこのWorkerをdeployする。過去outboxは次で再送する。

```sh
scripts/backfill-raw-evidence.sh
```

backfillと即時転送は元R2 objectを削除しない。

## 一時Cloudflare resourceとcleanup

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- R2 bucket: `kogane-sbi-vc-trade-poc`
- Cron: `*/15 * * * *`, `5 21 * * *`
- Worker Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `PASSKEY_CREDENTIAL`

検証終了後は次でまとめて削除する。

```sh
npx wrangler delete --name kogane-sbi-vc-session-poc
```

上記はR2 dataを削除しない。R2 objectsと`kogane-sbi-vc-trade-poc` bucketは、保存dataが不要になったことを確認した後だけ別途削除する。
