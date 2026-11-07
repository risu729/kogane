# ADR 0084: The operator's MCP principal acts with the operator's UI authority; MCP_DELEGATIONS is removed

- Status: proposed
- Date: 2026-11-07
- Decided by: the owner, 2026-11-07 06:00:39 UTC (15:00 JST)
- Supersedes: [ADR 0063](0063-delegated-ai-operation-path.md) items 2 (the
  `MCP_DELEGATIONS` declaration), 4 (roles and declared capabilities and
  scopes), the delegation part of item 11 (revocation) and its
  [2026-11-06 delegation-status amendment](0063-delegated-ai-operation-path.md#operator-delegation-status-amendment--2026-11-06-proposed)
- Amends: [ADR 0081](0081-ui-parity-through-mcp.md) point 3
- Keeps: ADR 0063 items 1, 3, 5–10 and 12 (authentication, no other door,
  risk classes, two-step confirmation, stale checks, idempotency, rollback,
  one implementation per command, reads, INV07); [ADR 0047](0047-mcp-client-connection.md)
  and [ADR 0064](0064-common-audit-log.md) unchanged

## Context

ADR 0063 made the owner's MCP identity able to apply operations only under an
entry the owner writes into the App variable `MCP_DELEGATIONS`: a role,
capabilities, three scope axes, `issuedAt`/`notAfter` (at most 90 days) and a
daily write budget, validated against `OPERATOR_SUBJECTS` and the principal's
`AGENT_API_GRANTS` read grant. The committed value has always been `""`, so no
MCP write has ever executed. ADR 0081 then made UI parity a rule, and the
Phase 2 card flow needed the first entry.

Asked on 2026-11-07 whether to keep the mechanism and add one entry for
Claude's MCP client, or to remove the mechanism so an authenticated agent can do
what the UI can, the owner answered 「仕組みをなくす」 (remove the mechanism),
06:00:39 UTC.

## Options considered

1. **Keep `MCP_DELEGATIONS` and add one entry.** Rejected by the owner. Every
   operation the UI gains would also need an entry change, and the entry's
   expiry would stop MCP every 90 days.
2. **Grade the MCP caller as the operator.** Rejected: it is the bare-`sub`
   fallback ADR 0047 removed. An MCP decision must stay distinguishable from
   the owner's own in the browser (actor `mcp-client:<sub>`, audit
   `path = mcp`).
3. **Any principal with an `AGENT_API_GRANTS` entry may operate.** Rejected: a
   read grant can be given to an agent that is not the operator; it would
   become operation authority by accident.
4. **Derive the authority from what the UI already uses (chosen).** The MCP
   principal `mcp-client:<sub>` may apply over MCP what `<sub>` may apply in
   the UI, inside its own read grant's scope, with everything else of ADR 0063
   unchanged.

## Decision

1. **No declaration.** `MCP_DELEGATIONS`, its parser, roles, lifetimes and
   entry limits are removed. The App no longer has the variable.
2. **Who.** `resolveDelegation` resolves only a verified `mcp-client:<sub>`
   caller (ADR 0047's MCP audience; a browser token, the HTTP agent route and
   a service token never resolve one). `<sub>` is graded by the UI's own
   resolver (`resolvePrincipal` over `OPERATOR_SUBJECTS` and `AGENT_GRANTS`):
   only a `human` (operator) subject resolves. A subject listed in both lists,
   or unreadable lists, is `delegation_misconfigured` (503), as the UI answers
   `grants_misconfigured`; anything else is `delegation_not_configured` (403).
3. **What.** Every operation capability of ADR 0063 item 4. There are no
   roles. R3 stays refused (`operation_not_delegable`: stopped-execution lease
   release, a maintenance deferral beyond 31 days) and R4 has no tool, as
   before.
4. **Where.** The scope is the principal's own `AGENT_API_GRANTS` read grant:
   `sources`, `accounts` and `scheduleSources` (absent means none). An
   operation therefore never reaches, or previews, what the same principal
   could not read. `commands.*` and `operations.projection.request` are held
   only when both `sources` and `accounts` are `"*"`, the rule ADR 0063 item 4
   applied to declarations.
5. **How much.** A fixed rolling-day budget of 200 writes per principal
   (`MCP_AUTHORITY.writesPerDay`), counted in the effect's own batch exactly
   as before. It is a runaway guard, not an authority; the UI has none.
6. **How long.** The resolved principal carries `notAfter` = request time +
   10 minutes. It bounds only that request's App→Processor envelope; every
   call resolves again, so removing the subject from `OPERATOR_SUBJECTS` or
   the grant takes effect on the next call. R2 confirmations keep their own
   10-minute window.
7. **Reference.** `delegationRef` = `dlg_` + the canonical digest of
   `{v: "kogane-mcp-authority-v1", principal, delegator, capabilities, scopes,
   budget}`. It has no clock, so a confirm binds to the authority its prepare
   recorded, and a changed grant scope voids an open prepare.
8. **Storage names stay.** The principal kind `delegated`, `delegation_ref`,
   CORE 0078's `actor_kind = 'delegated'`, the `delegated-audit:` decision
   reference and the presentation 委任された操作 are kept: they now mean "the
   operator's MCP principal". Renaming them would need migrations of
   append-only tables for no change in meaning.
9. **The delegation-status page is removed.** `GET /api/v2/delegations`, its
   contract `kogane-delegation-status-v1` and the notices on the schedules and
   confirm pages showed the table that no longer exists. `kogane.capabilities`
   keeps its `delegation` status (`kogane-delegation-capabilities-v1`), now
   computed from the derived authority.

**Revocation.** Remove the subject from `OPERATOR_SUBJECTS` (this also removes
its UI rights), remove or narrow the principal's `AGENT_API_GRANTS` entry,
remove the person from the MCP Access application's policy, or unset
`ACCESS_MCP_AUDIENCE`. Each takes effect on the next request; nothing applied
is deleted. There is no switch that stops MCP writes while keeping MCP reads.

## Consequences

- With the committed configuration, the owner's MCP identity
  (`mcp-client:2c440753-…`, grant `sources: "*"`, `accounts: "*"`, no
  `scheduleSources`) can plan, approve and commit card-settlement, relation and
  identity decisions, request imports, replays, projections, collections and
  session refreshes, and read its own operations, over MCP, as soon as this
  ships. Schedule writes stay refused until that grant gains a
  `scheduleSources` axis, which is a grant change for the owner.
- Merging this ADR's pull request changes production authority: it is the
  first time an MCP write executes. Its pull request needs the owner's OK.
- ADR 0063's per-delegation knobs (narrow roles, a shorter expiry, a smaller
  budget) are gone. Narrowing is done with the read grant's scope only.
- The roadmap rule "Delegations and grants are owner decisions and never part
  of an agent PR" becomes "Grants are owner decisions and never part of an
  agent PR".
- The 2026-11-07 decision to expose the delegations list over MCP (ADR 0081,
  "delegations list readable via audit.read") is moot: there is no list.

## Verification

Synthetic tests only: the application resolver (operator, agent, stranger,
both-lists, unreadable lists, missing or foreign read grant, narrowed and
whole-store scopes, reference stability and change, revocation, readiness and
the public status); the App's real Worker over the signed MCP transport (tool
listing for operator and non-operator subjects, R1 import/replay, R2 decision
and provider requests, the fixed budget exhausted with synthetic records, job
and maintenance writes under narrowed schedule scopes, refusal records); and
the unchanged browser routes. Not verified: anything in production or with a
real MCP client.
