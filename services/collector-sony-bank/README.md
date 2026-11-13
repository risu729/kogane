<a id="sony銀行-read-only-worker-poc"></a>

# `Sony銀行` (Sony Bank) read-only Worker PoC

This independent Worker logs into the current Sony Bank Web BFF afresh on each run and saves gross balances, yen/foreign-currency ordinary-deposit history, official CSV and the latest 15 months of Sony Bank WALLET details to shared DATA (`kogane-raw-evidence`). It uses no Chrome, Browser Rendering, Container, TLS impersonation or Akamai workaround.

## Runtime profile

- **Browser: none.** Authentication, Web BFF, WALLET SSO, month changes and HTML/CSV capture all use Worker `fetch`.
- WALLET server-rendered HTML is also parsed as an HTTP response; no JavaScript navigation or browser cookie jar is needed.
- Chrome captures and browser scripts used during investigation are not collector runtime dependencies.

<a id="検証済みの認証経路"></a>

## Verified authentication path

On 2026-08-30, the following were verified with the owner's real account using a fresh `.NET HttpClient`, without reusing Chrome cookies.

1. GET the login page: 200.
2. `POST /custom-web00/dbca/csrf-token/get` returns `BFF-CSRF` and `FSID`.
3. With `FBaaS-Provider-Key: CustomAuth`, screen/event headers, branch number, account number and login password, `POST /custom-web00/dbca/cust-web/to-customers/login` returns 200 and business error 0.
4. The gross-balance API returns 200 in the same fresh session.
5. Authenticated balance, history and CSV requests also return 200 over ordinary HTTP without UA, `sec-*`, Origin or Referer.

`CustomAuth` is a static value in public `core.js`, not a browser fingerprint. CloudFront was observed on the current path; no Akamai DNS, header, script or cookie was observed. Caulis/PhishWall scripts exist on the public Web, but the read-only login above did not need them.

<a id="収集対象"></a>

## Captured data

- `gross-balance.json`: raw gross-balance BFF JSON.
- `yen-history-page-NNNN.json`: raw yen ordinary-deposit history JSON for all retained dates through yesterday; exhausts the 3-record pager.
- `yen-history.csv`: official CSV bytes for the same period.
- `foreign-history-<ccy>-page-NNNN.json`: raw JSON per currency: USD/EUR/GBP/AUD/NZD/CAD/CHF/HKD/ZAR/SEK.
- `foreign-history-<ccy>.csv`: official CSV bytes for the same period/currency; does not call the generation API for 0 transactions.
- `wallet-history-YYYY-MM.html`: monthly Sony Bank WALLET usage details, scanning the latest 15 months at 10-second intervals.
- `monthly-*`: unchanged current-month JSON/CSV requests retained as evidence, without a parser dataset; full-history files above are the current transaction input.
- `collection-summary.json`: non-secret summary containing only period, page/record counts and cookie names.
- `manifest.json`: R2 key, SHA-256, bytes and success/failure per artifact.

The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`). The Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) for the `sony-bank` job in [`config/alarm-jobs.json`](../../config/alarm-jobs.json), daily at 06:00 JST (21:00 UTC). Each run collects from the first day of the JST month that contains yesterday through yesterday (JST): the run on the 1st requests the whole previous month (`defaultWindow`, `src/worker.ts`). In the same authenticated session, it also requests all retained history for JPY and all ten foreign currencies, omitting `inquiryStrtdtCat` and ending yesterday, with observed `sortSelect=00002`. Every later successful run recovers a missed month-end. It exhausts the three-row pager (at most 1,000 pages per currency/range), checks any declared returned count and the stable total against every page, then requires CSV rows to equal that total. It keeps no cursor and adds no request-window input. The full-history terminal carries `full_snapshot` with a null lower bound and yesterday as the upper bound; it claims the provider's retained history, not independently proved account-opening coverage. Normal collection uses the existing fixed-action private RPC path. Public `/trigger` and arbitrary-period selection are retired (404); no equivalent override path is added.

After collection, `packages/collection` writes the run to shared DATA. Each artifact above is content-addressed at `objects/<2 hex>/<sha256>`, followed by a terminal manifest after every object. Objects and terminals use immutable conditional puts with R2 native SHA-256; a run without a terminal is not treated as completely stored. The Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). The dedicated source bucket, Service Binding to the central raw-evidence importer, `deferred` responses and `scripts/backfill-raw-evidence.sh` were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

```text
objects/<2 hex>/<sha256>                 each artifact, such as gross-balance.json, yen-history.csv, wallet-history-YYYY-MM.html and manifest.json
runs/sony-bank/<run-id>/terminal.json    run completion record written last (artifact key/object mapping)
```

Login responses (including names), cookie values, CSRF, passwords, temporary WALLET SSO values, JSESSIONID and hidden-form values are not stored in R2. JSESSIONID and hidden-form values are removed from WALLET HTML immediately before storage. Body text is retained (personal names may be stored: ADR 0029, amendment 2). Captured balances/history contain personal financial information, so the bucket must not be public.

WALLET obtains a temporary SSO value each time from bank BFF `/jada/debit-sso/login-usage-dtl-inq`, then connects over ordinary HTTP through `igw.sonybank.jp` to monthly lists at `dc.sonybank.jp`. The list contains every detail field; there is no separate detail endpoint. Month changes use `RW1313010201`, and the PDF entrypoint is `RW1313010301`. Official JavaScript rejects consecutive month changes within 10 seconds, so the Worker also observes a 10.25-second interval. This PoC does not store PDFs.

Cloudflare production verification on 2026-08-31 saved 34 artifacts for 2025-09-01 through 2026-08-31: 10 yen transactions, 6 foreign-currency transactions across 11 pages and 15 months of WALLET, with failure 0. Requesting official CSV for a foreign currency with 0 transactions can make Sony return 500 to Cloudflare egress, so empty CSV with no information is omitted when the JSON count is 0. Balances and 0-record history JSON are retained.

Production migration of existing data into central raw-evidence was verified on 2026-09-04. Scanning all 120 source-bucket listing pages imported 11 manifests (2 old v1 and 9 current v2); all 11 D1 runs were sealed, with 0 unsealed. Repeating the entire backfill from the start kept the run count at 11, confirming idempotent exact replay of sealed runs. A further sample of 1 old-v1 manifest confirmed matching SHA-256 and byte counts between the source R2 object and central content-addressed R2 object. No bodies or financial values were recorded in stdout or documentation during verification.

This backfill script and source bucket were retired on 2026-09-13. Every source-bucket object was copied to central DATA and SHA-256-verified before deletion; no outbox remains to resend ([legacy-retirement.md](../../docs/legacy-retirement.md)).

For local real-account verification, keep authentication JSON out of stdout and shell arguments. Point `SONY_BANK_CREDENTIAL_FILE` to a file protected with mode 600 or equivalent.

```sh
SONY_BANK_CREDENTIAL_FILE=/secure/path/sony-bank.json \
  bun scripts/live-smoke.ts -- 2025-01-01 2026-08-31
