# ADR 0075: Reported holdings change between two dates, per provider holding key, never totalled

- Status: accepted (merged 2026-11-06 in #944)
- Date: 2026-11-06
- Issue: #550 (指定日状態: 採用イベントから残高・保有数量を再構成する) and #551
  (範囲付きの指定日状態), the "changes between dates" part of
  [layers 8 + 11](../roadmap.md#layers-8--11--dated-reported-and-reconstructed-state)
- Builds on: [ADR 0019](0019-dated-reported-state.md) (reported state on a
  date), [ADR 0056](0056-as-of-price-fx-selection.md) (the decimal-v1 position
  quantity read of valuation on a date)
- Carried by: `packages/domain/src/holdings-change.ts`,
  `packages/read-model/src/dated-state.ts` (`DATED_SNAPSHOT_UNITS_SQL`),
  `packages/application/src/query/holdings-change.ts`,
  `services/app/src/reported-holdings-change-api.ts`,
  `packages/observation-shared/src/reported-holdings-change-contract.ts`,
  `apps/web/src/pages/ReportedHoldingsChange.tsx`,
  [reported state](../reported-state.md#holdings-changes-between-two-dates)

## Context

Phases 8 + 11 ask to "show historical holdings and changes between dates",
beside reconstruction from events, with incomplete coverage kept as a scoped
result. What exists, read from the code on main at `f33b121`:

- [Reported state on a date](../reported-state.md) lists, per account, the
  positions of the latest complete capture of each container before the end
  of the date (`queryDatedState`); a position absent from that capture is not
  held there. Valuation on a date reads each listed position's decimal-v1
  quantity by key (`DATED_POSITION_QUANTITIES_SQL`).
- [Reconstructed state](../reconstructed-state.md) (ADRs 0052, 0058) folds one
  account's adopted events from a start snapshot and already compares the
  result with the provider's end figure per currency: the remainder
  `reported − reconstructed` is exact, explained by late, pending and boundary
  components or left `difference_unexplained`, and never written as an
  adjustment. A per-account reconciliation view of reconstructed against
  reported balances is therefore implemented already.
- Positions are never folded (`positions_not_folded`): no writer emits a
  `security-quantity` leg, and the lot adapter answers unsupported until a
  securities writer exists ([ADR 0059](0059-lot-adapter-from-selected-revisions.md)).
- Nothing compares two dates. Neither the reported state nor the valuation
  says how a holding changed between two days.

## Options considered

1. **A reconciliation view of reconstructed against reported balances.**
   Rejected as a new slice: step 7 of the fold and the `/reconstruction` page
   already are that view, for one account and a range.
2. **Reconstruction over several accounts of a selected scope.** Deferred.
   No real account produces a reconstructed figure today (a card account is
   `unavailable`, a bank account at best `incomplete`, and no coverage
   producer exists), one account costs 1.1–2.0 s at the statement scale and a
   scope multiplies it, and which accounts a scope may name depends on the
   grant contract (today's grant scopes list sources and provider accounts,
   not resolved accounts; ADR 0058, amendment, Limits).
   _Pointer (2026-11-18): [ADR 0116](0116-reconstructed-state-account-scope.md)
   takes this option up: a scope costs one load and one read per date, not
   one per account, and every caller reads with the whole-store grant since
   ADR 0084._
3. **Holdings changes from adopted events.** Not possible: no event moves a
   security quantity (above).
4. **Reported holdings changes between two dates.** Chosen. It needs no new
   provider semantics (both figures are the provider's own quantity of its
   own key, read under the existing decimal-v1 policy), adopts and writes
   nothing, and states every gap as a reason.

## Decision

1. **Inputs.** Two reported states (`queryDatedState`, narrowed by `source`
   only), on `from` before `to`, `to` not after the caller's date in Tokyo;
   each listed position's decimal-v1 quantity in the unit
   `instrument:<source>:<market>:<code>`; and each chosen snapshot's fetch
   unit (`DATED_SNAPSHOT_UNITS_SQL`, keyed by artifact id). The account filter
   is not passed to the dated reads: a capture whose identity is not recorded
   yet still lists its holdings, so its absence never reads as "not held".
2. **Key.** A holding is the provider's own key: source, container (parser,
   dataset), provider account, market and security code. The same code in
   another container or provider account is another key; nothing is matched
   across sources or by instrument mapping.
3. **Each date's side.** `listed` (one position), `listed_more_than_once`
   (no one quantity), `not_listed` (the complete capture of the key's
   container and fetch unit on that date does not list it),
   `snapshot_scope_ambiguous` (the key is listed in captures of several fetch
   units, so which capture would list it is unknown) or `no_snapshot` (no
   complete capture of that container and fetch unit before the end of the
   date). A dataset snapshot is one fetch run's unit, so absence is judged
   only against the capture of the same unit; a run without units is a
   different scope from any unit.
4. **Outcome** (`holdings-change-v1`). Reasons, in this closed order:
   `no_snapshot_at_start|end`, `snapshot_scope_ambiguous_at_start|end`,
   `holding_key_ambiguous_at_start|end`, and, when both dates list it,
   `same_capture_both_dates` (no capture between the dates: the change is not
   observed), `capture_order_inverted`, `account_differs` and
   `instrument_differs` (both dates name a resolved id and they differ; an
   identity not recorded on one date is not a difference),
   `quantity_not_exact_at_start|end`. Any reason makes the status
   `not_comparable` with no figure. Otherwise a key both dates list is
   `compared`, with `change = end − start` computed exactly in
   `packages/domain` (`subtractQuantities`, INV03), zero included; a key one
   date lists and the other date's capture does not is
   `listed_at_start_only` or `listed_at_end_only`, with no figure: the
   absence is shown as a status, never as a zero quantity (INV05).
5. **Account filter.** A key is kept when a listing of it on either date names
   the requested account (today's mapping, as the reported state reads it);
   its other side is still judged on that date's whole listing.
6. **What it returns.** Holdings in key order (any input order gives the same
   output and context), counts per status, the position containers without a
   capture on either date and the stale snapshots, `total: "not-computed"`
   and `valuation: "not-computed"`. Each listed side carries its position,
   snapshot, capture time and freshness, resolved account and identity
   status, instrument mapping, the provider's text and the decimal quantity.
   The change is between the two chosen captures; a stale capture is shown
   with its age, not refused. The manifest pins schema, policy, zone, both
   dates, filters, quantity policy, both reported context ids and every key
   with its side refs, status and reasons; `contextId` is its digest. Fetch
   unit keys are matched only and never returned.
7. **Bounds and refusals.** More than 500 positions on a date is refused
   (`holding_limit_exceeded`), a reported state past its own row bound
   likewise (`dated_state_limit_exceeded`); nothing is cut. A malformed
   request is `invalid_request`, `from` not before `to` is `invalid_range`,
   `to` after the caller's date is `date_in_future`, and a named source or
   account that does not exist is `unknown_source` or `unknown_account`, each
   decided before the reads it guards.
8. **Exposure.** An application query (`queryHoldingsChange`), served as
   the reported state is: a route, a wire contract and a panel of the `/state`
   page, decided in the [amendment below](#amendment-route-contract-and-page-2026-11-06),
   which replaces this decision's earlier "no route, agent tool or page yet".
   No agent tool, since the reported state on a date had none when this was
   decided; it now has `kogane.reported-state.read`, and a change tool would
   follow it.

## Consequences

- No migration and no new index. One new statement, keyed on the primary
  keys of `fetch_artifacts` and `fetch_units`; every other statement is the
  reported state's or valuation's own.
- `storedPositionQuantity` is exported from
  `packages/application/src/query/valuation-on-date.ts` so both queries read
  a position's quantity the same way.
- Nothing is written, adopted or approved (INV07); nothing is added across
  holdings or accounts (INV06 is not at stake: no event is counted).

### Limits

- Identity, account mappings and publication are read as they are today
  (ADR 0019's limit): a later mapping correction or re-parse changes an
  earlier answer and its context id.
- A change is what the two captures report; it is not attributed to trades,
  transfers or corporate actions, since no event moves a security quantity
  yet. Once a securities writer exists, a reconstructed quantity can be set
  beside it as the fold does for balances.
- A parser renamed between the dates would make one holding two keys, each
  `listed_at_*_only`; parser names have not changed so far.
- The key holds only what the position row states: the foreign positions
  container names one provider account (`sbi-securities:foreign`), so two
  rows of one market and code in a capture are one key listed twice
  (`holding_key_ambiguous_*`), never paired with either.
- Only the reported state's perimeter is compared: aggregators and provider
  totals stay excluded (ADR 0019, decision 2), and balances are not compared
  here (the reconstructed state sets reported balances at both ends of a
  range beside each other already).
- Cost: two dated reads and two keyed lookups; at `STATEMENT_SCALE` a month
  ending today took 1,198 ms on `bun:sqlite` (median of three, one run on a
  shared machine). The statement-scale store holds no
  position container (see [reported state](../reported-state.md#cost)); not
  measured on workerd or D1.
- No agent tool yet (amendment below); the reported state on a date now has
  `kogane.reported-state.read`, which a change tool would follow.

## Verification

Synthetic data only; no production data, D1 or Workers.

- `packages/domain/test/holdings-change.test.ts`: exact changes (fractional
  and zero), holdings on one date only, a missing capture, a complete-empty
  capture, the same capture on both dates, fetch-unit scope (the other unit's
  capture never states an absence; a run without units is no unit's capture),
  a key listed in captures of two units, a key listed twice, an inexact
  quantity, moved account and instrument identities and an unrecorded one,
  an inverted capture order, the account filter judged on the whole listing,
  containers compared one by one, the refusals and the bound; 40 seeded
  random worlds checking that every key appears once in order, a figure
  exists exactly for `compared` and equals end − start in the key's unit,
  `listed_at_*_only` faces a `not_listed` side, every `not_listed` and
  `no_snapshot` side agrees with an independent reading of the inputs (the
  date's captures of the key's container and fetch unit), the filter keeps only keys
  naming the account, and a shuffled input gives the same output and context
  id; a coverage check that the random worlds reach every status and every
  side's reasons; the context id follows the reported contexts.
- `packages/read-model/test/dated-state.test.ts`: `DATED_SNAPSHOT_UNITS_SQL`
  equals `observation_fetch_artifacts.fetch_unit_key` and its plan without
  table statistics searches both tables by primary key.
- `packages/application/test/holdings-change-query.test.ts`: the query over
  the migrated schema (an exact change across an unidentified end capture,
  one-date holdings, an unreadable quantity, a container captured only at the
  end, the account filter, no capture between the dates, captures of two
  fetch units, every refusal and the number of statements before it, the
  bound, a dated read past its bound, reads only).
- `packages/application/test/holdings-change-scale.test.ts`: every statement
  of one answer on the scaled store has no whole scan beyond what
  `dated-state-scale.test.ts` accepts for the same statement, and the timing
  above.

## Amendment: Route, contract and page (2026-11-06)

- Status: accepted (merged 2026-11-06 in #950)
- Date: 2026-11-06
- Issue: #550 and #551, the exposure of the comparison above
- Replaces: decision 8's "no route, agent tool or page in this decision"
- Carried by: `services/app/src/reported-holdings-change-api.ts`,
  `packages/observation-shared/src/reported-holdings-change-contract.ts`,
  `apps/web/src/reported-holdings-change-api.ts`,
  `apps/web/src/pages/ReportedHoldingsChange.tsx`,
  [reported state](../reported-state.md#http-contract-and-page)

### Context

Decision 8 left `queryHoldingsChange` without a caller and said its exposure
would follow the reported state's own: `GET /api/v2/reported-state` under the
reader authority, a strict wire contract checked by the browser, and the
`/state` page. The reported state on a date has no agent tool (the shared
query's `reported-state` intent reads the latest balances, not a dated state),
so there was none to mirror. (The dated read `kogane.reported-state.read`
was added afterwards, with the amendment to ADR 0019.)

### Options considered

1. **A sibling page** (`/state/changes`). Rejected: the comparison ends on a
   date the `/state` page already asks for, and a second page would repeat its
   date form and its capability.
2. **A panel of the `/state` page that compares a chosen start date with the
   page's date.** Chosen. It asks nothing until a start date is chosen, so the
   page's own request and cost are unchanged.
3. **An agent tool now.** Rejected: the reported state has none, and the
   owner's direction is to mirror its exposure; a tool would need its own
   grant, listing and audit decision.

### Decision

- **Route.** `GET /api/v2/reported-holdings-change?from=YYYY-MM-DD&to=YYYY-MM-DD[&source=…][&account=…]`,
  GET and HEAD only, under the reader authority (the same `summary.read`
  check of `readerGrant` as the reported state), served exactly where the
  reported state is (`reportedStateAvailable`), otherwise `404 not_found`.
  The parameter shapes are the reported state's. Closed answers: `400
  invalid_query` for any other, repeated or empty parameter and a malformed
  source or account; `400 invalid_date` for a missing, malformed or
  impossible `from` or `to`; `400 invalid_range` when `from` is not before
  `to`; `400 date_in_future` when `to` is after today in Tokyo; `404
  unknown_source` and `404 unknown_account` (the query's own refusals); `413
  result_limit_exceeded` with `refs` naming `holding_limit_exceeded` or
  `dated_state_limit_exceeded`, never a cut answer. The body is
  `{ apiVersion: 2, …HoldingsChange }`; the request class is
  `reported_holdings_change`.
- **Contract.** `validReportedHoldingsChange`, wired into `validApiResponse`:
  exact keys at every level; closed schema, policy, zone, statuses, reasons
  (each once, in the domain's order) and side states; each side's own reason
  present exactly when its state gives one; a change only for `compared`, an
  exact decimal-v1 quantity (decimal strings) in the holding's unit, and
  `null` for `listed_at_*_only` and `not_comparable`, the one-date statuses
  facing a `not_listed` side; counts equal to the holdings; `total` and
  `valuation` `"not-computed"`; the manifest's dates, filters and policy
  matching the body, and its holdings matching the body's one by one (key,
  each side's reference, status and reasons). The lists are imported from `packages/domain`, which the
  client already bundles; the client recalculates nothing.
- **Page.** A panel `保有数量の変化` on the `/state` page (shown while
  `reportedStateOnDate` is; no new capability, since the route is served on
  the same condition), with a start date `比較の開始日` before the page's
  基準日. Compared rows show the server's change with its sign through the
  shared display module (`QuantityChange` beside `SettlementQuantity`); a
  holding listed on one date shows the provider's text on that side, `記載なし`
  on the other, and `数値なし` in the change column; `not_comparable` rows
  show their reasons in words. No total, valuation or sum of changes is shown.
- **Agent.** No tool, no MCP listing change.

### Consequences

- No migration, no new statement, no new capability field.
- The route adds one GET path to the Worker; an MCP-application token is
  refused there like on every ordinary route.

### Limits

- No agent read; one would follow `kogane.reported-state.read`, the agent
  read of the reported state on a date.
- The page compares only up to its own 基準日, and does not offer the
  `source` or `account` filters the route takes.

### Verification

- `services/app/test/reported-holdings-change-api.test.ts`: two captures of
  one position container recorded on two days through the in-process ingest
  (the clock faked while each is recorded); the validated answer (compared,
  start-only and end-only rows, and a missing start capture as a reason),
  nothing written, any signed-in subject served and an anonymous one refused,
  GET-only, every closed refusal and its status, `date_in_future` flipping at
  Tokyo midnight exactly where the reported state's does, the 413 on a dated
  read past its bound, and absence where the views are missing.
- `services/app/test/mcp-client.test.ts`: an MCP-application token is refused
  on the route.
- `apps/web/test/reported-holdings-change-contract.test.ts`: the query's own
  answers pass on four ranges, and a total, a valuation, a figure on a
  one-date or not-comparable row, a missing or out-of-order reason, an unknown
  status or side state, a change in another unit or not exact, wrong counts, a
  dropped holding or coverage and a manifest that does not describe the
  body (dates, filters, a holding's status, side, key or reasons, its order)
  are refused.
- `apps/web/test/reported-holdings-change.browser.test.ts`: in the production
  client, nothing is asked before a start date is chosen; the request carries
  `from` and the page's date; compared rows show `+2.5`, `±0` and `-3.5`, the
  other rows `数値なし` with their status and reasons; no sum appears; a start
  date on or after the 基準日 cannot be asked; a 413 says so; and the page
  has no sideways scroll at desktop and phone widths.
- `apps/web/test/quantity-change.test.ts`: `QuantityChange` writes `+`, `-`
  or `±0` and every digit of the exact decimal (18 fraction digits, more
  integer digits than a Number holds), and a change that is not exact as
  unknown.

## Amendment 2026-11-07: an agent read of the same page

- Status: accepted (risu's decision of 2026-11-07, recorded as
  [ADR 0081](0081-ui-parity-through-mcp.md)); implemented by #1069

The limit "No agent read" above no longer holds. ADR 0081 requires an MCP read
for every UI read, so `kogane.reported-holdings-change.read` answers
`GET /api/v2/reported-holdings-change` through the route's own reader
(`readHoldingsChange`), under `records.read` on `"*"` sources and accounts, and
only where the reported state's views exist, as the route does
([agent API: UI read pages](../agent-api.md#ui-read-pages)). It takes the
route's `from`, `to`, `source` and `account` and answers under `data`; each call
is an R0 read in the audit log. `services/app/test/page-read-rewards.test.ts`
compares its answer with the route's.

## Amendment 2026-11-18: the page's source and account filters

- Status: accepted (merged 2026-11-18 in [#1388](https://github.com/risu729/kogane/pull/1388))
- Date: 2026-11-18
- Replaces: the 2026-11-06 amendment's limit that the page "does not offer
  the `source` or `account` filters the route takes"

### Context

The route and `kogane.reported-holdings-change.read` take `source` and
`account`, but the panel sent only `from` and `to`, so a comparison narrowed
to one source or account existed over HTTP and MCP but not on the screen. The
2026-11-06 amendment recorded this as a limit, which no longer holds.

### Options considered

1. **Filters in view state, like the start date.** Rejected: a narrowed
   comparison could not be linked, unlike the other filtered lists, whose
   filters live in the URL.
2. **Filters in the URL as `source` and `account`.** Rejected: on `/state`
   they would read as filters of the whole page, whose reported state panel
   does not use them.
3. **Filters in the URL as `changeSource` and `changeAccount`, sent as the
   route's `source` and `account`.** Chosen.

### Decision

The panel has 取得元 and 口座 ID fields beside 比較の開始日. They are kept in
the page URL as `changeSource` and `changeAccount` and applied with 比べる;
絞り込みを解除 removes them. The fields suggest the sources and account ids
the page's date lists holdings for (the page's own reported state) and take
any other. The route's query shape rule moves into the wire contract as
`holdingsChangeQueryRefusal`, with the route's parameter list and source and
account patterns; the route applies it unchanged, and the page applies it
before it asks, so the page sends only the route's parameters in shapes the
route accepts. A URL holding a repeated, empty or malformed filter asks
nothing and offers to remove it, rather than widening the comparison.
`unknown_source` and `unknown_account` are stated in words.

### Consequences

- No route, tool, contract body, capability or MCP change: the parity
  mapping of `/api/v2/reported-holdings-change` to
  `kogane.reported-holdings-change.read` stays as it is.
- The answer is not paged, so a filter change has no page to reset.
- A filter change reloads the view, as on every page whose URL carries its
  filters (the app keys each view by its URL), so the page's reported state
  is asked again.

### Verification

`apps/web/test/reported-holdings-change.browser.test.ts` checks the sent
parameters, the URL, back navigation, the suggestions, refused shapes, the
unknown source and account notices and the accessibility audit of the
filtered panel; `apps/web/test/reported-holdings-change-contract.test.ts`
checks the shared request rule; the route's refusal tests in
`services/app/test/reported-holdings-change-api.test.ts` run unchanged.

## Amendment 2026-11-19: a summary that lists changed lines only

- Status: accepted (merged 2026-11-20 in [#1459](https://github.com/risu729/kogane/pull/1459)). Owner approval was required before merge: it changes the
  published input schema and the default answer of
  `kogane.reported-holdings-change.read` and of its route.
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414) (MCP
  everyday questions: one or two calls, each answer under 8 KB), question Q12
  "How did my holdings change since last month?" and gap G6 of the plan
  [MCP everyday questions](../plans/2026-11-mcp-everyday-questions.md)
- Follows: the `detail` pattern of
  [ADR 0123](0123-summary-detail-for-large-reads.md) (the balance,
  schedule and collection quality reads answer a summary by default; merged
  2026-11-20 in [#1458](https://github.com/risu729/kogane/pull/1458)), and the
  cursor conventions of [ADR 0119](0119-cursor-page-size.md) (a cursor
  continues at another offered page size; merged 2026-11-20 in
  [#1446](https://github.com/risu729/kogane/pull/1446)). Neither is needed to build this one:
  the summary is shaped in `packages/domain` and pages with the keyset cursor
  format already in `packages/domain/src/paging.ts`.
- Carried by: `packages/domain/src/holdings-change-summary.ts`,
  `packages/observation-shared/src/reported-holdings-change-contract.ts`,
  `services/app/src/reported-holdings-change-api.ts`,
  `services/app/src/page-read-tools.ts`,
  `apps/web/src/reported-holdings-change-api.ts`

### Context

Q12 takes one call today, but the answer lists every holding key of both
dates, the unchanged ones included, each with both sides' capture time,
capture date, age, freshness, resolved account and instrument with their
identity statuses, the provider's text and the decimal quantity object, and a
manifest that repeats every key. An MCP client shows the first 8 KB of a tool
result. Measured as the bytes of the MCP result (`{ schemaVersion, data }`,
the text a client reads) on synthetic stores:

| Store                                                                                                                                 | Before (`full`, the only answer) | After, default `summary`                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------: | ------------------------------------------------ |
| The route's store in `page-read-holdings-change.test.ts`: 80 SBI-shaped domestic holdings, 70 grown, 5 unchanged, 3 removed, 2 added  |                          135,855 | 8 pages of 10 lines, 3,151–5,627 B each          |
| `holdings-change-summary.test.ts`: 65 holdings at the longest key shape (deposit-type account, market, 12-character code, 8 decimals) |                          106,096 | first page 6,017 B                               |
| The same shape at the side bound, 500 holdings, every line listed                                                                     |                          806,200 | 50 pages of 10, 5,517–6,147 B; 25 lines 13,026 B |

The owner's store measured 20–250 KB for this read (issue 1414's audit).

### Options considered

1. **`detail: summary | full`, `summary` the default on the route and the
   tool, the page asking for `full` (chosen).** The pattern ADR 0123 proposes
   for three other reads, so one argument means the same on every read that
   has it. The route and the tool take the same `detail` with the same
   default, so ADR 0081's "the same answer as the route for the same input"
   stays literal.
2. **The same with `full` the default.** No published answer changes, but an
   agent that does not pass the argument still receives an answer it cannot
   see, which is Q12's problem (ADR 0123, option 2).
3. **A filter `changes: only` on the full shape.** A full holding is about
   1.7 KB at the realistic shape with its manifest entry (135,855 B for 80
   holdings: both sides' provenance and identity), so fewer than five fit in
   8 KB; and the manifest, which the contract checks
   against the body holding by holding, would either list holdings the body
   drops or stop pinning them.
4. **A total per unit beside the lines.** Rejected: this ADR's decision 6
   never adds holdings, one unit can be held under several provider accounts
   or containers that the key keeps apart, and Q12 asks what changed, not a
   sum. The summary states `total: "not-computed"` as the full answer does.
5. **A compact default on MCP only.** The tool would answer what its route
   does not, the special case ADR 0081 point 2 excludes.

### Decision

1. **Input.** The route takes `detail` (`summary` or `full`; absent is
   `summary`), and, with the summary, `limit` (10, 25, 50 or 100 lines;
   absent is 10) and `cursor`. `kogane.reported-holdings-change.read` takes
   the same three. Another `detail` or `limit`, a malformed `cursor` (not
   base64url, or over 512 characters), or a `limit` or `cursor` with
   `detail=full` is `400 invalid_query` on the route (`holdingsChangeQueryRefusal`,
   which the page also applies), and a `detail` outside the closed schema is
   `400 invalid_request` on the tool.
2. **`full`** is the comparison as decisions 1–7 answer it, byte for byte the
   route's answer before this amendment, unpaged, without a `detail` key.
3. **The summary** (`reported-holdings-change-summary-v1`) is
   `summarizeHoldingsChange` of that same comparison: it reads nothing the
   full answer does not and adds no state.
   - **Lines.** Every holding except a `compared` one whose exact change is
     zero: `compared` with a nonzero change, `listed_at_start_only`
     (removed), `listed_at_end_only` (added) and `not_comparable`, in that
     order, key order within. A `compared` holding with a zero change is
     counted in `unchanged`, never listed. A holding whose change cannot be
     determined (a missing, unparsed or conflicting quantity on either side,
     an ambiguous key or scope, no capture on a date, the same capture on
     both dates, an identity that differs) is `not_comparable` and is always
     listed with its reasons (INV05), and `reasonCounts` counts the holdings
     that carry each reason (a holding may carry several).
   - **A line** is `{ container, sourceAccount, market, securityCode,
     unitRef, status, reasons, start, end, change }`. `container` is a
     page-local ref (`c1`, `c2`, … in order of first use) into `containers`
     (`sourceId`, `parserName`, `dataset`). A side is `listed` with its
     `positionRef`, `quantity` (the exact decimal as text, or null) and
     `quantityStatus` (`exact`, `missing`, `unparsed`, `conflict`); `not_listed`
     with the `snapshotRef` of the capture that does not list it;
     `listed_more_than_once` with its `positionRefs`;
     `snapshot_scope_ambiguous` with its `snapshotRefs`; or `no_snapshot`.
     `change` is end minus start as exact decimal text, only on `compared`.
     Each line keeps its own unit and the refs that read it in full
     (`kogane.observations.get` with the position or artifact id). Dropped:
     each side's capture time, capture date, age and freshness (stale
     captures stay in `coverage`), the resolved account and instrument and
     their identity statuses (a difference stays as `account_differs` or
     `instrument_differs`), the provider's text, the decimal-v1 object and
     the manifest.
   - **The answer** carries the full answer's `from`, `to`, `filters`,
     `quantityPolicy`, `counts` (per status, over every holding), `coverage`
     (containers without a capture, stale snapshots, `total` and `valuation`
     `"not-computed"`) and `contextId`, plus `unchanged`, `reasonCounts`,
     `containers`, `items` and `page` (`offset`, `limit`, `listed`: every
     listed line on all pages, `hasMore`, `nextCursor`).
4. **Paging.** A page is lines `offset` to `offset + limit` of the listed
   lines. The cursor is the keyset cursor of `paging.ts` (`s` the
   comparison's `contextId`, `f` a digest of the summary schema, the dates
   and the filters, `t` the next offset), bound to neither the page size nor
   the detail (ADR 0119's rule). A cursor that does not decode, names a
   position outside the lines or carries a read instance or sort key is
   `400 invalid_cursor`; one of other dates or filters `400 cursor_mismatch`
   with `mustMatch` naming `from`, `to`, `source` and `account` (ADR 0123's
   body for a refused cursor);
   one of the same request whose comparison has another `contextId` (a new
   capture, mapping, parse or reported context) `410 context_expired`, never
   a page of the new comparison. Every page computes the comparison again.
5. **The context id.** The summary's `contextId` is its comparison's, the
   same as the full answer's for the same request: it names what both details
   describe, so a summary line can be checked against the full answer. It
   changes with every input decision 6's manifest pins (dates, filters,
   quantity policy, both reported context ids and every key's refs, status
   and reasons); what the reported context ids do not pin yet is under
   Limits. `detail`, `limit` and `cursor` choose which part of the
   comparison is shown, not what it is, so they are not in it.
6. **The page** keeps its full answer: `useReportedHoldingsChange` sends
   `detail=full` and refuses any answer that is not the full shape.
7. **Contract.** `validReportedHoldingsChangeSummary` checks the summary:
   exact keys; closed statuses, reasons, side states and value statuses; a
   side's own reason; `quantity_not_exact_at_*` exactly when both dates list
   the key and that side is not exact; a quantity only when exact; a change
   only on `compared`, as canonical exact decimal text and never `"0"`;
   lines in status order; `listed` equal to the counts minus `unchanged`;
   every line the page can hold; `hasMore` and `nextCursor` agreeing;
   `containers` defined once each in order of first use; `reasonCounts`
   within the closed list and the `not_comparable` count; no total.
   `validApiResponse` takes either detail (a body with `detail` is the
   summary); the page applies `validReportedHoldingsChange` itself.
8. **Audit.** A summary page is recorded with its line count and as
   truncated while lines follow (the page-read rule: `items`, `page.hasMore`).

### Consequences

- Q12 is one call under 8 KB; a month with more than ten changed lines is
  one more call per ten lines, or one call with `limit: 25` where the lines
  are short.
- A client of the route that relied on the full default must ask for
  `detail=full`. The repository's only client, the web page, does.
- ADR 0123 merged with its D2 as proposed (`summary` the default on the
  routes too), the same default as this read.
- [#1445](https://github.com/risu729/kogane/pull/1445) (the reported state's
  context id v2, merged 2026-11-20) pins more inputs in the reported context ids this
  comparison's manifest carries (mappings, the account filter, containers
  without a snapshot). It touches no file of this amendment; since it merged,
  a summary cursor also expires on a mapping correction that leaves every
  key's status and reasons as they were, which is the stricter, correct
  answer.

### Limits

- Headroom: the default page is about 5.6 KB at the realistic SBI shape and
  6.1 KB at the longest shape measured, with two containers without a
  capture in `coverage`. `coverage` is repeated on every page and grows with
  each stale snapshot and missing container (about 110 bytes each), so about
  eighteen of them on top of the longest lines would pass 8 KB. A page of 25
  lines at the longest shape is about 13 KB (the caller asked for it).
- `full` is unchanged and still past 8 KB on any store with more than a few
  holdings; it is the page's answer and the evidence view.
- Each page recomputes the comparison (two dated reads and two keyed reads;
  about 1.2 s at `STATEMENT_SCALE`, decision 7's measurement), so walking ten
  pages costs ten comparisons. Not measured on workerd or D1.
- Until #1445 merges, the reported context ids do not pin the containers
  without a snapshot, so a migration that adds a position container between
  two pages changes `coverage` under the same cursor.

### Verification

Synthetic data only.

- `packages/domain/test/holdings-change-summary.test.ts`: changed, unchanged
  (two exact zero changes, one written `3.000`), removed, added and
  `not_comparable` lines in status order; a missing, unparsed and conflicting
  quantity on either side listed with its reason and status and no number;
  no capture at the start and the same capture on both dates listed, never
  unchanged; one code in two markets and two provider accounts listed as
  three lines in their own units, with no total; an all-unchanged comparison
  lists nothing; the account filter's kept set; a 65-line walk at sizes 25,
  10, 50 and 100 joins into every listed line once in order; a cursor that
  does not decode, of other filters or dates, of a moved comparison, or
  forged at offset 0 or past the lines, with a sort key or a read instance,
  is refused with its code; a size outside the offered list is refused; and
  the sizes above (every default page at the bound under 8 KB, 25 lines
  over it). Every page it builds passes the contract.
- `apps/web/test/reported-holdings-change-contract.test.ts`: the summary of
  the query's own answers is valid on four ranges; each detail's validator
  refuses the other's body; a total, a valuation, a listed zero change, a
  change that is not canonical (`2.50`, `-0`, `1e3`, a number) or not on
  `compared`, a number for a quantity that is not exact, a missing
  `quantity_not_exact_*` or side reason, wrong `unchanged`, `reasonCounts`,
  counts, `listed`, `hasMore`, `nextCursor` or `limit`, a dropped or
  reordered line, and a container ref that is undefined, unused, out of
  order or duplicated are refused; the request rule takes `detail`, `limit`
  and `cursor` and refuses the shapes in decision 1.
- `services/app/test/reported-holdings-change-api.test.ts`: the default
  answer is the summary; `detail=full` is the text of
  `{ apiVersion: 2, …queryHoldingsChange(…) }` byte for byte, with the same
  `contextId`; the refusals of decision 1 and `invalid_cursor`; the existing
  full-answer tests ask for `detail=full` and pass unchanged otherwise.
- `services/app/test/page-read-holdings-change.test.ts` (80 holdings): the
  route, `/api/agent/v1/*` and `/mcp` give the same answer for the default,
  `detail=summary`, `limit=25`, a continuation at another size and
  `detail=full`, and write nothing; the MCP pages are each under 8 KB and
  join into the 75 listed lines (70 grown, 3 removed, 2 added) with the 5
  unchanged counted; a line's position ref reads its position through
  `kogane.observations.get`; `cursor_mismatch`, `invalid_cursor` and
  `invalid_query` are the same on the route and the tool; a capture recorded
  after a page expires its cursor (`410 context_expired`) on both; a grant
  without `records.read` or narrower than the whole store is refused under
  either detail; the audit records 10 lines truncated and 75 lines not.
- `services/app/test/ui-mcp-parity.test.ts`: the tool's description is at
  most 2,048 characters and names `detail`, both details, every status,
  `unchanged`, `quantityStatus` and the three non-exact value statuses,
  `reasonCounts`, `containers`, the page sizes, the cursor codes,
  `contextId` and `not-computed`; `agent-api.test.ts` pins the input schema.
- `apps/web/test/reported-holdings-change.browser.test.ts`: the page sends
  `detail=full` with its parameters, and its synthetic server answers only
  that.
