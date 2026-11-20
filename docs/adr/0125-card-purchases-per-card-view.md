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
- "On what" (merchants) is not answered: the view carries no counterparty. The line view of the
  [amendment below](#amendment-compact-purchase-lines-view-lines-2026-11-19) (gap G2) answers it.
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

## Amendment: compact purchase lines (`view: lines`, 2026-11-19)

- Status: proposed. **A published MCP tool change: it needs the owner's approval before merge**, like the decision
  above.
- Plan: [MCP everyday questions](../plans/2026-11-mcp-everyday-questions.md), gap G2 (questions Q5 "on what" and
  Q21).

### Context

`view: cards` answers how much each card was used, but not on what. The counterparties and the largest purchases
are only in the page of events (`view: events`): 50 events and 70–150 KB a page, in usage-date order. So "what did
I spend on card X this month, on what?" and "what were my largest purchases this month?" still need every page of
the month and a client-side sort of decimal amounts, which INV03 keeps out of the client.

### Options considered

1. **Order by amount in SQL.** A leg stores its amount as `coefficient` (text, up to 4,096 digits) and `scale`
   (0 to 4,096). Text order is not number order (`"999"` sorts after `"1000"`). A cast to an integer is exact only
   up to 2^63, a cast to a real is not exact at all, and two scales need the coefficient multiplied by a power of
   ten first. No index orders legs by amount, so SQL would sort the month's rows anyway. Rejected: an inexact or
   guarded comparison in SQL buys nothing over a domain comparison of the same bounded set. AGENTS.md forbids
   summing amounts in SQL; ordering by them is not summing, but it has the same exactness problem, so it stays in
   `packages/domain` too.
2. **Bound the month and sort in the domain (chosen).** The per-card view already reads the whole month's live
   events (bounded at 10,000) to total them. The lines sort that same set with `compareCardPurchaseLineKeys`
   (`compareDecimals`, exact) and read the provider rows of the listed lines only.
3. **Offset paging.** Rejected: an event recognised between two pages shifts every later offset, so a walk repeats
   or skips lines. A keyset cursor (the last line's sort key) continues strictly after the line it names.
4. **A required account.** Rejected: "my largest purchases this month" spans cards, and with a required account it
   is one call per card. The account is optional, and a line carries its `accountId` only when none is named.
5. **A fixed number of lines per page, alone.** Rejected: counterparty text has no stored bound, so a fixed count
   cannot keep an answer under 8 KB. A line count and a byte bound both apply, and the counterparty is cut.

### Decision

- `queryCardPurchaseLines(sql, { period? | usageMonth?, account?, sort?, cursor? })` in
  `packages/application/src/query/card-purchases.ts` is the one reader. It reads the month exactly as
  `queryCardPurchaseCards` does (`SELECTION_SQL` or `USAGE_MONTH_SELECTION_SQL` under the same bound, now shared
  through `monthFilter` and `monthEvents`; no SQL text changes). It keeps the named account's events (`account`: an
  `accountId` of at most 128 characters matching `[A-Za-z0-9][A-Za-z0-9_.:-]*`), or every event, and sorts them:
  - `sort: "date"` (default): newest usage date first, the larger event id first on one date. This is the page's
    order.
  - `sort: "amount"`: exact amounts first, grouped by unit in code-unit order (two units are never compared),
    largest first within a unit, then the date order. Every line without an exact amount (an `unknown` event has no
    leg) comes after them, in the date order.
- Per line (`CardPurchaseLine`):
  - `eventId`, `date` (the provider usage date), `kind` (`purchase` or `refund`) and `state` (`captured`,
    `authorized` or `unknown`).
  - `amount`: the live leg as decimal text, or `{ unit: null, status: "missing", reason }` with the event's unknown
    reason. Never a zero.
  - `lastKnown`, only on a line without an amount: the page's `lastKnownAmount`, read through its own
    `LAST_AMOUNT_SQL`.
  - `counterparty`: the first provider row of the event that has one, posted before pending, which is what the
    page's `sourceRows` publish. It is cut to 64 code points, with `counterpartyCut: true` when cut. Nothing else
    of the provider rows (locator, observation, current flag) is in a line.
  - `accountId`, only when no account is named.
- Beside the lines:
  - `events`, `unresolved` and `figures` (`cardPurchaseSummary` of the selected events as decimal text). With an
    account these are the per-card view's figures for that card; without one, its `totals`.
  - A coverage of `scope`, `completeTransactionHistory: false`, `unrecognizedCurrentRows` and
    `refundsAllocated: false`. The unrecognised rows' reasons and the statements stay with `view: cards` and
    `view: events`.
- Paging:
  - A page holds at most `CARD_PURCHASE_LINES_MAX` = 25 lines, and fewer when the answer's `data` as compact JSON
    would pass `CARD_PURCHASE_LINES_BYTES` = 7,168 bytes. One line is always listed.
  - `nextCursor` is base64url of the canonical JSON of the request (account, period, usage month, sort), the last
    listed line's key (date, event id and, for the amount order, its unit and canonical decimal text), and the
    page's depth: the lines listed so far, or more when more lines now sort at or before the previous key, held at
    the summary bound (10,000, past every grant's `maxRows`) so a cursor claiming more still continues. It is at
    most 2,048 characters. It is not signed.
  - A cursor is taken only with the request that issued it (`linesCursorFits`, which the route and the agent
    service check before reading). Another request's cursor, a malformed one or one with a non-canonical amount
    text is refused.
  - The next page is every line strictly after the key in the total order. A walk therefore lists no line twice
    and skips none while the month's events stay as they are. An event recognised mid-walk is listed if it sorts
    after the cursor, and not otherwise; an event revised mid-walk may move across the cursor.
- `kogane.purchases.explain` takes `view: lines` with `account`, `sort` and `cursor`. It answers
  `{ schemaVersion: "kogane-card-purchases-lines-v1", query: { view, account, period, usageMonth, sort },
  decisions: "operator-only", nextPage, data }`, `data` being the reader's answer. A next page this grant would be
  refused is withheld (`data.nextCursor: null`, `nextPage: "budget_exceeded"`), as on the page of events.
  - The grant rules are the page's. The grant's `maxRows` counts the lines listed across the walk (the cursor's
    count): a page that would reach past it is `budget_exceeded` before anything is read, so a grant below 25 is
    refused outright. Because the cursor is not signed, the page is also refused after the read, before anything
    is answered, when its key's depth in the month (the lines that now sort at or before it) reaches past
    `maxRows`; a cursor rewritten to claim fewer lines reads no deeper. An event recognised before the cursor
    mid-walk counts toward that depth, so such a walk can be refused a page the previous answer offered.
  - `400 invalid_query`, naming the keys: `account`, `sort` or `cursor` with another view; `eventId` or `offset`
    with this one; not exactly one month; a malformed value; another request's cursor.
- `GET /api/v2/card-purchases?view=lines&…` serves the same `data` (plus `apiVersion: 2`) to the operator, with the
  route's codes (`invalid_query`, `invalid_period`, `413 result_limit_exceeded`). `cursor` may be up to 2,048
  characters; every other parameter stays at 128.
- The agent audit record counts the listed lines, and marks the read truncated while a next page exists or is
  withheld.
- `encodeCursorJson` and `decodeCursorJson` (`packages/application/src/query/cursor.ts`) now carry the base64url
  canonical JSON form that the agent query cursor (ADR 0091) already used. That cursor is unchanged.
- Web parity: as for `view: cards`, the operator page does not render the lines; the route serves them.

### Consequences

- "What did I spend on card X this month, on what?" is one call for up to 25 purchases (two for 50), with the
  card's figures beside them. "What were my largest purchases this month?" is the first page of `sort: "amount"`
  without an account: one call.
- An answer stays under 8 KB. 25 lines with a short counterparty measure about 6.4–7 KB of `data`. The largest line
  shape (an identity-store account id, a 64-code-point counterparty of characters JSON escapes to six bytes) fits
  about ten lines.
- Cost: the per-card view's selection (the live-revision index, each recognition and leg by primary key). For the
  listed lines only, it adds the page's provider-row read (keys by event, observations by primary key) and, for
  lines without an amount, its last-amount read. It also makes the page's one pass over current usage. No
  statement, settlement, history, evidence or candidate is read. The in-memory sort covers at most 10,000 events,
  the same set the figures already add up.
- The account filter is applied after the month is read, so the 10,000-event bound counts the whole month, not the
  card.
- A counterparty is provider text. It appears only inside `data.lines`, as on the page, and a cut one says so.
- Limits:
  - A unit reference above 128 characters, or an amount above 512 characters of decimal text, cannot be carried in
    a cursor. A page that would end on such a line fails rather than hand one out. The stored unit reference is at
    most 128 characters (migration 0032).
  - An account id outside the account pattern cannot be named.

### Verification

- `packages/application/test/card-purchase-lines.test.ts`:
  - The lines of a statement period equal the page's items for that period in the page's order: for every card,
    for each account alone, and for a usage month against the page's items filtered by usage date. The figures are
    the per-card view's.
  - The amount order on stored events: numeric rather than text (10000 before 999); equal amounts by date; the
    refund ranked by its own amount; the retired event last, with `provider_status_absent` and its last known
    amount. The amount order on keys across scales and units.
  - Keyset walks without a duplicate or a skip: both orders, with and without an account, by period and by usage
    month, and with events recognised between pages.
  - Cursor refusals before any read: another sort, account or month; a malformed or non-canonical cursor.
  - A cursor's depth counted from its key: a count rewritten lower is raised to the key's depth and the next cursor
    counts from it, a deeper claim is kept and held at the summary bound, and a key past every line has the whole
    selection before it.
  - Every page within 7,168 bytes, and the agent answer around it under 8 KB, on the largest line shape, with
    counterparties cut and flagged.
  - Query plans without `sqlite_stat1`: no scan of legs, keys, observations or accounts; keys and observations by
    index; no statement, settlement, history, evidence or candidate read.
  - Nothing written.
- `packages/application/test/card-purchase-scale.test.ts`, on the scaled store without statistics: every statement
  period's lines by date equal the page's events in the page's order, and by amount the same events once each, with
  every page within its bounds; every usage month of one account lists that account's events; the provider-row
  read's plan is keyed.
- `packages/application/test/purchases-explain.test.ts`: the request rules of the line view; the grant, perimeter,
  `maxRows` and summary-bound refusals (a grant that may read one page but not two gets the next page withheld and
  said, and a cursor past it is refused before any read; a cursor rewritten to claim fewer listed lines is
  refused by its key's depth); the dispatcher.
- `services/app/test/purchases-explain.test.ts`: the agent HTTP path, MCP and the operator route answer the same
  `data` for a period, for a usage month with an account in amount order, and for every page of a cursor walk in
  both orders. Each answer is under 8 KB, with provider text only in `data.lines[].counterparty`. Refusals on all
  three paths; nothing written.
- `services/app/test/agent-api.test.ts`: the published input schema lists `account`, `sort` and `cursor`.