```

## Secret

- `SONY_BANK_CREDENTIAL_JSON`: JSON containing only `branchNum`, `accountNum` and `loginPwd`.

This Worker holds no central credential. The old importer ingest client `collector-r2-sony-bank` was disabled on 2026-09-13.

Keep secret values out of source, Wrangler configuration, shell history and stdout.

```sh
mise run install                                 # from the repository root
mise run //services/collector-sony-bank:test
mise run //services/collector-sony-bank:ci
mise run //services/collector-sony-bank:dry-run
wrangler secret put SONY_BANK_CREDENTIAL_JSON
```

Production deployment is the release workflow's, in the order of
[`infra/deploy-order.json`](../../infra/deploy-order.json), with a `/health` postcheck.

<a id="作成するcloudflare-resourceとcleanup"></a>

## Created Cloudflare resources and cleanup

- Worker: `kogane-sony-bank-collector-poc`
- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; no bucket is dedicated to this Worker)
- Schedule: Processor alarm job `sony-bank` (`config/alarm-jobs.json`, `0 21 * * *` UTC); no Cron Trigger
- D1 binding: `SCHEDULE_DB` → `kogane-raw-evidence` (the execution lease)
- Worker secret: `SONY_BANK_CREDENTIAL_JSON` (the one above)

When retiring the PoC, delete only the Worker. Keep shared DATA because other collectors and the Processor also use it. The former dedicated source bucket `kogane-sony-bank-collector-poc` was deleted on 2026-09-13.

### Failure diagnostics

Collection failures emit a structured `*-collection-failure` event before teardown
or the DATA write. Join on `runId`; use `phase` to distinguish collection from
teardown, relay and shared-persist events. The collector manifest stored in DATA
retains the same three failure fields (`operation`, `errorType`, `message`). Its
bounded message includes the safe stage and available HTTP status; structured logs
expose these as `diagnostics` fields. Use that manifest or the Worker logs for
diagnosis.

No exception message, stack, cause, request URL, credential, response body, or
unrecognized provider text is logged. Sony logs only fixed operation IDs/currencies
and the count of provider errors (no provider codes are currently approved for
logging). Shinsei accepts only known browser stages and records whether authentication
was attempted. Its relay events include `runId` and `peerClosed`; compare them with
`*-container-teardown-start` before attributing a connection error to collection.
An unknown stage stays `unknown-browser-stage`; a failed read is separate from
subsequent `NotAttempted` reads. No retries or collection requests are added.

### Empty JPY history and progress logs

JPY now follows the same zero-transaction CSV rule as foreign currencies: after
validating every official history JSON page, request CSV only when the total is
positive. Keep the original zero-row JSON, balance and WALLET evidence; do not
fabricate an empty CSV. A positive-history CSV error still fails collection.
No importer re-checks this any more: the collector itself omits JPY CSV only after
validating zero-row history, and the manifest and collection-summary field shapes
remain unchanged.

This matches Sony's public `eaba0600/search` frontend: its `csvdlBtn` section is
rendered only after a successful history response with `countCnt !== 0`.
Verified on 2026-09-05 in the official
[history page module](https://sonybank.jp/pages/ea/_next/static/chunks/53a82944a612014e935388c108002b83322cace3.58e22f343a3103820839.js).
The prior unconditional JPY CSV request could hit the same HTTP 500 behavior
already observed for empty foreign-currency history.

`sony-bank-progress` records use the run's `runId`, allowlisted stage/event and
currency, page index/count, validated row/transaction counts, HTTP status,
duration, and `zero_transactions` skip reason. `phase=request` records HTTP
transport completion; `phase=collection` records validated collection steps.
Thus HTTP 200 alone does not imply a valid JSON/history response. Validated
counts are logged before requesting CSV, even if a later step fails. No URLs,
credentials, financial bodies or free-text provider errors enter these records.
Log emission is best effort and cannot replace a collection result or failure.

Artifacts are still persisted after full collection returns. A failure midway
does not yet preserve earlier fetched artifacts, so the failure manifest's
default transaction count is not evidence that JPY history was empty; use the
validated progress count instead.
