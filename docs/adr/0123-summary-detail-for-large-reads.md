# ADR 0123: The balance, schedule and collection quality reads answer a summary by default, and a refused cursor names what must repeat

- Status: proposed. **Owner approval is needed before merge**: it changes the
  published input schema and the default answer of three MCP tools and of
  their HTTP routes (decisions D2 and D3 of the 2026-11-19 proposal for
  [issue 1414](https://github.com/risu729/kogane/issues/1414)). The owner
  asked for a compact default on issue 1414; this ADR implements the
  proposal's recommended D2 (the routes' default is the summary too, and the
  web UI asks for `full`), which the owner decides before merge.
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414)
  (points 1, "Responses are huge and get truncated", and 2, "Paging is
  fragile")
- Carried by: `packages/application/src/query/read-detail.ts`,
  `packages/application/src/query/collection-quality-detail.ts`,
  `scheduleSnapshotSummary` in `packages/collection/src/schedule-model.ts`,
  `services/app/src/balances-v2.ts`, `services/app/src/schedules-api.ts`,
  `services/app/src/collection-quality-api.ts`,
  `services/app/src/page-read-tools.ts`, `services/app/src/rewards-read.ts`,
  `services/app/src/http.ts`
- Builds on: [ADR 0081](0081-ui-parity-through-mcp.md) (a route and its MCP
  read are two adapters over one reader),
  [ADR 0119](0119-cursor-page-size.md) (a cursor continues at another offered
  page size), [ADR 0088](0088-collection-quality-per-account.md) (the
  collection quality account view), [ADR 0045](0045-collection-quality-read.md)
- Related: [agent API: UI read pages](../agent-api.md#ui-read-pages),
  [balance read model](../balance-read-model.md#cursor-contract)

## Context

An MCP client shows the first 8 KB of a tool result. On 2026-11-19 the owner
recorded (issue 1414) that `kogane.balances.read` (`latest`, one source, 50
rows) answered about 160 KB, `kogane.schedules.read` about 95 KB and
`kogane.collection-quality.read` without a source about 30 KB, so every
answer had to be saved and re-parsed by a script. Each balance row repeats its
full organization, product, instruments, interpretation, quantity, metric and
adoption evidence.

Measured on a synthetic store at that scale (`test/realistic-store.ts`: 120
balances on 12 accounts of 4 sources, each organized with a Japanese label and
a 64-hex account entity id; ten days of occurrences for every collection job
the migrations configure; every value invented), as the bytes of the MCP
result's structured content (`test/mcp-answer-size.test.ts`, run with
`--silent=false`):

| Tool and arguments                                                                                                                                                                                                                                                                                | Before (default) | After (default `summary`) | After, `detail: full` |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------: | ------------------------: | --------------------: |
| `kogane.balances.read` `{collection: latest}` (100 rows before, 10 after)                                                                                                                                                                                                                         |          297,410 |                     4,112 |               297,410 |
| `kogane.balances.read` `{collection: latest, limit: 50}`                                                                                                                                                                                                                                          |          148,821 |                         — |                     — |
| `kogane.balances.read` `{collection: history}`                                                                                                                                                                                                                                                    |          281,410 |                     3,528 |               281,410 |
| `kogane.schedules.read` `{}`                                                                                                                                                                                                                                                                      |           75,585 |                     4,955 |                75,585 |
| `kogane.collection-quality.read` `{}`                                                                                                                                                                                                                                                             |           28,235 |                     7,049 |                28,235 |
| `kogane.collection-quality.read` `{source}` (one synthetic cell)                                                                                                                                                                                                                                  |            1,044 |                       727 |                 1,044 |
| the same, 301 cells shaped like Vpass's (pure, in the test)                                                                                                                                                                                                                                       |        > 163,840 |   < 8,192 a page, 3 pages |                     — |
| `kogane.observations.list` `{kind: balances}`                                                                                                                                                                                                                                                     |          538,779 |                 unchanged |                     — |
| `kogane.schedules.maintenance.read` `{}`                                                                                                                                                                                                                                                          |           15,258 |             see amendment |                15,258 |
| `kogane.store.read` `{page: overview}`                                                                                                                                                                                                                                                            |            9,234 |             see amendment |                 9,234 |
| `kogane.audit.search` `{}`                                                                                                                                                                                                                                                                        |            6,915 |                 unchanged |                     — |
| every other read tool's default (capabilities, context, explain, instrument candidates and coverage, account candidates, identity, card settlements, reported state, store meta and filter options, observations other than balances, rewards, events, reports, evidence meta, survey, purchases) |         65–4,764 |                 unchanged |                     — |

"Before" is this branch's base (main with ADR 0119 and the
[balance basis](https://github.com/risu729/kogane/pull/1423) and
[read-tool store failure](https://github.com/risu729/kogane/pull/1402) changes
merged) on the same store. Each `detail: full` answer is byte for byte the
answer before. The 50-row balance page (about 149 KB) is the shape issue 1414
measured in production (about 160 KB).

Paging (point 2): a cursor re-sent with another `limit` was
`cursor_mismatch` with no hint. ADR 0119 already lets a cursor continue at any
offered page size; what remains is that the refusal says nothing.

## Options considered

1. **A `detail` input, `summary` the default on the routes and the tools; the
   web UI asks for `full` (chosen; proposal D2, recommended).** ADR 0081's
   "the same answer as the route for the same input" stays literally true:
   the tool and the route take the same `detail` and default the same way.
2. **`detail` with `full` the default, `summary` opt-in.** Changes no
   published answer, but an agent that does not know the argument still
   receives answers it cannot see; issue 1414 asks for the compact default.
3. **A compact default on MCP only, the routes keeping `full`.** The tool
   would answer something its route does not for the same input, the special
   case ADR 0081 point 2 excludes.
4. **Generic truncation (first N bytes, or a field allow-list).** Cuts rows
   or drops reasons without saying so (INV05), and a field list is a second
   contract per read.
5. **Columnar rows (`columns` plus arrays).** The smallest form, but the
   proposal's row is an object with named fields, which a reader cannot
   misalign; the page-local reference tables below get the size within 8 KB
   without it.

## Decision

1. **`detail`.** `GET /api/v2/balances/latest`, `/api/v2/balances/history`,
   `/api/ops/v1/schedules`, `/api/collection-quality` and
   `/api/collection-quality/{source}` take `detail`, `summary` or `full`;
   absent is `summary`. `kogane.balances.read`, `kogane.schedules.read` and
   `kogane.collection-quality.read` take the same `detail` with the same
   default. `full` is each read's answer as it was, unchanged and without a
   `detail` key; the web pages ask for it (`apps/web/src/api.ts`,
   `pages/Schedules.tsx`, `pages/CollectionQuality.tsx`). Another value is
   the route's refusal (`400 invalid_detail` on the balance routes,
   `400 invalid_query` on the others; `400 invalid_request` on the tool's
   closed schema). The account view of ADR 0088 has its full answer only:
   `detail` with it is refused.
2. **A summary is its full answer, shaped by one function.** Each read builds
   its full answer as before and, for `summary`, passes it to one pure
   function the route and the tool share: `latestBalanceSummary` and
   `balanceHistorySummary` (`read-detail.ts`), `scheduleSnapshotSummary`
   (`schedule-model.ts`, applied by the App's relay of the Processor's
   snapshot), `collectionQualitySummaryLines` and
   `collectionQualityCellSummary` (`collection-quality-detail.ts`). A summary
   reads nothing the full answer does not and adds no state.
3. **What a summary keeps.** Every row keeps the id that reads it in full or
   as evidence; every unit; every closed state, reason and failure code of
   what it collapses, and how many rows it collapsed; a value that is not
   exact as its status (`missing`, `unparsed`, `conflict`) with no value and
   no scale, never a zero (INV05). It drops provenance: evidence members,
   temporal references, interpretation and organization records (beyond
   the account fields below), policy releases (`interpretationContext`),
   occurrence lists, maintenance patterns, provider data type parser lists,
   terminals. The closed states it drops besides are listed with each read
   below.
   - **Balances.** `{ schemaVersion, detail: "summary", accounts, metrics,
     items, page, dataCoverage, subtotals }`. An item is `{ observationId,
     account, metric, amount: { value, unit, status, scale }, asOf,
     reasons }`, with `freshness` and `adoption` (states) on `latest`, whose
     reasons are `adoption:<code>` and `freshness:<code>`. History carries
     superseded and failed parses' rows beside current ones, so a `history`
     line's reasons are `parse:superseded` when a later parse replaced its
     row's parse and `parse:<status>` when that parse is not `ok`
     (`parse:pending`, `parse:error`: the closed statuses of
     `parse_runs.status`; another status is refused, never passed on as a
     code, and the validator takes these three codes only); a line with no
     reason is a current successful parse's row, and two lines of one measurement are never both read as current
     (INV06). `account` and `metric` are page-local
     refs (`a1`, `m1`, in order of first appearance) into `accounts`
     (`source`, `sourceAccount` — the key the `account` filter takes —,
     account entity id, label, mapping `status` (`identified`,
     `provider-local`, `aggregate`, `unresolved`) and `lineage` (`current`
     or `historical`: the mapping the row was organized under), the last
     four null exactly when the organization is unavailable) and `metrics`
     (`source`, registry metric id, provider metric). An `accounts` entry is
     keyed by all six of its fields, so one provider account organized two
     ways on a page (a history row recorded under an older mapping, or a row
     whose organization is unavailable) is two entries, and a line never
     resolves to an entity, label or mapping state its own row does not
     carry; the validator refuses a page that lists one entry under two
     refs. Dropped: the instrument organization, the product claim, the
     metric's definition release, measurement kind and aggregation rule
     (the registry's, under its id) and the adoption's evidence count. A
     64-hex account id, a label and a provider metric are written
     once per page, not once per row: a line costs about 150 to 200 bytes, an
     `accounts` entry about 250 and a `metrics` entry about 100. The page
     sizes become 10, 25, 50, 100, 200 and 500; a summary defaults to 10
     rows, `full` to 100 as before. Ten, not 25: the owner's store has
     sources with dozens of provider accounts (SBI Shinsei has 62), so a
     default page can name a new account on every line, and 25 such lines
     are 11 to 18 KB; ten are under 8 KB even when every line also names a
     new metric (below). The page, its cursor, the coverage and the
     subtotals are the full page's.
   - **Schedules.** `{ detail: "summary", schedules, maintenance, leases }`:
     per job its id, source, kind, enabled, supported, next run, reservation,
     `dispatch` (its `collectionRequest`'s dispatch state, null when no
     collector serves a request, absent when the snapshot does not say) and
     newest occurrence (`nominalAt`, `status`, `failureCode`); per source its
     maintenance reference status and number of rules; every held lease.
     `kogane.schedules.read` still leaves out the route's `survey`, which the
     summary does not carry. Dropped: each rule's `enabled` and `scope` (a
     source's `rules` counts every rule, enabled or not) and the actual
     alarm time (`reservation` is the state read from it).
   - **Collection quality.** Without a source, one line per source (its
     freshness, newest fetch run, reasons, each job's newest receipt status
     and failure code with the distinct blocked and failure codes of its
     terminals (`terminalCodes`), the number of unregistered collectors and
     their distinct codes (`unregisteredCodes`), the provider data types
     counted as collected, partial and not collected); sources
     whose lines would be equal share one line whose `sourceIds` names each.
     A job line drops its kind, `supported`, next run, alarm, held lease and
     its terminals' registration, outcome and coverage: under a source they
     are that source's reasons (`schedule_unsupported`, `lease_held`,
     `terminal_*`, `acquisition_*`, `coverage_*`), and `kogane.schedules.read`
     names them per job. A job under no CORE source (`otherSchedules`, today
     only the Processor tick, which names no terminal) has no source line,
     so its terminals' stages are in `full` only (an open limit). A source
     line counts its data types by status without naming them.
     With a source, every cell is read (the cell read's pages at one instant,
     refused past 2,000 cells with `413 result_limit_exceeded`, never cut)
     and answered as one line per dataset, parser and fetch unit, collapsed
     over periods: how many cells and in which state, the first and last
     named period, the newest capture, the freshness of the newest current
     capture, and the union of the cells' reasons, of their newest
     captures' unit and parse failure codes (`failureCodes`) and of their
     coverage causes (`coverageCauses`); 20 lines a page, `offset` counting
     lines, and `coverage` giving the cell and line counts. A line drops a
     cell's period kind and state (MyJCB's `confirmed`/`unconfirmed`), its
     current rule and its per-artifact parse counts; its reasons say which
     of those stages is not complete. The pages are separate reads at one `asOf`,
     not one transaction: a capture registered between two pages of a
     source with more than 500 cells can shift a cell across the page
     boundary, as it can between two pages a client reads (an open limit).
4. **Cursors.** A cursor is bound to neither `detail` nor `limit` (ADR 0119):
   a page read in one detail continues in the other at any offered size. A
   cursor read with another route, filter or read mode stays
   `400 cursor_mismatch` and now carries `mustMatch`, the argument names that
   must repeat: `collection`, `source`, `account`, `instrument`, `metric`,
   `view`, `identityRead` for balances; `collection` and `program` for reward
   expiry (`collection` for simulations). `HttpError` carries such closed
   hints beside its code (`hints`), and the Worker and the page reads answer
   them; names only, never a value.
5. **Owner approval.** The input schemas of the three tools, their default
   answers, the routes' default answers, the balance page sizes and the
   `cursor_mismatch` body are published changes. They merge only with the
   owner's approval (proposal D2, D3).

## Consequences

- An agent's first call to any of the three reads fits what its client shows;
  `detail: "full"` or `kogane.observations.get` with an item's
  `observationId` gives the provenance.
- A client of the routes that relied on the full default must ask for
  `detail=full`. The repository's only client, the web UI, does. Saved
  reports and the shared query do not read these routes.
- The response validator (`validApiResponse` in
  `packages/observation-shared/src/api-validation.ts`) takes the detail a
  request asked for (`requestedDetail` of its query) and then accepts that
  shape only, on the balance paths and the collection quality summary and
  cells; without one it accepts either. The web UI's `getJson` and the
  conformance checks pass it, so a page that asked for `full` refuses a
  summary instead of rendering it. A full page has no `detail`.
- Measured headroom (open limits): the default balance summary is ten
  lines. On the synthetic store it is about 4.1 KB (latest) and 3.5 KB
  (history). At the worst a page comes to, every line naming its own
  account (64-hex id, Japanese label) and its own long provider metric,
  with every reason set, it is about 7.7 KB (latest) and 6.9 KB (history);
  the same page at 25 lines is 16 to 18 KB. So the default fits a page
  that names a new account and metric on every line, with about 500 bytes
  to spare at that worst: labels,
  provider account keys or metric names much longer than the synthetic
  ones (about 40 bytes each), or a nonempty `knownAssetsSubtotal` with
  several units, could pass 8 KB on such a page, and a `limit` of 25 or
  more on an account-dense source passes it (the caller asked for it). The
  collection quality summary is about 7.0 KB: a source line with a job
  costs about 400 to 490 bytes, so two or three more sources with a
  collection job (each source that gains a collector leaves the shared
  line and costs a line of its own), or two or three codes of about 20
  characters on every job line (all empty on the synthetic store), pass
  8 KB, and no argument shortens it (a follow-up would page its lines).
  The synthetic store configures every job the migrations configure, so a
  migration that adds one fails `mcp-answer-size.test.ts` once it does.
- Left as they are, and over 8 KB at this scale: `kogane.observations.list`
  `{kind: balances}` (the v1 grouped list, about 520 KB) and the collection
  quality account view (about 107 KB for Vpass in production, issue 1414's
  proposal). Each is a follow-up of its own.
  `kogane.schedules.maintenance.read` (about 15 KB) and `kogane.store.read`
  `{page: overview}` (about 9 KB) were too; the
  [amendment below](#amendment-the-store-overview-and-the-maintenance-read-answer-a-summary-by-default-2026-11-19)
  gives them a summary.
- Unit B of the proposal (`collection-quality.read` `view: status`, its own
  branch) adds a view to the same tool and route. `detail` is defined only
  for the summary without a source and for `view: cells`; every other view
  has one detail, its own answer, and refuses `detail` as the account view
  does here. The status view is already one short line per job, so it gets
  no `summary`/`full` pair; whichever of the two lands second applies that
  rule to it (a refusal of `detail` with `view: status`) and keeps the
  tool's description under the 2,048 characters a client accepts.

## Verification

- `services/app/test/mcp-answer-size.test.ts`: measures every read tool's
  default answer on the synthetic store above and asserts the three
  summaries are under 8 KB, the full answers far over it; a balance summary
  equals `latestBalanceSummary` / `balanceHistorySummary` of the full page
  read with the same cursor and size, on the route, `/api/agent/v1/*` and
  `/mcp` alike; every unparsed value is `{ value: null, status: "unparsed",
  scale: null }` with its unit; a cursor continues under either detail and at
  50 rows; a cursor with another `source` is `cursor_mismatch` with
  `mustMatch` on the route and the tool; the schedules summary equals
  `scheduleSnapshotSummary` of the full snapshot and keeps a job's
  `collection_failed`; the collection quality summary equals
  `collectionQualitySummaryLines` of the full summary; 301 cells shaped like
  Vpass's (seven units, 36 statement months each never current since an
  older capture, seven current datasets each) validate against the cell
  contract, collapse into 56 lines over three pages each under 8 KB, keep
  every cell's state count, every reason and the units' failure code.
- `packages/application/test/read-detail.test.ts`: one provider account
  organized two ways on a page is two `accounts` entries and each line
  resolves to its own row's entity, label, mapping status and lineage, and a
  page listing one entry under two refs fails the validator; a history line
  says `parse:superseded`, `parse:pending` and `parse:error`, one without
  `reasons` or with a code outside those three fails the validator, and a
  parse status outside the closed set is refused; a default page whose
  every line names its own account and metric is under 8 KB on both
  collections, and the same page at 25 lines is over it; a value that is
  not exact is its status with no value and no scale; a latest line keeps
  its adoption and freshness reason codes; a summary page fails the
  validator when `full` was asked for.
- `packages/application/test/collection-quality-detail.test.ts` (the
  synthetic CORE store): every source is on one line that carries its
  reasons, its jobs' receipt states and codes, its terminals' blocked and
  failure codes and its unregistered collectors' codes; a source's cells
  collapse with every state counted once and every reason, failure code and
  coverage cause kept; each shape fails the validator under the other
  detail.
- `packages/collection/test/schedule-summary.test.ts`: a job line keeps
  `supported`, `dispatch` (null and absent kept apart) and its newest
  receipt's failure code.
- The existing tests that pin the full shape read `detail=full`
  (`balances-v2.test.ts`, `collection-quality-api.test.ts`,
  `page-read-reports.test.ts`, `page-read-schedules.test.ts`,
  `schedules.test.ts`, `audit.test.ts`); the published schema pins
  (`agent-api.test.ts`) and the request schema pins (`conformance.test.ts`,
  `apps/web/test/api-schema.test.ts`) gain `detail`; the browser tests'
  synthetic servers answer the three pages only when asked for `full`; and
  `ui-mcp-parity.test.ts` passes unchanged: no route or tool was added.

## Amendment: the store overview and the maintenance read answer a summary by default (2026-11-19)

- Status: proposed. **Owner approval is needed before merge**, as for the
  decision above: it changes the published input schema and the default
  answer of `kogane.store.read` and `kogane.schedules.maintenance.read`, the
  default answer of `GET /api/overview` and of
  `POST /api/agent/v1/schedules.maintenance.read`, and the shared request
  schema (`LIST_REQUEST_SCHEMA` gains `/api/overview` and the capability
  requirement `sharedQuery`).
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414),
  the follow-ups this ADR's consequences list
