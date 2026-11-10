<a id="sbi証券-read-only-worker-poc"></a>

# `SBI証券` (SBI Securities) read-only Worker PoC

This independent Worker creates a fresh session from a stored `SBI証券` passkey on every run, captures domestic/US stock balances and history through official Web/app communications, and saves them to shared DATA (`kogane-raw-evidence`). It uses `mnie` as neither a runtime dependency, submodule nor configuration source. Only the necessary authentication, decryption and read-only communications were ported into this directory.

## Runtime profile

- **Browser: none.** No Cloudflare Browser Run, Container Chrome/Chromium or external browser session.
- WebAuthn challenges/assertions, SSO callbacks and MTS/foreign-securities/main-site sessions are handled directly with Worker cryptography and `fetch`.
- HTML endpoints are also captured/parsed as read-only HTTP responses, without browser rendering.

<a id="現在の範囲"></a>

## Current scope

- Domestic-stock app: domestic cash equities/custody-cash payload through an MTS session and read-only TR code `F2631`.
- Main site: current and available weekly `My資産` ("My assets") valuations, yen deposit/withdrawal details and domestic-stock execution history from January 1 of year minus two, split into windows of at most 90 days as in the successful historical scan. Yen details retain every provider page-metadata field and response field in a page bundle, validating completeness before making an artifact.
- Foreign-stock app: US cash equities, USD custody cash and retained execution history in windows of at most 90 days. The historically observed mobile BFF duration query supplies `pastYears`; the successful historical scan began January 1 of year minus `pastYears`, rather than at the web rolling cutoff.
- Execution: the Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) for the `sbi-securities` job in [`config/alarm-jobs.json`](../../config/alarm-jobs.json), daily at 06:00 JST (21:00 UTC), and an accepted operations request calls `runOperation` (ADR 0048). Either one collects domestic/foreign data serially in one invocation (`scope=all`). The Worker has no Cron Trigger and no public trigger route.
- Storage: `packages/collection` writes directly to shared DATA; the Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). The only D1 the collector uses is the execution lease (`withCollectionLease`) in `SCHEDULE_DB` (`kogane-raw-evidence`).

Neither implementation nor configuration includes orders, amendments, cancellations, trading passwords or device registration. Even for `POST`, allowed hosts, paths, MTS TR codes and GraphQL operations are fixed to read-only purposes.

<a id="公開接続先とsecret"></a>

## Public endpoints and secrets

The following public endpoints used by official clients are fixed in source.

- passkey: `https://login.sbisec.co.jp/login/entry`
- Domestic MTS: `https://apli.sbisec.co.jp`
- Foreign securities: `https://fstockapp.sbisec.co.jp`
- Main site: `https://www.sbisec.co.jp`

There are only 2 Worker secrets.

- `SBI_CREDENTIAL_JSON`: JSON containing only `rpId`, `origin`, `credentialId`, `keyValue`, optional `userHandle` and `counter`.
- `SBI_HANDSHAKE_KEY_JSON`: an RSA-4096 transport key decrypting temporary tokens returned by SBI. It is not an account-authentication key and is generated locally once.

Neither the central raw-evidence bearer nor a storage-fingerprint key is placed in the collector. The old dedicated source bucket, Service Binding to `kogane-collector-r2-importer` and `scripts/backfill-raw-evidence.sh` were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

The whole Bitwarden item, login ID/password, trading password, master password and vault export stay outside the Worker. This PoC copies the SBI passkey private key into a Cloudflare secret, so it is treated as stronger than an ordinary password. The transport key is neither an account-authentication nor session key: generate it once and reuse it across runs. Sessions and passkey assertions are recreated on every run.

Sync only required fields from an already-created local SBI-specific Bitwarden item JSON to Cloudflare. The `SBI_HANDSHAKE_KEY_JSON` transport key is generated only on first use, as `sbi-worker-handshake-key.json` in the same Git-excluded secret directory (`scripts/generate-handshake-key.ts`).

```sh
scripts/sync-local-secrets.sh \
  ~/.local/share/kogane/secrets/sbi-securities.json
```

This script prints no secret values to stdout. Changing the SBI password needs no resync if the passkey is unchanged; rerun it only after re-registering/deleting the passkey.

<a id="実行と保存形式"></a>

## Execution and storage format

```sh
mise run install                                    # from the repository root
mise run //services/collector-sbi-securities:test
mise run //services/collector-sbi-securities:ci
mise run //services/collector-sbi-securities:dry-run
```

Public `/trigger`, scope/arbitrary-period selection, old `scripts/trigger.sh` and 90-day split `scripts/backfill.sh` are retired. The existing private RPC runs normal all-scope collection, including the retained execution-history walk. No window parameter, new authentication path or scope override is added.

```text
objects/<2 hex>/<sha256>                       content-addressed object per artifact
runs/sbi-securities/<run-id>/terminal.json     run completion record written last (artifact key/object mapping)
```

