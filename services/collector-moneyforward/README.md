# Money Forward ME Worker collector PoC

A PoC that reads Money Forward ME from a browserless Cloudflare Worker using a Money Forward ID passkey. Connected-service lists, account details and detail fragments for the latest 12 months available on screen are stored as unmodified HTML in private shared DATA (`kogane-raw-evidence`).

<a id="収集対象"></a>

## Captured data

- `/accounts`: connected-service list, totals, registration date, last update, status and opaque detail-page keys.
- Every `/accounts/show/<opaque-id>` enumerated from that list.
- `/cf/fetch` using each detail page's `account_id_hash`, `service_id` and CSRF token.
- The latest 12 months, including the current month, sent as `from=YYYY/M/1&account_id_hash=...&service_id=...`.
- A manifest per run (counts, SHA-256, byte sizes, R2 keys and failure stages).

Response HTML contains balances/details, so its body is returned in neither Worker logs nor HTTP responses (the Worker serves only `GET /health`; every other path is 404, `src/worker.ts`). The R2 bucket is not public either.

<a id="認証"></a>

## Authentication

The Worker holds only 1 passkey stored for the correct Money Forward ID. It holds no Bitwarden master password, `BW_SESSION` or Money Forward cookie.

If multiple passkeys share an rpId, neither the item name nor first array element selects one. `scripts/select-bitwarden-passkey.ts` sequentially verifies Bitwarden candidates for `id.moneyforward.com` without displaying values, recording only the 1 candidate that actually reached ME account details in local metadata. Rerun this after passkey addition/deletion/storage-location changes, not password changes.

```bash
export BW_SESSION="$(bw unlock --raw)"
bun scripts/select-bitwarden-passkey.ts
./scripts/sync-local-secrets.sh
unset BW_SESSION
```

`moneyforward-bitwarden-match.json` holds only item id and credential index, with no authentication secret. `sync-local-secrets.sh` follows that selection to extract the Bitwarden passkey and pipe it directly into `MONEYFORWARD_CREDENTIAL_JSON`. No intermediate secret JSON is created.

Local connectivity checks also pass the same Bitwarden passkey through stdin.

```bash
./scripts/credential-from-bitwarden.sh | bun scripts/live-smoke.ts
```

## Cloudflare

```bash
mise run install                                   # from the repository root
mise run //services/collector-moneyforward:test
mise run //services/collector-moneyforward:ci
./scripts/sync-local-secrets.sh
```

Production deployment is the release workflow's, in the order of
[`infra/deploy-order.json`](../../infra/deploy-order.json), with a `/health` postcheck.

The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`). The
Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled`
(`src/schedule-entrypoint.ts`) for the `moneyforward-me` job in
[`config/alarm-jobs.json`](../../config/alarm-jobs.json), daily at 06:15 JST (21:15 UTC).
GitHub Actions is not the scheduler. Nothing requests a bank/card refresh on Money Forward's side; only the contents last synchronized into Money Forward are saved.

<a id="中央raw-evidenceへの保存"></a>

## Central raw-evidence storage

`packages/collection` writes runs directly to shared DATA, saving each page and manifest under `objects/<2 hex>/<sha256>` and writing `runs/moneyforward-me/<run-id>/terminal.json` last. The Processor registers terminals in-process ([processor.md](../../docs/processor.md)). `POST /backfill-raw-evidence`, the Service Binding to `kogane-collector-r2-importer`, `scripts/backfill-raw-evidence.sh` and the dedicated source bucket were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

<a id="2026-08-31の実データ検証"></a>

## Real-data verification on 2026-08-31

- Money Forward passkey candidates in Bitwarden: 2.
- Candidates whose signatures were accepted: 2.
- Candidates actually authorized for the ME account: 1.
- Local capture: 4 details, 48 monthly fragments, 53 artifacts total, failure 0.
- Worker capture: 4 details, 48 monthly fragments, 53 artifacts total, failure 0.
- R2: all 53 manifest entries had byte sizes/SHA-256; rereading sample bodies confirmed matching SHA-256.
- Verification at that time: `/health`: 200; the old authenticated trigger: success. The public trigger was retired on 2026-10-10 (404); the existing fixed-action private RPC remains the normal collection path.

During diagnosis, a Kogane-specific passkey was temporarily registered for the correct MFID, then removed after identifying the correct existing Bitwarden passkey. The count was confirmed to return from 2 to 1 and the credential ID to disappear. Windows/WSL copies of the dedicated private key were also deleted; the Worker secret now uses the Bitwarden passkey.

