# Read model

`packages/read-model` (`@kogane/read-model`) is the explicit read repository
of the production evidence browser (`services/app`). It replaces
the adapter that rewrote table names in SQL text with a regular expression and
stripped a trailing `LIMIT 501` before re-wrapping the query (design review
finding D04, PR-04). Nothing else changed: the API surface, response shapes,
limits and the snapshot policy are the ones the browser served before, and a
parity test proves it.

The package is pure TypeScript: no Cloudflare types, no database driver, no
HTTP. It exports an `ObservationReader` interface, the named SQL concepts every
query is built from, typed query inputs, explicit row → API contract mappers,
and `createD1ObservationReader(db)`. The evidence browser binds it to its D1
database in `src/observations.ts`; the local PoC keeps its own synchronous
SQLite queries in `experiments/observation-pipeline-local/src/queries.ts` and shares only the
snapshot CTE builder.

## The rule

**New reads go through the reader. No SQL string rewriting.** A route never
composes SQL and never names a table; it calls a reader method with a typed
input. A new query is a new method whose SQL names the sealed view it reads
and is added next to the others in `src/sql.ts`. If a query needs a relation
or predicate that does not exist yet, it gets a name in `src/concepts.ts`
first. Replacing identifiers inside a finished SQL string, in any form, is not
an acceptable way to change what a query reads.

The frozen copy of the old adapter in
`services/app/test/legacy-read-path.ts` exists only for the
parity test. Production code must not import it, and it must not be extended.

## Named concepts (`src/concepts.ts`)

The review asked for the several meanings of "current" and "visible" to be
named separately rather than pushed into one view. These are the names; each
is a complete SQL fragment that states the view it reads.

