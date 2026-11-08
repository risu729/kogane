# ADR 0089: A statement's ready candidate leads the grouped card settlement list however old it is

- Status: proposed
- Date: 2026-11-08
- Carried by: `packages/application/src/query/card-settlements.ts`
  (`queryCardSettlementStatements`, `CARD_SETTLEMENT_STATEMENT_OLDER_SQL`,
  `CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS`,
  `CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED`);
  `packages/domain/src/card-settlement-review.ts`
  (`CARD_SETTLEMENT_LEAD_SEARCHES`); `apps/web/src/pages/Reconciliation.tsx`
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
5. **Option 4, bounded, with a closed reason.** As option 4, but judge at
   most a fixed number of a statement's older candidates per page read and
   say in the group how far the search went. Unbounded, option 4 walks every
   undecided older candidate whose facts could be eligible, a read per 50, on
   every page load: candidates are append-only and stale recaptures keep
   those facts, so a statement whose recent candidates are all blocked grows
   that walk without limit: the reads and readiness work of one page load
   would grow with the history, bounded only by D1's per-invocation query
   and time limits.

## Decision

Option 5. A statement leads with its accepted candidate, else the newest
proposed candidate with no acceptance blocker among its five newest and the
older candidates the search judged, else its newest candidate. The search
reads `CARD_SETTLEMENT_STATEMENT_OLDER_SQL` (the statements still searching,
the window size, the candidates passed and the pass size, 50), judges the
rows with the same readiness CTEs and review mapping as every list, and stops
a statement at its first ready candidate, at a pass shorter than 50, or after
`CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED` (200, four passes) of its older
candidates. The ready candidate found is added to the group's judged
candidates and leads; the others follow newest first as before.

Each group says how far its lead was looked for, `leadSearch`, a closed code
(`CARD_SETTLEMENT_LEAD_SEARCHES`): `not_searched` (the five newest hold an
acceptance or a ready candidate, or there is no older candidate), `found`,
`none_ready` (every older candidate that could be ready was judged; none is;
see the limit under Consequences),
or `truncated` (the search judged 200 without finding one and stopped; a full
last pass does not read whether more follow, so a statement with exactly 200
is `truncated` too). `truncated` is unknown, never "none ready" (INV05): the
page says the older candidates past the limit were not checked and points to
the statement's full list, which judges every candidate. The page's coverage
carries the limit as `olderCandidatesSearched`.

Nothing else in the page changes: the statements, their order and counts,
the window and its rows, and every statement whose window holds an acceptance
or a ready candidate.

The search lives in the application service, so the HTTP route and any MCP
read of the grouped list (ADR 0081) show the same lead.

## Consequences

- The page's lead rule holds for every statement whose ready candidate is
  among its five newest or its 200 newest older candidates that could be
  ready; past them the group says `truncated` instead of implying none is
  ready.
- A statement's group can carry one candidate older than its five newest, and
  `candidateCount` still counts every candidate. The wire contract adds
  `leadSearch` to each group and `olderCandidatesSearched` (200) to the
  coverage, both checked by the web client's contract
  (`validCardSettlementStatementPage`); `candidatesPerStatement` stays 5 and a
  group carries at most 50 candidates. Both fields are additive: a client
  that does not know them reads the page as before. The web client and the
  App Worker that serves it deploy together, so the stricter check meets
  only pages that carry both. `kogane.card-settlements.statements` (#1088)
  returns this page over the same service, so it carries both fields, and
  its description names the older ready lead and `leadSearch`.
- Cost: no change for a statement its newest candidates decide. Otherwise at
  most four more keyed reads per page load: a pass is one read for all the
  page's statements still searching (their keys as one JSON array), judging
  at most 50 older candidates of each. A page of ten statements therefore
  makes at most eight reads (the statement page, the window, four passes,
  the decision history and the debit-account evidence), and the search
  judges at most 10 × 200 = 2,000 older candidates, beside the window's five
  newest and accepted ones per statement. Each pass reaches every candidate
  of the statements it searches through `card_settlement_candidates_statement`
  to rank them, as the shipped window read does once, so the ranking still
  grows with the history, up to five times the window read's
  (docs/card-settlements.md, Cost).
- The passes are separate reads that page by position, not one snapshot. A
  decision recorded, between two passes, on an older candidate an earlier
  pass judged moves the later candidates up one place, so the next pass can
  skip one: that page load can then say `none_ready`, or lead with an older
  ready candidate than the newest one. The next load reads again, and the
  statement's full list judges every candidate. A new candidate moves them
  down one place at most, so a pass then judges one again and skips none.
  This is an open limit: `none_ready` is exact only when no such decision
  lands during the page load.
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
  candidate its full list holds (one pass, then two, `found`); after the
  operator rejects it the page equals the shipped one again and the search
  stops at a short pass (`none_ready`); with 200 more the ready one lies past
  the limit, the search stops after four reads, the lead is the shipped one
  and only `leadSearch` differs (`truncated`); every statement's lead and
  code are checked against its full list; the search's plan reads nothing
  whole without table statistics.
- `packages/application/test/card-settlement-statements.test.ts`: on random
  stores with synthetic history (owners and accounts drawn otherwise,
  rejected candidates, tied creation times) the search chooses exactly the
  candidates a TypeScript reference chooses for windows of 1, 2 and 5 and
  several passes, and the grouped read equals the frozen text. A scripted
  store checks the loop: only undecided statements are searched, one read a
  pass for the statements still searching, never more than four, and each
  of the four codes, including a ready candidate on the last pass judged
  (`found`), one just past it and statements with exactly 200 and 201
  (`truncated`) and 199 (`none_ready`); the worst page (ten statements,
  every one `truncated`) makes eight reads and judges 200 older candidates
  of each; and on drawn histories each statement's lead and code equal a
  reference written from the counts, not from the loop.
- `apps/web/test/card-settlement-contract.test.ts` refuses a group without a
  known `leadSearch` and a coverage without `olderCandidatesSearched`;
  `apps/web/test/card-settlement.browser.test.ts` shows the `truncated` note,
  which says a ready candidate is not ruled out and where the full list is,
  and no note for `none_ready`.
