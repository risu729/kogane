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