- Carried by: `packages/application/src/query/overview-detail.ts`,
  `maintenanceReadSummary` in `packages/collection/src/schedule-model.ts`,
  `services/app/src/observation-api.ts`, `services/app/src/page-read-tools.ts`,
  `services/app/src/schedule-tools.ts`,
  `packages/observation-shared/src/api-schema.ts`,
  `packages/observation-shared/src/api-validation.ts`, `apps/web/src/api.ts`

### Context

Two reads this ADR left as they were are over the 8 KB a client shows on the
synthetic store: `kogane.schedules.maintenance.read` (15,258 bytes) and
`kogane.store.read` `{page: overview}` (9,234 bytes). The synthetic store
understates the overview: its run lists hold the newest 500 fetch runs and
the newest 500 parse runs of the whole store, and the synthetic store has 12
of each. At the window's bound (500 and 500 over 38 sources and 57 parsers,
the counts the source and parser registries declare today) the full overview
is about 261 KB. The maintenance read grows with rules: each rule lists up to
20 revisions, and a delegated principal that adds a `once` window adds a rule.
At 30 sources with two jobs and four rules of 20 revisions each it is about
1 MB.

### Options considered

1. **The decision's pattern: `detail`, `summary` the default, one pure
   function from the full answer, the web UI asking for `full`; the
   maintenance summary paged by line (chosen).**