| Concept                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                        | SQL                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibleEvidence`            | What an authenticated reader may see at all: sealed runs of financial sources (not `kogane-synthetic`, not annotated `exclude_from_financial_views`), their artifacts, sources, raw objects.                                                                                                                                                                                                                                                   | `observation_fetch_runs`, `observation_fetch_artifacts`, `observation_sources` (migration 0017 over `financial_fetch_runs`, 0004); raw objects only through a visible artifact.                          |
| `visibleEvidence.parseRuns`  | Recorded parse results over visible artifacts: `ok` or `error`. A `pending` run is not a result and is never visible anywhere.                                                                                                                                                                                                                                                                                                                 | `parse_runs` joined to `observation_fetch_artifacts`, `status <> 'pending'`.                                                                                                                             |
| `successfulParses`           | The parser ran to completion.                                                                                                                                                                                                                                                                                                                                                                                                                  | `p.status = 'ok'`                                                                                                                                                                                        |
| `publishedParses`            | Adopted for normal display: the run named by the publication projection of its (artifact, parser), maintained by the pipeline writer in the transaction that marks a run `ok` (PR-05, `docs/publication-gate.md`). A successful run outside the projection is not current.                                                                                                                                                                     | `EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id)` (migration 0026)                                                                                             |
| `legacyPublishedParses`      | The rule readers used before the gate. Exported only so the consistency check and tests can compare against it; no query composes it (`tasks/_lib/publication-gate-predicates.test.ts`).                                                                                                                                                                                                                                                       | `p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'`                                                                                                                                               |
| `recordedParses`             | A result a reader may see at all, current or historical: published, replaced by a later publication (superseded), or failed. An unadopted successful run (a future candidate) is not visible anywhere, ids included. `visibleEvidence.parseRuns/observations` apply it.                                                                                                                                                                        | `p.status <> 'pending' AND (p.status = 'error' OR p.superseded_by_parse_run_id IS NOT NULL OR publishedParses)`                                                                                          |
| `successfulFetchRuns`        | The collector reported complete success with no failure evidence.                                                                                                                                                                                                                                                                                                                                                                              | `f.status = 'success' AND f.failure_count = 0`                                                                                                                                                           |
| `completeSnapshotCandidates` | Container datasets whose latest complete capture defines the current snapshot; an empty successful capture is a complete snapshot that means "nothing". A capture is complete only through published parses. Which parses are complete is decided per dataset by its `dataset_snapshot_policies` row (migration 0025): `coverage-v1` reads the stored claim, `legacy-warning-compat-v1` (seeded everywhere) the confined warning-text adapter. | `snapshotCtes({observation_fetch_artifacts, observation_fetch_runs, parse_runs, published_parse_runs})` from `packages/parsers/src/snapshot-query.ts`, plus the `CURRENT_SNAPSHOT` membership predicate. |
| `evidenceExists`             | D13 stage 1: a visible artifact whose raw object is reachable.                                                                                                                                                                                                                                                                                                                                                                                 | `EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = a.sha256)`                                                                                                                             |
| `unitParseable`              | D13 stage 2: the artifact may become observations. Scope `run` (the whole parent run succeeded) until `unit-independent-v1` names a `unit` scope; the Worker's `artifactSql` uses it.                                                                                                                                                                                                                                                          | `successfulFetchRuns`                                                                                                                                                                                    |
| `snapshotAdoptable`          | D13 stage 3: the parse is the current complete snapshot of its container under the dataset's active policy.                                                                                                                                                                                                                                                                                                                                    | `completeSnapshotCandidates`                                                                                                                                                                             |
| `economicallySummable`       | D13 stage 4: the measure may enter an economic total. No aggregation policy is published, so it is false for every row.                                                                                                                                                                                                                                                                                                                        | `0`                                                                                                                                                                                                      |
| `snapshotPolicyComparison`   | A03 shadow comparison: every container dataset under both policies, listing partitions whose current artifact differs. Identifiers only. Served by the observation-pipeline Worker.                                                                                                                                                                                                                                                            | `snapshotPolicyComparisonSql(SNAPSHOT_RELATIONS)`                                                                                                                                                        |
| `activeStateProjection`      | The rows a "current" list shows: a published parse of a successful visible fetch run, plus snapshot membership for snapshot datasets, plus per-source multi-page contracts stated per query.                                                                                                                                                                                                                                                   | `publishedParses AND successfulFetchRuns`; the chain `parse_runs p → observation_fetch_artifacts fa → observation_fetch_runs f`.                                                                         |
| parsing health (`/api/meta`) | A job-level notion, not a visibility rule: a failed job counts until a newer published parse of the same parser repairs it; retired versions are ignored.                                                                                                                                                                                                                                                                                      | `PARSING_HEALTH_SQL` over `observation_parse_jobs`, `published_parse_runs` and `parse_runs`.                                                                                                             |
| Identity eligibility         | `services/app/src/identity-api.ts` reads `eligible_identity_runs` (migration 0020) joined to the publication projection; the organization read moved here (`src/organization.ts`).                                                                                                                                                                                                                                                             | The identity catalogue queries stay in the browser over `published_parse_runs` (PR-05); the organization query is `organizationSql(mode)`.                                                               |
| Identity read mode           | `src/identity.ts`: `latest` joins the current mapping revisions; `as-recorded` joins the mapping rows the sealed identity run pinned. `interpretationContext` names the releases a response was computed under. See [decision-log.md](decision-log.md).                                                                                                                                                                                        | `MAPPING_RELATIONS[mode]`; the run's policy release comes from `identity_run_contexts` (migration 0029).                                                                                                 |

The snapshot CTE builder takes its relations as explicit parameters
(`SnapshotRelations`: artifacts, fetch runs, parse runs and the publication
projection, plus optional coverage-claim and policy tables). The PoC passes the
base tables and exports the same constant text as before (`SNAPSHOT_CTES`); the
read model passes the views (`SNAPSHOT_RELATIONS`).
That is construction with named inputs, not substitution on finished text.

## Queries (`src/sql.ts`)

