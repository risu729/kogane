# ADR 0089: A statement's ready candidate leads the grouped card settlement list however old it is

- Status: proposed
- Date: 2026-11-08
- Carried by: `packages/application/src/query/card-settlements.ts`
  (`queryCardSettlementStatements`, `CARD_SETTLEMENT_STATEMENT_OLDER_SQL`,
  `CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS`)
- Related: [card settlements](../card-settlements.md#candidate-and-decision-lifecycle)
  (the grouped list, #1021), [ADR 0081](0081-ui-parity-through-mcp.md) (the
  page and its MCP read call one service)

## Context

The `カード照合` page lists statements, not candidates
(`queryCardSettlementStatements`, #1021). Each statement judges its five
newest candidates and any accepted one, and leads with its accepted candidate,
else the newest proposed one with no acceptance blocker, else the newest. The
docs recorded a limit: a ready candidate older than the five newest was never
the lead. When the five newest were all blocked or decided (they cite another
debit of the same amount that is no longer current, or the operator rejected
them), the newest led with its blockers and the candidate the operator could
accept was only in the statement's full list, one click away and 50 a page.
The operator could then read the statement as having nothing to decide.

A test on the scaled store confirmed it on origin/main (c96e80e6): five newer
candidates copied from the statement's stale ones moved the lead from the
ready candidate to the newest copy.

## Options considered

1. **Keep the limit, documented.** No cost, but the page's lead rule says
   "the newest ready" and does not hold for every statement.
2. **Judge every candidate of each statement on the page.** Exact, but every
   page would judge every statement's whole history, ready or not, although
   the five newest already decide the lead for nearly every statement (every
   statement of the scaled store).
3. **Widen the window** (judge the ten or twenty newest). Moves the limit; a
   ready candidate older than the window is still never the lead.
4. **Search only where the window decides nothing.** Keep the shipped read of
   the five newest and accepted ones unchanged; for a statement whose judged
   candidates hold no acceptance and none ready, and which has older
   candidates, judge the older ones newest first, a bounded pass at a time,
   until one is ready or none is left. Judge only the candidates that could
   be ready: no decision names them (migration 0044 allows only `accepted`,
   `rejected` and `withdrawn`, so a candidate a decision names is not
   proposed), and their facts claim the `established-same` owner and both
   accounts (`cardSettlementEligible` requires each, so a candidate without
   them always has a blocker).

## Decision

Option 4. A statement leads with its accepted candidate, else the newest
proposed candidate with no acceptance blocker of all its candidates, else its
newest candidate. The search reads `CARD_SETTLEMENT_STATEMENT_OLDER_SQL` (the
statements still searching, the window size, the candidates passed and the
pass size, 50), judges the rows with the same readiness CTEs and review
mapping as every list, and stops a statement at its first ready candidate or
at a pass shorter than 50. The ready candidate found is added to the group's
judged candidates and leads; the others follow newest first as before.
Nothing else in the page changes: the statements, their order and counts,
the window and its rows, and every statement whose window holds an acceptance
or a ready candidate.

The search lives in the application service, so the HTTP route and any MCP
read of the grouped list (ADR 0081) show the same lead.

## Consequences

- The page's lead rule holds for every statement: the decidable candidate,
  when one exists, is shown first.
- A statement's group can carry one candidate older than its five newest, and
  `candidateCount` still counts every candidate. The wire contract is
  unchanged (`candidatesPerStatement` stays 5; at most 50 candidates a group).
- Cost: no change for a statement its newest candidates decide. For one they
  do not, one keyed read a pass, judging at most 50 candidates per statement;
  when none of its older candidates is ready the search walks every one that
  could be, a pass per 50 (docs/card-settlements.md, Cost).
- A malformed older candidate the search judges before finding a ready one is
  an unavailable answer (`card_settlement_facts_invalid`), as a malformed
  candidate of the window already is.

## Verification

- `packages/application/test/card-settlement-review-scale.test.ts`: the
  failing case above now leads with the ready candidate; the grouped read's
  rows equal the frozen shipped text's
  (`card-settlement-statement-group-legacy-sql.ts`, digest-pinned in
  `card-settlement-statements.test.ts`); every page equals the shipped list's
  where no lead changes; with five, then sixty-five, synthetic newer stale
  candidates only that statement's lead changes, to the newest ready
  candidate its full list holds (one pass, then two); after the operator
  rejects it the page equals the shipped one again and the search stops at a
  short pass; the search's plan reads nothing whole without table statistics.
- `packages/application/test/card-settlement-statements.test.ts`: on random
  stores with synthetic history (owners and accounts drawn otherwise,
  rejected candidates, tied creation times) the search chooses exactly the
  candidates a TypeScript reference chooses for windows of 1, 2 and 5 and
  several passes, and the grouped read equals the frozen text.
