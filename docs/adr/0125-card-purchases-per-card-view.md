# ADR 0125: Answer card spending per card in one compact read (`view: cards`)

- Status: proposed
- Date: 2026-11-19
- Issue: [#1414](https://github.com/risu729/kogane/issues/1414) (everyday questions in one or two MCP calls, each answer under 8 KB)
- Plan: [MCP everyday questions](../plans/2026-11-mcp-everyday-questions.md) (gap G1)
- Builds on: [ADR 0013](0013-agent-card-purchase-read.md) (the agent's card purchase read and its 2026-11-08 amendment),
  [ADR 0081](0081-ui-parity-through-mcp.md) (one service for the route and the tool),
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (every MCP client holds the whole-store grant)
- Amends: `kogane.purchases.explain` and `GET /api/v2/card-purchases` with a `view` argument and, for the new
  view only, a `usageMonth` filter. **This is a published MCP tool change: it needs the owner's approval before
  merge.**

## Context

"How much did I spend on each card this month?" is one of the questions an owner asks most
([plan, questions Q5 and Q6](../plans/2026-11-mcp-everyday-questions.md#2-everyday-questions-and-what-they-cost-today)).
Today the only read that answers it is `kogane.purchases.explain`:

- Its `summary.units` covers every live event of the filter, but across all cards together: there is no
  per-card figure.
- Per card, the client must page through every event (50 a page, about 1.4 KB per event without a statement,
  settlement or candidate, more with them: 70 KB to 150 KB a page on a synthetic store), group the items by
  `accountId` and add `amount` per state itself. That is three to seven calls for a month of 150 to 300 events,
  300 KB or more, and client-side arithmetic that INV03 keeps in `packages/domain` for a reason.
- An MCP client shows the first 8 KB of an answer (#1414), so even one page is unreadable without saving it.
- The only filter is the statement period. A purchase still pending this month has no statement yet, so
  "this month" by usage date cannot be asked at all.

The reader already does the expensive part: `queryCardPurchases` reads the whole filter's live events once
(bounded at 10,000) and sums them through `cardPurchaseSummary`. The page then reads the evidence, provider rows,
history, last amounts and candidates of 50 events, which the question does not need.

## Options considered

1. **A new tool (`kogane.cards.spending`).** Rejected: it would duplicate the grant, perimeter, bound and
   refusal rules of `purchases.explain` and add a catalogue operation; the owner allowed new tools only where no
   existing tool fits, and this one fits.
2. **Client-side grouping (status quo).** Rejected for the reasons above.
3. **A `view` of the same read (chosen).** `view: events` (default) is today's page; `view: cards` regroups the
   same whole-filter selection by card and reads no per-event explanation. The operator route serves the same
   view from the same reader, so ADR 0081's "same answer as the route" holds.
4. **Group by usage month in memory over every live event.** Rejected: a store past the 10,000-event bound
   would then refuse every month. The usage-month filter is applied in SQL instead, so the bound counts that
   month's events only.

## Decision

- `queryCardPurchaseCards(sql, { period? | usageMonth? })` in
  `packages/application/src/query/card-purchases.ts` is the one reader. It takes exactly one month: a statement
  `period`, read by the page's own whole-filter selection (`SELECTION_SQL`, unchanged), or a `usageMonth`, read
  by `USAGE_MONTH_SELECTION_SQL`: the same text with the event-id predicate replaced by
  `substr(json_extract(c.facts_json,'$.usageDate'),1,7)=?2`, built from the shipped string at module load (it
  throws if the predicate it replaces is not there). One month keeps each card to the one or two statements its
  events can belong to, so the answer grows with the cards and not with the history; every live event at once
  is the page's figure (`view: events` without `period`). The same 10,000-event bound refuses a larger filter,
  never sums part of it.
- Per card (resolved account and card source), at most `CARD_PURCHASE_CARDS_MAX` = 100 cards by source then
  account, `cardsTruncated` saying when more exist:
  - `label`: the stored `accounts.label`, by primary key (`ACCOUNT_LABELS_SQL`), or null without a row.
  - `events` and `unresolved`.
  - `figures`: `cardPurchaseSummary` of the card's events, as decimal text per unit (`captured`, `authorized`,
    `capturedRefunds`, `authorizedRefunds`). The states stay apart and there is no combined total, as on the
    page. Every figure is exact by construction (the summary refuses a leg that is not), and `cardFigures`
    throws rather than print a non-exact one.
  - `withoutStatement`: the events with no statement figure, counted by the page's closed reasons
    (`not_posted`, `statement_not_collected`, `period_unrecognized`).
  - `statements`: the statements its posted events belong to, read through the page's own chain
    (`STATEMENT_SQL`, `SETTLEMENT_SQL`, now shared through `statementChain`): period, the provider total
    (`CompactAmount`: decimal text when exact, else `status` and `reason`, never a zero), the payment date
    (`CompactDate`: `YYYY-MM-DD` or `{ reason }`), the settlement review's status (accepted first, as the
    page picks it) and, only while it is accepted, the bank debit's source and date. The debit's amount and
    account stay with the settlement reads (`kogane.card-settlements.read`, `.debit-accounts`).
- `totals`, `events` and `unresolved` are the page's `summary` for the same filter; `coverage` is the page's
  coverage without `limit` (the unrecognised current rows and their reasons, `completeTransactionHistory:
  false`, `refundsAllocated: false`). No provider row, counterparty, candidate or evidence is read or returned.
- `kogane.purchases.explain` takes `view` (`events` | `cards`) and `usageMonth` (`YYYY-MM`). With
  `view: cards` it answers `{ schemaVersion: "kogane-card-purchases-cards-v1", query: { view, period,
  usageMonth }, decisions: "operator-only", data }`, `data` being the reader's answer unchanged. The grant rules
  are the page's (`records.read` over the whole store); a grant whose `maxRows` is below 100 is refused with
  `budget_exceeded` before anything is read, as `kogane.card-settlements.debit-accounts` refuses it. A
  `usageMonth` outside the view, an `eventId` or `offset` inside it, both frames at once, or an unknown view is
  `400 invalid_query` naming the keys, as is a per-card request without a month. `view: events` is the same
  request as no view.
- `GET /api/v2/card-purchases?view=cards&period=…` or `?view=cards&usageMonth=…` serves the same `data` (plus
  `apiVersion: 2`) to the operator, with the route's codes (`invalid_query`, `invalid_period`,
  `413 result_limit_exceeded`).
- The agent audit record counts the listed cards as its rows and marks the read truncated when
  `cardsTruncated` is true.
- Web parity: the operator page (`/purchases`) does not render the view yet; the route serves it and the page
  keeps its whole-filter figures and statement totals. ADR 0081 requires every screen read to have an MCP read,
  which holds; an MCP read without a screen panel is allowed and recorded here as an open item.

## Consequences

- "How much did I spend on each card (this statement month / this usage month)?" is one call. The largest
  per-card shape (an identity-store account id of 72 characters, a 45-byte label, two statements in one usage
  month, each with an accepted settlement) measures about 650 bytes a card: ten cards answer in about 7.3 KB,
  and the first page of events is more than five times larger (`card-purchase-cards.test.ts`). The answer grows
  with the number of cards, not of events; a store with more than about eleven card accounts passes 8 KB, an
  open limit (production has fewer than ten card accounts, a count only).
- The read's cost is the page's selection: on a store without statistics it walks the live-revision index
  `economic_event_revisions_current` (every live economic event) and reaches each card purchase recognition and
  leg by primary key; the usage-month selection has the identical plan. It adds one primary-key lookup per
  listed card for the labels and the page's statement, settlement and current-usage reads. It reads no
  per-event evidence, provider row, history or candidate.
- "On what" (merchants) is not answered: the view carries no counterparty. The client still reads the page
  (`view: events`) for that; a compact per-card line list is gap G2 of the plan.
- The label is the stored account label. Vpass cards all carry `Vpassカード明細` until the read-time card name
  of the Vpass card-name unit (the plan's Unit F) exists; this view does not apply it yet.
- Reads write nothing (INV07); amounts are added only by `cardPurchaseSummary` in `packages/domain` (INV03); a
  statement total that is not exact keeps its status and reason (INV05).

## Verification

- `packages/application/test/card-purchase-cards.test.ts`: the view equals the page's summary per filter and
  per card on a synthetic world of three cards (statement collected and settled, statement not collected,
  pending authorisation); the cards' figures, events and unresolved counts, parsed and added again in the
  domain by `card-purchase-cards-sum.ts`, equal the answer's totals (no event under two cards or none, INV06);
  101 cards list 100 with `cardsTruncated` while the totals keep the unlisted one; the usage-month frame across
  statement periods; the usage-month SQL against the page's selection filtered by usage date; the summary
  bound and malformed input; the 8 KB size bound for ten cards; query plans without `sqlite_stat1` (no scan of legs, keys or accounts; the usage-month plan equals the
  page selection's; labels by primary key); nothing written.
- `packages/application/test/card-purchase-scale.test.ts`: on the scaled store without statistics, the view's
  totals and per-card event counts equal the page's, the cards added again in the domain equal the totals for
  every statement period and usage month, the usage-month selection equals the page's selection
  filtered by usage month for every month, and the plans match.
- `packages/application/test/purchases-explain.test.ts`: the request rules of both views; the grant,
  perimeter and `maxRows` refusals; the dispatcher.
- `services/app/test/purchases-explain.test.ts`: the agent HTTP path, MCP and the operator route answer the
  same `data` for each frame, under 8 KB and without provider text; refusals on all three; nothing written.
- The route-to-tool map of `services/app/test/ui-mcp-parity.test.ts` already maps `/api/v2/card-purchases` to
  `kogane.purchases.explain`.
