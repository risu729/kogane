# Read model

`packages/read-model` (`@kogane/read-model`) is the explicit read repository
of the production evidence browser (`services/evidence-browser`). It replaces
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
SQLite queries in `poc/observation-pipeline/src/queries.ts` and shares only the
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
`services/evidence-browser/test/legacy-read-path.ts` exists only for the
parity test. Production code must not import it, and it must not be extended.

## Named concepts (`src/concepts.ts`)

The review asked for the several meanings of "current" and "visible" to be
named separately rather than pushed into one view. These are the names; each
is a complete SQL fragment that states the view it reads.

| Concept                      | Meaning                                                                                                                                                                                                                                                                    | SQL                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibleEvidence`            | What an authenticated reader may see at all: sealed runs of financial sources (not `kogane-synthetic`, not annotated `exclude_from_financial_views`), their artifacts, sources, raw objects.                                                                               | `observation_fetch_runs`, `observation_fetch_artifacts`, `observation_sources` (migration 0017 over `financial_fetch_runs`, 0004); raw objects only through a visible artifact.                                  |
| `visibleEvidence.parseRuns`  | Recorded parse results over visible artifacts: `ok` or `error`. A `pending` run is not a result and is never visible anywhere.                                                                                                                                             | `parse_runs` joined to `observation_fetch_artifacts`, `status <> 'pending'`.                                                                                                                                     |
| `successfulParses`           | The parser ran to completion.                                                                                                                                                                                                                                              | `p.status = 'ok'`                                                                                                                                                                                                |
| `publishedParses`            | Adopted for normal display: the run named by the publication projection of its (artifact, parser), maintained by the pipeline writer in the transaction that marks a run `ok` (PR-05, `docs/publication-gate.md`). A successful run outside the projection is not current. | `EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id)` (migration 0026)                                                                                                     |
| `legacyPublishedParses`      | The rule readers used before the gate. Exported only so the consistency check and tests can compare against it; no query composes it (`scripts/publication-gate-predicates.test.ts`).                                                                                      | `p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'`                                                                                                                                                       |
| `recordedParses`             | A result a reader may see at all, current or historical: published, replaced by a later publication (superseded), or failed. An unadopted successful run (a future candidate) is not visible anywhere, ids included. `visibleEvidence.parseRuns/observations` apply it.    | `p.status <> 'pending' AND (p.status = 'error' OR p.superseded_by_parse_run_id IS NOT NULL OR publishedParses)`                                                                                                  |
| `successfulFetchRuns`        | The collector reported complete success with no failure evidence.                                                                                                                                                                                                          | `f.status = 'success' AND f.failure_count = 0`                                                                                                                                                                   |
| `completeSnapshotCandidates` | Container datasets whose latest complete capture defines the current snapshot; an empty successful capture is a complete snapshot that means "nothing". A capture is complete only through published parses.                                                               | `snapshotCtes({observation_fetch_artifacts, observation_fetch_runs, parse_runs, published_parse_runs})` from `poc/observation-pipeline/src/snapshot-query.ts`, plus the `CURRENT_SNAPSHOT` membership predicate. |
| `activeStateProjection`      | The rows a "current" list shows: a published parse of a successful visible fetch run, plus snapshot membership for snapshot datasets, plus per-source multi-page contracts stated per query.                                                                               | `publishedParses AND successfulFetchRuns`; the chain `parse_runs p → observation_fetch_artifacts fa → observation_fetch_runs f`.                                                                                 |
| parsing health (`/api/meta`) | A job-level notion, not a visibility rule: a failed job counts until a newer published parse of the same parser repairs it; retired versions are ignored.                                                                                                                  | `PARSING_HEALTH_SQL` over `observation_parse_jobs`, `published_parse_runs` and `parse_runs`.                                                                                                                     |
| Identity eligibility         | `services/evidence-browser/src/identity-api.ts` reads `eligible_identity_runs` (migration 0020) joined to the publication projection; the organization read moved here (`src/organization.ts`).                                                                            | The identity catalogue queries stay in the browser over `published_parse_runs` (PR-05); the organization query is `organizationSql(mode)`.                                                                       |
| Identity read mode           | `src/identity.ts`: `latest` joins the current mapping revisions; `as-recorded` joins the mapping rows the sealed identity run pinned. `interpretationContext` names the releases a response was computed under. See [decision-log.md](decision-log.md).                    | `MAPPING_RELATIONS[mode]`; the run's policy release comes from `identity_run_contexts` (migration 0029).                                                                                                         |