2. **The same, with the maintenance summary unpaged.** The synthetic store's
   summary is already about 10 KB unpaged (16 jobs and 14 rules at about 300
   bytes a line), so it does not fit.
3. **The same, paged by whole source.** A source with more lines than a page
   holds would need a page of its own, and one source with 30 rules is about
   12 KB: an open limit that grows with every `once` window. Paging by line
   bounds every page.
4. **An overview paged as well.** Its unbounded parts are its per-source and
   per-parser lines for failing statuses; at the realistic worst below they
   fit unpaged, so the overview keeps one answer (an open limit records where
   it would not).

### Decision

1. **`detail` on both reads.** `GET /api/overview` and `kogane.store.read`
   take `detail`, `summary` or `full`, absent being `summary`, for
   `page: overview`. Another value is `400 invalid_detail` on the route (as
   on the balance routes, in the same reader) and `400 invalid_request` on
   the tool's closed schema; `detail` on `meta` or `filter-options` is the
   route's `400 invalid_query`, which the tool answers as its result.
   `kogane.schedules.maintenance.read` and its agent route take `detail` and,
   with `summary`, `offset` (an integer from 0 to 1,000); `offset` with
   `full`, another detail, or either argument on
   `kogane.schedules.survey.read` is `400 invalid_request`. `full` is each
   read's answer as it was, byte for byte and without a `detail` key.
