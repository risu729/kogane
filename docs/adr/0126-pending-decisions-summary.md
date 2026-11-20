# ADR 0126: One compact list of what waits for the owner's decision, as `kogane.decisions.pending` and on ホーム

- Status: proposed. A new published MCP tool (`kogane.decisions.pending`) and
  a new operator route: **the owner's approval is needed before merge**, as for
  every published tool change. The owner allowed new tools where needed for
  issue #1414 (2026-11-19, "you may add new tools if needed"); that allows the
  proposal, not this tool.
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414), gap G9
  of the MCP everyday-questions audit (`docs/plans/2026-11-mcp-everyday-questions.md`,
  proposed in its own pull request; question Q20, "what is waiting for my
  decision?")
- Related: [ADR 0081](0081-ui-parity-through-mcp.md) (UI/MCP parity, one
  service), [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (MCP
  clients hold the operator's authority), [ADR 0001](0001-domain-axes.md)
  (INV05, INV07), [change lifecycle](../change-lifecycle.md)

## Context

The owner asked for MCP improvements so that everyday questions take one or
two calls, each answer under 8 KB (#1414). "What is waiting for my decision?"
took about five calls and 150–400 KB on main (`c9cd0c9`): the grouped card
settlement list, the account and instrument candidate reviews, the purchase
explanation pages (pending-to-posted candidates) and the re-survey read, each
shaped for its page, and the client had to find the open items in each and
count them. No page gathered them either: the 確認 page (`/confirm/:planId`)
shows one plan, and ホーム shows the evidence store's counts.

What waits for a decision today, by the change lifecycle and the review pages
(main `3ec7454`):

- card settlement candidates no decision names, per statement (カード照合,
  `card-settlement.accept` / `.reject`);
- accounts those candidates need an ownership decision for (the ownership
  review, `relation.accept` of `liable_party` / `beneficial_owner`, ADR 0082);
- proposed account connection candidates, `open` and `held` (ADR 0077);
- proposed instrument candidates, `open` and `held` (ADR 0055);
- stage-B `pending_to_posted` proposals (the pending-to-posted link review);
- re-survey proposals no decision names (ADR 0050);
- change plans planned or approved and not yet expired (the 確認 page).

Not decidable or not listed today: own-transfer and economic-event proposals
(no planner registered, `ECONOMIC_EVENT_PLANNERS` is empty); the card
purchase review kinds (refused until a planner exists); relations an agent
recorded with `kogane.reconcile.propose` (no page or tool lists them, and
`entity_relations` has no index on status); unresolved account mappings
(nothing proposes a mapping).

## Options considered

1. **A view on an existing tool.** `kogane.store.read` (`overview`) is the
   evidence browser's store overview, served by the observation API rather
   than `packages/application`, and its page is about observations; the
   command tools read or decide one plan; `kogane.capabilities` reports the
   grant. Each candidate review is shaped around one queue. None fits without
   giving a tool a second subject.
2. **A new read tool with its own route and one shared service (chosen).**
   `kogane.decisions.pending`, `GET /api/v2/decisions/pending` and the ホーム
   page's `判断待ち` panel all call `readPendingDecisions`.
3. **Count in the client from the existing tools.** The current state; five
   calls and up to 400 KB.

## Decision

1. **One service.** `readPendingDecisions`
   (`packages/application/src/query/pending-decisions.ts`) answers
   `kogane-pending-decisions-v1`: one line per kind, in the closed order of
   `PENDING_DECISION_KINDS` (`packages/domain/src/pending-decisions.ts`):
   `card-settlement.statement`, `card-ownership.account`,
   `account-candidate.open`, `account-candidate.held`,
   `instrument-candidate.open`, `instrument-candidate.held`,
   `pending-posted.link`, `maintenance-survey.proposal`, `change-plan.open`.
   The route (operator-only, the operator reading with the authority of
   ADR 0084), the agent HTTP route and the MCP tool are adapters over it, and
   the panel reads the route (ADR 0081 point 2). `/api/meta` advertises the
   route as the `pendingDecisions` capability, and the panel reads it only
   where it is advertised, so a store without it (the local evidence
   browser) is never probed. The answer carries no total;
   the panel's header sums the counted lines and says `以上` when a line is
   cut at its bound or is `unavailable` for any reason but `not_served`, so
   it never reads as complete when it is not (INV05).
2. **A line.** `count`, `complete` (false when the count reached
   `countBound`, 1,000: at least that many), the first `ids` (at most 5 and
   640 bytes), `oldestAt` with `timeBasis` (`created`, or `not_recorded` for
   the derived account and instrument candidates, which carry no proposal
   time), and the `handler`: the existing page and read tool, the argument an
   id goes in, fixed arguments, and the path that decides it
   (`kogane.command.plan`, `kogane.command.approve` or
   `kogane.schedules.survey.decide`). A line the deployment does not serve,
   the grant cannot read or whose own read refuses past its bounds is `unavailable` with `not_served`,
   `unauthorized` or `budget_exceeded`; the other lines still answer. Closed
   codes only; no amount, label or provider text. A line needs the capability
   the catalogue gives its handler's read tool
   (`PENDING_DECISION_CAPABILITIES`): `records.read` for the card settlement,
   ownership, candidate and pending-to-posted lines, `schedules.read` for the
   survey line (`kogane.schedules.survey.read`) and `interpretation.propose`
   for the plans line (`kogane.command.simulate`). Without it the line is
   `unauthorized` and its table is not read, so the summary shows no id the
   grant could not read through the line's own tool: the HTTP agent route's
   reader grant (a browser subject in neither `OPERATOR_SUBJECTS` nor
   `AGENT_GRANTS`) sees no plan id, as the command routes refuse it.
3. **Each line counts its own list.** The account and instrument lines run
   their reviews' own bounded reads and view filters
   (`accountCandidateView`, `instrumentCandidateView`, exported for this). The
   survey line counts what the survey read's `attention` counts, for the
   grant's `scheduleSources`. The card settlement line counts statements with
   an undecided candidate and no live acceptance; it does not judge readiness
   (the statements page judges it ten statements at a time, through the keyed
   readiness CTEs, which over every undecided candidate would cost seconds).
   The ownership line counts each (role, account) such a candidate resolved
   with no current accepted claim, and lists the candidate whose ownership
   review shows it. The pending-to-posted line counts undecided stage-B
   proposals; the plans line plans planned or approved whose `expires_at` is
   after now.
4. **Bounded reads.** The card settlement lines read the candidates once (as
   the statements page's `GROUP BY` does) with each decision, each statement's
   candidates and each ownership claim by key; the pending-to-posted and plan
   lines read one index range each (`reconciliation_proposals_status`,
   `change_plans_status` from 24 hours back, the longest a plan lives), capped
   at `countBound` + 1 rows; the survey line reads the proposals with each
   decision by key, as the survey read does, capped the same way.
5. **Not counted, and said so.** `notCovered` names the queues left out with a
   closed reason: `economic-event.proposal` and `card-purchase.review`
   (`no_decision_path`), `relation.agent-proposal` (`no_list`),
   `identity.unresolved-mapping` (`no_proposal`). A kind is added to the
   summary with its read, or listed there.
6. **Reads only (INV07).** The service decides, proposes and writes nothing;
   each served agent call records one R0 audit read (catalogue entry
   `decisions.pending`, `records.read`).

## Consequences

- Q20 is one call, under 8 KB: nine lines of about 300 bytes plus at most
  640 bytes of ids each (the size test fills every line with the longest ids
  its kind can have).
- The answer does not say whether a settlement statement's lead is ready to
  accept; an agent reads the statement through the handler for that. A count
  of statements whose every candidate is blocked (for example by a changed
  statement) still counts them: they still wait for a decision (reject, or
  the ownership review), not for nothing.
- The pending-to-posted ids cannot be passed to `kogane.purchases.explain`,
  which takes a purchase or a period, not a proposal; the candidate shows
  under its purchase.
- The account and instrument lines cost what their reviews cost (the
  instrument review walks the current identity observations, refused past
  500,000); the summary is a read for a person or an agent asking, not a
  lane.
- New published tool, route and panel: one more adapter each, mapped in the
  UI/MCP parity guard.

## Verification

- `packages/application/test/pending-decisions.test.ts`: an empty store (every
  line zero, no id, no time); the card settlement and ownership lines against
  the カード照合 list's own SQL (statement pages, then each statement's
  candidates) on four random synthetic stores, with an ownership reference
  written in TypeScript, drawing waiting and decided statements and owned and
  unowned accounts; the account and instrument lines against
  `reviewAccountCandidates` and `reviewInstrumentCandidates` (`total` and
  first ids, `open` and `held`); a store past the instrument read's bound
  (those lines `budget_exceeded`, the others counted); pending-to-posted
  proposals (decided, other kind and other stage left out) against the
  purchase page's candidate reader; survey proposals for every source and a
  grant's sources; plans planned, approved, committed, stale and expired, and
  a plan expiring between two reads; the count bound; grant refusals before
  any read; `not_served` and `unauthorized` lines, each line's capability
  equal to its handler tool's catalogue capability, and a reader grant's
  plans and survey lines refused without reading their tables; the id bounds
  and the
  8 KB worst case; every answer against the wire contract; plans without
  table statistics; and that no read changes the store.
- `services/processor/test/pending-decisions.test.ts`: on workerd's SQLite
  with every CORE migration, the survey line equals `maintenanceSurveyView`'s
  `attention` and list for every source and three source scopes, the plans
  reach decisions, relations and plans by key, and the read writes nothing.
- `services/app/test/pending-decisions-api.test.ts`: the route, the agent
  HTTP route and MCP give the same answer (but `asOf`), valid against the
  contract and under 8 KB; operator-only, GET-only, no parameter; the grant
  refusals; the audit read; no write. The UI/MCP parity guard maps the route
  to the tool.
- `apps/web/test/pending-decisions.browser.test.ts`: the panel lists every
  kind, links to the deciding page, says why a line is unavailable, passes the
  accessibility audit, and is absent for a caller the route refuses; its total
  is exact with every line complete or `not_served`, and says `以上` for a cut
  line, a `budget_exceeded` line and an `unauthorized` line, each on its own;
  the wire contract refuses lines the summary cannot produce.
