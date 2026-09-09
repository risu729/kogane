# Observation pipeline PoC

Everything that happens **after** collection: an already-collected raw
artifact is ingested, parsed into typed observations by deterministic
versioned parsers, and browsed read-only with full provenance.

This PoC deliberately contains **no collector**. Authentication, anti-bot
handling, and session management are the subject of `poc/vpass-json` and
`poc/sbi-securities-worker`, which already write raw evidence to R2 daily.
The question here is the one nothing in the repository had yet answered:
once the bytes exist, what turns them into observations without ever
becoming a finished ledger?

It exercises phases 2 and 3 of `docs/roadmap.md` end to end, against the
payload shapes the live collectors actually emit. See `docs/raw-store.md`,
`docs/observations.md`, and `docs/evidence-browser.md` for the plans this
implements, and `RESULTS.md` for what it settled and what it did not.

The parsers, the identity resolver, the observation types and the shared HTTP
contracts no longer live here: design review D07 moved them to
`packages/parsers`, `packages/identity` and `packages/observation-shared`, so
that the deployed Workers stop importing a PoC. The old paths under `src/` and
`shared/` are one-line re-exports of those packages, and everything below
behaves exactly as it did. See `docs/package-layout.md`.

## Running it

```sh
bun install
bun run preview       # build + isolated synthetic-data browser (no existing state access)
bun run demo          # ingest the fixtures, parse them, print row counts
bun run build         # build the client into web/dist
bun run serve         # API + built client on http://127.0.0.1:8787/
bun run dev           # Vite dev server on 5173, proxying /api to 8787
bun test              # pipeline/API tests; browser tests require Chromium and a build
bun run typecheck
```

The frontend now provides Japanese navigation, responsive layouts, source
and date filters, and explicit loading/error/retry states. See
[Frontend foundation](../../docs/frontend.md) for the stack decision and
production API handoff. `/api/meta` distinguishes a verified synthetic
preview from a normal local store whose data classification is unknown.
Neither is connected to the production D1/R2 store yet.

`bun run preview` uses only committed synthetic fixtures in a fresh temporary
store and removes that store on normal shutdown. Use it to review the UI
without opening `state/` or running a collector. `bun run demo` retains its
older behavior of ingesting fixtures into `state/`, so it is not a data-mode
switch and does not mark that store synthetic.

`bun run serve` binds loopback only and has no authentication: it renders
real financial evidence and must never be reachable from a network. The
same holds for the dev server, which binds localhost unless it is given
`--host`. `bun test` runs 5 of its tests in a real Chromium when one is
available and the client has been built; without either it reports why it
skipped them.

`bun run demo` is idempotent. Running it twice ingests nothing new and
parses nothing new, because runs are keyed by their external run id, blobs
by their SHA-256, and parse runs by (artifact, parser, version).

State lives in `state/` (gitignored): `kogane-poc.sqlite` stands in for D1,
and `state/blobs/` stands in for R2. Deleting the directory and re-running
is always safe — that is the point of the architecture. The client build
output in `web/dist/` is gitignored too, and `bun run serve` says so
rather than 404-ing silently when it is missing.

## What it does

```text
collector run directory (or a single file export)
      │  ingest.ts — content-addressed, hash-verified, idempotent
      ▼
raw_objects + fetch_artifacts + fetch_runs         layer A: evidence
      │  parse.ts — deterministic, versioned, supersession-aware
      ▼
transaction / balance / position / valuation observations   layer B
      │  queries.ts — read-only, computed per request, stores nothing
      │  api.ts — a Hono JSON API over those queries
      ▼
evidence browser (React client in web/, served by serve.ts)
```

Thirty-three parsers are registered against shapes the collectors already produce:

