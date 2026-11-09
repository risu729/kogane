# ADR 0084: Every MCP client Access verifies acts with the UI's authority; MCP_DELEGATIONS and AGENT_API_GRANTS are removed

- Status: accepted (merged 2026-11-07 in [#1034](https://github.com/risu729/kogane/pull/1034))
- Date: 2026-11-07
- Decided by: the owner, 2026-11-07 06:00:39 UTC (15:00 JST), 06:32:23 UTC
  and 06:32:43 UTC (15:32 JST)
- Supersedes: [ADR 0063](0063-delegated-ai-operation-path.md) items 2 (the
  `MCP_DELEGATIONS` declaration), 4 (roles and declared capabilities and
  scopes), the delegation part of item 11 (revocation) and its
  [2026-11-06 delegation-status amendment](0063-delegated-ai-operation-path.md#operator-delegation-status-amendment--2026-11-06);
  the `AGENT_API_GRANTS` table of [ADR 0047](0047-mcp-client-connection.md)
  and the agent API (`docs/agent-api.md`, A08)
- Amends: [ADR 0081](0081-ui-parity-through-mcp.md) point 3
- Keeps: ADR 0063 items 1, 3, 5–10 and 12 (authentication, no other door,
  risk classes, two-step confirmation, stale checks, idempotency, rollback,
  one implementation per command, reads, INV07); ADR 0047's separate MCP
  Access application and audience; [ADR 0064](0064-common-audit-log.md)
  unchanged

## Context

ADR 0063 made the owner's MCP identity able to apply operations only under an
entry the owner writes into the App variable `MCP_DELEGATIONS`: a role,
capabilities, three scope axes, `issuedAt`/`notAfter` (at most 90 days) and a
daily write budget, validated against `OPERATOR_SUBJECTS` and the principal's
`AGENT_API_GRANTS` read grant. The committed value has always been `""`, so no
MCP write has ever executed. Reads were graded by `AGENT_API_GRANTS`, a table
from principal to scopes, capabilities and budget; the committed table gave
the owner's MCP identity `summary.read` and `records.read` over the whole
store with 100 rows. ADR 0081 then made UI parity a rule, and the Phase 2 card
flow needed the first delegation entry.

The owner decided, on 2026-11-07:

- 06:00:39 UTC, asked whether to keep `MCP_DELEGATIONS` and add one entry or
  to remove the mechanism: 「仕組みをなくす」 (remove the mechanism).
- 06:32:23 UTC, on the review finding that nothing would stop MCP writes while
  keeping MCP reads: "i'll control them in the mcp settings in the mcp client,
  so fine".
- 06:32:43 UTC: 「本番グラントみたいなサーバー側でコントロールする仕組みもいったん消して。
  必要になったら追加しますが、個人利用なので今のところ不要」 (remove server-side control
  such as the production grant too, for now; it will be added when needed, but
  for personal use it is not needed at present).

## Options considered

1. **Keep `MCP_DELEGATIONS` and add one entry.** Rejected by the owner. Every
   operation the UI gains would also need an entry change, and the entry's
   expiry would stop MCP every 90 days.
2. **Grade the MCP caller as the operator.** Rejected: it is the bare-`sub`
   fallback ADR 0047 removed. An MCP decision must stay distinguishable from
   the owner's own in the browser (actor `mcp-client:<sub>`, audit
   `path = mcp`).
3. **Derive the authority from `OPERATOR_SUBJECTS` and the read grant.** The
   first version of this ADR (06:00 UTC): only the operator's own MCP
   principal operates, inside its `AGENT_API_GRANTS` scope. Superseded by the
   owner's 06:32:43 UTC decision, which removes the read grant table too.
4. **No server-side table at all (chosen).** Cloudflare Access on the MCP
   application decides who reaches `/mcp`. Whoever it lets in is the
   agent-only `mcp-client:<sub>` and reads and operates over the whole store,
   as the browser's signed-in user does. Which tools an agent uses is set in
   the MCP client.

## Decision

1. **No table.** `MCP_DELEGATIONS` and `AGENT_API_GRANTS` are removed, with
   their parsers (`parseDelegations`, `parseGrants`, `grantFor`), roles,
   lifetimes and entry limits. The App no longer has either variable. A
   leftover value in a deployment is ignored.
2. **Who.** Every caller the Access gate proved. On `/mcp` that is only an
   identity from the MCP Access application (ADR 0047's separate audience; a
   browser token or a service token is refused), as `mcp-client:<sub>`. On
   `/api/agent/v1/*` it is the browser session's subject. The operator lists
   (`OPERATOR_SUBJECTS`, `AGENT_GRANTS`) grade the UI's routes, including the
   browser's HTTP agent routes (item 3); they neither add nor remove MCP
   authority, and an MCP principal is still never graded as the operator
   (ADR 0047).
3. **Reads.** Every MCP client holds the whole-store grant (`fullGrant`):
   `sources`, `accounts` and `scheduleSources` are `"*"`, every capability of
   the read vocabulary (`summary.read`, `records.read`, `audit.read`,
   `evidence.read`, `interpretation.propose`, `schedules.read`), and the
   published bounds (`GRANT_LIMITS`: 1000 rows, 50 proposal targets, explain
   depth 8). A browser session on `/api/agent/v1/*` holds what the UI gives
   its subject (`agentGrant`): the operator the same whole-store grant; a
   subject in `AGENT_GRANTS` the GET routes' reader grant (`summary.read`,
   `records.read`, `evidence.read` over `"*"`) plus `interpretation.propose`,
   as on the command routes; anyone else, or a deployment whose lists cannot
   be read, the reader grant alone. So the HTTP agent routes reach the audit
   log and maintenance windows only for the operator, as the UI does. The
   browser's GET routes keep their own reader grant.
4. **Operations.** `resolveDelegation` takes only the verified caller and the
   clock. Any `mcp-client:<sub>` whose subject has the actor shape resolves,
   with every operation capability of ADR 0063 item 4 over the whole store.
   A browser caller never resolves (`delegation_not_mcp_client`). There are no
   roles. R3 stays refused (`operation_not_delegable`: stopped-execution lease
   release, a maintenance deferral beyond 31 days), R4 has no tool, and R2
   keeps its prepare/confirm step, as before.
5. **Runaway guards.** A fixed rolling-day budget of 200 writes per principal
   (`MCP_AUTHORITY.writesPerDay`), counted in the effect's own batch as
   before, and the 1000-row read bound of item 3. They are not authority: they
   stop a looping client, and the owner may ask to remove them.
6. **How long.** The resolved principal carries `notAfter` = request time +
   10 minutes. It bounds only that request's App→Processor envelope; every
   call resolves again. R2 confirmations keep their own 10-minute window.
7. **Reference.** `delegationRef` = `dlg_` + the canonical digest of
   `{v: "kogane-mcp-authority-v2", principal, delegator, capabilities, scopes,
   budget}`. It has no clock, so a confirm binds to the authority its prepare
   recorded, and to its own principal: another MCP client cannot confirm it.
8. **Storage names stay.** The principal kind `delegated`, `delegation_ref`,
   CORE 0078's `actor_kind = 'delegated'`, the `delegated-audit:` decision
   reference and the presentation 委任された操作 are kept: they now mean "an MCP
   client acting as itself". Renaming them would need migrations of
   append-only tables for no change in meaning.
9. **The delegation-status page is removed.** `GET /api/v2/delegations`, its
   contract `kogane-delegation-status-v1` and the notices on the schedules and
   confirm pages showed the table that no longer exists. `kogane.capabilities`
   keeps its `delegation` status (`kogane-delegation-capabilities-v1`), which
   now says only which operations this deployment has installed.
10. **The scope machinery stays.** The shared services still take a grant and
    still enforce source, account and schedule scopes and capabilities, with
    their tests. Only the tables that configured them are gone, so a narrower
    grant can be added back when it is needed.

**Revocation.** Remove the person from the MCP Access application's policy, or
unset `ACCESS_MCP_AUDIENCE`. Either takes effect on the next request; nothing
applied is deleted. The owner controls which tools an agent may call in the
MCP client's own tool settings. There is no server-side switch that stops MCP
writes while keeping MCP reads.

## Consequences

- Anyone the MCP Access application admits can read everything and apply
  every operation the UI offers (except R3 and R4) over MCP, as soon as this
  ships. Today that policy admits only the owner. Adding a person to it is
  now an authority change, not only a sign-in change.
- A browser session on `/api/agent/v1/*` no longer needs a table entry: the
  operator gets the whole-store grant there, and any other signed-in subject
  the reader grant the GET routes already gave it. That includes
  `purchases.explain`, which needs only `records.read` over `"*"`, although
  the UI's card-purchases page is the operator's; the same rows are already
  readable to that subject on the GET routes.
- The owner's MCP identity gains schedule writes and the audit, evidence and
  schedule reads it did not have under the committed grant, and its read
  bound grows from 100 to 1000 rows.
- Merging this ADR's pull request changes production authority: it is the
  first time an MCP write executes. The owner gave the OK at 06:32:23 UTC,
  after the review and green CI.
- ADR 0063's per-delegation knobs and the per-principal read grants are gone.
  The `agent_api_not_configured` refusal no longer exists.
- The roadmap rule "Delegations and grants are owner decisions and never part
  of an agent PR" becomes "Grants (`AGENT_GRANTS`, `OPERATOR_SUBJECTS`),
  Access policies and secrets are owner decisions and never part of an agent
  PR".
- The 2026-11-07 decision to expose the delegations list over MCP (ADR 0081,
  "delegations list readable via audit.read") is moot: there is no list.

## Verification

Synthetic tests only:

- The application resolver: any verified MCP client resolves; a browser
  caller or a malformed principal does not. Also the reference's stability and
  its change by principal, readiness, and the public status.
- `fullGrant`, and that no committed configuration declares a table.
- The App's real Worker over the signed MCP transport:
  - tool listing for every subject, whatever the operator lists say;
  - a leftover `AGENT_API_GRANTS` value that changes nothing;
  - R1 import and replay, R2 decision and provider requests;
  - the fixed budget exhausted with synthetic records;
  - job and maintenance writes;
  - refusal records;
  - another principal unable to confirm or replay one's prepare.
- The execution path given a narrower scope directly (cross-boundary tests).
- The unchanged browser routes.

Not verified: anything in production or with a real MCP client.
