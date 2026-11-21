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
| `kogane.observations.list` `{kind: balances}`                                                                                                                                                                                                                                                     |          538,779 |             see amendment |               538,779 |
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
   `detail` with it is refused (until the
   [amendment of 2026-11-20](#amendment-the-collection-quality-account-view-answers-a-paged-summary-by-default-2026-11-20),
   which gives it a paged summary).
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
   expiry, with `from` and `before` once its deadline window (ADR 0049,
   amendment of 2026-11-19) binds them (`collection` for simulations). `HttpError` carries such closed
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
  proposal). `kogane.schedules.maintenance.read` (about 15 KB) and
  `kogane.store.read` `{page: overview}` (about 9 KB) were too. Each is a
  follow-up of its own, taken up by the amendments below, in order: the
  [amendment of 2026-11-19](#amendment-the-store-overview-and-the-maintenance-read-answer-a-summary-by-default-2026-11-19)
  gives the overview and the maintenance read a summary; the
  [first amendment of 2026-11-20](#amendment-the-overview-summary-is-held-to-8-kb-by-construction-2026-11-20)
  holds the overview summary to 8 KB by construction; the
  [second](#amendment-the-collection-quality-account-view-answers-a-paged-summary-by-default-2026-11-20)
  gives the account view a paged summary; the
  [third](#amendment-cash-per-account-and-per-bank-in-one-call-collection-cash-2026-11-20)
  answers cash per account and per bank in one call
  (`kogane.balances.read` `collection: cash`) instead of pages of `latest`;
  and the
  [fourth](#amendment-the-v1-grouped-balance-list-answers-a-summary-by-default-2026-11-20)
  gives the grouped list a summary.
- Unit B of the proposal (`collection-quality.read` `view: status`, its own
  branch) adds a view to the same tool and route. `detail` is defined only
  for the summary without a source and for `view: cells`; every other view
  has one detail, its own answer, and refuses `detail` as the account view
  does here (the account view takes it since the amendment of 2026-11-20).
  The status view is already one short line per job, so it gets
  no `summary`/`full` pair. It landed first (ADR 0045, amendment of
  2026-11-19), so this ADR applies that rule to it: `detail` with
  `view: status` is `400 invalid_request` on the tool, and
  `?view=status&detail=...` is `400 invalid_query` on the route; the tool's
  description stays under the 2,048 characters a client accepts.

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
   per-parser lines for failing statuses and its partial-unit lines. Paging
   them would add `offset` to `kogane.store.read`, the route and the shared
   request schema, and repeat the counts and sources (about 3.7 KB at the
   worst) on every page.
5. **The overview unpaged and uncapped.** At the realistic worst it was
   7,981 bytes, about 200 under 8 KB with no unit updates in the measure; ten
   partial-unit lines (about 180 bytes each), one more failing parser (about 200) or a second failure code on a few lines passed 8 KB, and every source
   partial with twenty parsers failing was about 14.4 KB.
6. **The overview's lists capped, each line's failure codes capped, what is
   left out counted, and every failure code on its status's line (chosen).**
   One answer, bounded whatever the store holds; the lines left out are
   counted with their runs and listed by `full`.

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
     not be read, the number of parsers, `failureCodes` (every distinct
     `parse_runs.error` value of its runs, newest first: the Processor
     writes that column as a closed code, so it is the failure code the full
     answer carries; a value that is not code-shaped is `unclassified`; at
     most the Processor's closed set, 29 codes today, and `unclassified`),
     and the newest run (`id`, `artifactId`, `parser`, `parsedAt`).
     `parseRuns.notOk`: per parser and status other than `ok`, its number of
     runs, how many were superseded, `failureCodes` (the distinct codes of
     its runs, newest first, at most three) with `moreFailureCodes` (how many
     more it has, each on its status's line), and its newest run.
   - `unitUpdates` (only when the full page has it): per source and dataset,
     the number of partial runs and the newest one's run id, time and unit
     counts.
   - Bounded lists: `notSuccessful`, `notOk` and `unitUpdates` each hold the
     five lines with the newest runs (`OVERVIEW_SUMMARY_LINES`), newest
     first; lines whose newest run is the same run (one fetch run's
     datasets) are ordered by source and dataset, so which of them is listed
     does not depend on the order the reader returned them in. The lines
     left out are counted, never dropped silently:
     `fetchRuns.notSuccessfulOmitted` and `parseRuns.notOkOmitted` hold one
     `{ status, lines, runs }` per status with lines left out (empty when
     none is), and `unitUpdatesOmitted` is `{ lines, runs }`, present
     exactly with `unitUpdates`. `detail: "full"` lists them, and their
     failure codes stay on their status's `byStatus` line.
   - A status outside the closed sets is refused (the summary throws), never
     passed on as a code. The validator accepts each status once; requires
     the per-source and per-parser lines of a status, with its omitted
     entry, to count exactly its runs and its sources or parsers (the
     status's `sources` or `parsers`, one line each); refuses a list over
     five lines, lines counted as left out of a list that is not full, a
     line over three failure codes or counting more than it may, and a
     line's code missing from its status's line.
   - Dropped: each source's provider name and ingestion; each fetch run's
     producer (`tool`) and session id (`external_run_id`); each parse run's
     parser version, warning text and superseding parse id; every run but
     the newest of each line (their states and failure codes are counted);
     and the lines past the fifth of each list (counted with their runs).
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

| Read                                                                                                                                                           |      Full | Summary                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: | ------------------------------------- |
| `kogane.store.read` `{page: overview}`, synthetic store                                                                                                        |     9,234 | 1,499                                 |
| the same at the window's realistic worst (38 sources, 10 with partial runs; 57 parsers, 10 failing, 3 pending; 10 sources' datasets with partial-unit updates) |   266,375 | 6,882 (9,787 with the lists uncapped) |
| the same at its bound (every list full; all three parse statuses; the longest codes on each line, all 30 on the error line; today's longest names)             |   370,304 | 8,081                                 |
| `kogane.schedules.maintenance.read` `{}`, synthetic store (15 sources, 16 jobs, 14 rules)                                                                      |    15,258 | 4,909 and 4,172 (2 pages)             |
| the same with 30 sources, each with two jobs and four rules of 20 revisions                                                                                    | 1,042,886 | at most 6,268 a page (12 pages)       |
| one source with two jobs and 30 rules                                                                                                                          |         — | 6,173 and 6,321 (2 pages)             |

- An agent's first overview or maintenance read fits what its client shows;
  `detail: "full"` (and, for the overview, `kogane.observations.get` with a
  line's `artifactId`, or `kogane.evidence.read` with a source) gives the
  rest. The overview summary no longer lists every run, so the web overview,
  which does, asks for `full`.
- A client of `GET /api/overview` that relied on the full default must ask
  for `detail=full`. The repository's clients are the web UI, which does, and
  the conformance checks, which sample `detail=full` and validate it under
  that detail.
- The overview summary names at most five sources or parsers per list: at
  the realistic worst above it lists five of the ten partial sources, five
  of the thirteen failing or pending parsers and five of the ten unit-update
  lines, and counts the rest with their runs. Which sources or parsers those
  are, and their newest runs, is in `detail: "full"` (about 260 KB at that
  scale, past what a client shows) or, per source, `kogane.evidence.read`;
  no argument pages the summary's lists (an open limit). Every failure code
  stays on its status's line.
- Open limits. With every list full, the summary still grows with the
  source registry (each further source with its own artifact count adds a
  `sources` line, about 55 bytes), with the Processor's closed set of
  failure codes (about 25 bytes a code on the status's line), and with
  longer source ids, parser names and datasets than today's longest (17,
  40 and 37 characters; the schema allows source ids of 100 characters,
  datasets of 200 and parser names of any length); the bound above leaves
  about 110 bytes under 8 KB for them, so three more sources with their own
  artifact counts, five more codes, or three more characters on every
  source id pass 8 KB (with 100-character source ids the bound is about
  12 KB). The
  [amendment of 2026-11-20](#amendment-the-overview-summary-is-held-to-8-kb-by-construction-2026-11-20)
  closes this limit for the overview. A maintenance page is bounded by its 16 lines: a rule line is
  about 300 bytes with its 20 revisions' codes, so a page passes 8 KB only
  when most of its lines are rules whose revisions carry most of the eight
  change reasons and each sits under its own source; nothing measured comes
  near it.
- The maintenance summary's type (`MaintenanceRead`) mirrors the Processor's
  answer in `packages/collection`; the Processor does not import it, so
  `schedule-tools.test.ts` and `mcp-answer-size.test.ts` check the summary
  against the real Processor route's answer.

### Verification

- `packages/application/test/overview-detail.test.ts`: the summary of a
  synthetic page, line for line (equal artifact counts sharing a line, every
  status counted, the newest run's ids, a run that has not completed kept as
  null, superseded, warning and unreadable-warning counts, each failing
  parser's failure codes newest first, every code on its status's line);
  provider names, producers, session ids, warnings and error text that is
  not a code are not in it, and a summary carrying text where a failure code
  belongs fails the validator; a line keeps its newest three codes and
  counts the fourth, and a line over three codes, counting more than its
  status has or with a code its status's line lacks fails the validator;
  eight failing parsers, seven partial sources and seven unit-update lines
  list the five with the newest runs each and count the rest with their
  runs, and a summary that leaves lines out without counting them, lists a
  sixth, or counts lines out of a list that is not full fails the validator;
  unit updates collapse per source and dataset and stay absent (with their
  count) when the page has none; on 1,500 seeded random full answers (no
  lines, under five, exactly five, six and more per list, codes repeated
  across statuses, datasets sharing a fetch run) the summary validates, lists
  the five lines a reference ordering picks, its listed and left-out lines and
  runs add up to the full answer's per status, each line's shown and counted
  codes are its runs' distinct codes, each status's codes are exactly its
  runs', the unit updates in another order give the same summary, and an
  omitted entry that miscounts its lines with its runs right fails the
  validator; a status outside the closed sets is refused; each shape passes
  the validator only under its own detail, and a summary whose lines do not
  count their status's runs, repeat a status, put
  `success` on a not-successful line or name an unknown status fails it.
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
  validates in full and in summary, stays under 7 KB, and lists five lines
  a list with the rest counted; the bound above validates in full and in
  summary, has all three parse statuses, five lines a list each with its
  newest run completed, the three longest codes and more on every failing
  line, every one of the Processor's codes on the error line, pending and
  failing lines left out, and the longest names in use today, and stays
  under 8 KB; every maintenance page equals `maintenanceReadSummary` of the
  full read on `/mcp` and the agent route, is under 8 KB, and together the
  pages list every source in order and every job and rule once, a failure
  code kept; the 30-source and crowded-source reads stay under 8 KB a page.
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

## Amendment: the overview summary is held to 8 KB by construction (2026-11-20)

- Status: proposed. **Owner approval is needed before merge**: it changes
  the default answer of `kogane.store.read` `{page: overview}` and of
  `GET /api/overview` (two new keys, lists that can hold fewer lines than
  their cap, and a new refusal), as the amendment above did.
- Date: 2026-11-20
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414)
  (point 1, "Responses are huge and get truncated"), the open limit the
  amendment above records
- Carried by: `packages/application/src/query/overview-detail.ts`,
  `packages/observation-shared/src/api-contract.ts`
  (`OVERVIEW_SUMMARY_BYTES`, `PAGE_READ_SCHEMA_VERSION`),
  `packages/observation-shared/src/api-validation.ts`,
  `services/app/src/observation-api.ts`, `services/app/src/http.ts`,
  `services/app/src/page-read-tools.ts`

### Context

The amendment above caps the overview summary's lists and per-line codes,
which bounds how many lines it has but not how long they are. Its own open
limit measures the bound at 8,081 bytes with today's names, about 110 bytes
under the 8 KB a client shows: three more sources with their own artifact
counts, three more characters on every source id, or 100-character source
ids (the schema's maximum, about 12 KB) pass it, and parser names have no
bound at all. The summary did not guarantee 8 KB, which is what issue 1414
asked for.

### Options considered

1. **Lower the caps.** Fewer lines a list still have no byte bound while
   names do not.
2. **Cut long names.** A cut source id, dataset or parser name no longer
   names its row, so it cannot be read further; never.
3. **Refuse whenever the capped summary is over 8 KB.** Three more sources
   would refuse the default answer.
4. **Measure the answer and trim it: lines, then per-line codes, then the
   per-source `sources` lines; refuse past that.** Trimming lines until the
   answer fits leaves no line whose codes the second step could trim, and
   at the schema's longest names (measured below) it answers 36 of 38
   sources' artifact counts and not one failing source or parser.
5. **Measure the answer and trim it: sources, then per-line codes, then
   lines; refuse past that (chosen).** A source's artifact count is neither
   a state, a reason nor a code, and `detail: "full"` and
   `kogane.evidence.read` hold every one; a code moved off a line stays on
   its status's line, so only which line it was on is lost; a line moved
   into its list's count loses which source or parser it was, so it goes
   last. At the same names it answers every failing line.

### Decision

1. **The budget.** `OVERVIEW_SUMMARY_BYTES` is 8,192: the UTF-8 bytes of
   the tool's answer `{ schemaVersion: "kogane-page-read-v1", data }`
   serialized as the tool's text content (`JSON.stringify`, as the MCP
   adapter writes it). The route answers `data` alone, 47 bytes shorter.
   `PAGE_READ_SCHEMA_VERSION` moves to `packages/observation-shared` so the
   summary measures the very envelope the tool sends.
2. **Untrimmed first.** `overviewSummary` builds the summary under the
   caps as before. When its answer fits, it is the answer, with
   `sourcesOmitted: 0` and `budget: { bytes: 8192, trimmed: false }`.
3. **Then trimmed, one step at a time in a fixed order, stopping at the
   first answer that fits** (`budget.trimmed: true`):
   1. sources, the last in the full answer's order (by id) first, counted
      in `sourcesOmitted` (leaving one more out never lengthens the answer,
      so the most that fit are found by halving, as one at a time would);
   2. per-line failure codes, the oldest listed `notOk` line's first and
      each line's oldest code first, counted in its `moreFailureCodes`;
   3. lines, the oldest line of the list holding the most first (a tie goes
      `unitUpdates`, `notSuccessful`, `notOk`), counted in its status's
      `notSuccessfulOmitted` or `notOkOmitted` entry or in
      `unitUpdatesOmitted`.
4. **Never trimmed:** `counts`, `coverage`, and the `byStatus` lines, each
   with its counts, its newest run and every distinct failure code of its
   runs; and every omitted count. When these alone are over the budget, the
   summary throws `OverviewSummaryLimitError`, and the route and both agent
   transports answer `413 result_limit_exceeded` with the closed hint
   `retryWith: { detail: "full" }` (`HttpErrorHints` gains `retryWith`).
   How large this part can grow: `counts` is the reader's fixed list of
   nine tables; `fetchRuns.byStatus` holds at most two lines, each naming
   one source id (at most 100 characters); `parseRuns.byStatus` at most
   three, each naming one parser (no schema bound) and every distinct code
   of its runs (at most 64 characters each, as `safeCode` passes them on;
   the Processor writes a closed set of 29 and `unclassified`). Measured
   with every one of today's 30 codes on the error line, it is 2,856 bytes
   at today's names, 3,022 with 100-character source ids and 4,102 with
   400-character parser names; it passes 8 KB only past parser names of
   about 1,800 characters on all three status lines, or about 80 more
   distinct codes of 64 characters.
5. **Said in the answer.** `budget: { bytes, trimmed }` and
   `sourcesOmitted` are always present. `trimmed` is true exactly when the
   summary shows what only the budget does: a list that leaves lines out
   while holding fewer than five, a `notOk` line that counts codes while
   listing fewer than three, or `sourcesOmitted` above 0.
6. **The validator** refuses a summary whose answer passes the budget, one
   whose `budget.bytes` is another number, and one whose `budget.trimmed`
   disagrees with what it shows. It drops the rules that a list leaves
   lines out only when full and that a line counts codes only when it lists
   three (each now holds exactly when `trimmed` is false), and keeps every
   rule that refuses a miscount.

### Consequences

Measured as the bytes of the tool's answer
(`test/mcp-answer-size.test.ts`, `--silent=false`):

| Read                                                                                    | Summary | What the budget trimmed                                  |
| --------------------------------------------------------------------------------------- | ------: | -------------------------------------------------------- |
| `kogane.store.read` `{page: overview}`, synthetic store                                 |   1,558 | nothing                                                  |
| the realistic worst of the amendment above                                              |   6,941 | nothing                                                  |
| its bound (today's names)                                                               |   8,140 | nothing                                                  |
| the bound with three more sources                                                       |   8,191 | 2 of 41 sources                                          |
| the bound with three more characters on every source id                                 |   8,175 | 2 of 38 sources                                          |
| the bound at 100-character source ids, 200-character datasets and 120-character parsers |   8,172 | all 38 sources and 12 of 15 line codes; every line kept  |
| the same over 120 sources                                                               |   8,172 | all 120 sources and 12 of 15 line codes; every line kept |
| a failed parse under a 9,000-character parser name                                      |       — | refused: `413 result_limit_exceeded`                     |

- The default overview answer fits what a client shows whatever the store
  holds, or is refused with a closed code; a client never cuts it. The
  bound at today's names leaves 52 bytes, so a little growth of the source
  registry already leaves a source or two out: `budget.trimmed` and
  `sourcesOmitted` say so, and `detail: "full"` lists them.
- Which sources a trimmed summary leaves out is fixed (the last by id), not
  chosen by relevance; their number is in the answer and their ids are in
  `full` (an open limit). The failing lines are kept longest.
- Every summary carries two keys more (59 bytes), and a reader that relied
  on a list being full before it leaves lines out reads `budget.trimmed`.
- An untrimmed summary is serialized once; a trimmed one at most about 30
  times more plus the halving over sources, each an answer a few kilobytes
  over the budget (more with many long source ids), over the 500-row window.

### Verification

- `packages/application/test/overview-detail.test.ts`: a full answer at
  the schema's longest source ids and datasets, widened 16 bytes at a time,
  is untrimmed, then leaves sources out (the last by id first; the first
  step one source), then moves per-line codes (the fifth line's oldest
  first, then the fourth's), then lines (`unitUpdates` first on a tie, then
  `notSuccessful`, then `notOk`, each its oldest), and then is refused,
  never trimmed less as it grows; each answer is at most 8,192 bytes and
  validates, and its error line keeps every code. Three 3,000-character
  parser names are refused, with or without sources. The validator refuses
  a trimmed summary that says it was not, an untrimmed one that says it
  was, another budget, an answer over 8,192 bytes, and lines or codes left
  out uncounted or miscounted. The seeded property test runs its 1,500 full
  answers as before (none trimmed) and 600 more at up to 120 sources,
  100-character source ids, 200-character datasets, 400-character parser
  names, 64-character codes and safe-integer counts: every summary is at
  most 8,192 bytes and validates, each list is the reference's newest lines
  (all five when untrimmed), each line's codes are its newest, every line,
  run and code is counted, the sources listed are the first by id, each
  budget step comes only after the one before it, and every step comes up.
- `services/app/test/mcp-answer-size.test.ts`: the realistic worst and the
  bound are untrimmed and under 7 KB and 8 KB; the four extremes above are
  trimmed to at most 8,192 bytes, validate, count every run, line and
  source, and keep every Processor code on the error line; a failed parse
  under a parser name of 1,500 three-byte characters (4,500 bytes, 1,500
  UTF-16 code units) is trimmed so that the text `/mcp` sends is at most
  8,192 UTF-8 bytes, and `/api/agent/v1/*` answers the same and the route
  the same `data`, 47 bytes shorter; a failed parse
  under a 9,000-character parser name is `413 result_limit_exceeded` with
  `retryWith: { detail: "full" }` on the route, `/mcp` and
  `/api/agent/v1/*`, and `detail=full` still answers it.
- `services/app/test/ui-mcp-parity.test.ts`: the `kogane.store.read`
  description names the budget, what it trims, the flag and the refusal,
  within 2,048 characters.
- `apps/web/test/api-transport.test.ts`: the summary fixture carries the two
  new keys.

## Amendment: the collection quality account view answers a paged summary by default (2026-11-20)

- Status: proposed. **Owner approval is needed before merge**: it changes
  the published description and the default answer of
  `kogane.collection-quality.read` with `view: "accounts"`, the default
  answer of `GET /api/collection-quality/<sourceId>/accounts`, and the
  queries that route takes (`detail` and `offset`, where it took none).
  Whether the account view's default becomes the summary, as here and as for
  the other views, or stays `full` with `summary` opt-in, is the owner's
  decision (as D2 above).
- Date: 2026-11-20
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414)
  (point 1, "Responses are huge and get truncated"); the follow-up this
  ADR's consequences list (the account view, about 107 KB for Vpass in
  production)
- Carried by: `accountCoverageSummary` in
  `packages/application/src/query/collection-quality-detail.ts`,
  `packages/observation-shared/src/collection-quality-contract.ts`
  (`ACCOUNT_SUMMARY_LINE_PAGE`, `ACCOUNT_SUMMARY_BYTES`,
  `pageReadAnswerBytes`, the summary's wire check),
  `services/app/src/collection-quality-api.ts`,
  `services/app/src/page-read-tools.ts`, `services/app/src/audit.ts`,
  `apps/web/src/pages/CollectionQuality.tsx`
- Builds on: [ADR 0088](0088-collection-quality-per-account.md) (the account
  view and its full answer), [ADR 0081](0081-ui-parity-through-mcp.md)

### Context

The decision above left the account view of
[ADR 0088](0088-collection-quality-per-account.md) with its full answer
only, and `detail` with it refused. That answer lists every period of every
account a source's observations name, each with its unit key, period,
current rule, cell state, standing, capture, observation count, reasons and
freshness, and every unattributed cell. Issue 1414's proposal records about
107 KB for Vpass in production. A synthetic source at the read's bound
(below: 62 accounts, as SBI Shinsei has, 2,000 cells) answers about 1 MB.
An MCP client shows the first 8 KB, so an agent asking which accounts a
source names, and whether their data is current, read nothing usable.

### Options considered

1. **The decision's pattern: `detail`, `summary` the default, one pure
   function from the full answer, the web UI asking for `full`; the summary
   one line per account, then per unit of unattributed cells, paged by
   line, each page held to 8 KB by measuring it (chosen).**
2. **The same with a fixed number of lines a page and no byte measure.** An
   account line is about 470 bytes with a 64-hex id and no reason, about
   780 with eight reasons and a 30-character label, and about 1.8 KB with
   every reason, status, kind and provider type and a 200-character label
   (the page's other fields are about 750), so no fixed count is under 8 KB for every source
   without being far under it for most; a label or period text near the
   schema's 512 characters passes any count.
3. **One unpaged answer: counts per standing and state over the whole
   source, with a pointer to `full`.** Bounded, but it drops which accounts
   the source names; ADR 0088 lists every account a source's observations
   name precisely because whether each is the owner's is not decided there,
   and an agent reads further by account id.
4. **A cursor (ADR 0119).** The read is one statement over the whole source
   at one instant; a cursor would bind nothing an offset does not, and the
   cell summary beside it already pages by `offset`.

### Decision

1. **`detail` and `offset`.** `GET /api/collection-quality/<sourceId>/accounts`
   takes `detail`, `summary` or `full`, absent being `summary`, and, with
   the summary, `offset` (an integer from 0, as on the cell route). `full`
   is ADR 0088's answer, byte for byte and without a `detail` key, unpaged:
   `offset` with it is `400 invalid_query` on the route and
   `400 invalid_request` (`refs: ["offset"]`) on the tool. Another detail, a
   repeated or empty parameter, or any other parameter is
   `400 invalid_query`; an offset that is not a decimal integer is
   `400 invalid_offset`. `kogane.collection-quality.read` with
   `view: "accounts"` takes the same `detail` and `offset` (its input schema
   is unchanged: both were already properties of the tool) and passes them
   to the same reader. The collection quality page asks for `full`.
2. **One function.** The reader reads the full answer as before and, for
   `summary`, passes it to `accountCoverageSummary(full, offset)`, which the
   route and the tool share (ADR 0081). It reads nothing the full answer
   does not and adds no state.
3. **The summary.** `{ apiVersion: 3, detail: "summary", freshnessAsOf,
   dataTypesVersion, dataTypes, sourceId, latestFetchRun, cells, accounts,
   unattributed, coverage }`:
   - `dataTypes`: the source's catalogue as each provider data type under
     its status (`collected`, `partial`, `notCollected`), or null where the
     catalogue does not describe the source. Dropped: each entry's parsers
     and tracking issue (in `full`).
   - `accounts`: one line per account, in the full answer's order (by id):
     `accountId` (what reads it further: `detail: "full"`, the identity
     pages), `label` (the stored label the full answer already shows),
     `statuses` (its mapping statuses), `freshness` (that of its newest named
     capture, as in `full`), `kinds` (its observation kinds),
     `dataTypes` (how many data types name it), `providerTypes` (the union
     of their provider data types), `periods` (`count`, and the smallest and
     largest named period, both null when none is named), `standings` and
     `cellStates` (its periods counted by standing and by cell state, each
     summing to `periods.count`), `newestCapturedAt` and `reasons` (the union
     of its periods' cell reasons). Dropped: each data type's dataset,
     parser and freshness, and each period's unit key, period kind and
     MyJCB state, current rule, capture run, observation count, own
     freshness and which reasons are on which period (all in `full`; ADR
     0045's cell summary drops the same per-period fields).
   - `unattributed`: after the accounts, one line per dataset, parser and
     fetch unit of the cells no observation attributes to an account, in
     order of first appearance, as the cell summary's lines are: `cells`,
     the first and last named period, the cells counted by state, and the
     union of their reasons.
   - `coverage`: `{ accounts, unattributedCells, lines, limit: 20, offset,
     truncated, nextOffset }`, the whole answer's account count,
     unattributed cell count and line count, and where the next page starts
     (null on the last page). `cells` is the full answer's.
   - Every closed state, reason, status, kind and provider data type of
     what a line collapses is on it, and every period and cell is counted
     once. Nothing in it is an amount, and no value that is not exact is
     shown as a count: a count here is of stored rows, and a freshness
     keeps its state and age as `full` has them (INV05). No provider text is
     added: the texts are the ids, label, datasets, parsers, unit keys and
     period labels `full` already shows.
4. **8 KB by construction.** A page holds the lines from `offset` in order,
   at most `ACCOUNT_SUMMARY_LINE_PAGE` (20), and stops before the line that
   would carry the tool's answer past `ACCOUNT_SUMMARY_BYTES` (8,192): the
   UTF-8 bytes of `{ schemaVersion: "kogane-page-read-v1", data }`
   serialized with `JSON.stringify`, as the MCP adapter writes the tool's
   text content (`pageReadAnswerBytes`; the route answers `data` alone, 47
   bytes shorter). A page that cannot hold its first line within that
   budget (texts near the schema's 512 characters, in multi-byte
   characters) is refused whole with `413 result_limit_exceeded`, as a read
   past its bound is, never cut; `detail: "full"` answers it.
5. **Wire check.** The validator (`validCollectionQualityResponse`, reached
   from `validApiResponse`) takes the detail a request asked for and accepts
   that shape only on the account path, as on the other paths: the page's
   `getJson` passes `detail=full`, so it refuses a summary. A summary passes
   only with every line's counts summing to its periods or cells, a
   `current` or `older-current` standing never exceeding its cell state's
   count, accounts sorted and before the unattributed lines, a page's
   `nextOffset` where its lines end (null exactly on the last page), an
   account's age that of its `newestCapturedAt`, and the answer within
   8,192 bytes.
6. **Audit.** The account view's record still counts the cells read (its
   `cells`), never an account; a summary page is `truncated` while more
   lines follow (`coverage.truncated`).
7. **Owner approval.** As point 5 of the decision: the tool's description
   and default answer, the route's default answer and queries are published
   changes, merged only with the owner's approval.

### Consequences

Measured as the bytes of the tool's answer (`pageReadAnswerBytes`, which
`services/app/test/mcp-answer-size.test.ts` checks against the real `/mcp`
result):

| Read                                                                                                                                                                                                          |      Full | Summary                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------- |
| `kogane.collection-quality.read` `{source: "sony-bank", view: "accounts"}`, synthetic store (one cell, no account named)                                                                                      |     1,639 | 1,162                                                               |
| realistic worst (62 accounts, each three data types of ten months, two statuses, a 64-hex id, a 30-character label and eight reasons a period; 140 unattributed cells of seven units; 2,000 cells, the bound) | 1,025,853 | 9 pages: six of 9 accounts at 7,817–7,819, then 8,100, 7,879, 2,572 |
| 25 accounts, every reason, status, kind and provider type, 200-character labels                                                                                                                               |         — | 10 pages, 3 to 9 lines, at most 7,987                               |

- An agent's first account read fits what its client shows and names the
  first accounts with their states; `offset` reads the rest, and
  `detail: "full"` (about 1 MB at the bound) or the identity reads give each
  period. Production was not read: the 107 KB above is issue 1414's
  measure of the full answer.
- The tool's description stays within the 2,048 characters a client
  accepts (2,040), shortened elsewhere to make room.
- A client of the route that relied on its full answer must ask for
  `detail=full`; the repository's only client, the web page, does.
- Open limits: the pages are separate reads at their own instant, not one
  snapshot (as the cell summary's): a capture or identity run recorded
  between two pages can move a line across a page boundary, and an age can
  change at midnight Asia/Tokyo, which can change where a page ends. A page
  ends where its own `nextOffset` says, so following it repeats or skips a
  line only when the answer itself changed between the reads, which
  `coverage.lines` then shows. A line whose texts alone pass 8 KB is
  refused, so the accounts after it are read with a larger `offset` or in
  `full`. Fewer lines a page fit than the line limit for accounts (about 9
  at the realistic worst), so a source with 62 accounts takes seven pages
  to list them.

### Verification

- `packages/application/test/collection-quality-detail.test.ts`: on the
  realistic worst above (`test/account-coverage-scale.ts`, whose full answer
  passes ADR 0088's wire check) every page passes the wire check under
  `summary` only and is within 8,192 bytes, and the pages list every
  account once in order, each line equal to its full entry's counts by
  standing and state, its statuses, kinds, freshness, newest capture and
  the union of its reasons and provider types, and every unattributed cell
  once with its reasons; the full answer is over 100 times 8 KB; the same
  with every reason, status, kind and provider type and 200-character
  labels, where the bytes end each page before the line limit; 45
  unattributed units, where the line limit ends them (20, 20, 5); an
  offset past the end answers an empty last page; an uncataloged source
  keeps `dataTypes` null; a line of 512-character multi-byte texts is
  refused (`CollectionQualityLimitError`); and a page that miscounts a
  standing or state, misorders accounts, misplaces `nextOffset` or
  `truncated`, drops a line, misstates an age, carries an unknown reason or
  another limit, puts an unattributed line before its accounts, or passes
  8 KB fails the wire check; and over 150 seeded random sources (labels and
  unit keys in multi-byte, four-byte and JSON-escaped characters, random
  reasons, unnamed periods) the walk from offset 0 lists every line once, in
  order, each page within 8 KB, and a page from a random offset lists the
  walk's lines there.
- `packages/application/test/account-coverage.test.ts`: every store answer
  of ADR 0088's tests (unresolved mappings, newest-not-current periods,
  corrected mappings, unattributed cells) also pages into summaries that
  pass the wire check under `summary` only and count every account, period
  and unattributed cell once.
- `packages/observation-shared/test/account-coverage-contract.test.ts`: each
  detail passes only where it was asked for and under its own source's path,
  and miscounted or mispaged pages fail.
- `services/app/test/mcp-answer-size.test.ts`: the account summary on the
  route equals `accountCoverageSummary` of the route's full answer, the tool
  answers it under `data`, its bytes are `pageReadAnswerBytes` of it and
  under 8 KB; `detail: "full"` with `offset` is refused on the tool and the
  route; the realistic worst pages under 8 KB through the envelope.
- `services/app/test/page-read-reports.test.ts`: the route, `/api/agent/v1/*`
  and `/mcp` give one body for the account view's default, `offset`,
  `detail: summary` with `offset` and `detail: full`; `detail: full` with
  `offset`, an unknown detail, another parameter and a repeated `offset` are
  `invalid_query`, a negative offset `invalid_offset`; the tool refuses
  `detail: full` with `offset` and an unknown detail; with a stored label
  in multi-byte, four-byte and JSON-escaped characters, the UTF-8 bytes of
  the text `/mcp` writes for the default are `pageReadAnswerBytes` of the
  route's body, and that text is the `/api/agent/v1` answer.
- `services/app/test/collection-quality-api.test.ts`: the route's full
  answer under `detail=full` and its summary by default, each passing the
  validator under its own detail only.
- `apps/web/test/collection-quality.browser.test.ts`: the synthetic server
  answers the account view only when asked for `detail=full`, and the page
  requests exactly `/accounts?detail=full`.
- `services/app/test/ui-mcp-parity.test.ts` passes unchanged: no route or
  tool was added, and the description keeps its pinned terms within 2,048
  characters.

## Amendment: cash per account and per bank in one call (`collection: cash`) (2026-11-20)

- Status: proposed. **Owner approval is needed before merge**: it changes the
  published input schema of `kogane.balances.read` (`collection` gains
  `cash`) and its description, adds `GET /api/v2/balances/cash` to the shared
  request schema (`LIST_REQUEST_SCHEMA`, `LIST_PATH_CAPABILITY`), and the MCP
  Portal needs its capabilities synced after the deploy.
- Date: 2026-11-20
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414), gap
  G4 of the everyday-questions audit (question Q2: "How much cash do I have
  across banks, per bank?")
- Carried by: `packages/application/src/query/cash-per-account.ts`,
  `cashPerAccountPage` in `services/app/src/balances-v2.ts`,
  `services/app/src/page-read-tools.ts`, `services/app/src/observation-api.ts`,
  `projectionMeasureSql` in `packages/read-model/src/balance-projection-sql.ts`
  with `measureRows` in `packages/storage-d1/src/read/reader.ts`, and the
  contract, validator and request schema in `packages/observation-shared`
- Builds on: [ADR 0120](0120-readable-account-labels.md) (one readable
  label per account entity), [ADR 0119](0119-cursor-page-size.md),
  [ADR 0081](0081-ui-parity-through-mcp.md),
  [ADR 0093](0093-direct-bank-deposit-disjointness.md) (the adopted set the
  known-assets subtotal and `holdings` share)

### Context

Q2 took `kogane.financial.query` `holdings` (one adopted figure per unit,
no account) and pages of `kogane.balances.read` `latest` for each account
(160 to 300 KB in production before this ADR's summary; two to four summary
pages after it), and the client had to pick the cash rows, group them by
account and bank and add them itself, which INV03 keeps in
`packages/domain`. Both reads already rest on one adopted set: the balance
projection adopts at most one measurement per subject and unit, and the
known-assets subtotal (`known-assets-subtotal-v1`) sums its `sum-disjoint`
asset-positive currency stocks with no overlap group, refusing a subject
counted twice in one unit (`subtotalCountKey`). That key is the projection
subject, which is the provider reference, not the account entity.

### Options considered

1. **`financial.query` `holdings` with `groupBy: account`.** Holdings has
   the grant-scope pairs and the same adopted figures, but no account
   organization (no entity, no ADR 0120 label: its executor reads no SQL),
   no as-of date per figure, and its answer envelope (context, resolved
   query, five quality dimensions) is several KB before a line. Grouping
   needs a new reader port for labels, a new projection read for dates and
   statuses, and a change to the query spec that `context.open` pins too.
2. **A new `kogane.cash.read` tool.** A new tool and route for a view of
   the same snapshot the balance read already serves; the plan and the
   owner prefer extending a tool.
3. **`kogane.balances.read` `collection: cash` and
   `GET /api/v2/balances/cash` (chosen).** The balance read already
   serves the snapshot under the routes' refusals, organizes rows with the
   ADR 0120 label, pages with the ADR 0119 cursor, and answers the
   known-assets subtotal; a third collection reuses each of them and adds
   only the grouping. `holdings` is unchanged.
4. **A `groupBy` on `collection: latest`.** The latest page is a keyset
   page of rows with its own `limit`, `metric` and `view` semantics; a
   grouped answer would change what each of them means on one route.

### Decision

1. **What is cash.** The known-assets subtotal's metrics, as a closed list
   (`CASH_METRIC_IDS`): `deposit.balance` (SBI Shinsei, SMBC, Mizuho),
   `broker.foreign-cash-deposit` (SBI Securities foreign cash, one per
   currency) and `exchange.cash-balance` (SBI VC Trade). A test pins the
   list to `knownAssetMetricIds()`, so a registry change that moves a
   metric in or out fails until this list follows. Every other latest
   measurement of the scope is left out under one closed reason, decided
   from its registry definition in this order: `metric_unknown`,
   `not_currency`, `not_a_stock`, `not_asset_positive`,
   `overlaps_another_measure`, `restates_a_balance`, `not_summable`
   (`CASH_LEFT_OUT_REASONS`). Today that leaves out Sony Bank's and Mobile
   Suica's balances (`restates_a_balance`: a balance after a transaction),
   PRESTIA's term-deposit principal and Sony Bank's gross aggregates
   (`overlaps_another_measure`), Mizuho's available balance and SBI's
   buying power (`not_a_stock`), and every card, reward and income measure.
   `not_summable` describes no registry metric today.
2. **One line per account.** `lines` holds one line per account entity
   (`account`, the 64-hex id, and `label`, the ADR 0120 label of its first
   reference), or per projection subject when the organization is
   unavailable (both null). An account reached through several provider
   references is one line with one `references` entry each (`source`,
   `sourceAccount`, `amounts`). Each amount is `{ observationId, metric,
   unit, value, scale, status, adoption, counted, asOf, reasons }`: an
   exact value has its decimal text and scale, one that is not has neither
   and keeps its status (INV05); `reasons` are `adoption:<code>`,
   `freshness:<code>` and `cash:account_reported_twice`, and a not-counted
   amount always has one. Lines are ordered by source, then label.
3. **What is counted (INV06).** An adopted exact amount, and only when it
   is the only adopted amount of its unit on its line and on its provider
   reference. Two adopted amounts of one unit on one account are both left
   uncounted with `cash:account_reported_twice`; the read never picks one.
   An aggregate beside its members, or one balance reached through a second
   route, is the projection's to keep out (`excluded`, with its code), as
   for the known-assets subtotal.
4. **Subtotals.** `subtotals.byUnit` and `subtotals.bySource` (source and
   unit) over the whole filter scope, the same on every page:
   `sumQuantities` of the counted amounts (INV03), `value` and `scale` null
   when nothing is counted (never a zero), `counted`, `notCounted`, `status`
   (`partial` when an amount is not counted for a reason other than
   `excluded`) and the not-counted amounts' `reasons`. Each source of a cash
   metric is one institution's own screen, so `bySource` is per bank. No
   unit is added to another, nothing is valued, and the page carries
   `liabilitiesCoverage: "unknown"` and no net worth.
5. **Left out.** `leftOut` has one entry per reason present: its row count,
   up to three metric ids with the most rows (`CASH_LEFT_OUT_METRICS`) and
   `moreMetrics`, the overview summary's bound.
6. **Read and paging.** One read of the snapshot's latest rows of the scope
   in compact columns (`measureRows`): the subtotal's scope and view
   predicates, its 5,000-row bound (`413 result_limit_exceeded` past it,
   never a partial answer; the bound counts every latest row of the scope,
   of every metric and state, where the subtotal counts its adopted exact
   rows, so the cash read is refused on a smaller scope than the one where
   the subtotal reports itself unavailable), and a plan that searches one
   snapshot through `current_balance_projection_order` without table
   statistics, on SQLite and on D1. Only the
   cash rows are organized. A page holds whole lines up to `limit`
   measurements (10 by default, the offered sizes of the balance read), so
   a line with more is a page alone, and fewer when the next line would
   carry the tool's answer past 8,192 bytes as `/mcp` writes it (the
   overview summary's and the account summary's rule); a page that cannot
   hold its first line is `413 result_limit_exceeded`. The cursor is the balance cursor
   (snapshot, READ instance, a digest of the route, `source`, `account`,
   `instrument` and `identityRead`), continues at any offered `limit` (ADR
   0119), answers `400 cursor_mismatch` with `mustMatch` otherwise, and
   carries a digest of the whole grouping (every line's key and label, and
   its references' observations): when an identity decision between two
   pages merges, splits, relabels or reorders any line of the scope, the
   cursor is `410 context_expired` instead of skipping or repeating a line
   or continuing under other subtotals.
7. **Arguments.** `source`, `account`, `instrument`, `identityRead`,
   `limit`, `cursor`; `metric`, `view` and `detail` are the route's
   `400 invalid_query` (one detail, its own lines). The snapshot, its
   refusals and the grant checks are the balance read's: `records.read`
   over the whole store, checked before any read, and `503` with the
   snapshot's closed code.

### Consequences

Measured as the UTF-8 bytes of the text `/mcp` answers (`{ schemaVersion,
data }` serialized, the page's own cursor included):

| Read                                                                                                                                                                                                                         |                      Bytes |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: |
| `{collection: cash}`, synthetic store of 30 cash accounts in four units over five sources (`test/cash-per-account-api.test.ts`), each page                                                                                   | 6,184, 6,713, 6,649, 2,961 |
| `{collection: cash}`, the answer-size store of #1414 (no cash metric: only `leftOut`)                                                                                                                                        |                        564 |
| first page, 30 accounts with 64-hex ids, 20-character labels, 48-character keys, half their amounts stale, two four-currency accounts, every registry metric left out (`packages/application/test/cash-per-account.test.ts`) |                      8,065 |
| the same, every account a one-currency deposit                                                                                                                                                                               |                      7,146 |
| the same, every account four currencies                                                                                                                                                                                      |                      5,529 |

- Q2 is one call: `bySource` and `byUnit` answer "per bank" and "in all"
  on the first page, and the lines page at about 6 to 8 KB.
- Every page is held to 8,192 bytes by construction (`CASH_PAGE_BYTES`,
  `cashPage`, and the validator): a page ends before the line that would
  carry the tool's answer past them, measured with its own cursor, so
  longer labels or provider keys, more sources holding several units or
  more reasons per amount make pages shorter, never larger. At the
  realistic worst above the measurements end the first page 127 bytes
  short of the bound; with 120-character labels and 200-character keys
  the bytes end it (nine pages of 30 accounts), and with 512-character
  labels and keys a page holds one account.
- Open limit: a page that cannot hold its first line within 8,192 bytes
  is `413 result_limit_exceeded`, never cut, with no hint beside the code
  (as the 5,000-row refusal: the read has no other `detail` to name, so it
  carries no `retryWith`). A line passes it with a label of thousands of
  characters, and nothing shortens a line. The header passes it with about
  50 source and unit pairs in `bySource` (each about 160 bytes, about 220
  with two reasons, so about 35 when every amount is stale), which every
  page repeats; `source` or `instrument` narrows `bySource` and `byUnit`
  to one source or one unit, and that header fits.
- Open limit and owner decision: the known-assets subtotal of the latest
  page and `financial.query` `holdings` key on the provider reference, so
  an account entity reached through two references of one source that the
  within-source policy lists apart is added twice there
  (`cash-per-account-api.test.ts` pins this: the latest page counts nine
  amounts where the cash read counts seven and names the two). The cash
  read is stricter by design; aligning the other two is a change to their
  published answers, left to the owner.
- The cash definition follows the known-assets policy: a bank whose only
  balance is a balance after a transaction (Sony Bank) or whose deposits
  are an overlap group (PRESTIA) has no cash line; `leftOut` names it.
  Counting such a balance is a registry and policy decision (ADR 0093's
  allow-list is the precedent), not this read's.
- The organization (entity, label) is the current identity's, not the
  snapshot's, as on the latest page.
- Open limit: `cash:account_reported_twice` is decided within the filter
  scope. An account entity whose two references fall on either side of a
  `source` or `account` filter has one of them in the filtered answer, and
  that one is counted there while the unfiltered answer counts neither.
  Within one answer nothing is added twice.
- No screen reads the route yet: like `kogane.changes.since`, it is an
  agent's everyday question; a page is a later slice. `ui-mcp-parity.test.ts`
  passes unchanged (the route is the mapped tool's).

### Verification

- `packages/application/test/cash-per-account.test.ts`: the cash metrics
  equal `knownAssetMetricIds()`; every other registry metric has one closed
  reason (the nearest measures named); left-out entries count rows and name
  their metrics; one line per account, an account with several units
  counted once in each, subtotals per unit and per source, never mixed; an
  account reached through two references counts once when the projection
  excluded one, and neither when both were adopted; one reference adopted
  twice in a unit is not added; an unparsed, unresolved or stale amount is
  a reason and a unit with nothing counted has no value; a snapshot behind
  CORE is partial; the validator refuses a counted amount that is not
  adopted, a zero subtotal, a partial subtotal or an uncounted amount
  without reasons, and a net worth; pages hold whole lines up to their
  measurements; the size rows above, measured with a cursor as long as the
  route's; past today's widths (labels of 120 and 512 characters, keys of
  200 and 512, `limit` 500) every page is within 8,192 bytes and the walk
  lists every line once; a line or a header that cannot fit is
  `CashPageLimitError`.
- `services/app/test/cash-per-account-api.test.ts`: every page is the same
  answer on the route, `/api/agent/v1/balances.read` and `/mcp`, validates,
  and is under 8 KB; the pages list 30 accounts once each with the same
  subtotals and left-out counts; the subtotals equal the latest page's
  known-assets subtotal unit by unit; source and unit filters; `metric`,
  `view` and `detail` refused; a cursor continues at 25 and is
  `cursor_mismatch` with `mustMatch` under another source and from a
  latest page; two references of one account are one line and not added;
  a cursor is `410 context_expired` after an identity decision moves a
  reference of a line past the cursor onto an account before it; the
  bytes measured are those of the text `/mcp` answers, `limit` 500 pages
  end at 8,192 bytes and list every account once, and an account whose
  label alone passes them is `413 result_limit_exceeded` on all three
  paths; the published description is within 2,048 characters and names
  every closed term.
- `packages/storage-d1/test/statement-plans.test.ts`: `projectionMeasureSql`
  under every filter searches one snapshot by key, without table
  statistics; `cash-per-account-api.test.ts` checks the same on the D1
  READ binding (no `sqlite_stat1`): a search of
  `current_balance_projection_order` by snapshot under every filter, no
  scan and no temporary sort. `packages/storage-d1/test/read-cursor.test.ts`:
  `measureRows` answers 5,000 rows and refuses 5,001.
- `services/app/test/mcp-answer-size.test.ts` measures the cash call among
  every read tool's default answer and keeps it under 8 KB; the schema pins
  (`agent-api.test.ts` unchanged: no property was added; `conformance.test.ts`,
  `apps/web/test/api-schema.test.ts`, `page-read-observations.test.ts`)
  gain the route.

## Amendment: the v1 grouped balance list answers a summary by default (2026-11-20)

- Status: proposed. **Owner approval is needed before merge**, as for the
  decision above: it changes the published input schema and the default
  answer of `kogane.observations.list` `{kind: "balances"}`, the default
  answer of `GET /api/balances` and of
  `POST /api/agent/v1/observations.list`, and the shared request schema
  (`LIST_REQUEST_SCHEMA` gains `detail` on `/api/balances` under the
  capability requirement `sharedQuery`).
- Date: 2026-11-20
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414),
  the first follow-up this ADR's consequences list
- Carried by: `balanceListSummary` in
  `packages/application/src/query/read-detail.ts`,
  `BALANCE_LIST_SUMMARY_LINES` and `BALANCE_LIST_SUMMARY_BYTES` in
  `packages/observation-shared/src/api-contract.ts`,
  `services/app/src/observation-api.ts`, `services/app/src/page-read-tools.ts`,
  `services/app/src/http.ts` (the `retryWith` hint),
  `packages/observation-shared/src/api-schema.ts`,
  `packages/observation-shared/src/api-validation.ts`, `apps/web/src/api.ts`

### Context

`kogane.observations.list` `{kind: "balances"}` answers `GET /api/balances`:
up to 500 latest grouped balances and up to 500 history rows, each row with
its organization, stored decimal and interpretation. On the synthetic store
of this ADR (120 balances) it is 538,779 bytes; with 60 accounts under long
Japanese labels and long provider metrics (180 balances) it is 929,049. Its
rows are the balance rows the v2 summaries already shape (`BalanceRow`, with
`organization` and `normalized`), but it has two lists paged by `offset` and
`latestOffset`, no registry metric id, and an `interpretation` record (the
group's evidence ids, its conflict, and a classification in closed codes
with a label and reason text) where the v2 pages have an adoption.

### Options considered

1. **The decision's pattern: `detail`, `summary` the default on the route
   and the tool, one pure function from the full answer, the web page asking
   for `full`, reusing the v2 summaries' line builder (chosen).** The route,
   the agent HTTP path and `/mcp` keep answering the same body for the same
   input (ADR 0081 point 2), and the account entries, amounts and history
   reasons come from the code that already shapes them.
2. **Keep the list full-only and document that agents read balances with
   `kogane.balances.read`.** Changes nothing published, but an agent that
   calls the list (the tool exists for every UI page, ADR 0081) still
   receives 0.5 to 1 MB it cannot see, and the v2 read answers
   `503 read_model_unavailable` until a snapshot is published, where the
   list answers from the request-time rows.
3. **Cap the list's page size or default (for example a `limit` of 10 rows
   a list).** Each row is about 2.2 KB in full (its organization, decimal
   and interpretation), so even four rows of each list pass 8 KB, and a
   `limit` on a v1 offset route would be a second paging contract beside
   `offset`; the rows would still carry their provenance.
4. **Within option 1, a fixed line count alone (as the v2 summaries do).**
   Ten lines of each list share one page here, and a line whose account and
   metric are both new costs about 900 to 1,000 bytes with the long names
   above, so twenty such lines are about 18 KB; a count small enough for
   that (four of each) pages a 500-row list in 125 calls on an ordinary
   store. A byte budget bounds the page whatever the names are.
5. **Within option 1, a page per list.** Two reads where the full answer is
   one, and no shared account entries between a balance's latest and
   history lines.

### Decision

1. **`detail` on the list.** `GET /api/balances` and
   `kogane.observations.list` `{kind: "balances"}` take `detail`, `summary`
   or `full`; absent is `summary`. `full` is the answer as it was, byte for
   byte and without a `detail` key; the web balances page asks for it
   (`useBalances`). Another value is `400 invalid_detail` on the route (as on
   the balance and overview routes) and `400 invalid_request` on the tool's
   closed schema; `detail` with `transactions`, `positions` or `artifacts`
   is the route's `400 invalid_query`, which the tool answers as its result.
2. **Where the parameter exists.** In the shared request schema under
   `sharedQuery`, as the overview's: the summary is shaped by the shared
   application service, so the central store accepts it, and the local store
   (and the demo export, which is the local store's) answers its full list
   alone and refuses the parameter. The web page builds its request through
   `useListRequest`, so it sends `detail=full` exactly where it is accepted.
3. **One function.** The route builds its full answer as before and, for
   `summary`, passes it with the request's `offset` and `latestOffset` to
   `balanceListSummary` (`read-detail.ts`), which the tool shares because it
   calls the route's reader (ADR 0081). The function builds its lines with
   the v2 summaries' line builder (`lines`, generalized to take the metric
   entry a page names), so an account entry, an amount and a history line's
   parse reasons are shaped by the same code as in `kogane.balances.read`.
   It reads nothing the full answer does not.
4. **The summary.** `{ detail: "summary", accounts, metrics, latest,
   history, coverage }`:
   - Lines: the first rows of each list of the full answer, latest and
     history taken in turn (latest 1, history 1, latest 2, ...), at most
     `BALANCE_LIST_SUMMARY_LINES` (10) of each, stopping before the line
     that would take the page's JSON past `BALANCE_LIST_SUMMARY_BYTES`
     (7,680 bytes in UTF-8; the tool result's text is the page inside the
     page read's envelope, `{"schemaVersion":"kogane-page-read-v1","data":
     ...}`, 47 bytes more, so it stays under 8 KB). Lines are left out from
     the end and read on the next page, never cut. When the first line alone
     (with its own account and metric entries) passes the budget, the read
     is refused, `413 result_limit_exceeded` with the closed hint
     `retryWith: { detail: "full" }`, as the other reads refuse rather than
     answer past 8 KB; so a page that answers holds at least one line
     whenever its window has one, and moves on.
   - A line is `{ observationId, account, metric, amount: { value, unit,
     status, scale }, asOf, reasons }`: the amount from the row's stored
     decimal under its row's unit (`instrument`), a value that is not exact
     as its status with no value and no scale (INV05). A latest line adds
     `duplicates`, the ids of the other observations its group folded in (the
     interpretation's evidence beside its own id), and the reason
     `interpretation:conflict` when its witnesses disagreed and were kept
     apart; a history line's reasons are `parse:superseded`, `parse:pending`
     and `parse:error`, as on the v2 history. Both are closed sets the
     validator holds the lines to.
   - `accounts` are the v2 summary's entries (source, provider account,
     entity, label, mapping status, lineage). A `metrics` entry is
     `{ source, providerMetric, kind, measurementKind, assetClass,
     timeBasis }`: the closed codes of the row's `interpretation.semantic`,
     null where an older policy release leaves one out. Each entry is keyed
     by all its fields, so a line never resolves to a classification its row
     does not carry, and both lists share one set of refs.
   - `coverage` has the full answer's keys for this page: `limit` is 10;
     `nextOffset` and `latestNextOffset` are the `offset` and `latestOffset`
     at which each list's next summary page starts, null when neither this
     window nor the full answer has more; `truncated` says either is not
     null. It adds `next`, the one hint a caller follows:
     `{ offset, latestOffset }` of the next page, null exactly when neither
     list has more. A list that has ended is given at its end, where it
     answers no line, so passing both offsets of `next` (with the same
     filters) until it is null reads every line of both lists once and never
     starts a list again, without knowing either list's length.
   - A row without its stored decimal or its interpretation, or a history
     row whose parse status is outside `parse_runs.status`'s closed set, is
     refused (the summary throws), never written as missing, zero or an
     unknown code. The central store lists every row with both.
   - Dropped: the interpretation's label, reason text and policy release;
     each row's provider amount text, legacy minor units, parser,
     `observed_at`, instrument organization and product claim; and
     `interpretationContext`. `kogane.observations.get` with a line's
     `observationId`, or `detail: "full"`, gives them.
5. **Owner approval.** As point 5 of the decision: the tool's input schema,
   its default answer, the route's default answer and the shared request
   schema are published changes, merged only with the owner's approval.

### Consequences

Measured as the bytes of the MCP result on `/mcp` (`structuredContent`,
which `content`'s text serializes):

| Read                                                                                                                      |    Full | Summary                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------: | --------------------------------------------- |
| `kogane.observations.list` `{kind: "balances"}`, the synthetic store above (120 balances on 12 accounts)                  | 538,779 | 7,420 (10 + 10 lines)                         |
| the same with 60 accounts, each with a 64-character Japanese label, a long provider key and three long metrics of its own | 929,049 | 7,705 first page (7 + 6 lines); at most 7,726 |
| pure, 500 rows a list, every line a new account and metric with the names above and every reason set (`read-detail` test) |       — | 6,838 (4 + 3 lines)                           |
| a line whose account label alone is 2,700 Japanese characters (`observation-list-limit` test)                             |       — | `413`, never a page over 8 KB (8,837 before)  |

- An agent's first balance list read fits what its client shows, and every
  row of both lists is read once by following `coverage.next`.
- A client of `GET /api/balances` that relied on the full default must ask
  for `detail=full`. The repository's clients are the web UI, which does,
  and the conformance checks, which read `detail=full` for the rows and check
  that the default is the summary exactly where `detail` is offered. Saved
  reports and the shared query do not read this route.
- Open limits. A line whose own account and metric names together pass
  about 7 KB (names of thousands of characters; the schema does not bound
  them, and nothing seen comes near) cannot be read in `summary`: the page
  where it comes first is `413 result_limit_exceeded` with
  `retryWith: { detail: "full" }`, and the caller reads that window in
  `full` (whose answer is not held to 8 KB). A summary page reads its full window, as
  `full` does (up to 5,000 candidates grouped and 500 history rows), so
  paging a 500-row list takes at least 50 such reads (10 of its lines a
  page), and about 140 when every line names a new account and metric with
  the long names above; `kogane.balances.read` (one snapshot, keyset paged)
  stays the cheaper read of balances. A caller that follows one list's own
  next offset and leaves the other offset out starts that other list again
  at 0 on every page, as in `full`; `coverage.next` carries both. Offset
  pages are fresh reads, not one snapshot: a row recorded
  between two pages can move lines across a page boundary, as in `full`.

### Verification

- `packages/application/test/balance-list-summary.test.ts`: a synthetic full
  answer line for line (latest and history in turn, one account entry for
  both lists, a folded duplicate's id, a conflict, a superseded and a failed
  parse, a value that is not exact as its status with its unit, a metric
  entry per classification); none of the interpretation's text, the
  provider amount text or a release in it; each shape passes the validator
  under its own detail only; each list's next offset at the line count,
  past a full window cut at 500, and null when nothing is left, and `next`
  with an ended list at its end; an empty list is an empty page; 500 rows
  a list with every line a new long account and metric stays under the
  byte budget and under 8 KB with the envelope, cut before the line cap,
  and paged through by `next` alone reads every id of both lists once in
  order; a first line over the budget alone (latest or history) is refused
  with `BalanceListSummaryLimitError`, the largest that fits is answered
  under it, and a later line that does not fit ends its page and is refused
  on the next; 300 fuzzed stores (lists of 0 to 560 rows, past the 500-row
  window, names short to long) walked by `next` alone through a model of
  the route read every row of both lists once, in `full`'s order, every
  page valid, under 8 KB and holding a line while one is left; a row
  without its decimal or its interpretation, or with a parse status outside
  the closed set, is refused; a summary that drops or repeats a ref, folds
  its own id or two ids, adds a conflict to a folded line, carries another
  reason, miscounts `truncated`, changes `limit`, holds eleven lines, names
  an unknown kind, writes a not-exact value as `"0"`, or leaves out `next`,
  gives it while nothing is left, withholds it while a list has more, or
  disagrees with a list's own next offset fails the validator.
- `packages/application/test/read-detail.test.ts` passes unchanged: the v2
  summaries' line builder answers as before.
- `services/app/test/mcp-answer-size.test.ts`: the list's default is under
  8 KB on the synthetic store and its full answer over ten times that
  (538,779 bytes, as before this amendment); the summary equals `balanceListSummary` of the full answer
  at the same offsets on the route, `/api/agent/v1/*` and `/mcp`, with and
  without offsets and a filter, and `detail: full` on the tool is the
  route's full body; paging on `/mcp` by `coverage.next` alone reads every
  row of both lists once with every page's text under 8 KB; every value
  that is not exact is its
  status with no value; `compact` is `invalid_detail` on the route and
  `invalid_request` on the tool, and `detail` on the other lists
  `invalid_query` on both.
- `services/app/test/observation-list-summary.test.ts`: the 60-account store
  above through `/mcp`: the first page is cut by its byte budget before the
  line cap, every page's text is under 8 KB and is its structured content's
  `data` at or under `BALANCE_LIST_SUMMARY_BYTES` plus exactly the 47-byte
  envelope (and the budget plus 47 is under 8 KB), and paging by
  `coverage.next` alone reads every row of both lists once.
- `services/app/test/observation-list-limit.test.ts`: a line whose account
  label alone passes the budget is `413 result_limit_exceeded` with
  `retryWith: { detail: "full" }` on the route, `/api/agent/v1/*` and
  `/mcp` alike, `full` answers its row, another account's summary is
  unaffected, and paging the whole list (the ordinary account's lines
  first) answers at least one page under 8 KB, the oversized line ending it
  rather than refusing it, until the page where that line is first, which
  is refused.
- `services/app/test/page-read-observations.test.ts`: the route and the tool
  give the same list under no detail, `summary` and `full`, and refuse
  `detail` on transactions and positions alike; `compact` is outside the
  tool's schema.
- The schema pins: `agent-api.test.ts` (the `kogane.observations.list`
  properties), `conformance.test.ts` and `apps/web/test/api-schema.test.ts`
  (`/api/balances` granted `detail` on the central store and nothing on the
  local store); the shared conformance checks read the rows under
  `detail=full` and check the default summary; the local store refuses
  `detail` (`experiments/observation-pipeline-local/test/api.test.ts`).
- `apps/web/test/api-transport.test.ts`: a page that asked for the full list
  refuses a summary; the tests that read the full list's rows
  (`api.test.ts`, `balances-v2.test.ts`, `balance-presentation.test.ts`,
  `publication-gate.test.ts`, `release-candidates.test.ts`, `load.test.ts`)
  ask for `detail=full`; the browser tests expect the page's request with
  `detail=full`.