Every method of `ObservationReader` and what it does. "Filter" is the typed
scope (`source`, `account`, `instrument`, `metric`, `from`/`to`, `q`,
`measureView`); each query declares which keys it accepts and refuses others.

| Method                  | Reads                                                                               | Current means                                                                 | Filter vs grouping                                                                                                                                                                             | Order                                               | Limit                               |
| ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `overview`              | every `visibleEvidence` relation, counted under the contract table names            | recorded (parse runs list includes failed and superseded)                     | none                                                                                                                                                                                           | fetch runs / parse runs by id desc                  | 501 each                            |
| `fetchRunCounts`        | `observation_fetch_runs` of the listed sources only (`SOURCE_FETCH_RUN_COUNTS_SQL`) | visible                                                                       | **Filter first, then group.** The listed sources are one bound JSON array applied before counting; one row per listed source with a run.                                                       | source id                                           | one row per listed source           |
| `parsingHealth`         | `observation_parse_jobs`, `parse_runs`; probes `observation_fetch_artifacts`        | job repaired by a newer published parse                                       | none                                                                                                                                                                                           | —                                                   | —                                   |
| `globalPassEmptyMonths` | the GLOBAL PASS snapshot CTEs, probing `transaction_observations` by run and month  | the month's current snapshot is empty and an older eligible snapshot had rows | none; a notice, not a visibility rule                                                                                                                                                          | source, month desc                                  | 100 months, plus one for truncation |
| `listTransactions`      | `transaction_observations` via `activeStateProjection`                              | published + successful run + per-source current page/container                | **Group first, then filter.** Duplicates within (source, account, parser family, external id) are ranked over the whole active set and rank 1 kept; the filter applies to that derived result. | `COALESCE(as_of,'') DESC, id DESC`                  | 501                                 |
| `listLatestBalances`    | `balance_observations` via `activeStateProjection` + `completeSnapshotCandidates`   | as above, plus current complete snapshot, MyJCB and V Point windows           | **Group first, then filter.** Latest witness per (source, parser family, unit, account, metric, instrument) is ranked over the whole active set; the filter applies after.                     | `source_id, source_account, metric, instrument, id` | 501, or 5001 for the candidate set  |
| `listBalanceHistory`    | `balance_observations` via `visibleEvidence.parseRuns`                              | recorded: failed, superseded and partial-run rows included, marked            | No grouping; filter, order, page.                                                                                                                                                              | `COALESCE(as_of, observed_at,'') DESC, id DESC`     | 501                                 |
| `listPositions`         | `position_observations` via `activeStateProjection` + snapshot membership           | published + successful run + current complete snapshot                        | No grouping; filter, order, page, then valuations are matched for the first 500 positions of the page.                                                                                         | `source_id, source_account, security_code, id`      | 501 positions; pairs bounded        |
| `listArtifacts`         | `observation_fetch_artifacts`; counts via `visibleEvidence.parseRuns`               | recorded (counts include failed and superseded parses)                        | Cursor and source inside the query.                                                                                                                                                            | `a.id DESC`                                         | 501                                 |
| `filterOptions`         | per kind; balances read recorded results so superseded rows stay filterable         | transactions/positions: active; balances: recorded, by measure view           | Distinct values; no paging.                                                                                                                                                                    | by source, account                                  | 5,000 bound                         |
| `getArtifact`           | `observation_fetch_artifacts` + reachable raw object + `observation_fetch_runs`     | recorded: every non-pending parse run of the artifact                         | —                                                                                                                                                                                              | parse runs by id                                    | 5,000 bound per list                |
| `getObservation`        | the observation table via `visibleEvidence.observations`                            | recorded: failed and superseded results are shown with provenance             | —                                                                                                                                                                                              | —                                                   | —                                   |
| `getRawDownload`        | `raw_objects` joined to `observation_fetch_artifacts`                               | reachable through a visible artifact                                          | —                                                                                                                                                                                              | lowest artifact id                                  | 1                                   |
| collection quality      | `src/collection-quality.ts`; see [Collection quality](#collection-quality)          | per cell, by the composed snapshot rules                                      | Cells per (dataset, parser, unit, period) of one source, ranked whole, then paged.                                                                                                             | dataset, unit, period desc, parser                  | 501 cells; 200 jobs and sources     |

### Limits

- Page queries fetch one row past the page (`LIMIT 501 OFFSET ?`) so the API
  can report truncation and the next offset without a count query.
- Grouping callers (`/api/balances`) ask for the complete candidate set
  (`LIMIT 5001`). Every list read is wrapped in `SELECT * FROM (...) LIMIT 5001`
  and refused when it returns more than 5,000 rows: the reader throws
  `ResultLimitExceededError`, which the evidence browser maps to
  `413 result_limit_exceeded`. A result is never silently cut to look complete.
- `/api/artifacts` walks an immutable descending id cursor; derived lists use
  deterministic total orderings (each ends in `id`) with an offset.

### Coverage run counts

`fetchRunCounts` is the `coverage` intent's `collectionRunCount`: each listed
source's exact number of visible fetch runs over its whole history. The
sources are applied before anything is counted, so a run of an unlisted
source is never read and cannot move a listed source's count. It replaced, for
that intent only, counting inside `overview`'s fetch-run list, which is the
newest 501 runs across every source and is unchanged for the operator
overview ([ADR 0047](adr/0047-mcp-client-connection.md)).

Cost, without table statistics (`test/source-run-counts.test.ts`, on
complete-CORE stores never analyzed): the plan searches
`idx_fetch_runs_source (source_id=?)` once per listed source and reaches each
run's seal, terminal report, session and exclusion by key; it scans no table,
builds no automatic index and sorts nothing. Rows read grow with the listed
sources' own run history; a whole-store scope reads every visible run once,
which `overview`'s own `COUNT(*)` of `fetch_runs` already does on each call.
The same file is the differential: on 8 random stores inside the window it
returns the window's count for every scope, and on 8 random stores and a
fixed one past it the exact count, unmoved by an unlisted source's runs.

### Raw download

`getRawDownload` re-checks, for the one requested hash and after the Access
authentication gate, that the raw object is reachable through a visible
artifact. It is independent of any list limit; the R2 read and the integrity
checks in `src/read.ts` are unchanged.

### Card snapshot currentness and current card usage

Which Vpass and MyJCB capture is current is defined once in `src/sql.ts`:
`MYJCB_LEDGER_SNAPSHOT_CTES` (`current_myjcb_snapshots`: the newest published
credit-ledger capture per connection, statement state and statement, the
payment month `myjcbStatementSlot` reads, where a pending capture is current
only while it is also the newest capture of its position,
[ADR 0016](adr/0016-myjcb-pending-statement-slots.md)) and
`VPASS_STATEMENT_SNAPSHOT_CTES` (`current_vpass_snapshots`: per card unit and
statement month, the newest fetch run whose statement pages all have an active
parse, whatever the family), with the membership predicates
`MYJCB_LEDGER_MEMBER` and `VPASS_SNAPSHOT_MEMBER`. `listTransactions` composes
them unchanged.

GLOBAL PASS activity pages follow the Vpass rule:
`GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES` (`current_global_pass_snapshots`) takes,
per source and month (the month in `activity-YYYY-MM.html` or
`activity-YYYY-MM-pN.html`), the newest fetch run whose activity pages of that
month all have an active parse, and every page of that run. A walked month is
one snapshot, so a page a newer run no longer shows is not current beside the
newer page 1 that shows its rows again. A run in which any page of the month
has no active parse (pending, or failed) is passed over for that month as a
whole: the month shows the newest earlier run whose pages all parsed, and
nothing at all while no run qualifies; the failed parse shows only in the
parsing health count and the artifact's parse history. With one page per month
and run, which every run stored before 2026-10-04 has, it selects exactly what
the earlier per-artifact-key ranking selected. `test/global-pass-snapshots.test.ts`
compares a frozen copy of that ranking on hand-built and random stores and on a
scaled store with the complete CORE schema and no table statistics, checks
walked months against an independently written model there, and checks the
Transactions plan: one pass over the artifacts for the eligible snapshots, as
the per-key ranking made, and the expected-page count and the current pages
reached by `idx_fetch_artifacts_run_role` (`fetch_run_id=?`), never by a scan
per month
([ADR 0026's amendment of 2026-10-04](adr/0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-walks-every-page-of-a-month)).
The rule does not look at row counts: since `global-pass-activity@1.2.0` an
empty month is an `ok` parse with no row, so a newer run's empty page is its
month's current snapshot and an older run's rows for that month stop being
current. That limit is pinned by a test of the same file
([ADR 0026's empty-month amendment](adr/0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-empty-months-are-read-as-no-rows)).
What changed on 2026-10-08 is that the case is no longer silent:
`GLOBAL_PASS_EMPTY_MONTH_NOTICE_SQL` (`globalPassEmptyMonths`, served on
`/api/meta` as `globalPassEmptyMonths` and shown as a notice by the web app)
composes the same CTEs verbatim and names every month whose current snapshot
carries no row while an older eligible snapshot of the same month had rows: the
current run, the newest older run with rows and how many older runs had rows.
It reads nothing into the lists and moves nothing: the newer empty page stays
current, the older rows stay out, and a person checks the provider. A month
that was only ever empty, a newer run that is not current (failed, or a page
unparsed) and an older capture that was never a whole snapshot are not
reported; rows are those of the published parse, so an older capture re-parsed
to no row does not count. Every current snapshot is probed once for a row (an
`EXISTS` that stops at the first) and only a month whose current snapshot has
none probes its older snapshots, each by run and month through
`idx_fetch_artifacts_run_role`; the plan makes the snapshot CTEs' one pass over
the artifacts and no other whole scan
(`test/global-pass-snapshots.test.ts`: hand-built cases, an independent model
on a scaled store with empty captures, and the plan check;
[ADR 0026's notice amendment](adr/0026-collector-unit-coverage.md#amendment-2026-10-08-global-pass-empty-months-that-supersede-rows-are-reported)).

`currentCardUsageSql({ afterId, limit })` (`src/card-usage.ts`) composes the
same CTEs for purchase recognition: every current Vpass and MyJCB usage row with
its recognition key (the `bank_key` shape of migration 0044), resolved account,
identity policy family, provider state and decimal-v1 amount. On top of the
snapshot it keeps the newest fetch run per (resolved account, source, slot),
where the slot is the Vpass statement month or the MyJCB state and statement
(a pending MyJCB row must also come from the account's newest run of its
position), and then the latest observation per key. Ranking runs over the whole current set
before the `observation_id > afterId` cursor and the `limit` (1 to 1,000)
apply. Two identical Vpass rows on different pages of one capture are two keys
and two rows: the parser numbers identical rows per page, and since
`vpass-statement-page@1.2.0` every page after the first names itself in the
external id ([observations](observations.md#vpass-json-statement-observations)).
A later page whose published parse is still 1.1.0 keeps its old id, and so can
still share a key with the first page, until the re-parse that follows the
release reaches it.

A row's `statement_period` is the provider label verbatim (Vpass
`statementMonth`; MyJCB `_kogane.period`, which may be the collector's
relative `detailMonth-N`), and `snapshot_fetched_at` is the capture time: for
MyJCB the ledger artifact's own `fetched_at`, since a MyJCB snapshot is one
artifact. The read model never resolves a relative label. The domain does,
from exactly these two columns (`cardStatementPeriod`, rule
`relative-statement-period-v1`,
[observations](observations.md#relative-period-labels-are-resolved-from-the-capture-time)),
so every reader interprets a label the same way and the stored evidence stays
as the provider showed it.

#### Cost

The processor now reuses an empty stale-key result through migration 0064's
latched retirement proof ([ADR 0037](adr/0037-reconciliation-purchase-cost.md)).
A clean unchanged tick reads one operational singleton instead of invoking
`staleCardPurchaseKeysSql`; changed or unfinished retirement work still runs
this exact query, and recognition still reads its own current-usage page.
The proof listens to the existing CORE source/visibility revision and every
remaining current-usage/live-key dependency, including low-id changes. Its
contract version and conditional clean write protect deployments and races.
`purchase-retirement-cost.test.ts` derives the full-schema dependency closure
from SQLite bytecode, exercises overlapping checks and retries, and measures
the clean primary-key path without table statistics. The historical query
measurements below concern the query when it is invoked, not the clean skip.

D1 never runs `ANALYZE`, so its planner has no table statistics. Measured on
that basis: every CORE migration from 0001, no `sqlite_stat*` table, on
`bun:sqlite` and on workerd's SQLite through Miniflare, over the synthetic store
of `test/card-usage-scale-fixture.ts` at `FULL_SCALE` (three Vpass cards and a
MyJCB connection, 24 statement months, 180 daily captures after 18 monthly
ones, 2–3 pages of 30–60 rows per card-month): 268,575 transaction
observations, 8,829 artifacts, 10,869 current rows, 6,517 live recognised
events. Median wall time of the shipped plan and of the current one on
`bun:sqlite`, and of the current one on workerd (— not measured):

| Read                                           | Shipped   | Now    | Now, workerd |
| ---------------------------------------------- | --------- | ------ | ------------ |
| `currentCardUsageSql`, first page of 500       | 584 ms    | 411 ms | 520 ms       |
| `currentCardUsageSql`, mid-cursor page of 500  | 559 ms    | 397 ms | —            |
| `staleCardPurchaseKeysSql(100)`                | 10,786 ms | 503 ms | 589 ms       |
| `unrecognizedCardUsageCountSql()`              | 597 ms    | 467 ms | 501 ms       |
| `queryCardPurchases`, first unfiltered page    | 723 ms    | 536 ms | 927 ms       |
| `queryCardPurchases`, first page of one period | 643 ms    | 463 ms | 546 ms       |

About 300 ms of the unfiltered page on workerd is its whole-filter selection
of all 6,517 live events crossing the D1 binding, not a card usage read.

Doubling the history (360 daily captures, 522,943 observations, the same
current rows) took the shipped first page from 584 to 791 ms and the current
one from 411 to 462 ms. The shipped plan started `current_rows` from every
fetch run's terminal report and walked every artifact, parse and observation of
every source before the snapshot filter; it now starts from `card_artifacts`,
the members of the current snapshots, and reaches the rest by key: through
`CROSS JOIN`s, the primary keys behind `observation_fetch_artifacts` and
`observation_fetch_runs`, `idx_parse_runs_artifact` and `idx_txn_obs_parse_run`;
through the unchanged left joins, the decimal-v1 primary key and, after
`current_rows`, `sqlite_autoindex_identity_observations_2`. The
stale-key read probed each live revision's keys once per current key (quadratic
in the live and current sets); it now names the revisions holding a current key
once, through `card_purchase_recognition_keys_key`. No index was added: a
partial index on the two card datasets saved about 10 ms. What still grows with
history is the snapshot step shared with the Transactions page, which reads
every artifact once per call (about 50 ms here, nearly all of it the 4,869 Vpass
statement pages; 40,000 unrelated artifacts added 4 ms); the rest grows with the
current rows, ranked whole before the cursor by design. `card-usage-scale.test.ts`
compares every read with the shipped text (`card-usage-legacy-sql.ts`) on a
smaller store and fails on a plan that scans observations, parses, runs, reports
or identity rows whole; `KOGANE_CARD_USAGE_SCALE=full` builds this store and
prints the timings. `card-usage-differential.test.ts` makes the same comparison
on small random stores that draw every state the shipped reads handle, and
every scenario of `card-usage.test.ts` and `card-purchase-keys.test.ts` runs
both texts. The MyJCB currentness rules changed on purpose after the text was
frozen ([ADR 0007](adr/0007-myjcb-statement-identity.md),
[ADR 0016](adr/0016-myjcb-pending-statement-slots.md)), so the row comparisons
run the shipped text with those rules substituted and its plan untouched
(`STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL`, the rules restated as NOT EXISTS
and GROUP BY rather than window functions), and the random stores draw pending and
confirmed captures at positions 0 and 1 so that the substituted rules decide
rows; the plan checks run the unmodified shipped text. This proves the plan
rewrite and the rule change separately: the rewrite returns what the shipped
plan returns under the intended rules, not the shipped rows byte for byte.

## Parity proof

`services/app/test/read-model-parity.test.ts` seeds one
synthetic D1 fixture through the ingest Worker with: an unsealed run, a
pending parse, a failed parse, a superseded parse, a `kogane-synthetic` run,
an excluded run whose raw object is therefore unreachable, one raw object
referenced by two runs, a partial (non-success) sealed run, an empty successful
snapshot after a complete one (balances and positions), and source text that
contains `parse_runs` and `fetch_artifacts`. It runs the frozen legacy adapter
and the new reader for every list and detail read with every accepted filter,
asserts identical result sets and order, and asserts each result against an
independently written expected set. A second case seeds 5,001 balances and
positions and checks that both paths refuse the candidate set with 413 and
page positions identically.

`packages/read-model/test/read-model.test.ts` applies the production
migrations to an in-memory SQLite, runs every read through a plain SQLite
executor (proving the reader is not tied to D1), and checks that every SQL
text names a sealed `observation_*` view, contains no bare Layer A table,
excludes pending parses wherever recorded results are shown, applies the
filter after ranking and before paging, and treats source data that looks like
SQL as a bound argument.

## Deploy order and rollback

PR-04 had no migration and no writer change. Since PR-05 the reader depends
on migration 0026 (`published_parse_runs`) and on the observation-pipeline
writer that maintains it, and since A03 on migration 0025
(`dataset_snapshot_policies`, `parse_coverage_claims`; see
`docs/parser-coverage.md`); the order is schema → writer → reader and the
rollback rules are in `docs/publication-gate.md`. `packages/read-model` is
vendored by relative import, so there is no separate artifact to publish.

Verified locally with synthetic data: the CI checks (today
`mise run //<workspace>:ci`) of `packages/read-model`, `services/app`,
`experiments/observation-pipeline-local`, and the repository-wide guards (`mise run ci:root`). Not verified: production data.

## Balance projection reader

`src/balance-projection.ts`, `src/balance-projection-sql.ts`,
`src/balance-projection-reader.ts` and `src/authority.ts` add the latest-balance
read model of design review D10/D11. The pure builder produces the rows of one
snapshot; `BalanceProjectionReader` is the named reader over them, with the
same rule as the rest of this package — a route calls a method with a typed
input and never sees a table name or composes SQL.

The reader's queries are one keyed range scan of
`current_balance_projection_order` per page, plus a coverage roll-up and an
exact-arithmetic subtotal over the filter scope. `legacyLatestPage` serves the
v1 `/api/balances` window from the same rows in the same order, which is what
the compatibility adapter uses. See
[Balance read model](balance-read-model.md) for the contract.

## Collection quality

`src/collection-quality.ts` ([ADR 0045](adr/0045-collection-quality-read.md))
holds the SQL behind `GET /api/collection-quality` and
`GET /api/collection-quality/<sourceId>`; `packages/application/src/query/collection-quality.ts`
maps its rows to the contract and the closed reason codes. It is not an
`ObservationReader` method: like the dated reads it is composed by an
application query over an executor.

| Text                       | Reads                                                                                                                                                        | Bound                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `SCHEDULE_QUALITY_SQL`     | every `collection_schedules` row, its newest receipt by `nominal_at` (the unique index) and its held lease                                                   | 201 rows; more is refused                                |
| `TERMINAL_QUALITY_SQL`     | the `collection_runs` rows of exactly the (collector, run id) pairs a receipt names, with the newest `registered` stage and the visible fetch run            | the pairs given                                          |
| `UNREGISTERED_QUALITY_SQL` | never-registered terminals of the given collectors, once per run by its newest row, grouped by code                                                          | every row of those sources, by index; grows with history |
| `SOURCE_QUALITY_SQL`       | every visible source and its newest visible fetch run, read by id                                                                                            | 201 rows; more is refused                                |
| `CELL_QUALITY_SQL`         | one source's visible artifacts named by a dataset, a job or a recorded parse; their jobs, parses, publications, claims and unit outcomes; current membership | 501 cells from an offset                                 |

A cell is (dataset, parser, fetch unit, period, MyJCB statement state,
currentness rule). Its newest capture is its newest fetch run by capture time;
its current capture is the newest fetch run with a member of the current set,
decided by `current_global_pass_snapshots`, `current_vpass_snapshots`
(`VPASS_SNAPSHOT_MEMBER`), `current_myjcb_snapshots` (`MYJCB_LEDGER_MEMBER`),
or `activeStateProjection` with `completeSnapshotCandidates.currentMember`. The
CTE texts are composed unchanged; `GLOBAL_PASS_MONTH` and
`VPASS_STATEMENT_MONTH` are exported from `src/sql.ts` so the cell's period is
the expression the snapshot partitions on. The parsers whose current set a
read narrows further (`UNCOMPOSED_QUERY_RULE_PARSERS`) carry
`query_rule_not_composed`. A capture no job or parse names is its own cell,
shown only while it is newer than every parsed capture of its slot. The read
counts no observation, so an empty current capture is `current` like any
other; the GLOBAL PASS months where such a capture supersedes an older one
with rows are named by `globalPassEmptyMonths` (the Queries table), not by
this read. A
`container-snapshot` cell is current in the sense of the Balances and
Positions reads: the Transactions read applies no snapshot selection, so the
transactions a snapshot parser also emits
(`sbi-shinsei-top-balances-and-activity`) stay listed from a capture this read
calls not current.

### Cost

D1 has no table statistics. `test/collection-quality.test.ts` checks every plan
on a complete-CORE store with none: the summary reads are keyed by job, run
and source. `UNREGISTERED_QUALITY_SQL` reads every `collection_runs` row of
each visible collector source on each call through `collection_runs_run
(source)`, so it grows with the terminal history (measured once in review on a
loaded machine with every row never registered, the worst case: about 20 ms at
4,000 rows, 200 ms at 16,000; not asserted). The cell read reaches the source's artifacts by
`idx_fetch_artifacts_source_dataset_time (source_id=?)`, its runs by
`idx_fetch_runs_source` and their units by `idx_fetch_units_run`, and every
job, parse, publication, claim and unit report by key; no observation table is
read. Its only whole-store passes are inside the composed snapshot CTEs, the
passes the Transactions, Balances and Positions reads already make, and each is
evaluated once (an `IN` list materialized once, or an automatic index built
once), never per row. A per-source CTE is reached only from a cell of its
dataset: measured once on `bun:sqlite`, a Sony Bank page took the same time
with 0 or 2,000 GLOBAL PASS pages in the store (not asserted). On the test's
scaled store (90 daily captures of four sources) one source's cells take
roughly 10 to 50 ms on `bun:sqlite`; not measured on workerd or D1.