| Parser                                     | Artifact                                           | Emits                                        |
| ------------------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| `sbi-domestic-cash-positions`              | SBI `domestic-cash-positions`                      | deposit-type-scoped positions and valuations |
| `sbi-account-assets-current`               | SBI `account-assets-current`                       | provider valuations by source view/category  |
| `sbi-yen-detail-history`                   | SBI `yen-detail-history`                           | transactions                                 |
| `sbi-domestic-trade-records`               | SBI `domestic-trade-records`                       | transactions                                 |
| `sbi-foreign-trade-records`                | SBI `foreign-trade-records`                        | transactions                                 |
| `sbi-foreign-cash-positions`               | SBI `foreign-cash-positions`                       | positions, provider valuations               |
| `sbi-foreign-cash-balances`                | SBI `foreign-cash-balances`                        | balances                                     |
| `sbi-vc-cash-balances`                     | SBI VC Trade `cash-balances`                       | balances                                     |
| `sbi-vc-account-margin`                    | SBI VC Trade `account-margin`                      | balances                                     |
| `sbi-vc-position-summary`                  | SBI VC Trade `position-summary`                    | positions                                    |
| `sbi-vc-executions`                        | SBI VC Trade recent and historical execution pages | transactions                                 |
| `sbi-vc-cashflows`                         | SBI VC Trade historical cashflow pages             | transactions, balances                       |
| `myjcb-credit-ledger`                      | MyJCB normalized credit ledger                     | transactions                                 |
| `myjcb-credit-past-month-balances`         | MyJCB past-month JSON-RPC response                 | statement payment metrics                    |
| `myjcb-canonical-evidence-boundary`        | MyJCB sanitized menu/detail HTML and discovery     | no financial observations                    |
| `paypay-csv`                               | PayPay consumer CSV export                         | transactions                                 |
| `mobile-suica-sf-history`                  | Mobile Suica `sf-history`                          | transactions, post-row balances              |
| `sony-bank-gross-balance`                  | Sony Bank gross-balance JSON                       | account-type balances and provider totals    |
| `sony-bank-history-json`                   | Sony Bank yen/foreign history pages                | transactions and after-transaction balances  |
| `sony-bank-history-csv`                    | Sony Bank official yen/foreign CSV                 | transactions and after-transaction balances  |
| `sony-bank-wallet-history`                 | Sony Bank WALLET monthly HTML                      | card transactions                            |
| `smbc-direct-balance`                      | SMBC Direct `balance-normalized`                   | balance                                      |
| `smbc-direct-transactions`                 | SMBC Direct `transactions-normalized`              | transactions                                 |
| `sbi-shinsei-top-balances-and-activity`    | SBI Shinsei `top-accounts-balance-and-activity`    | balances, valuations, transactions           |
| `sbi-shinsei-yen-deposit-account`          | SBI Shinsei `yen-deposit-account`                  | source-view-scoped balances                  |
| `global-pass-activity`                     | GLOBAL PASS sanitized `globalpass-activity` HTML   | transactions                                 |
| `v-point-balance-info`                     | V Point common/store expiry buckets                | point balances                               |
| `v-point-smfg-point`                       | V Point SMFG display breakdown                     | separately scoped point balances             |
| `v-point-history-page`                     | V Point complete paginated history                 | signed point transactions                    |
| `v-point-pay-notification-event`           | V Point Pay normalized notification event          | transactions and source-separated balances   |
| `vpass-statement-page`                     | Vpass sanitized statement JSON pages               | posted/unconfirmed card transactions         |
| `moneyforward-monthly-transactions`        | MoneyForward ME monthly calendar fragment          | transactions                                 |
| `moneyforward-canonical-evidence-boundary` | MoneyForward ME accounts/detail full HTML          | no financial observations                    |

V Point registers only the three financial Layer-A artifact families.
`vmoney-history-page-*` is the observed empty boundary for a separate asset,
and `collection-summary` plus the history graph are completeness metadata, not
additional financial rows. Numeric `point_type`, `point_div`, and `get_month`
values remain provider enums in `extra`; the parser assigns them no names.
History amounts retain the sign of the provider `point` field. Since the source
does not provide a stable row id, no `externalId` or reconciliation identity is
created. Current transaction and balance queries select the newest complete V
Point run as one snapshot, preventing repeated full-history captures from being
double counted while preserving every occurrence and expiry bucket in that run.

Mobile Suica deliberately has one canonical Layer-B route. The collector's
Shift-JIS `sf-history-html` is provider evidence and `collection-summary` is
run metadata; neither is parsed into observations. Only the collector-derived,
UTF-8 normalized `sf-history` JSON is registered, so the HTML and its derivative
cannot double-count the same rows. Each amount keeps the sign stated by the
normalized row, each row balance is a separate `sf_balance_after_transaction`
measurement, and the most recent row is marked as the current-balance candidate
rather than presented as a guaranteed real-time balance.