<a id="money-forwardから取得できないまたは意味が弱くなるデータ"></a>

## Data Money Forward cannot provide, or whose meaning becomes weaker

For `三井住友銀行` (Sumitomo Mitsui Banking Corporation), Money Forward presentation cannot completely reconstruct:

- Post-transaction balances, bank-side transaction IDs/inquiry numbers and value dates.
- Structured transfer-counterparty name, bank, branch and account information.
- Official bank CSV or official-API raw responses.
- Original-currency amounts, applied rates and post-transaction foreign-currency balances.
- Time-deposit details per lot and maturity conditions.
- Guaranteed exact agreement/completeness against official bank details.

For Vpass, Money Forward's generic details cannot completely provide:

- States such as usage, posted sales and finalized billing.
- 1-payment, installment/revolving classification and installment counts.
- Billing month, payment day and statement-level grouping.
- Links from cancellations/refunds to original transactions.
- Original-currency amounts/rates for overseas usage.
- Approval numbers/sales IDs, merchant country and category.
- Point earning/usage history.

`Oliveデビット` (Olive Debit) merchant-level usage history is unavailable through bank linking alone. It may appear in Vpass linking's generic `内容・金額` ("description and amount"), but completeness, finalized state and official-statement-specific fields are not guaranteed.

Across sources, uncaptured data includes the latest/pending items Money Forward has not refreshed, the provider's full historical period and per-transaction source-fetch times. On-screen free-plan limits also include 4 connections, the past 1 year, refresh frequency and bulk refresh.

<a id="依存箇所と制約"></a>

## Dependencies and limits

- Private HTML and `/cf/fetch` dependencies require following screen-structure changes.
- Even after successful storage, downstream parsers validate each HTML revision.
- After passkey authentication, the ME OAuth account selector still needs an active-account selection.
- Money Forward session cookies and Chrome profiles are not copied into the Worker.

<a id="検証資源と削除対象"></a>

## Validation resources and cleanup

When retiring the PoC, remove these together:

- Worker: `kogane-moneyforward-collector-poc`
- Worker secrets: `MONEYFORWARD_CREDENTIAL_JSON` (account-unit identity is derived without a secret: [ADR 0029](../../docs/adr/0029-data-classification-and-unkeyed-identity.md). Previously configured `MONEYFORWARD_ACCOUNT_IDENTITY_KEY` is unread and can be deleted with `wrangler secret delete MONEYFORWARD_ACCOUNT_IDENTITY_KEY --name kogane-moneyforward-collector-poc`.)
- Schedule: Processor alarm job `moneyforward-me` (`config/alarm-jobs.json`, `15 21 * * *` UTC); no Cron Trigger
- Local matching metadata: `/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json`

Keep shared DATA (`kogane-raw-evidence`) because other collectors and the Processor also use it. The old dedicated source bucket `kogane-moneyforward-collector-poc` was deleted on 2026-09-13.

## Safe operational diagnostics

Each run logs `collector-stage-started` and `collector-stage-failed` with the same
`runId`. Stages distinguish credential parsing, login entry, passkey options,
local signing, assertion, redirects, account selection, account pages, monthly
fragments, artifact storage, and manifest storage. Failure records retain only
allowlisted error categories, HTTP status and fixed protocol reasons. Partial R2
failures are logged individually; manifest-write failures remain traceable even
when no manifest can be saved. Logging is best effort and cannot stop collection.

Exception messages/stacks, provider response bodies, redirect URLs, cookie names
or values, CSRF/challenge values, account identifiers and passkey material are
excluded from diagnostics. Raw evidence storage and collection status semantics
are unchanged. There is no central backfill path any more; it was retired with
the per-source bucket on 2026-09-13.

## Stored detail-page measures

The collector already stores account detail HTML. The central
`moneyforward-detail-balances@1.0.0` parser now publishes strictly observed
bank aggregate JPY values and single-row point quantities/current JPY values,
under the existing MoneyForward account identity. These are non-additive
reported measures; native product balances, premium-gated card debt and
unobserved securities holdings remain unavailable with closed diagnostics.
Capture time is not the underlying provider's balance as-of.

No collection request or registration-contract change is needed. See
[`docs/sources/moneyforward.md`](../../docs/sources/moneyforward.md) and
[ADR 0103](../../docs/adr/0103-moneyforward-detail-measures.md).
