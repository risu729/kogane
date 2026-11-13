# SBI VC Trade collector Worker PoC

A temporary PoC that logs into VCTRADE using an existing Bitwarden passkey entirely in a Cloudflare Worker, refreshes the session on a rolling basis and saves read-only data to R2. It uses no external Bun process, Container or Chrome.

<a id="secretと永続化"></a>

## Secrets and persistence

- `SESSION_SEED`: JSON containing 8 observed session cookies and `secureKey`, supplied only through `wrangler secret put`.
- `SESSION_ENCRYPTION_KEY`: a base64-encoded random 32-byte key; AES-256-GCM encrypts the mutable session stored in the Durable Object.
- `PASSKEY_CREDENTIAL`: only the required fields of the existing FIDO2 credential extracted through tmpfs with Bitwarden CLI. Never save it in Git.
- The Durable Object stores only the encrypted session, status, cookie-update count and last-success time.
- `__cf_bm` is not stored. Financial responses go to the shared DATA bucket (`kogane-raw-evidence`), with `meta.secureKey` removed before storage.

Workers Web Crypto uses the existing Bitwarden passkey; `initiateLoginWithPasskey` and `loginWithPasskey` reconstruct 8 fresh cookies and `secureKey`. Normally only the 15-minute keepalive runs. Reauthentication occurs only for HTTP 401/403, gateway refusal or a missing seed, with a 6-hour cooldown. Required terms agreement stops execution without sending `setAgreement`.

<a id="収集"></a>

## Collection

The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`). The Processor's
`ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) for two
jobs in [`config/alarm-jobs.json`](../../config/alarm-jobs.json), passing each job's cron shape:

- `sbi-vc-keepalive` (`*/15 * * * *`, every 15 minutes): sends only `informationTitle` to maintain the session.
- `sbi-vc-trade` (`5 21 * * *`, daily at 06:05 JST): captures the fixed read allowlist.
- Manual operations go through the operations API, which reaches this Worker only over the private `ScheduledCollection.runOperation` binding: a `collection` request (source `sbi-vc-trade`) runs the daily collection, and a `session-refresh` request runs the keepalive and, when it fails, a passkey login without the 6-hour cooldown. The former bearer routes `/run`, `/reauth`, `/collect`, `/health` and their `ADMIN_TOKEN` were removed on 2026-11-08 ([ADR 0069 amendment](../../docs/adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08)); session health is in the keepalive alarm history (`kogane.schedules.read`) and the Worker logs (`sbi_vc_keepalive`, `sbi_vc_reauth`). The only public route is `GET /healthz` (CD liveness: status and schema version, no session or provider call); every other path is 404 (`src/worker.ts`).
- Destination: content-addressed objects in shared DATA (`objects/<2 hex>/<sha256>`), with the terminal manifest (`runs/sbi-vc-trade/<run-id>/terminal.json`) written last.
- Contents: balances, account details, position summary, recent executions page 0, every historical execution page, every historical JPY deposit/withdrawal page, both unfiltered cash-flow views, monthly PDF/P&L ZIP documents, report indices, CSV checks, and manifest.
- Existing pages use size 30. The unfiltered cash-flow views use size 20,
  empty currency/type arrays and empty date bounds, as observed in the trader
  UI on 2026-11-10. Each view walks at most 100 pages and checks page numbers,
  sizes, cardinality and stable totals. No generic sender can select write events.
