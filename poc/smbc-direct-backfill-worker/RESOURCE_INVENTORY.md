# SMBC Direct backfill PoC resource inventory

2026-09-01時点の検証資源とcleanup境界です。実credential、Cookie、Safety Pass URL、金融明細本文、残高は記録しません。

## このPoC専用で、終了時に削除するもの

| Resource | Name / location | State |
| --- | --- | --- |
| Worker | `kogane-smbc-direct-backfill-poc` | deployed |
| Worker URL | `https://kogane-smbc-direct-backfill-poc.takuanimal.workers.dev` | Access protected |
| Durable Object class/storage | `SmbcBackfillSession` | active; encrypted challenge/session only |
| R2 bucket | `kogane-smbc-direct-backfill-poc` | active; successful 93-month run retained |
| Worker secrets | `SMBC_CREDENTIAL_JSON`, `SESSION_ENCRYPTION_KEY` | active; values not retrievable from Cloudflare |
| Access application | `Kogane SMBC Direct backfill` | active; existing `default` policy attached |
| Local selector metadata | `/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id` | item ID only |
| Local encryption key | `/home/risu/.local/state/kogane/smbc-direct-session-encryption-key` | secret; never commit |

R2は、bucket全体がこのPoC専用であることを確認してからbucketごと削除する。Worker削除前に必要なmanifestを確認し、Access application、Worker、Durable Object storage、R2、secrets、ローカル2ファイルを同じcleanup作業で扱う。

## 共有資源で、削除しないもの

| Resource | Identifier | Reason |
| --- | --- | --- |
| TAMIA Cloudflare Tunnel / VPC network | `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33` | 他collectorと個人networkで共有 |
| Access policy | `default` | 他Access applicationと共有 |
| Device posture check | `Gateway` | 他Access applicationと共有 |
| Personal Cloudflare WARP configuration | account-wide | 個人端末と他routeで利用 |

## 作成していないもの

- D1 database
- Queue
- Workers Cron / GitHub Actions cron
- Cloudflare Container / Container image / registry artifact
- 新しいCloudflare Tunnel、hostname route、device posture check

WorkerのVPC bindingは削除対象Workerの設定に含まれる参照だけであり、binding削除のために共有TAMIA Tunnelを削除しない。
