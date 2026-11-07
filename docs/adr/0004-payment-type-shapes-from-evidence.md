# ADR 0004: Accept only the payment-type shapes production evidence shows

- Status: accepted
- Date: 2026-09-25
- Implemented by: #246
- Carried by: [economic events](../economic-events.md#single-payment-per-source),
  `classifyCardUsage` in `packages/domain/src/card-purchase.ts`,
  `myjcbSinglePayment` in `packages/domain/src/myjcb-amounts.ts` (moved
  there by [ADR 0005's amendment (d)](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-d-a-confirmed-page-under-the-usage-header-proven-by-the-page)), `payment_type` in
  `packages/read-model/src/card-usage.ts`

## Context

Card purchase recognition ([ADR 0002](0002-card-purchase-recognition.md))
accepts single payments only. The first rule matched wording the synthetic
fixtures had invented (`1回払い`), so production rows were skipped as
`payment_type_unsupported`. Neither provider documents its codes, and the
MyJCB cell the ledger parser takes for the payment type holds a short
on-screen label in production, not the payment type.

## Options considered

1. Assume a code table (Vpass `1` single, `2` installment, and so on).
   Rejected: a guessed purchase is a wrong figure, while a skipped purchase is
   only an incomplete one.
2. Release a parser that extracts a clean MyJCB payment type. Rejected: the
   evidence already holds the wording in the combined cell, so the read model
   can read it without a parser release.
3. Accept exactly the shapes observed in production aggregates, and only with
   the owner's confirmation where no document states the meaning. Chosen.

## Decision

- **Vpass web** (`posted`): `data[6]` is exactly `1` after NFKC. In
  production 6,053 rows carry `１` and 230 an empty text; the empty text is
  unsupported.
- **Vpass customized** (`unconfirmed`): `bunkatsuYaku` is exactly `0` after
  NFKC. The provider does not document the field. `0` was the only value on
  all 2,395 rows, and the owner confirmed on 2026-09-25 that it means a single
  payment (1回払い).
- **MyJCB** (`confirmed` and `unconfirmed`): the combined `summaryCells[1]`
  cell holds, after NFKC, at least one `N回払` count and every count is 1, and,
  after whitespace removal, none of `分割`, `リボ`, `ボーナス`, `キャッシング`.
- Every other value, a blank, a padded value and any other wording stays
  `payment_type_unsupported` until it is observed and confirmed.

## Consequences

- Pending Vpass rows become `authorized` events, so the purchase lane's
  pending-to-posted candidates cover Vpass as well as MyJCB.
- A MyJCB merchant name that contains an excluded word, or ends in a digit
  written just before `1回払`, is skipped. That is safe, and it is counted as
  unrecognised.
- A new code needs evidence and a recorded confirmation before it is accepted,
  the way this one was. The rule only reads the combined cell; nothing stores
  or logs the merchant.

## Verification

The counts come from read-only aggregate queries over every
`transaction_observations` row the deployed parsers had written (2026-09-24,
no row values). The rule is covered by `packages/domain` tests on synthetic
rows.

## Amendment: the purchases read names each unrecognised row's reason (2026-11-07)

- Status: proposed (takes effect when the PR that adds it merges)
- Date: 2026-11-07
- Records: [#1020](https://github.com/risu729/kogane/pull/1020) (merged
  2026-11-07), and `coverage.refundsAllocated` added with this amendment
- Carried by: `CARD_USAGE_UNRECOGNIZED_REASONS` in
  `packages/domain/src/card-purchase.ts`, `cardUsageFactOf` in
  `packages/application/src/card-usage-fact.ts`, `CURRENT_SQL` and
  `CARD_PURCHASE_UNRECOGNIZED_LIMIT` in
  `packages/application/src/query/card-purchases.ts`,
  `validUnrecognizedReasons` in
  `packages/observation-shared/src/card-purchase-contract.ts`,
  [economic events: HTTP](../economic-events.md#http)

### Context

This record keeps every payment type nobody has observed and confirmed
`payment_type_unsupported`. Installment, revolving and bonus rows are among
them: no such shape is recorded here as observed and confirmed for either
provider, so nothing tells which Vpass code or MyJCB wording means which. The lane counts
skipped rows per code in its tick record (`skipped`), for the rows that tick
scanned only. The purchases read (`GET /api/v2/card-purchases`, the
`/purchases` page and the agent's `kogane.purchases.explain`) gave one count
of current rows no live event holds, beside the static list of every
exclusion code, so neither the operator nor an agent could tell whether a row
was an unsupported payment type, an unreadable amount or a row the writer had
not reached. The Phase 2 plan's step 2d
([plan](../plans/2026-11-phase2-card-flow.md)) asked for that count per closed
code, without a recognition change. Refunds are recognised as their own
events and shown and summed apart from purchases; nothing plans or writes
`card-refund.allocate` ([ADR 0017](0017-card-purchase-review-commands.md)).
The page said so beside each refund and on its refund figures (対応不明); the
route and the agent read did not.

### Options considered

1. Codes of their own (`installment`, `revolving`, `bonus`), read from the
   wording or code. Rejected: it guesses provider semantics this record
   leaves unsupported, and the MyJCB words also occur in merchant names.
2. Store each skipped row's reason in the lane (a migration). Rejected: a
   stored reason goes stale between ticks and after a rule change, while a
   reason derived when the page is read is always the current rule's.
3. Classify the read's unrecognised rows when the page is read, with the
   writer's own rule, bounded per request. Chosen.

### Decision

- `coverage.unrecognizedReasons` is `{complete, counts}`; each count is
  `{sourceId, reasonCode, rows}`. A reason is one of
  `CARD_USAGE_UNRECOGNIZED_REASONS`: the twelve `CARD_USAGE_EXCLUSIONS`, or
  `recognition_pending` for a row `classifyCardUsage` accepts that no live
  revision holds yet (the writer has not reached it in its cursor cycle, or
  its write conflicted, including a re-derived key that differs from the read
  model's). Only pairs some row has are listed, Vpass before MyJCB, each in
  the closed reason order. Counts and codes only: no amount, merchant or key
  leaves the classification.
- Each row's reason is the writer's: the read maps the row with the lane's
  own `cardUsageFactOf` (moved to `packages/application/src/card-usage-fact.ts`
  so both import it) and classifies it with `classifyCardUsage`, whose checks
  run in a fixed order. A row whose payment type is not the accepted
  single-payment shape, installment, revolving and bonus wording among them,
  therefore stays `payment_type_unsupported` until a shape is observed and
  confirmed as this record requires. A MyJCB row that passes that check but
  whose usage and payment amounts differ is `installment_amount_differs`, or
  `payment_split_unknown` when one of them is unreadable; the read does not
  say what the difference means. No reason is stored and nothing is written
  (INV07).
- The read's one pass over current usage (`CURRENT_SQL`) returns the page's
  current keys and the unrecognised rows whole, at most
  `CARD_PURCHASE_UNRECOGNIZED_LIMIT` (1,000) of them, lowest observation id
  first, with `unrecognized_total` counting all of them before that bound.
  `unrecognizedCurrentRows` stays that exact total. Beyond the bound
  `complete` is `false` and the counts add up to less than the total (INV05:
  a partial count says so, never scaled or zero). The wire contract refuses
  a pair given twice, a code or source outside the closed lists, a count of
  zero, and counts that do not add up to the total when `complete` or that
  reach it when not.
- `coverage.refundsAllocated` is always `false`, on the route and the agent
  read alike (both read `queryCardPurchases`, [ADR 0081](0081-ui-parity-through-mcp.md)),
  and the wire contract refuses any other value or its absence.
- The `/purchases` page lists the counts under its unrecognised-rows notice
  and says when they are partial.

### Consequences

- The operator and an agent see how many current rows are unsupported
  payment types, unreadable amounts or not yet processed. A count of zero
  means no such row is current, not that the provider has none.
- Returning the unrecognised rows whole costs about 45 ms more per page on
  the full-scale synthetic store
  ([economic events: HTTP](../economic-events.md#http)).
- Partial payments and multiple debits stay statement-side
  ([card settlements](../card-settlements.md#multiple-debits-and-partial-payments-adr-0074));
  this read does not name them.

### Verification

- `packages/application/test/card-purchase-query.test.ts`: each unheld row
  under its own `classifyCardUsage` reason, the order, and the bound
  (`complete: false`, exact total, page items unchanged).
- `packages/application/test/card-purchase-current.test.ts`: `CURRENT_SQL`
  against the pass shipped before #1020, frozen from git history in
  `card-purchase-current-legacy-sql.ts`, on the random stores of
  `packages/read-model/test/card-usage-random-store.ts`: the same page keys
  and count, exactly the first unrecognised rows up to each bound, and
  reasons equal to each row's classification.
  `card-purchase-scale.test.ts` checks the same keys and count on the scaled
  store and the plan without table statistics.
- `apps/web/test/card-purchase-contract.test.ts` refuses the shapes above and
  `refundsAllocated` other than `false`; `card-purchases.browser.test.ts`
  checks the listed reasons. `packages/application/test/purchases-explain.test.ts`
  and `services/app/test/card-purchases-api.test.ts` check the agent read and
  the route carry `refundsAllocated: false`.