SMBC Direct also has one canonical route per financial fact. Its Shift-JIS
`balance-raw` and `transactions-raw` artifacts remain provider evidence, while
Layer B reads only the cross-checked UTF-8 normalized partners. The balance is
an exact JPY account-balance observation. Each transaction uses the provider
ID, takes its sign only from the explicit credit/debit field, and retains the
post-row balance, requested range, and provider totals in `extra`. A repeated
provider ID is collapsed only in the current view; both raw observations remain
append-only and traceable.

GLOBAL PASS likewise has one financial route. A successful Layer-A artifact is
one sanitized provider HTML page for one selected month. Its desktop and
responsive tables are two views of the same records, so the parser requires
their cardinalities to agree and emits each transaction once. All provider
fields, including fees, approval/status text, remarks, local/funded amounts,
and unmodelled conditional fields, remain in `extra`. The observed transaction
amount is unsigned: the parser keeps its exact text, scale and ISO currency but
does not manufacture a debit sign or `amountMinor`. Pending-to-confirmed and
family-card identity are not inferred, and the whole provider row plus its
occurrence supplies replay-stable evidence identity. The month selector accepts
the Layer-A range of one through fifteen contiguous months, binds the selected
month to the artifact key, and the current view uses only the latest successful
snapshot for each month, including an explicitly empty replacement snapshot.

V Point Pay Layer B accepts only the canonical `notification-event` JSON from
the successful, failure-free Layer A email-pair run. The paired
`notification-mail` remains evidence-only and has no parser route. The email
does not establish settlement, so non-declined transactions use the separate
`v-point-pay:notification-events` account and `status=notified`; usage is signed
as an outflow notification, while charge and prepaid balance addition are signed
as inflow notifications. A declined event is retained without a typed cashflow
amount. `usedPoints` remains supporting `extra` and is not guessed into a
separate funding leg. Only `balanceYen` becomes a snapshot under
`v-point-pay:prepaid-yen`. Event identity collapses replayed notifications in
the current transaction view, and current balances use the newest successful
event time rather than import order.

Vpass also has one canonical financial route: sanitized JSON
`statement-page`. Layer A supplies the stable card unit key separately from the
redacted payload, and the PoC run-manifest ingestion carries that unit through
nested statement artifact paths. Known presentation-only rows are validated
against exact row metadata, lengths, and required slots but not emitted;
known settled and unsettled transaction rows retain their complete source row,
and unknown subtypes fail closed. The provider success code and customized
top/answer index, page metadata types, and statement-month binding are checked
again in Layer B. Purchases and refunds receive exactly one explicit
credit-liability sign inversion. The current view chooses the latest successful
snapshot per card and statement month, including a latest empty snapshot, but
only after every statement artifact in that card-month fetch unit has a current
successful parse. A newer interrupted parse therefore cannot hide the last
complete snapshot.

Balance, position and valuation containers use the same completeness rule in
`src/snapshot-query.ts`. Selection happens before joining observations, so a
successful empty container removes previous rows and a missing account or
instrument cannot survive from an older capture. The snapshot key is source,
parser, dataset and Layer-A fetch unit; every matching artifact in a fetch run
must have a successful current parse. Provider fetch time orders eligible runs,
with append-only artifact order breaking ties. The current collectors write one
artifact for each of these containers; the all-artifacts condition also prevents
an interrupted multi-artifact parse from publishing a mixed snapshot.

| Collector      | Complete container datasets                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| SBI securities | `domestic-cash-positions`, `foreign-cash-positions`, `account-assets-current`, `foreign-cash-balances` |
| SBI VC Trade   | `position-summary`, `cash-balances`, `account-margin`                                                  |
| SBI Shinsei    | `top-accounts-balance-and-activity`, `yen-deposit-account`                                             |
| Sony Bank      | `gross-balance`                                                                                        |
| SMBC Direct    | `balance-normalized`                                                                                   |