The terminal records the period, success/partial success/failure, artifact hashes/byte sizes, machine-readable failure codes with secrets removed, and nothing for access tokens, SIDs, cookies, MTS session headers or account numbers.

Execution windows are newest first and disjoint, with at most thirteen per scope.
The newest ordinary 90-day request keeps `<scope>-trade-records.json`; older
requests use `<scope>-trade-records-<from>-<to>.json`. Each carries its own
requested range in the terminal and, under `terminal-registration-v4` and later, its
CORE artifact descriptor. Equal empty bodies may share a content-addressed
object while their separate requested windows remain registered evidence.
Foreign retention is the historically observed read-only `GetSearchingDuration`
query on `/graphql/bff`, using the existing authenticated mobile session.
Only the observed `pastYears=2` response is supported, and its default-period
date fields are not substituted for the January-start scan. The execution
query and all row identity calculations stay unchanged. No progress cursor or
state is stored. This request and bound have historical provenance, but no
new live-mobile verification has been performed; a scheduled run still has
to establish the current contract. The fresh web observations describe a
different surface and do not set this mobile bound.

A failed window preserves the other windows but makes its scope incomplete
with a closed code. If foreign retention discovery fails, the foreign scope
keeps the old 90-day request as partial evidence and names
`sbi_foreign_history_retention_unavailable`. Missing foreign pagination flags,
the 20-page bound and a domestic result reaching the unwalked 200-row cap
also fail closed. A domestic empty window needs both its search form and the
observed fixed empty-result message. All six returned domestic date controls
must retain the requested range; a server clamp or cleared value is partial,
not proof of that earlier window. Publication, complete retention counts
and the 13-minute holder limit still require a scheduled production run to
verify ([ADR 0096](../../docs/adr/0096-sbi-scheduled-execution-history.md)).

`yen-detail-history.json` and `foreign-cash-history.json` use
`sbi-retained-cash-history-v1`. Every main-site run selects the observed two-year
yen / five-year foreign preset through JST today, independently of execution
window arguments. `GET /banking/api/yen/detail/query` walks every declared page
with observed size 10, all directions/details and descending dates. The foreign
statement uses `GET /banking/api/fc/detail-history/search`, all trade kinds and
the observed USD filter `currencyCode=011`, with the same page size and descending sort. Only USD code `011`
is supported; other currencies and an unobserved foreign second page stop
with a closed failure code.

After original-JSON, duplicate-key, exact-number and closed-field audits, each
raw page is retained as `<dataset>-page-NNNN-source.json`. The derived bundle
names all raw inputs; shared persistence checks its exhaustive inventory.
Both statements belong to the domestic main-site unit. Bounds are 2,000 pages /
20,000 rows. Page metadata, each page's expected rows, total rows, descending
calendar dates and requested-range membership are checked, as are known codes,
unsigned exact amounts and duplicate yen `did`. Yen deposit/payment counts and
domain exact sums must match the unchanged controls. Positive transfer controls
remain unsupported until their semantics are observed. Unknown fields/private
error envelopes are rejected before storage; coverage failures retain audited
financial evidence and keep the unit partial.

Registration v7 maps only the new USD derivative and attaches cash requested
ranges; earlier mappings stay frozen and raw pages remain unparsed. The yen
parser retains legacy single-page/v1 bundles and stable provider ids. USD uses
normalized row fingerprints with occurrence ordinals, preserving identical
receipts and stable ids across full-range runs; the production reader selects
one witnessed revision per id. These are settlement-cash observations, never
a second income publication. Catalogue status remains partial under #1226 until
foreign continuation/transfer semantics and scheduled publication, retained
coverage, freshness and the 13-minute execution budget are verified
([ADR 0102](../../docs/adr/0102-sbi-retained-cash-history.md)).

Stored runs in the old dedicated source bucket were copied to central DATA and verified on 2026-09-13; no outbox remains to resend ([legacy-retirement.md](../../docs/legacy-retirement.md)).

<a id="workers-paidでの定期実行"></a>

## Periodic execution on Workers Paid

Free-plan measurements succeeded for separate `scope=foreign` and `scope=domestic` calls, but running both in the same invocation produced Cloudflare Error 1102. Queue splitting did not resolve the Free CPU limit either, so calling separate scope-specific HTTP requests from an external scheduler was temporarily evaluated.

After the move to Workers Paid on 2026-08-27, periodic execution was unified under the Worker's Cloudflare Cron Trigger. Daily 21:00 UTC `scheduled()` directly ran `scope=all`, collecting domestic and foreign data serially in the same invocation. Daily Cron intervals exceed 1 hour, so Cloudflare limits at that time allowed up to 15 minutes CPU time and 15 minutes wall time, sufficient for measured foreign collection (about 7 seconds) and domestic collection (about 15 seconds). Since #430 the Cron Trigger is gone (`triggers.crons` is empty): the Processor alarm calls `runScheduled` instead, which still runs `scope=all` in one invocation (`alarmCollection`, `src/worker.ts`).

