# SMBC Direct backfill Worker PoC

A Cloudflare Worker PoC in which a person approves SMBC Direct QR authentication, then the authenticated session backfills yen ordinary-deposit details month by month from 2019. Cloudflare Zero Trust Access protects the screen/API; official raw responses and normalized results are stored in private R2.

<a id="操作"></a>

## Operation

1. Open the Worker URL and authenticate through Cloudflare Access.
2. Press `QRを生成` ("generate QR"). No period selection is accepted: the scope is always the Web bankbook's earliest available date, 2019-01-01, through the execution day.
3. Scan the QR in the SMBC app and approve Safety Pass.
4. Press `承認済み・backfill開始` ("approved; start backfill").
5. The screen refreshes progress every 3 seconds. Work continues through Durable Object alarms, so the screen may be closed.

Confirming the QR too early yields `approval_not_completed_generate_new_qr`. Generate a new QR, finish app-side approval, then start backfill. If the SMBC session expires mid-period, generating/approving a new QR resumes the same Run from its uncaptured month. `QRを生成` returns the same QR while valid, so generate after expiry.

Shared storage retains existing partial terminals. Additional captures go to continuation terminals; final success is another completion terminal containing every captured artifact. Partial accounts are ineligible for central parsing, so earlier partial data is included in the completion record. Artifacts already successful/eligible for parsing are not duplicated.

The screen shows `取得完了` ("capture complete") and `共有保存` ("shared storage") separately. If shared storage failed or is unconfirmed, `保存済み明細の取り込みを再試行` ("retry importing saved details") republishes from staging without logging into the bank or capturing again. After shared storage completes, central registration/parsing completion is checked separately.

<a id="保存内容"></a>

## Stored contents

- Current yen ordinary-deposit balance: official raw Shift_JIS JSON and normalized JSON.
- Monthly deposit/withdrawal details: official raw Shift_JIS JSON and normalized JSON.
- Normalized details: bank detail ID, date, deposit/withdrawal amount, description, post-transaction balance and direction.
- Manifest per run: period, chunk progress, counts, artifact size, SHA-256, failure code and logout result.

Monthly chunks are staged under `raw/smbc-direct/YYYY/MM/DD/<run-id>/...` in shared DATA (`kogane-raw-evidence`). On run completion they are checked against the manifest, written to `objects/<2 hex>/<sha256>`, then followed by terminal `runs/smbc-direct/<run-id>/terminal.json` last. Neither keys nor manifests contain account numbers or user names.

<a id="セッション設計"></a>

## Session design

- The QR challenge and authenticated cookie/top page are encrypted with AES-256-GCM in Durable Object storage.
- The SMBC password is not stored in the Durable Object; each operation reads it from a Worker secret.
- 1 Durable Object is used per 1 Access identity, with the identity hashed using SHA-256 for its name.
- Each 1 alarm processes 3 monthly chunks, persisting the session/manifest after each chunk.
- Completion performs official logout and deletes the encrypted session.
- Raw details are not returned to UI/API. The screen shows only run ID, period progress, counts, error code and manifest key.

<a id="secret同期"></a>

## Secret synchronization

Only the Bitwarden item ID is kept in local metadata. No intermediate password or item-JSON file is made.

```bash
cd services/collector-smbc-direct
export BW_SESSION="$(bw unlock --raw)"
printf '%s\n' '<item-id>' > /home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id
./scripts/sync-local-secrets.sh
```

`SESSION_ENCRYPTION_KEY` is generated as 32 bytes on first synchronization and saved in local `smbc-direct-session-encryption-key` and the Worker secret. Generation/synchronization of an unused admin token is retired. Existing Access authentication, same-origin/action-header validation and the session encryption key remain. Authentication values are not printed to stdout.

<a id="中央raw-evidenceへの保存"></a>

## Central raw-evidence storage

`packages/collection` writes runs directly to shared DATA, and the Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). See [collection.md](../../docs/collection.md#smbc-direct-kogane-smbc-direct-backfill-poc) for staging rereads and their bounds. `RAW_EVIDENCE_IMPORTER` Service Binding, `POST /backfill-raw-evidence`, `scripts/backfill-raw-evidence.sh` and the dedicated source bucket were retired on 2026-09-13. Old staging objects are already in central DATA under the same keys, and Durable Object progress can resume from DATA ([legacy-retirement.md](../../docs/legacy-retirement.md)). No GitHub Actions cron, Queue or extra scheduled trigger is used.

## Cloudflare resources

- Worker: `kogane-smbc-direct-backfill-poc`
- Durable Object: `SmbcBackfillSession`
- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; the old dedicated source bucket was deleted on 2026-09-13)
- Worker secrets: `SMBC_CREDENTIAL_JSON`, `SESSION_ENCRYPTION_KEY`
- Worker-level Cloudflare Access: protects production and preview (preview itself is disabled)

The Worker also returns 403 to requests without Access authentication. POST requires the same origin and a custom action header.

<a id="実証状態"></a>

## Verified state

- Local SMBC Direct: after Safety Pass approval, yen balance, 14 details for 2026/8, deposit/withdrawal totals and logout succeeded.
- Worker QR challenge: ordinary Workers egress returned SMBC `ERRINFO`; the existing TAMIA VPC binding successfully generated it.
- Worker login/backfill to SMBC Direct: Safety Pass QR approval through TAMIA, 93 months from 2019-01-01 through 2026-09-01, 1,069 detail rows, 188 artifacts, failure 0 and successful logout were also confirmed in the private R2 manifest.
- The 1st authenticated session lost `TPALTOP` at 48/93 months and became partial after 3 retries. Approving a new QR resumed the same Run ID from month 49 while retaining 98 existing artifacts, eventually reaching success.
- Zero Trust Access: configured with the existing `default` policy requiring WARP/Gateway and an allowed email domain.

Ordinary Workers egress and TAMIA were A/B tested with identical code/credentials. The former returned an HTTP 200 SMBC `ERRINFO` form, the latter a `BCATBCA` Safety Pass form. This PoC therefore sends only the 2 SMBC hosts through `TAMIA.fetch()`. Configuration is fixed to an exact-origin allowlist; arbitrary client-specified destinations are refused.

<a id="埋められるmoney-forward-gap"></a>

## Money Forward gaps this can fill

- Post-transaction balance for each detail row.
- SMBC internal JSON `meisaiId`.
- Original bank descriptions and raw responses.
- Backfill independent of MF free-tier display period, connection count and refresh frequency.
- Success/failure and capture time per chunk.

SMBC Direct cannot fill card-usage status, billing months/payment dates, installments/revolving payments, merchant details, refund links or `Vポイント` (V Point).

## Cleanup

Remove these together after verification:

- Worker `kogane-smbc-direct-backfill-poc`.
- Durable Object instances/storage.
- Worker secrets and Access application.
- `/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id`.
- `/home/risu/.local/state/kogane/smbc-direct-session-encryption-key`.

Shared TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`, personal WARP configuration and the existing `default` Access policy serve other uses and are excluded from cleanup. This PoC created no D1, Queue, Cron trigger, Container or Container image. See [`RESOURCE_INVENTORY.md`](RESOURCE_INVENTORY.md).