An account or market inside one container is not a separate capture: disappearing
rows must disappear together with that container's old snapshot. The two tolerant
SBI foreign container parsers can skip unreadable containers, so warnings about
unreadable rows or fields prevent a parse from establishing a complete snapshot.
Warnings about exact decimal text without a minor-unit representation, or extra
unmodelled fields preserved alongside all known metrics, do not imply missing
measurements and do not block snapshot replacement. Other strict
container parsers establish completeness on successful parsing. Position detail
joins valuations only from the same parse and, for SBI positions, the same
provider record locator; equal security codes in different markets cannot attach
one another's valuations. These internal joins add no fields to the public API.

Foreign positions require pagination-validating parser `0.3.0`: the collector
captures page 1 only, so `hasNextPage` must be false and the pagination metadata
must identify a valid first page. Earlier parser successes remain historical
evidence and cannot establish current membership until successfully reparsed.
An error on reparse does not resurrect an older unvalidated parse. A registry
parity test makes future parser version changes update this eligibility rule.

Historical transactions and after-transaction balances are not portfolio
containers. Mobile Suica, SBI yen details, domestic/foreign trades and SBI VC
cashflows collapse replayed transaction identities only in the current view.
Identity is namespaced by source, source account and parser family. Fingerprint
occurrence suffixes remain intact, and rows without an identity remain separate.
Sony JSON/CSV history intentionally share one family, preserving the official CSV
preference. An empty history capture does not erase previously observed events or
their post-event balance measurements. MyJCB, V Point and Vpass retain their
separate statement/run snapshot rules described above.

MoneyForward ME uses its monthly calendar fragment as the sole transaction
route. The account detail contains a bounded recent view of the same activity,
so both the accounts index and account detail are validated as evidence-only.
Each tooltip table is bound to the immediately preceding provider ISO date;
the parser validates adjacent calendar rows but emits only dates belonging to
the artifact's declared month. This prevents both recent-view duplication and
the same edge-of-calendar row appearing from two neighboring month artifacts.
Amounts are emitted only when the provider displays an explicit `+` or `-` JPY
integer. A latest successful snapshot is selected per HMAC account unit and
month, including a newer complete empty fragment that clears older current
rows. Layer A derives the stable account unit from an exact account/service
tuple in verified detail bytes, matched to the sorted index. Ordinals remain
provenance only; insertion or removal of another account cannot change identity.
Legacy ordinal-only artifacts cannot enter this semantic route. Every monthly
fragment requires one calendar marker; empty snapshots require the audited
dialog/calendar/select tag and attribute-name structure. Incomplete tables,
unknown empty shapes and embedded whitespace in amounts fail closed.

The demo ingests 11 artifacts from 3 sources and produces 49 observations:
14 transaction, 24 balance, 3 position, 8 valuation.

## The parser contract

A parser is a deterministic, side-effect-free function from bytes to
observations. It does not fetch, does not read the clock, and does not use
randomness, so re-parsing the same artifact always yields the same result.
Beyond that it must:

- carry a name and a version, and select the artifacts it accepts from
  metadata alone;
- require the owning fetch run to have terminal status `success`; partial and
  failed run artifacts remain raw evidence but never become observations;
- record a raw locator on every observation (`json:$.records[3]`,
  `csv:row=12`) so the value can be found again in the same bytes;
- never drop a provider field it does not model — unrecognized material is
  carried in `extra`, by name;
- warn rather than discard when a known row has one unreadable optional field.
  The four newer SBI parsers intentionally fail the artifact on envelope,
  cardinality, enum, pagination, fixed-width, or required-value drift: recording
  a plausible partial portfolio or history would be more dangerous than a
  retryable error parse run.

Re-parsing is first class. Running the same parser version again is a
no-op; a bumped version re-parses and marks the earlier parse run
superseded. No observation row is ever updated or deleted, so "current"
is a query — observations whose parse run nothing has superseded — rather
than a stored state.

## The evidence browser

Strictly read-only, and closer to a debugger than to a dashboard. It exists
so that a human can see, for any observation, the exact bytes it came from
and the parser version that produced it; re-parsing is only trustworthy if
someone can check what changed.

