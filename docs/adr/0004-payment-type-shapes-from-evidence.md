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

## Amendment: name each unrecognised row's closed reason in the purchases read (2026-11-06)

- Status: proposed (takes effect when the PR that adds it merges)

### Context

Phase 2 of the [roadmap](../roadmap.md#phase-2--card-usage--statement--bank-debit-current-milestone)
is done only when installments, revolving, bonus payments, partial payments
and refund allocation are either supported or shown as unsupported with a
closed reason. Before this amendment, the code did this:

- **Recognition** (`classifyCardUsage`) skips every row that is not a single
  payment with a closed code. A Vpass web code other than `1`, a Vpass
  customized `bunkatsuYaku` other than `0`, and a MyJCB cell holding `分割`,
  `リボ`, `ボーナス`, `キャッシング` or a count other than 1 are
  `payment_type_unsupported`. A MyJCB row whose usage and payment amounts
  differ, which is how an installment slice shows, is
  `installment_amount_differs`. One whose amounts cannot be read is
  `payment_split_unknown`. A refund whose shape does not agree with its sign
  is `refund_shape_unverified`. No event is written for any of them.
- **The lane** counts the skipped rows per code in its tick record and log
  line (`skipped`). That count covers only the page it scanned, and it is not
  on any screen.
- **The purchases read** (`GET /api/v2/card-purchases`, the `/purchases`
  page, and the agent's `kogane.purchases.explain`) showed one number of
  current rows no live event holds. Beside it, it showed the static list of
  every exclusion code. The operator could not tell whether any row was an
  unsupported payment type, an unreadable amount, or a row the writer had not
  reached yet.
- **Refunds** are recognised as `refund` events, shown and summed apart from
  purchases, and labelled 対応不明 on the page. No planner exists for
  `card-refund.allocate` ([ADR 0017](0017-card-purchase-review-commands.md)),
  and the read did not say this.
- **Partial and multiple debits** are statement-side
  ([card settlements](../card-settlements.md#multiple-debits-and-partial-payments-adr-0074)).
  The settlement sweep counts statements with no candidate per closed code
  in its tick record
  ([unmatched statements](../card-settlements.md#unmatched-statements)).
  This amendment does not change them.

No installment, revolving or bonus row has been observed in production for
either provider, so nothing tells which unknown Vpass code or MyJCB wording
means which.

### Options considered

1. Add codes of their own (`installment`, `revolving`, `bonus`) and split
   `payment_type_unsupported` by wording or code. Rejected: it guesses what
   unobserved codes mean, which this record forbids. The MyJCB words also
   match merchant names.
2. Keep the single count and the static list. Rejected: it does not show the
   operator or an agent which reason applies.
3. Count the read's unrecognised rows per existing closed code. Add two codes
   that are not exclusions: one for a row the rule accepts but nothing holds
   yet, and one for rows past the read's bound. State that refunds are not
   allocated. Chosen.

### Decision

- The purchases read's `coverage` gains `unrecognizedReasons`: a list of
  `{reasonCode, rows}` over `CARD_USAGE_UNRECOGNIZED_REASONS`. That list is
  `CARD_USAGE_EXCLUSIONS` plus `not_yet_recognized` (the rule accepts the row
  but no live event holds its key) and `beyond_read_limit` (counted, not
  classified). Only reasons with rows appear, in the list's order. Their rows
  add up to `unrecognizedCurrentRows`, and the wire contract refuses any
  other shape.
- Each row's reason is its own `classifyCardUsage` reason. The read and the
  lane build the fact the same way (`cardUsageFactOf`, now in
  `packages/application/src/query/card-usage-fact.ts`). An installment,
  revolving or bonus row therefore stays `payment_type_unsupported`, or
  `installment_amount_differs` or `payment_split_unknown` for a MyJCB amount
  mismatch. It gets a code of its own only when one is observed and confirmed
  as this record requires.
- The read's one pass over current usage (`CARD_PURCHASE_CURRENT_SQL`) also
  returns the unrecognised rows' classified columns. It returns at most
  `CARD_USAGE_REASON_READ_LIMIT` (2,000) of them, lowest observation id
  first. It still counts every row, and the rest are `beyond_read_limit`.
  Provider text in those columns, such as the MyJCB combined cell, is read in
  the request and dropped there. The page carries counts and codes only.
- `coverage.refundsAllocated` is always `false`.
- The `/purchases` page lists the counts per reason under its
  unrecognised-rows notice.
- Nothing is written: no event, decision, proposal or stored count (INV07).

### Consequences

- An operator or agent can see how many current rows are unsupported
  payment types, unreadable amounts or not yet processed. A count of zero
  means no such row is current. It does not mean the provider has none: an
  uncollected statement has no row.
- The pass materializes the classified columns of every current row instead
  of only its key. The plan still starts from the current captures.
- Above 2,000 unrecognised rows, the excess has no reason, only a count.
- Partial payments and multiple debits stay statement-side and are not named
  on this page.

### Verification

- `packages/domain/test/card-purchase.test.ts`: `unrecognizedReasonCounts`
  on synthetic rows. Covers Vpass codes other than `1`, MyJCB installment and
  revolving wording, an installment slice, an unreadable amount, a refund
  shape, a recognisable row and the bound.
- `packages/application/test/card-purchase-current.test.ts`: the pass against
  its shipped text (`card-purchase-current-legacy-sql.ts`) on the random
  stores of `packages/read-model/test/card-usage-random-store.ts`. Checks the
  same keys and count, exactly the unrecognised rows up to each bound, and
  reasons equal to each row's classification.
  `card-purchase-scale.test.ts` checks the same keys and count on the scaled
  store without statistics, and the plan check.
  `card-purchase-query.test.ts` pins the reasons and the bound on the
  snapshot world.
- `apps/web/test/card-purchase-contract.test.ts` refuses a guessed code, a
  reason given twice, out of order or with no rows, a sum other than the
  count, and `refundsAllocated: true`.
  `card-purchases.browser.test.ts` checks the listed counts.