- `cashflows-all-recent-page-NNNN` and `cashflows-all-historical-page-NNNN`
  retain raw sanitized evidence only. No parser accepts them, so the overlapping
  JPY remittances are published only by the existing filtered dataset. Crypto
  transfers and staking/lending rewards remain uncollected as typed observations
  until their response semantics are observed. See the [observation and remaining
  limits](../../docs/sources/sbi-vc-trade.md#17-unfiltered-cash-flow-observation-2026-11-10).
- Classic captures stay in their original `account` unit. The additional lists
  belong to `full-cashflows`; failure there keeps that unit and the run partial
  while a completed classic unit remains eligible for its existing publishers.
  Classic failures still block the original account unit. The exact dataset
  eligibility policies do not enable publication of the raw lists.
- Leverage opening/closing × latest/past-history page-one responses are retained
  in four separate `executions-leverage-*` units. Filters were observed only on
  trader Socket.IO; even a strict numeric empty HTTP envelope remains partial
  `leverage_execution_transport_unverified`, without complete-empty coverage.
  Populated pages remain partial `leverage_execution_rows_unobserved` and do
  not initiate further pagination. No parser publishes these evidence datasets.
  Session/transport failures stop later leverage reads, including refusals from
  earlier stages; local shape refusals preserve sibling independence. Existing
  spot account and valid document units keep their own completion. The source
  execution capability remains partial. See the
  [observed filters and remaining limits](../../docs/sources/sbi-vc-trade.md#20-trader-leverage-execution-filters-2026-11-11).
- The observed simple-mode report events are `tradeReportList`, `monthlyTradeReport`
  and `plCalcData`. The collector walks MONTH and TRADE_DATA indices for 2018
  through the capture's Tokyo calendar year, and captures the unbounded YEAR
  index once. An empty annual index is explicit complete-empty evidence;
  offered annual files stay partial because their download event is unobserved.
- PDF/ZIP replies use JSON Buffer envelopes despite their MIME headers. Decode
  and validate native bytes before private content-addressed storage; keys carry
  the complete eight-digit report identity and SHA-256. Monthly PDF retrieval
  marks the provider's report as read as an intrinsic download side effect.
- Every document has its own unit. A failed index, download or separate CSV
  comparison keeps other successful documents and the classic account eligible.
  CORE 0097 enables only evidence metadata for the two canonical document
  datasets, with no economic rows. CSVs are checked against the existing API
  captures, not published again. Missing API views never mean zero rows.
  Annual downloads, daily reports and valuation history remain unsupported;
  see [the dated protocol evidence](../../docs/sources/sbi-vc-trade.md#18-simple-mode-documents-and-spot-execution-correspondence-2026-11-10).
- Later trader navigation observed balance quantities via Socket.IO and daily
  report list/browser-PDF routes. Their HTTP collector compatibility, retention
  and valuation/native-file semantics remain unverified; they add no runtime
  events or publication. See the [balance-history boundary](../../docs/sources/sbi-vc-trade.md#21-trader-balance-history-quantities-2026-11-11)
  and [daily-report observation](../../docs/sources/sbi-vc-trade.md#22-trader-daily-report-list-and-browser-pdf-navigation-2026-11-11).
- After each response, the rotated session is encrypted and saved immediately. Artifacts with `meta.secureKey` removed remain in memory until the terminal is written; no staging R2 objects are written.
- `packages/collection` writes objects and the final terminal with `etagDoesNotMatch: "*"` and R2-native SHA-256. The terminal follows every object, so a run without a terminal is not considered completely stored.
- The central importer, its Service Binding and `POST /backfill-raw-evidence` were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)). Even runs with 12 or more data artifacts write through the terminal immediately, without deferral. The Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)).

<a id="検証"></a>

## Verification

```sh
mise run install                                  # from the repository root
mise run //services/collector-sbi-vc-trade:test
mise run //services/collector-sbi-vc-trade:ci
mise run //services/collector-sbi-vc-trade:dry-run
```

Deploy the Processor before the collector ([rollout.md](../../docs/rollout.md#4-deployment-order)). Objects in the old private R2 bucket were copied to central DATA, verified and deleted; no outbox remains to resend ([legacy-retirement.md](../../docs/legacy-retirement.md)).

<a id="一時cloudflare-resourceとcleanup"></a>

## Temporary Cloudflare resources and cleanup

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; no dedicated bucket for this Worker)
- Schedule: Processor alarm jobs `sbi-vc-keepalive` (`*/15 * * * *`) and `sbi-vc-trade` (`5 21 * * *`); no Cron Trigger
- D1 binding: `SCHEDULE_DB` → `kogane-raw-evidence` (the execution lease)
- Worker Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `PASSKEY_CREDENTIAL`

After verification, remove the resources together with:

```sh
npx wrangler delete --name kogane-sbi-vc-session-poc
```

This does not delete data in shared DATA. The old dedicated source bucket `kogane-sbi-vc-trade-poc` was deleted on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).
