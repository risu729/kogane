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
| `kogane.balances.read` `{collection: latest}` (100 rows before, 25 after)                                                                                                                                                                                                                         |          297,410 |                     7,428 |               297,410 |
| `kogane.balances.read` `{collection: latest, limit: 50}`                                                                                                                                                                                                                                          |          148,821 |                         — |                     — |
| `kogane.balances.read` `{collection: history}`                                                                                                                                                                                                                                                    |          281,410 |                     7,392 |               281,410 |
| `kogane.schedules.read` `{}`                                                                                                                                                                                                                                                                      |           75,585 |                     4,249 |                75,585 |
| `kogane.collection-quality.read` `{}`                                                                                                                                                                                                                                                             |           28,235 |                     6,434 |                28,235 |
| `kogane.collection-quality.read` `{source}` (one synthetic cell)                                                                                                                                                                                                                                  |            1,044 |                       689 |                 1,044 |
| the same, 301 cells shaped like Vpass's (pure, in the test)                                                                                                                                                                                                                                       |        > 163,840 |   < 8,192 a page, 3 pages |                     — |
| `kogane.observations.list` `{kind: balances}`                                                                                                                                                                                                                                                     |          538,779 |                 unchanged |                     — |
| `kogane.schedules.maintenance.read` `{}`                                                                                                                                                                                                                                                          |           15,258 |                 unchanged |                     — |
| `kogane.store.read` `{page: overview}`                                                                                                                                                                                                                                                            |            9,234 |                 unchanged |                     — |
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
   temporal references, interpretation and organization records, policy
   releases (`interpretationContext`), occurrence lists, maintenance
   patterns, provider data type parser lists, terminals.
   - **Balances.** `{ schemaVersion, detail: "summary", accounts, metrics,
     items, page, dataCoverage, subtotals }`. An item is `{ observationId,
     account, metric, amount: { value, unit, status, scale }, asOf }`, with
     `freshness`, `adoption` (states) and `reasons` (`adoption:<code>`,
     `freshness:<code>`) on `latest`. `account` and `metric` are page-local
     refs (`a1`, `m1`, in order of first appearance) into `accounts`
     (`source`, `sourceAccount` — the key the `account` filter takes —,
     account entity id and label, both null when the organization is
     unavailable) and `metrics` (`source`, registry metric id, provider
     metric). A 64-hex account id, a label and a provider metric are written
     once per page, not once per row: a row then costs about 200 bytes. The
     page sizes become 25, 50, 100, 200 and 500; a summary defaults to 25
     rows, `full` to 100 as before. The page, its cursor, the coverage and the
     subtotals are the full page's.
   - **Schedules.** `{ detail: "summary", schedules, maintenance, leases }`:
     per job its id, source, kind, enabled, next run, reservation and newest
     occurrence (`nominalAt`, `status`, `failureCode`); per source its
     maintenance reference status and number of rules; every held lease.
     `kogane.schedules.read` still leaves out the route's `survey`, which the
     summary does not carry.
   - **Collection quality.** Without a source, one line per source (its
     freshness, newest fetch run, reasons, each job's newest receipt status
     and failure code, the number of unregistered collectors, the provider
     data types counted as collected, partial and not collected); sources
     whose lines would be equal share one line whose `sourceIds` names each.
     With a source, every cell is read (the cell read's pages at one instant,
     refused past 2,000 cells with `413 result_limit_exceeded`, never cut)
     and answered as one line per dataset, parser and fetch unit, collapsed
     over periods: how many cells and in which state, the first and last
     named period, the newest capture, the freshness of the newest current
     capture, and the union of the cells' reasons; 20 lines a page, `offset`
     counting lines, and `coverage` giving the cell and line counts.
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
- The summary validators (`packages/observation-shared/src/api-validation.ts`)
  accept either shape on the balance paths; a full page has no `detail`.
- Measured headroom: the default balance summary is about 7.4 KB with three
  accounts and ten metrics on the page; a page whose 25 rows name 25
  different accounts would pass 8 KB. A smaller `limit` is the remedy; the
  default stays at the proposal's 25.
- Left as they are, and over 8 KB at this scale: `kogane.observations.list`
  `{kind: balances}` (the v1 grouped list, about 520 KB),
  `kogane.schedules.maintenance.read` (about 15 KB) and `kogane.store.read`
  `{page: overview}` (about 9 KB); the collection quality account view (about
  107 KB for Vpass in production, issue 1414's proposal). Each is a follow-up
  of its own.
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
  every cell's state count and every reason.
- The existing tests that pin the full shape read `detail=full`
  (`balances-v2.test.ts`, `collection-quality-api.test.ts`,
  `page-read-reports.test.ts`, `page-read-schedules.test.ts`,
  `schedules.test.ts`, `audit.test.ts`); the published schema pins
  (`agent-api.test.ts`) and the request schema pins (`conformance.test.ts`,
  `apps/web/test/api-schema.test.ts`) gain `detail`; the browser tests'
  synthetic servers answer the three pages only when asked for `full`; and
  `ui-mcp-parity.test.ts` passes unchanged: no route or tool was added.
