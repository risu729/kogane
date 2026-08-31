# SBI VC Trade session keepalive Worker PoC

認証済みVCTRADE sessionがCloudflare Workersのegressから再利用・rolling更新できるかを検証する一時PoC。15分Cronで固定read-only event `informationTitle`を1回だけ送る。残高・約定・cashflow等のresponse bodyは保存しない。

## Secretと永続化

- `SESSION_SEED`: 8個の観測済みsession Cookieと`secureKey`のJSON。`wrangler secret put`だけで投入する。
- `SESSION_ENCRYPTION_KEY`: 32 byteのrandom keyをbase64化した値。Durable Objectに保存する可変sessionをAES-256-GCMで暗号化する。
- `ADMIN_TOKEN`: `/run`と`/health`を保護するrandom bearer token。
- `PASSKEY_CREDENTIAL`: Bitwarden CLIからtmpfsを介して抽出した既存FIDO2 credentialの必要fieldだけ。Gitへ保存しない。
- Durable Objectには暗号化sessionと、status・Cookie更新数・最終成功時刻だけを保存する。
- `__cf_bm`、response body、残高、取引履歴、口座情報は保存しない。

Bitwarden内の既存passkeyをWorkers Web Cryptoで使い、`initiateLoginWithPasskey`と`loginWithPasskey`から新しい8 Cookieと`secureKey`を再構成する。通常は15分keepaliveだけを実行し、HTTP 401/403、gateway拒否、seed欠落時だけ6時間cooldown付きで再認証する。`/reauth`はadmin bearerを持つ手動検証用で、規約同意が必要な場合は`setAgreement`を送らず停止する。

## 検証

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

## 一時Cloudflare resourceとcleanup

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- Cron: `*/15 * * * *`
- Worker Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `PASSKEY_CREDENTIAL`

検証終了後は次でまとめて削除する。

```sh
npx wrangler delete --name kogane-sbi-vc-session-poc
```