No Queue, dispatcher or GitHub Actions schedule is used. D1 is used only for the execution lease (`SCHEDULE_DB`). A Queue is added only if retries or scope-specific failure isolation actually become necessary, not merely because the plan became Paid. Public manual/backfill entrypoints are retired; normal collection retains its private RPC.

<a id="出典"></a>

## Sources

Some protocol understanding and the first implementation were based on `pnsk-lab/mnie` commit `c87e65c0a04c03c560962f8ead6e77415fb841f4`. Kogane code was independently rewritten for Cloudflare Workers, removing filesystem, OpenSSL-process, Mnie-session-type and order-API dependencies. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for license attribution.

Weekly asset history is requested once through the existing main-site session
at `/account/api/assets/valuations`, without a period parameter. The closed
shape audit precedes exact-byte storage as unmapped
`account-assets-history-source.json`. A derived inventory records every expected
calendar-year shard/hash/count with the raw hash, GET path and capture time.
`account-assets-history-<year>.json` retains at most 53 weeks, keeping long
histories under the existing 2 MiB parser-output limit. Each shard's input
lineage names source and inventory. Missing or altered inventory members make
the domestic unit/run partial; available evidence remains stored. Registration
v5 names only yearly shards as the new dataset and freezes v1–v4 mappings. Each successful
main-site capture is retained immediately, so a later yen/history failure
keeps these bytes while the run stays partial under the existing policy.

Whole-source calendar, native-series and exact-total validation runs before
any yearly filtering. Before auditing or normalizing numbers, the JSON reader
validates original syntax and per-object decoded-key uniqueness within fixed
byte/depth/token budgets. Duplicate keys (including escaped aliases) and
malformed numeric fragments are rejected before any raw capture is stored.
The JSON reader then proves financial numeric tokens are
exact safe integers before Number conversion. Inexact or inconsistent
financial-shaped responses keep their exact audited raw bytes but produce no
derivatives and leave collection partial. The closed shape/secret-field audit
still refuses unexpected fields or login payloads before storage. Rates stay
finite metadata, outside the three monetary metrics.

The parser emits available weekly profiles and listed categories plus ALL,
corroborates ALL with native tuples and exact category sums, and preserves
unlisted residual rows. Null metrics/views never become zero facts. The
production observation reader selects one latest revision per portfolio point,
keeps older witnessed weeks absent from a shorter response, and separates
aggregate/profile alternatives. No new UI, public trigger or read operation is
added. The catalogue remains partial: the observed 44 points do not establish
August 2021 coverage, the two iDeCo profiles were unavailable, and a scheduled
production collection/publication is still required ([ADR 0098](../../docs/adr/0098-sbi-weekly-asset-history.md)).

## Reported income and realised gains

Normal domestic main-site collection also reads the observed My Assets income
and domestic realised-gain routes from `2021/08/01` through the current JST
date. These five GETs use the observed first-page `offset=1&limit=30`, existing
cookies and referer; no collection window, cursor or login is added. Summary
counts, category counts and row counts must agree. More than 30 rows, unknown
products/accounts/currencies or a missing source makes the domestic unit/run
partial. Unobserved continuation requests are never guessed.

Exact summary/row bytes stay in unmapped private `provider_response` artifacts.
Only closed financial schemas reach that storage; duplicate-key secrets,
unknown fields and malformed syntax are refused. The existing bounded stream
reader limits each response to 256 KiB before full buffering. Numeric tokens
are preserved and checked with exact decimal arithmetic before financial
conversion. Financial-shaped precision failures retain raw evidence without a
derived artifact. Canonical `income-payments.json` / `realised-gains.json`
embed the original source texts, their requested range and exhaustive ordered
source lineage. Persistence rechecks every source hash and derivative.

Payments publish gross/tax/net metrics in original currency: JPY for domestic
stock, USD `Lc` for US stock. Yen equivalents are metadata, never second income
payments. Domestic sale metrics are provider-reported proceeds, pre-tax gain,
unit price and average acquisition **unit** cost. No cash/trade row or economic
event is emitted. Null metrics stay unavailable; all metrics have explicit
typed non-additive semantics.

Registration v9 freezes v1–v8 and maps only the new derivatives. Migration
0093 uses complete-container snapshot membership: a newer fully counted
since-2021 response replaces old payment/sale identities, including corrections
and removals, while every original/observation remains archived. Partial runs
keep the preceding current snapshot. The internal production
`ObservationReader.listSbiIncomeHistory` reads that membership before filtering
and paging. It adds no UI, HTTP route or MCP operation.

The catalogue stays partial. Other products, foreign gains, continuation beyond
30 and scheduled production coverage/publication remain unproved
([ADR 0106](../../docs/adr/0106-sbi-reported-income-and-gains.md)).