2. **Where the parameter exists.** The overview's `detail` is in the shared
   request schema under the requirement `sharedQuery`: the summary is shaped
   by the shared application service, so the central store accepts it and the
   local store (and the demo export, which is the local store's) answers its
   full overview alone and refuses the parameter. The web overview builds its
   request through `useListRequest`, so it sends `detail=full` exactly where
   it is accepted and waits for the capabilities first.
3. **One function per read.** The overview route builds its full page as
   before and, for `summary`, passes it to `overviewSummary`
   (`packages/application/src/query/overview-detail.ts`), which the route and
   the tool share because the tool calls the route's reader
   (ADR 0081). The maintenance tool relays the Processor's read as before and,
   for `summary`, passes it to `maintenanceReadSummary`
   (`packages/collection/src/schedule-model.ts`) in `readScheduleTool`, the
   one function both agent paths call. The Processor and its route are
   unchanged. Neither summary reads anything the full answer does not.
4. **The overview summary.** `{ detail: "summary", counts, sources,
   fetchRuns, parseRuns, unitUpdates?, coverage }`:
   - `counts` and `coverage` as the full page has them.
   - `sources`: `{ sourceIds, artifacts }`, sources with the same artifact
     count sharing one line.
   - `fetchRuns.byStatus`: per status of the window (`success`, `partial`,
     the view's closed set) the number of runs, the number of sources, and the
     newest run (`id`, `sourceId`, `startedAt`, `completedAt`, null while it
     has not completed). `fetchRuns.notSuccessful`: per source and status
     other than `success`, its number of runs and newest run.
   - `parseRuns.byStatus`: per status (`ok`, `pending`, `error`, the closed
     set of `parse_runs.status`) the number of runs, how many a later parse
     superseded, how many carry warnings, how many carry warnings that could
     not be read, the number of parsers, and the newest run (`id`,
     `artifactId`, `parser`, `parsedAt`). `parseRuns.notOk`: per parser and
     status other than `ok`, its number of runs, how many were superseded,
     `failureCodes` (the distinct `parse_runs.error` values of its runs,
     newest first: the Processor writes that column as a closed code, so it
     is the failure code the full answer carries; a value that is not
     code-shaped is `unclassified`), and its newest run.
   - `unitUpdates` (only when the full page has it): per source and dataset,
     the number of partial runs and the newest one's run id, time and unit
     counts.
   - A status outside the closed sets is refused (the summary throws), never
     passed on as a code. The validator accepts each status once and requires
     the per-source and per-parser lines of a status to count exactly its
     runs.
   - Dropped: each source's provider name and ingestion; each fetch run's
     producer (`tool`) and session id (`external_run_id`); each parse run's
     parser version, warning text and superseding parse id; and every run
     but the newest of each line (their states and failure codes are
     counted).
5. **The maintenance summary.** `{ detail: "summary", sources, limits,
   coverage }`:
   - Per source on the page: `source`, `reference` (the registered
     reference's status, `confirmed`, `no-applicable-rule` or `not-found`, or
     null when none is registered), `scheduleCount` and `ruleCount` (its jobs
     and rules in the whole read).
   - Per job: `id`, `kind`, `enabled`, `supported`, `revision`,
     `nextNominalAt`, `nextRunAt`, `reservation` (`armed`, `pending`,
     `disabled`) and `latest` (`nominalAt`, `status`, `failureCode`, or null).
   - Per rule: `id` and its current revision's `revision`, `timezone`,
     `pattern`, `enabled` and `scope`; `revisions`, how many revisions the
     full read lists for it (at most 20); `actorKinds` and `changeReasons`,
     the distinct values among them, newest first, a revision written before
     CORE 0078 kept as `null`; and `byCaller`, how many of them the reader
     wrote. A rule listed without a revision is refused, never summarized.
   - `limits` as the full read has them.
   - Paged by line: each job and each rule is a line, and so is a source
     with neither. A page holds 16 lines in the read's order (a source's jobs,
     then its rules); a source whose lines continue on the next page is
     listed on both, each with the lines that page holds. `coverage` is
     `{ sources, lines, limit: 16, offset, nextOffset }`, `nextOffset` null
     on the last page. Each page is a fresh read: an offset is not a cursor
     over one snapshot, so a rule or job added or removed between two pages
     moves the lines after it, and the next page can repeat or skip a line
     there. `coverage.lines` and `coverage.sources` then differ between the
     pages, which is how a reader sees it and reads again from `offset: 0`.
   - Dropped: the reference's URL and verification time; each job's `source`
     (the entry names it), `timezone`, `pattern` and actual alarm time
     (`reservation` is the state read from it), and its newest receipt's start
     and finish times; each rule's earlier revisions (their count, actor kinds,
     change reasons and the reader's share are kept) and every revision's
     reference URL, verification and creation times.
6. **Owner approval.** As point 5 of the decision: the two tools' input
   schemas, their default answers, the overview route's default answer and
   the shared request schema are published changes, merged only with the
   owner's approval.

### Consequences

Measured as the bytes of the MCP result's structured content
(`test/mcp-answer-size.test.ts`, `--silent=false`):

| Read                                                                                                           |      Full | Summary                         |
| -------------------------------------------------------------------------------------------------------------- | --------: | ------------------------------- |
| `kogane.store.read` `{page: overview}`, synthetic store                                                        |     9,234 | 1,437                           |
| the same at the window's realistic worst (38 sources, 10 with partial runs; 57 parsers, 10 failing, 3 pending) |   261,409 | 7,981                           |
| the same past it (all 38 sources with partial runs, 20 parsers failing)                                        |         — | 14,412                          |
| `kogane.schedules.maintenance.read` `{}`, synthetic store (15 sources, 16 jobs, 14 rules)                      |    15,258 | 4,909 and 4,172 (2 pages)       |
| the same with 30 sources, each with two jobs and four rules of 20 revisions                                    | 1,042,886 | at most 6,268 a page (12 pages) |
| one source with two jobs and 30 rules                                                                          |         — | 6,173 and 6,321 (2 pages)       |

- An agent's first overview or maintenance read fits what its client shows;
  `detail: "full"` (and, for the overview, `kogane.observations.get` with a
  line's `artifactId`, or `kogane.evidence.read` with a source) gives the
  rest. The overview summary no longer lists every run, so the web overview,
  which does, asks for `full`.
- A client of `GET /api/overview` that relied on the full default must ask
  for `detail=full`. The repository's clients are the web UI, which does, and
  the conformance checks, which sample `detail=full` and validate it under
  that detail.
- Open limits. The overview summary is unpaged: at the realistic worst above
  it is about 7.9 KB, and each further source with a non-successful status
  costs about 130 bytes and each further parser with one about 200 (its
  line with one failure code), so one more such line, a second failure code
  on a few lines, or longer source ids and parser names than the synthetic
  ones pass 8 KB; all 38 sources partial and 20 parsers failing is about
  14.4 KB. No argument shortens it; a follow-up
  would page its `notSuccessful` and `notOk` lines. A maintenance page is
  bounded by its 16 lines: a rule line is about 300 bytes with its 20
  revisions' codes, so a page passes 8 KB only when most of its lines are
  rules whose revisions carry most of the eight change reasons and each sits
  under its own source; nothing measured comes near it.
- The maintenance summary's type (`MaintenanceRead`) mirrors the Processor's
  answer in `packages/collection`; the Processor does not import it, so
  `schedule-tools.test.ts` and `mcp-answer-size.test.ts` check the summary
  against the real Processor route's answer.

### Verification

- `packages/application/test/overview-detail.test.ts`: the summary of a
  synthetic page, line for line (equal artifact counts sharing a line, every
  status counted, the newest run's ids, a run that has not completed kept as
  null, superseded, warning and unreadable-warning counts, each failing
  parser's failure codes newest first); provider names, producers, session
  ids, warnings and error text that is not a code are not in it, and a
  summary carrying text where a failure code belongs fails the validator; unit
  updates collapse per source and dataset and stay absent when the page has
  none; a status outside the closed sets is refused; each shape passes the
  validator only under its own detail, and a summary whose lines do not
  count their status's runs, repeat a status, put `success` on a
  not-successful line or name an unknown status fails it.
- `packages/collection/test/maintenance-summary.test.ts`: a job keeps its
  closed states, revision, run times and newest receipt's failure code, and
  no provenance; a rule is its current revision with every actor kind and
  change reason of its history, `null` kept; a source whose lines continue is
  listed on both pages with its counts, every rule once; a source with
  neither a job nor a rule is one line with its null reference; a rule
  without a revision is refused.
- `services/app/test/mcp-answer-size.test.ts`: both summaries under 8 KB on
  the synthetic store and their full answers over it; the overview summary
  equals `overviewSummary` of the full page on the route, `/api/agent/v1/*`
  and `/mcp`, `full` equals the route's full page, each validates under its
  own detail only, and every run of the window is counted; `compact` is
  refused on the route and the tool, and `detail` on `meta` or
  `filter-options` is `invalid_query` on both; the realistic worst above
  validates in full and in summary and stays under 8 KB; every maintenance
  page equals `maintenanceReadSummary` of the full read on `/mcp` and the
  agent route, is under 8 KB, and together the pages list every source in
  order and every job and rule once, a failure code kept; the 30-source and
  crowded-source reads stay under 8 KB a page.
- `services/app/test/schedule-tools.test.ts`: the summary pages on both
  agent paths are the same object and each the full read's summary, every
  page but the last holds 16 lines; `detail: full` is the Processor's read;
  `compact`, `offset` with `full`, a negative or fractional `offset`, and
  either argument on the survey read are `invalid_request` before anything
  is relayed.
- `services/app/test/page-read-observations.test.ts`: the route and the tool
  give the same overview under no detail, `summary` and `full`.
- The schema pins: `agent-api.test.ts` (the `kogane.store.read` properties),
  `conformance.test.ts` and `apps/web/test/api-schema.test.ts`
  (`LIST_REQUEST_SCHEMA`, `/api/overview` granted `detail` on the central
  store and nothing on the local store); the shared conformance checks sample
  `detail=full` on `/api/overview` and validate it under that detail.
- `apps/web/test/api-transport.test.ts`: a page that asked for the full
  overview refuses a summary; `apps/web/test/overview-counts.browser.test.ts`
  answers the overview only when asked for `detail=full`, and the page still
  renders every run.