The snapshot CTE builder takes its three relations as explicit parameters
(`SnapshotRelations`). The PoC passes the base tables and exports the same
constant text as before (`SNAPSHOT_CTES`); the read model passes the views.
That is construction with named inputs, not substitution on finished text.

## Queries (`src/sql.ts`)

Every method of `ObservationReader` and what it does. "Filter" is the typed
scope (`source`, `account`, `instrument`, `metric`, `from`/`to`, `q`,
`measureView`); each query declares which keys it accepts and refuses others.

| Method               | Reads                                                                             | Current means                                                       | Filter vs grouping                                                                                                                                                                             | Order                                               | Limit                              |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `overview`           | every `visibleEvidence` relation, counted under the contract table names          | recorded (parse runs list includes failed and superseded)           | none                                                                                                                                                                                           | fetch runs / parse runs by id desc                  | 501 each                           |
| `parsingHealth`      | `observation_parse_jobs`, `parse_runs`; probes `observation_fetch_artifacts`      | job repaired by a newer published parse                             | none                                                                                                                                                                                           | —                                                   | —                                  |
| `listTransactions`   | `transaction_observations` via `activeStateProjection`                            | published + successful run + per-source current page/container      | **Group first, then filter.** Duplicates within (source, account, parser family, external id) are ranked over the whole active set and rank 1 kept; the filter applies to that derived result. | `COALESCE(as_of,'') DESC, id DESC`                  | 501                                |
| `listLatestBalances` | `balance_observations` via `activeStateProjection` + `completeSnapshotCandidates` | as above, plus current complete snapshot, MyJCB and V Point windows | **Group first, then filter.** Latest witness per (source, parser family, unit, account, metric, instrument) is ranked over the whole active set; the filter applies after.                     | `source_id, source_account, metric, instrument, id` | 501, or 5001 for the candidate set |
| `listBalanceHistory` | `balance_observations` via `visibleEvidence.parseRuns`                            | recorded: failed, superseded and partial-run rows included, marked  | No grouping; filter, order, page.                                                                                                                                                              | `COALESCE(as_of, observed_at,'') DESC, id DESC`     | 501                                |
| `listPositions`      | `position_observations` via `activeStateProjection` + snapshot membership         | published + successful run + current complete snapshot              | No grouping; filter, order, page, then valuations are matched for the first 500 positions of the page.                                                                                         | `source_id, source_account, security_code, id`      | 501 positions; pairs bounded       |
| `listArtifacts`      | `observation_fetch_artifacts`; counts via `visibleEvidence.parseRuns`             | recorded (counts include failed and superseded parses)              | Cursor and source inside the query.                                                                                                                                                            | `a.id DESC`                                         | 501                                |
| `filterOptions`      | per kind; balances read recorded results so superseded rows stay filterable       | transactions/positions: active; balances: recorded, by measure view | Distinct values; no paging.                                                                                                                                                                    | by source, account                                  | 5,000 bound                        |
| `getArtifact`        | `observation_fetch_artifacts` + reachable raw object + `observation_fetch_runs`   | recorded: every non-pending parse run of the artifact               | —                                                                                                                                                                                              | parse runs by id                                    | 5,000 bound per list               |
| `getObservation`     | the observation table via `visibleEvidence.observations`                          | recorded: failed and superseded results are shown with provenance   | —                                                                                                                                                                                              | —                                                   | —                                  |
| `getRawDownload`     | `raw_objects` joined to `observation_fetch_artifacts`                             | reachable through a visible artifact                                | —                                                                                                                                                                                              | lowest artifact id                                  | 1                                  |

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

### Raw download

`getRawDownload` re-checks, for the one requested hash and after the Access
authentication gate, that the raw object is reachable through a visible
artifact. It is independent of any list limit; the R2 read and the integrity
checks in `src/read.ts` are unchanged.

## Parity proof

`services/evidence-browser/test/read-model-parity.test.ts` seeds one
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
writer that maintains it; the order is schema → writer → reader and the
rollback rules are in `docs/publication-gate.md`. `packages/read-model` is
vendored by relative import, so there is no separate artifact to publish.

Verified locally with synthetic data: `bun run scripts/ci-package.ts` for
`packages/read-model`, `services/evidence-browser`, `poc/observation-pipeline`,
and the standalone CI inventory. Not verified: production data.
