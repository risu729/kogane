# ADR 0004: Accept only the payment-type shapes production evidence shows

- Status: accepted
- Date: 2026-09-25
- Implemented by: #246
- Carried by: [economic events](../economic-events.md#single-payment-per-source),
  `classifyCardUsage` and `myjcbSinglePayment` in
  `packages/domain/src/card-purchase.ts`, `payment_type` in
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