```text
/                              row counts, sources, fetch runs, parse runs
/transactions                  current transaction observations, sortable
/balances                      latest per (account, metric, instrument), then full history
/positions                     current positions with provider-reported valuations
/observations/:kind/:id        every column, extra_json, and the provenance walk
/artifacts                     every artifact and its observation counts
/artifacts/:id                 all parse runs including superseded ones
```

Each page reads one endpoint of the same name under `/api`, with `/`
reading `/api/overview`; the stored bytes are at `/api/raw/:sha256`, which
the client links to and never fetches. Any method other than GET or HEAD
is refused before routing, and every current-state view is computed per
request and stored nowhere. The provenance walk is the point of the tool:
observation → parse run (parser@version, warnings) → artifact → raw object
→ fetch run.

The server is `src/api.ts` (a Hono app, so the same object can run on a
Worker later) over `src/queries.ts` (every read query, with the "current"
predicate stated once) and `src/money.ts` (minor units and amount
formatting, shared with the parsers). The client is React, built by Vite:

```text
web/index.html
web/src/main.tsx       React root and the query client
web/src/app.tsx        masthead, and the view for the current route
web/src/router.tsx     a pushState router, so there is no router dependency
web/src/api.ts         typed fetch layer, one hook per endpoint
web/src/ui.tsx         shared components: amounts, badges, panels, links
web/src/money.ts       re-export of src/money.ts — one formatter, not two
web/src/styles.css     one plain stylesheet, light and dark
web/src/pages/*.tsx    one page per route
```

Dependencies are Hono, React, TanStack Query and TanStack Table, with Vite
and Playwright for development. There is no component library, no CSS
framework, no icon pack, and no chart library: a chart is a claim about a
trend, and every claim here should be a row someone can trace
(`docs/evidence-browser.md`).

## Fixtures

`fixtures/` holds synthetic payloads shaped like the real collector output,
including a run `manifest.json` whose SHA-256 hashes match the bytes beside
it. They are not captured data: **no real balances, transactions, account
identifiers, or credentials are committed**, in line with
`docs/account-inventory.md`. Their field names and structure come from the
collectors' own source and from `docs/sources/`, so the parsers are written
against real shapes rather than invented ones.

`fixtures/sbi-parser-boundaries/` adds anonymous, manifest-free boundary
fixtures for the four additional SBI shapes. Keeping them outside the demo
run means no production object key or evidence digest is copied into the
repository; their role is parser contract testing, not layer-A ingestion.

This is also their limitation, and the reason `RESULTS.md` lists the
questions only real payloads can close.

`fixtures/global-pass/` is also anonymous and manifest-free. It pins the
sanitized HTML month selector and the outer/compact/expanded table relationship
without copying any production body, object name, digest, account identifier,
or financial value.

The SBI VC Trade fixture set mirrors all six source-separated collector
artifacts. Its shape was checked against the current public client models and
with the checked-in `services/collector-r2-importer/scripts/audit-sbi-vc-r2.sh`
production R2 read-only canary. The canary disclosed only aggregate pass/fail
counts and shape-evidence booleans: all nine successful manifests parsed
completely. Object keys, hashes, response bodies, provider values, and account
identifiers were not emitted. The observed runs did not prove non-empty
position/recent records, multi-page history, or cross-view overlap; those
remain synthetic-test coverage.

The MyJCB fixture is a complete anonymous `myjcb-worker-poc-v1` success run,
including connection/cardinality metadata, repeated monthly dataset names,
artifact keys, media types, statement state, periods, byte counts, and hashes.
Only `credit-ledger` and displayed `credit-past-months` totals are financial
Layer-B inputs. Sanitized menu/detail HTML and discovery are validated as
evidence-only, so the HTML and its collector-derived ledger cannot double
count a purchase. CSV/PDF/OFX and debit artifacts remain unregistered because
production R2 has not established their contracts.

`services/collector-r2-importer/scripts/audit-myjcb-r2.sh` is a local,
remote-read-only canary. It applies the source importer validator, then every
registered MyJCB parser, and returns only aggregate counts and shape booleans.
It never emits object keys, hashes, bodies, provider values, account IDs, or
financial values and contains no deploy or R2 mutation path.

