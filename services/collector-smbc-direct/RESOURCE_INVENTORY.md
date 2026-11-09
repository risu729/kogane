# SMBC Direct backfill PoC resource inventory

Validation resources and cleanup boundaries as of 2026-09-01. Actual credentials, cookies, Safety Pass URLs, financial-detail bodies and balances are not recorded.

<a id="このpoc専用で終了時に削除するもの"></a>

## Dedicated resources to remove at completion

| Resource                     | Name / location                                                     | State                                          |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| Worker                       | `kogane-smbc-direct-backfill-poc`                                   | deployed                                       |
| Worker URL                   | `https://kogane-smbc-direct-backfill-poc.takuanimal.workers.dev`    | Access protected                               |
| Durable Object class/storage | `SmbcBackfillSession`                                               | active; encrypted challenge/session only       |
| R2 bucket                    | `kogane-smbc-direct-backfill-poc`                                   | active; successful 93-month run retained       |
| Worker secrets               | `SMBC_CREDENTIAL_JSON`, `SESSION_ENCRYPTION_KEY`                    | active; values not retrievable from Cloudflare |
| Access application           | `Kogane SMBC Direct backfill`                                       | active; existing `default` policy attached     |
| Local selector metadata      | `/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id`      | item ID only                                   |
| Local encryption key         | `/home/risu/.local/state/kogane/smbc-direct-session-encryption-key` | secret; never commit                           |

Delete R2 as a whole bucket only after establishing that the entire bucket is dedicated to this PoC. Check necessary manifests before deleting the Worker, and handle the Access application, Worker, Durable Object storage, R2, secrets and 2 local files within the same cleanup.

<a id="共有資源で削除しないもの"></a>

## Shared resources that stay

| Resource                               | Identifier                             | Reason                                              |
| -------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| TAMIA Cloudflare Tunnel / VPC network  | `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33` | Shared by other collectors and the personal network |
| Access policy                          | `default`                              | Shared by other Access applications                 |
| Device posture check                   | `Gateway`                              | Shared by other Access applications                 |
| Personal Cloudflare WARP configuration | account-wide                           | Used by personal devices and other routes           |

<a id="作成していないもの"></a>

## Resources not created

- D1 database
- Queue
- Workers Cron / GitHub Actions cron
- Cloudflare Container / Container image / registry artifact
- New Cloudflare Tunnel, hostname route or device posture check

The Worker's VPC binding is only a reference in the configuration of the Worker being deleted; removing that binding does not require deleting the shared TAMIA Tunnel.
