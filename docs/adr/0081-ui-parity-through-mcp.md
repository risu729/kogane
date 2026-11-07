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
  `ops.*` entries list `mcp` only so that a refusal is recorded: the operations
  tools are never served on `/mcp`, and every such call is refused with
  `actor_not_supported`. In practice they are screen-only too. The catalogue
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
   A write over MCP still needs the owner's delegation under ADR 0063, with its
   confirmation class and audit record. Where ADR 0063 makes an R3 operation not
   delegable now, its MCP tool exists and refuses every call with a recorded
   refusal until that changes: `schedules.lease.release`, until the server can
   verify that an execution stopped. R4 is outside this rule: ADR 0063 gives it
   no tool and no route on any agent path, so the settings it lists (feature
   flags, session-refresh policy, survey page enablement, schedule bootstrap)
   stay with the operator even when a screen offers them. Grants, Access,
   delegations, secrets and deployment are R4 too.
4. **The inventory.** For recorded operations, each catalogue entry whose paths
   include `ui` also includes `mcp`, and its tool is published in the MCP tool
   list, refusing only as point 3 allows, unless it is R4. A repository test enforces both, so
   the `ops.*` entries no longer pass on a recorded refusal alone. Read pages
   are not catalogue entries: a second test compares the App's UI read routes
   with the MCP read tools through an explicit route-to-tool map, and fails on
   a route with no tool.

## Consequences

- Before the guard tests pass: `schedules.survey.decide` and
  `schedules.lease.release` need MCP tools (the second refusing as point 3
  says); the six `ops.*` operations need a served MCP tool under a delegation;
  read pages such as card settlements and the evidence browser need MCP reads;
  and the three tools that run their own SQL move it into `packages/application`.
  An inventory of screen operations and read pages against MCP tools is the first
  slice. It goes on the roadmap's parallel track A.
- Phase 2's card settlement accept and withdraw, and the ownership review, are
  done only when they also work over MCP under a delegation.
- New screens cost one more adapter each. Because both adapters call one service,
  the service's tests cover both paths. Each adapter tests only its own
  translation and authorization.
- MCP read tools return the service's result shape, not the UI's display shape.
  Display formatting stays in the web app.

## Verification

- Today: most MCP tools call shared services; three run their own SQL (above);
  no guard test exists yet.
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
