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
  `delegatedWritesRemaining` and `ownOperationSource` in `packages/application`.
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