`fixtures/sbi-shinsei-parser-boundaries/` pins the two SBI Shinsei source
artifacts whose monetary semantics are explicit. The raw top response is the
canonical source for its own balances and activity; the derived `normalized`
artifact is intentionally not registered, preventing a raw/derived duplicate.
`yen-deposit-account` keeps `debitAccountDetails` and `savingsDetails` as
separate metrics. Product codes remain opaque provider evidence. The
`balance-summary-and-stage` and `exchange-rate` artifacts are validated as raw
evidence but have no Layer-B route until their currency/unit meaning and a
rate observation kind are established. `collector-manifest` is run metadata.

The checked-in SBI Shinsei canary reads production R2 through a local Wrangler
process with a remote read-only binding. It directly reuses the Layer-A run
validator, including exact object metadata/native checksums/content types,
bounded complete inventories and raw/normalized cross-artifact meaning. It then
checks the two parser routes and the three explicit no-parser decisions. Its output
contains only aggregate counts and shape booleans; object names, digests,
response bodies, account identifiers, and financial values are never emitted.

Artifacts now carry their parent fetch-run outcome and failure count. A
non-success run is retained as evidence but is blocked before every parser,
and current queries independently require a successful, failure-free parent.
Collector manifests must explicitly declare both `status` and `failures`;
missing outcome evidence fails closed. SBI VC cash-balance and account-margin
child-row drift rejects the whole artifact. For SBI VC executions, raw Layer B
history keeps both recent and historical source views, while the current query
prefers the historical record when the same composite execution identity is
present in both. Re-fetched SBI Shinsei transactions likewise collapse only by
the exact source, account and provider transaction identity; other sources and
accounts remain independent.
The schema migrates existing v2, v3, and v4 stores in place. Old non-success
rows are conservatively backfilled with one failure, pre-v4 artifacts receive
nullable collector-key and statement metadata, and pre-v5 runs receive nullable
provider query-window fields.

`fixtures/sony-bank-parser-boundaries/` likewise contains anonymous JSON, CSV,
and sanitized HTML shaped from the merged Layer A contract and a read-only
production structure audit. No source object name, digest, account identifier,
or financial value was copied. Sony's current artifacts contain balances,
transactions, and provider total valuations; they do not contain a security
holding, so the Sony parsers deliberately emit no invented `position` rows.

Sony history JSON and CSV cover the same provider query window. Both source
views remain queryable, but they share an identity derived only from their
common date, signed amount, post-transaction balance, currency, and occurrence;
the current transaction view prefers the official CSV. Fetch windows are
persisted on Layer A runs and every history date must fall inside that exact
window. WALLET keeps the provider's eight-digit month option and default-first
selection semantics. It requires exact adjacent primary/supplement row pairs,
uses approval number plus occurrence when available, and maps `未確定` separately
from a settlement date. Because the captured WALLET table has no independent
credit/debit field, an unsigned display amount is retained only in `extra`; its
signed normalized amount is omitted with a warning instead of guessing cashflow
direction.

`services/collector-r2-importer/scripts/audit-sony-layer-b-r2.sh` is the
repeatable production canary. It starts a localhost-only Worker with a remote
read-only R2 binding, reuses the strict Layer A manifest/metadata/checksum and
inventory validator, invokes exactly one Layer B parser per financial artifact,
and returns aggregate counts and shape booleans only. The harness contains no
deploy, R2 write, or R2 delete path.

The SMBC Direct production canary invokes the same Layer-A run validator before
the parsers. On 2026-09-07 it scanned 189 objects and one successful manifest:
94 canonical normalized artifacts produced 1,069 transactions and one balance,
while all 94 raw partners were intentionally ignored by Layer B. It returned
aggregate counts only and performed no R2 write or delete.
Each normalized transaction artifact is bound to its manifest-relative monthly
range key. The current view selects the newest successfully parsed artifact for
that range by fetch time, so a late-imported stale run cannot replace newer
evidence and a newer empty statement removes older rows from the current view.

The V Point Pay Layer-B production canary invokes the exact Layer-A pair,
metadata, media-type, checksum, identity, and derivation validator before the
parser. It uses a localhost Worker backed by the existing remote read-only R2
binding, proves that mail has no parser route, and emits aggregate object and
observation counts only. It has no deploy, R2 write, or R2 delete path.
