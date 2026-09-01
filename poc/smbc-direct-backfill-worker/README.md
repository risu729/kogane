# SMBC Direct backfill Worker PoC

SMBC DirectのQR認証を人が承認し、その認証済みsessionで円普通預金明細を2019年から月単位でbackfillするCloudflare Worker PoCです。画面とAPIはCloudflare Zero Trust Accessで保護し、公式raw responseと正規化結果をprivate R2へ保存します。

## 操作

1. Worker URLを開き、Cloudflare Accessで本人認証する。
2. 「QRを生成」を押す。期間指定は受け付けず、Web通帳で取得可能な最古の2019-01-01から実行当日までを常に対象にする。
3. SMBCアプリでQRを読み、Safety Passを承認する。
4. 「承認済み・backfill開始」を押す。
5. 画面は3秒ごとに進捗を更新する。実処理はDurable Object alarmで継続するため、画面を閉じてもよい。

QRを早く確定すると `approval_not_completed_generate_new_qr` になる。その場合は新しいQRを生成し、アプリ側の承認完了後にbackfill開始を押す。
SMBC sessionが全期間の途中で切れた場合も、再度QRを生成・承認すると同じRunの未取得月から再開し、取得済みR2 objectを作り直さない。

## 保存内容

- 現在の円普通預金残高: official raw Shift_JIS JSONとnormalized JSON
- 各月の入出金明細: official raw Shift_JIS JSONとnormalized JSON
- normalized明細: 銀行側明細ID、日付、入出金額、摘要、取引後残高、方向
- 各runのmanifest: 期間、chunk進捗、件数、artifact size、SHA-256、failure code、logout結果

R2 keyは `raw/smbc-direct/YYYY/MM/DD/<run-id>/...`。口座番号や利用者名をkeyとmanifestへ入れない。

## セッション設計

- QR challengeと認証済みcookie/top pageはAES-256-GCMで暗号化してDurable Object storageへ保存する。
- SMBC passwordはDurable Objectへ保存せず、Worker secretから各処理時に読む。
- 1 Access identityにつき1 Durable Objectを使う。identityはSHA-256化して名前にする。
- 月単位chunkを1 alarmあたり3件処理し、chunkごとにsessionとmanifestを永続化する。
- 完了時は公式logoutを行い、暗号化sessionを削除する。
- raw明細をUI/APIへ返さない。画面に出すのはrun ID、期間進捗、件数、error code、manifest keyだけである。

## Secret同期

Bitwarden item IDだけをローカルmetadataへ保存する。passwordやitem JSONの中間fileは作らない。

```bash
cd poc/smbc-direct-backfill-worker
export BW_SESSION="$(bw unlock --raw)"
printf '%s\n' '<item-id>' > /home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id
./scripts/sync-local-secrets.sh
```

`SESSION_ENCRYPTION_KEY` は初回同期時に32 byteで生成し、ローカルの `smbc-direct-session-encryption-key` とWorker secretへ保存する。

## Cloudflare resources

- Worker: `kogane-smbc-direct-backfill-poc`
- Durable Object: `SmbcBackfillSession`
- private R2: `kogane-smbc-direct-backfill-poc`
- Worker secrets: `SMBC_CREDENTIAL_JSON`, `SESSION_ENCRYPTION_KEY`
- Worker-level Cloudflare Access: productionとpreviewを保護（preview自体は無効）

Access未認証requestはWorker側でも403にする。POSTは同一originとcustom action headerを要求する。

## 実証状態

- ローカルSMBC Direct: Safety Pass承認後、円残高と2026年8月明細14件、入出金合計、logoutまで成功済み。
- Worker QR challenge: 通常のWorkers egressではSMBCの`ERRINFO`、既存TAMIA VPC binding経由では生成成功を確認済み。
- WorkerからSMBC Directへのログイン・backfill: TAMIA経由でSafety Pass QR承認、2019-01-01から2026-09-01まで93か月、1,069明細、188 artifact、failure 0、logout成功をprivate R2のmanifestでも確認済み。
- 1回目の認証sessionは48/93か月で`TPALTOP`を失い、3回再試行後にpartialとなった。新しいQRを承認すると同じRun IDと98個の既存artifactを保ったまま49か月目から再開し、最終的にsuccessとなることを確認した。
- Zero Trust Access: WARP/Gatewayと許可メールドメインを要求する既存`default` policyで設定済み。

通常のWorkers egressとTAMIAの差は同一code・同一credentialsでA/Bした。前者はHTTP 200のSMBC `ERRINFO` form、後者は`BCATBCA` Safety Pass formを返したため、このPoCでは2つのSMBC hostだけを`TAMIA.fetch()`へ渡す。設定値はexact origin allowlistで固定し、client指定の任意destinationは受け付けない。

## 埋められるMoney Forward gap

- 各明細の取引後残高
- SMBC内部JSONの `meisaiId`
- 銀行が返す元の摘要とraw response
- MF無料版の表示期間・連携数・更新頻度に依存しないbackfill
- chunk別の取得成否と取得時刻

カード利用状態、請求月・支払日、分割/リボ、加盟店詳細、返金link、VポイントはSMBC Directでは埋められない。

## Cleanup

検証終了時にまとめて削除する対象:

- Worker `kogane-smbc-direct-backfill-poc`
- R2 bucket `kogane-smbc-direct-backfill-poc` と全object
- Durable Object instances/storage
- Worker secretsとAccess application
- `/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id`
- `/home/risu/.local/state/kogane/smbc-direct-session-encryption-key`

共有TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`、個人WARP設定、既存`default` Access policyは他用途と共有するため削除対象外。D1、Queue、Cron trigger、Container、Container imageはこのPoCでは作成していない。詳細は[`RESOURCE_INVENTORY.md`](RESOURCE_INVENTORY.md)を参照する。
