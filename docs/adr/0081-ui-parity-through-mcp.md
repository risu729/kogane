# ADR 0081: Every operation the web UI offers is also an MCP operation, served by the same application service

- Status: accepted (merged 2026-11-07 in #1017)
- Date: 2026-11-07
- Decided by: the owner, 2026-11-07 03:59:50 UTC and 04:00:14 UTC
- Builds on: [ADR 0063](0063-delegated-ai-operation-path.md) (the delegated
  operation path), [ADR 0064](0064-common-audit-log.md) (the audit record),
  [ADR 0001](0001-domain-axes.md) (one shared query/command service)

## Context

On 2026-11-07 the owner decided:

- 「画面からできることはすべてagentができるべきです。mcp経由で。」 (everything
  that can be done from the screens should be doable by an agent, through MCP),
  03:59:50 UTC.
- 「mcpはraw dbを触るべきではなく、mcp, 画面共通のapiを利用するべき」 (MCP should
  not touch the raw database; MCP and the screens should use one common API),
  04:00:14 UTC.

This restates the 2026-10-09 requirement quoted in ADR 0063 (「基本的に人間が
できることはすべてAIができてほしい」) as a rule that every new screen operation
must follow, instead of a direction.

What the code does today (main `02a915a`):

- [`catalogue.ts`](../../packages/application/src/operation-path/catalogue.ts)
  lists each recorded operation with the paths it exists on. Two operations are
  on `ui` only: `schedules.survey.decide` and `schedules.lease.release`. The six
  `ops.*` entries list `ui` and `mcp`. On `/mcp` their tools are published to
  and run for a delegated caller only (since #660, ADR 0063 slice S3:
  `delegatedOpsTools` and `callDelegatedOpsTool` in `ops-tools.ts`, over the
  same `opsServices` as the HTTP routes). Without a delegation a call is
  refused with `delegation_not_configured` and recorded. (Corrected
  2026-11-07: this ADR first said they were never served and were refused
  with `actor_not_supported`.) The catalogue
  lists recorded operations only, not read pages. Read pages
  such as card purchases, card settlements and the evidence browser have HTTP
  routes for the UI; some have an MCP read tool and some do not
  ([agent API](../agent-api.md)).
- MCP tools in `services/app/src/read-tools.ts`, `delegated-*-tools.ts` and
  `ops-tools.ts` mostly call the shared application services in
  `packages/application`, passing them the D1 executor or command store. Three
  run SQL of their own through that store: the 24-hour audit count in
  `delegated-maintenance-tools.ts` and `delegated-schedule-tools.ts`
  (`SELECT count(*) n FROM audit_records WHERE principal=? …`), and the
  request lookup in `ops-tools.ts`
  (`SELECT source_id FROM ops_requests WHERE operation_id=? AND principal=?`).
- Writes over MCP execute only under a delegation the owner names in
  `MCP_DELEGATIONS`, within its capabilities, scope and expiry, through the
  common command layer and with an audit record (ADR 0063). The committed
  `MCP_DELEGATIONS` is empty.

## Options considered

1. **Parity as a rule, one service per operation (chosen).** Every operation a
   screen offers has an MCP tool. Both call the same application service. A
   screen operation without its MCP tool is incomplete.
2. **Parity as a direction.** Add MCP tools when someone asks. This is the
   current state, and it leaves screen-only operations such as the two above.
3. **MCP over the HTTP routes.** The MCP server would call the App's HTTP routes.
   This keeps one entry point, but couples MCP to UI response shapes and to the
   browser's Access session, and adds a network hop inside one Worker.

## Decision

1. **Parity.** Every operation the web UI offers, read or write, is also an MCP
   operation. A PR that adds or changes a screen operation adds or changes its
   MCP tool in the same PR, or the operation is not done. This includes
   approving, rejecting, withdrawing and settings changes, except the R4
   settings in point 3.
2. **One service.** The screen's HTTP route and the MCP tool are thin adapters
   over the same function in `packages/application` (or the domain/read-model
   function it wraps). An MCP tool never issues SQL, opens a D1 binding for its
   own queries, or reads R2 directly. It passes the store it was given to the
   shared service, as most existing tools already do. Results, refusals and error codes
   are the service's, so the UI and MCP give the same answer for the same input.
3. **Authority is unchanged.** Parity is about what exists, not who may use it.
   A write over MCP is applied by the MCP client's own principal under ADR
   0063's confirmation classes and audit record; since
   [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (2026-11-07)
   any MCP client Access verifies holds that authority over the whole store,
   with no `MCP_DELEGATIONS` declaration and no `AGENT_API_GRANTS` table. Where ADR 0063 makes an R3 operation not
   delegable now, its MCP tool exists and refuses every call with a recorded
   refusal until that changes: `schedules.lease.release`, until the server can
   verify that an execution stopped. R4 is outside this rule: ADR 0063 gives it
   no tool and no route on any agent path, so the settings it lists (feature
   flags, session-refresh policy, survey page enablement, schedule bootstrap)
   stay with the operator even when a screen offers them. Grants, Access,
   delegations, secrets and deployment are R4 too.
4. **The inventory.** For recorded operations, each catalogue entry whose paths
   include `ui` also includes `mcp`, and its tool is published in the MCP tool
   list, refusing only as point 3 allows, unless it is R4. A repository test
   enforces both. Read pages
   are not catalogue entries: a second test compares the App's UI read routes
   with the MCP read tools through an explicit route-to-tool map, and fails on
   a route with no tool.

## Consequences

- Before the guard tests pass: `schedules.survey.decide` and
  `schedules.lease.release` need MCP tools (the second refusing as point 3
  says); read pages such as card settlements and the evidence browser need MCP
  reads. (The three tools that ran their own SQL now call `packages/application`.)
  An inventory of screen operations and read pages against MCP tools is the first
  slice. It goes on the roadmap's parallel track A.
- Phase 2's card settlement accept and withdraw, and the ownership review, are
  done only when they also work over MCP under a delegation. (2026-11-07,
  plan unit 2g.2: they do, through the catalogue's existing `command.*`
  operations and their tools `kogane.command.plan`, `.simulate`, `.approve`
  and `.commit`, which an MCP client uses as itself since ADR 0084. No
  settlement-specific catalogue entry was added. Reject works the same way.
  `services/app/test/card-settlement-decisions-parity.test.ts` runs each
  decision on the page's path and over MCP and compares the receipts and
  refusals. A third guard in `ui-mcp-parity.test.ts` fails when a change kind
  becomes plannable that the MCP decision tools do not decide
  ([agent API](../agent-api.md#change-lifecycle-decisions)). It calls the
  App's, the Processor's and the writer's family gates, which all derive
  from one list, `DECISION_FAMILIES`.)
- New screens cost one more adapter each. Because both adapters call one service,
  the service's tests cover both paths. Each adapter tests only its own
  translation and authorization.
- MCP read tools return the service's result shape, not the UI's display shape.
  Display formatting stays in the web app.

## Verification

- Today: the three tools that ran their own SQL (above) call
  `delegatedWritesRemaining` and `operationSource` (named `ownOperationSource`
  until ADR 0086 made the read whole-store) in `packages/application`.
  The helpers they shared with the screens moved too:
  the agent service's scoped parse-run window is the read model's
  `sourceParseRuns`, the proposal store is `commandProposalStore` in
  `packages/application/src/propose-store.ts`, and the `sqlite_master` checks
  behind `kogane.capabilities` and the optional routes are `storeHasFeature`
  in `packages/application/src/query/store-schema.ts`. The identity pages
  that `kogane.identity.read` shares with `GET /api/identity/*` are
  `readIdentityPage` and `readIdentityConnections` in
  `packages/application/src/query/identity-pages.ts`, with the account
  connection reviews and preferred instrument names beside them; the route
  keeps only its query-parameter checks. The observation pages' helpers
  (organization, filter-option labels, normalized decimals, activity facts)
  are in `packages/application/src/query/` too, since the page reads call
  them, and so are the report catalogue's reads (`report-artifacts.ts`), the
  evidence browser's run and artifact reads (`evidence-catalogue.ts`) and
  the collection-quality page's table check (`storeHasFeature`).
  `tests/mcp-tools-no-sql.test.ts` follows the relative imports from
  `services/app/src/mcp.ts` and fails when a module it reaches calls a store
  or the D1 binding directly or holds a SQL statement. It can exempt, by name
  and with the reason, a module whose remaining SQL only screen routes call;
  since the evidence browser's reads moved, no module is exempt. No SQL an
  MCP tool runs is left in `services/app`. An exemption fails once its module
  holds no SQL.
- The six `ops.*` tools: `services/app/test/delegated-ops-parity.test.ts`
  checks that a delegation holding every `operations.*` capability is shown
  all six and a narrower one only those it holds, and that each request gives
  the same receipt and stores the same request over MCP as over its HTTP
  route (collection and session refresh after prepare and confirm), and that
  following it with `kogane.ops.operation.get` reads the same receipt.
- 2026-11-07 (first slice): the catalogue and read-route guards are in
  [`ui-mcp-parity.test.ts`](../../services/app/test/ui-mcp-parity.test.ts),
  with allow-lists of the gaps they found, among them 35 UI read routes with
  no MCP read
  ([agent API: parity guards](../agent-api.md#ui-and-mcp-parity-guards-adr-0081-2026-11-07)).
- After the first slice: the catalogue test fails when a `ui` entry lacks a
  published `mcp` tool, and the read-route test fails when a UI read route has
  no MCP read. A test per new tool compares its result with the HTTP route's result
  for the same synthetic input.
- 2026-11-07: `kogane.schedules.lease.release` is listed on `/mcp` while
  `SCHEDULES_ENABLED` is on and refuses every call with
  `403 operation_not_delegable`, recorded at R3 under `schedules.lease.release`
  on `mcp`, whose catalogue paths are now `ui` and `mcp`
  (`services/app/test/schedule-tools.test.ts`;
  [agent access](../agent-api.md#maintenance-windows)).
- 2026-11-07: `GET /api/v2/reconciliation/card-settlements` and its
  `/ownership` read call `readCardSettlementsForGrant` and
  `readCardOwnershipForGrant`, the functions `kogane.card-settlements.read`
  and `kogane.card-settlements.ownership` call, under the browser's reader
  grant ([amendment below](#amendment-one-request-rule-and-one-budget-for-the-card-settlement-reads-2026-11-07)).
- 2026-11-07: its `/statements` read (the list grouped by statement) calls
  `readCardSettlementStatementsForGrant`, the function the new
  `kogane.card-settlements.statements` calls, so the route leaves the read
  guard's gaps ([amendment below](#amendment-the-grouped-card-settlement-list-over-mcp-2026-11-07)).
- 2026-11-07: `schedules.survey.decide` is on `ui` and `mcp`
  (`kogane.schedules.survey.decide`, which an MCP client applies as itself under
  ADR 0084; five review reasons, and any disable, re-enable or overlap, kept
  with the operator), and the page's re-survey section is read by
  `kogane.schedules.survey.read`
  ([ADR 0050 amendment](0050-maintenance-survey-proposals.md#amendment-delegated-decisions-over-mcp-2026-11-07);
  `services/app/test/delegated-survey.test.ts`).

## Amendment 2026-11-07: raw evidence bytes over MCP

- Status: accepted (risu's choice on 2026-11-07, 05:59 UTC (14:59 JST), in
  the thread that added the UI read pages)

### Context

Point 1 requires an MCP read for every UI read page. The raw downloads
(`GET /api/raw/{sha256}` and
`/api/evidence/v1/runs/{run}/artifacts/{artifact}/raw`) stream an object's
bytes, which an MCP result can carry only as text; the other page reads
return an artifact's detail, never its bytes. The same question was asked of
the delegation status list (`GET /api/v2/delegations`).

### Options considered

1. Both over MCP: the delegation list under `audit.read`, the raw bytes under
   `evidence.read`, base64 inside `data` up to 1 MiB.
2. The delegation list only; the raw bytes stay screen-only, recorded as an
   exception to point 1.
3. Neither, both recorded as exceptions.

### Decision

risu chose option 1.

- `kogane.evidence.raw.read` returns one object named as either route names
  it (`sha256`, or `runId` and `artifactId`), resolved by the route's own
  reader, so it reaches exactly the objects the downloads do. It needs
  `evidence.read` over `"*"` sources and accounts. The answer is the object's
  artifact key, declared media type, size, SHA-256 and its bytes as standard
  base64, all under `data`: the bytes are provider content. The object passes
  the download's integrity checks, and the bytes read are hashed again and
  compared with the catalogue. An object over 1 MiB is refused before it is
  read (`413 raw_too_large`); the browser still downloads it.
- The delegation list read is not built. At 06:00 UTC (15:00 JST) the same
  day risu decided to remove the `MCP_DELEGATIONS` allow-list itself;
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) removed it
  together with `GET /api/v2/delegations` and the table it showed, so there
  is no list to read.

### Consequences

An agent with `evidence.read` can read any raw object the operator can
download, up to 1 MiB, with the same refusals. Every MCP client holds the
whole-store grant, `evidence.read` included (ADR 0084), so every client the
MCP Access application admits can read them. Each call
is an R0 read of one object in the audit log, which records the object's
count, never its bytes. `services/app/test/page-read-raw.test.ts` compares
the decoded bytes with both downloads and checks the refusals, the size
bound and tampered bytes.

## Amendment: one request rule and one budget for the card settlement reads (2026-11-07)

- Status: proposed
- Date: 2026-11-07

### Context

The `カード照合` page route `GET /api/v2/reconciliation/card-settlements` (and
`/ownership`) parsed its own query string and called the queries directly,
while `kogane.card-settlements.read` and `.ownership` called
`readCardSettlementsForGrant` and `readCardOwnershipForGrant`, which wrap the
same queries. The two answered one request differently, against point 2: an
`offset` of `-1` was `400 invalid_offset` on the route and
`400 invalid_query` over MCP, and the route read any offset up to 1,000,000
while a tool refused `offset + 50` above the grant's `maxRows` (1000) with
`413 budget_exceeded`.

### Options considered

1. **The route's rules for both.** The service would answer
   `invalid_offset` (a new code in the closed `financial-error-v1` list that
   `kogane.capabilities` publishes) and take no row budget from the page's
   grant, or a grant past `GRANT_LIMITS.maxRows`, which `validGrant` refuses.
   This widens a published agent contract and makes the operator page an
   exception to the per-call bound ADR 0084 keeps for every caller.
2. **Keep two rule sets, deep paging only for the operator.** The divergence
   this amendment removes.
3. **The service's rules for both (chosen).** The route is an adapter: it
   turns its query into the tool's arguments and reads under the reader grant
   a signed-in browser holds over every GET route (`readerGrant`), as the
   unmatched statements and account candidate pages already do. The budget is
   the grant's: the reader grant and every MCP client's full grant hold
   `maxRows` 1000, so both page to offset 950.

### Decision

Option 3. On the route, a malformed list or ownership request is the
service's `400 invalid_query` as `financial-error-v1` (was `invalid_offset` or
`invalid_query` as `{error, requestId}`), and a list read with `offset + 50`
above 1000 is `413 budget_exceeded` (was a page). The `/statements` grouping,
which has no MCP read yet, keeps its own rules until it gets one.

### Consequences

- The page, the agent HTTP route and MCP give one status and one body for the
  same request.
- The page does not read the flat list; a statement's
  candidates and a review's competitors are paged 50 at a time, 36 per
  statement on average on the scaled store. A statement or competitor list of more than
  1,000 candidates is readable only to offset 950, and the page's next-page
  link past it is refused. Raising that is a change to `GRANT_LIMITS` or to
  the read's paging, for both paths at once.
- Other routes keep `invalid_offset` until their own adapters are reviewed.

### Verification

`services/app/test/card-settlements-read-tools.test.ts` sends offsets -1, 0,
950, 951, 1,000,000, 1,000,001, 10^20, 1.5, non-numeric and empty to the
route, the agent HTTP route and MCP and gets one status and body on all three.
`services/app/test/card-settlements-api-differential.test.ts` runs the frozen
route handler (`card-settlements-api-frozen.ts`) beside the adapter on a
store of 1,101 candidates and finds every answer byte-identical except these
two changes; the existing route tests are unchanged.

## Amendment: the grouped card settlement list over MCP (2026-11-07)

- Status: proposed
- Date: 2026-11-07

### Context

`GET /api/v2/reconciliation/card-settlements/statements` (#1021) is what the
`カード照合` page reads first: ten statements a page, each with its candidate
count and its newest five candidates plus any accepted one, the one to look at
first leading. It had no MCP read, so it was a listed gap of the read-route
guard, and the amendment above left it on its own request rules until it got
one. `kogane.card-settlements.read` returns the same candidates, but
ungrouped, without the counts and without the lead the page chooses.

### Options considered

1. **A `view: "statements"` argument on `kogane.card-settlements.read`.**
   One tool for the page's route family. But the grouped answer has another
   shape (`statements`, not `items`), takes `offset` only, and pages ten
   statements instead of 50 reviews, so the tool's published input schema
   would have to allow combinations the service then refuses, its result would
   be one of two shapes, and its audit row count would mean two things.
   Elsewhere `view` selects rows within one answer shape
   (`kogane.accounts.candidates`, and the measure view of the UI read pages on
   main), not another page.
2. **A sibling tool, `kogane.card-settlements.statements` (chosen).** As
   #1031 did for `/ownership` and #1029 for the unmatched statements: in the
   card settlement family each route has its own tool, input schema, catalogue
   operation and audit row count, and `CARD_SETTLEMENT_TOOL_NAMES` serves them
   on one condition. The existing tool's published schema is unchanged.
3. **Keep the gap.** Against point 1.

### Decision

Option 2. `readCardSettlementStatementsForGrant` in
`packages/application/src/query/card-settlements-read.ts` takes the request
and the grant, grades `records.read` on a whole-store scope as the other two
reads do, refuses any key but `offset` and any `offset` that is not an integer
from 0 to 1,000,000 with `400 invalid_query`, and an `offset + 10` above the
grant's `maxRows` with `413 budget_exceeded`, before it reads; it then calls
the unchanged `queryCardSettlementStatements`. The route and the tool are
adapters over it, as the amendment above decides for the other card settlement
reads. The new catalogue operation `card-settlements.statements` is R0,
`records.read`, on the agent paths, and its audit record counts the
statements on the page.

### Consequences

- A malformed grouped request is `400 invalid_query` as `financial-error-v1`
  where the route answered `invalid_offset` or `invalid_query` as
  `{error, requestId}`, and a grouped page past offset 990 is
  `413 budget_exceeded` where the route read on. Every page below that depth
  is unchanged byte for byte.
- No SQL moved or changed: the service calls the query the route called.
- The new tool is a catalogue and MCP addition, which the owner approves
  before it merges.

### Verification

`services/app/test/card-settlements-api-differential.test.ts` compares the
route with the frozen handler (`card-settlements-api-frozen.ts`) on the
existing requests, and `card-settlement-statements-differential.test.ts` on
every tenth grouped offset from 0 to 1,000 over 1,002 statements, and finds
every page below offset 990 byte-identical and every deeper one, which the
frozen handler served, refused. `services/app/test/card-settlements-read-tools.test.ts` sends the
grouped list's offsets 0, 990, 991, 1,000,000, malformed offsets and every
other key to the route, the agent HTTP route and MCP and gets one status and
body on all three, and checks the listing, the absence while the route is not
served, and the R0 audit records. `services/app/test/ui-mcp-parity.test.ts`
maps the route to the tool. `packages/application/test/card-settlements-read.test.ts`
covers the service's refusals before any read.

## Amendment: one pre-check for the MCP approve and commit tools (2026-11-08)

- Status: proposed
- Date: 2026-11-08

### Context

`kogane.command.approve` and `kogane.command.commit` are R2: a `prepare`
returns a `cfm_` digest and a `confirm` with it forwards to the Processor's
command route, which runs `approve` or `commit`, as the page's
`/api/command/v1/approve` and `/commit` do. Before the Processor was called,
the tools ran a check of their own in `services/app/src/delegated-decision-tools.ts`,
at `prepare` and again at `confirm`: plan expiry, plan status, digest,
`simulate` (refusing a failed or stale report), then the caller's own
approval. Against point 2 it answered differently from `approve` and
`commit`:

- with the code alone, never the `refs` the lifecycle gives (`plan_expired`
  without the plan id, `target_missing` without the subject);
- in another order: an ended override release with an expired approval was
  `target_missing` over MCP and `approval_expired` on the page's path, and a
  wrong digest on an expired plan `plan_expired` against `stale_context`;
- with other codes: an approval another principal holds was
  `approval_not_found` (the tool read only the caller's own) against
  `approval_required`, and an operation id the caller already completed was
  `plan_not_open` against the completed receipt as a replay;
- with other writes: a refused `confirm` never reached `approve` or `commit`,
  so a plan whose pins moved was not marked `stale` as the page's path marks it.

### Options considered

1. **Keep the tool's check and add refs.** Two lists of the same checks to
   keep in step by hand; the order and the codes would drift again.
2. **No pre-check: forward every `prepare` and `confirm`.** A `prepare` has
   no Processor call to make (it issues a digest and writes nothing to the
   change lifecycle), so it could only refuse what it checks itself.
3. **One pre-check in packages/application (chosen).** `approve` and `commit`
   are split into the caller's authority, a pure-read pre-check of the loaded
   plan and approval (`approvalPrecheck`, `commitPrecheck`, and
   `reversalCheck` for a delegated reversal), and the write. The tools call
   `previewApproval` / `previewCommit`, which run those same functions and
   then the simulation step.

### Decision

Option 3. Both paths run one function for every check of the plan and the
approval, so a refusal is one code, one set of refs and one order for every
input, at `prepare` and at `confirm`. A `confirm` checks its confirmation,
then the pre-check, and leaves every refusal the lifecycle gives to the
Processor, so its answer and what it records (a moved plan marked `stale`)
are `approve`'s or `commit`'s own. A `prepare` that finds a completed
operation answers with its receipt as a replay, as `commit` does. The
caller's authority stays each path's own (the operator's grant on the page's
path, the MCP client's capability and confirmation over MCP), as point 3
keeps it.

The R2 step keeps two differences, both written down in
[agent API](../agent-api.md#change-lifecycle-decisions):

- **The simulation step.** The confirmation page offers 承認 and 確定 only on
  a `simulate` report that loaded and is not stale (`Confirm.tsx`); the
  routes do not re-check it. A `prepare` returns that report as its preview,
  so the tools refuse, after every lifecycle check, a plan whose simulation
  fails (with the simulation's code and refs) or whose re-derived plan differs
  while no pinned revision moved (`stale_context` with the plan id), at
  `prepare` and at `confirm`. It adds a refusal only where the routes accept.
- **`prepare` writes nothing to the change lifecycle.** A plan whose pins
  moved is refused with the same `stale_context` and refs, but `approve`
  (and `commit` at its batch) also marks it `stale`; a `prepare` does not,
  as the page's own `simulate` does not. The App is not that table's writer.

### Consequences

- The two limits [agent API](../agent-api.md#change-lifecycle-decisions)
  recorded (a tool refusal without `refs`, and another order for an input
  with several refusals) are gone.
- Answers that change over MCP (the page's path is unchanged): every
  lifecycle refusal gains its refs; `approve`'s order is pinned, temporal,
  digest, expiry, status, eligibility, moved pins (was expiry, status,
  digest, simulation); `commit`'s is pinned, completed receipt, temporal,
  expiry, status, approval (found, same plan, same principal, expiry, uses,
  scope), eligibility, reversal (was reversal, expiry, status, simulation,
  approval); another principal's approval is `approval_required`; an
  invalid reversal is `stale_context` with the plan id and `revert_invalid`,
  as `commit` answers it (was `revert_invalid`); `approval_scope_mismatch` is
  `409`, the lifecycle's status (was `403`); a `confirm` checks its
  confirmation before the pre-check, since the Processor's delegated route
  runs `approve` or `commit` only for a verified confirmation, so an invalid,
  used or expired confirmation is answered with its own code even where the
  lifecycle would refuse the plan too (was the lifecycle's code first).
- A `prepare` that answers a completed operation's receipt issues no
  confirmation and is recorded `replayed` (step `call`, refs
  `operation:<id>`), which no write budget or audit cap counts.
- A new lifecycle check is one edit in `approve.ts` or `commit.ts`, and both
  paths have it.

### Verification

`services/app/test/command-precheck-parity.test.ts` runs, over the real App
Worker and the Processor's command route, the page's `approve` or `commit`,
the tool's `prepare` and the tool's `confirm` of a digest prepared while the
plan could still be decided, on inputs with several refusals: an ended
release with an expired plan, an expired approval or a spent approval; a
moved plan with an expired plan or an expired approval; a wrong digest on an
expired plan; another plan's approval on an ended release; another
principal's approval; and a completed operation. Every answer has the same
code and refs, with each path's own plan and approval ids named. Before the
change all 14 cases failed. A fifteenth case pins the `confirm` order: an
expired confirmation on an expired plan is `confirmation_expired`.
