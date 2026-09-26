# ADR 0020: Prices are provider observations promoted by a closed rule list

- Status: proposed
- Date: 2026-09-26
- Implemented by: #268
- Carried by: [calculation and reports §1](../calculation-and-reports.md#price-sources-provider-claims-promoted-by-rule),
  [SBI Shinsei exchange-rate board](../sources/sbi-shinsei-bank.md#exchange-rate-board-parser-sbi-shinsei-exchange-rate-2026-09-26),
  [processor §6](../processor.md#6-lanes),
  `packages/domain/src/price-sources.ts`,
  `packages/parsers/src/parsers/sbi-shinsei-exchange-rate.ts`,
  `packages/storage-d1/migrations/core/0053_price_promotion.sql`,
  `services/processor/src/price-promotion-job.ts`,
  `packages/read-model/src/price-selection.ts`

## Context

`price_observations` (migration 0034) stores a price with its base quantity
and the claim that asserted it, but nothing wrote it, so every report cell was
`missing-price`. The evidence already holds prices: SBI Securities positions
carry a per-share price beside the provider's market value (domestic
`current_price`, foreign `stockPrice.last`), and SBI Shinsei stores its
foreign-currency board on every run, which nothing parsed. The next-milestone
plan ([section 4](../plans/2026-09-next-milestone.md#4-binding-decisions),
decisions 3 and 4) asks that prices be observations promoted by rule and names
the FX policy.

## Options considered

1. Fetch prices from a market data API at read time. Rejected: a price would
   not be evidence, and a report could not be reproduced.
2. Let a reader take any provider number that looks like a price. Rejected:
   `8,000` does not say what quantity it prices, and a guessed basis is a
   wrong figure.
3. Promote provider claims already stored as observations, by a closed list of
   rules, each proving its basis on the same provider row, into the existing
   append-only table, with the claim recorded beside each price. Chosen.

## Decision

- **Rules.** `packages/domain/src/price-sources.ts` holds the only rules:
  `fx-sbi-shinsei-board-v1` (mid → `reference`, buy → `bid`, sell → `ask`;
  base the currency, quote JPY, per 1 unit), `sbi-domestic-current-price-v1`
  (per 1 share, quote JPY, paired with its position and `market_value` in the
  same MTS record by the `POSITION_VALUATIONS_SQL` locator rule) and
  `sbi-foreign-stock-price-last-v1` (per 1 share, quote the position's
  `currencyCode`). Execution prices are never used for valuation.
- **Basis checks.** A position price is promoted only when quantity × price
  equals the provider's market value on the same row, exactly. An FX row is
  promoted only for a currency whose quote basis is verified as per 1 unit in
  `SBI_SHINSEI_FX_QUOTE_BASIS`. A refused claim is counted
  (`basis_unverified`, `unsupported_currency`) and writes nothing.
- **No FX currency is admitted yet.** The payload never states a base
  quantity, and the survey the plan asked for could read only artifact
  metadata: the board bodies are in R2, and CORE holds no aggregate of the
  currency list, the `customerCategory` values or `transactionTime`. Under
  AGENTS.md and [ADR 0004](0004-payment-type-shapes-from-evidence.md), a
  basis nobody observed and the owner has not confirmed stays unsupported. A
  currency is admitted by adding it with its evidence, in a change that amends
  this ADR.
- **Effective time.** The provider's own instant when the claim states one
  (basis `provider`), otherwise the artifact's fetch instant (basis
  `collector`). A provider date is never promoted to an instant.
- **Identity and history.** The price id is `price_<sha256(rule, claimRef)>`
  with `claimRef = <kind>_observations/<id>#<json path>`, also stored as
  `source_claim_ref`. `price_observation_claims` records rule, claim kind,
  observation, parse run and path; it is append-only and `core-keep`. A
  re-parse writes new observations and therefore new prices; nothing is
  rewritten.
- **Lane.** `price_promotion` runs after `identity_sweep` and right before
  `report_job`, without a flag: it writes only append-only prices and claims,
  and nothing reads them until it selects them. At most 500 claims a tick,
  one cursor per claim kind in `price_promotion_cursor` (operational-mutable,
  outside the revision ledger), `INSERT … WHERE NOT EXISTS`, counts-only log
  and tick record.
- **Selection.** `selectPrices` picks, per (base, quote, kind), the latest
  price with an instant effective time at or before the cutoff whose claim's
  parse run is currently published.
- **FX policy name.** The policy that will value with this board (P2-3) is
  `fx-sbi-shinsei-mid-v1`: pivot JPY, SBI Shinsei's mid rate. The name says
  whose rate it is because the board is a customer rate, possibly tiered by
  `customerCategory`, not a market reference such as TTM or an ECB fixing;
  those can be added later as other `fx` policies. A board that lists one
  currency twice is refused rather than one tier being picked.

## Consequences

- The report job, which still reads the most recently recorded price per
  instrument in its base unit, can value domestic holdings from the promoted
  JPY prices. It has no cutoff, publication join or freshness rule, so a
  holding whose latest price was refused is valued at an older promoted one.
  Moving it to `selectPrices` with freshness and FX is P2-3.
- The SBI Shinsei `exchange-rate` artifacts are parsed and chosen as a
  complete container under `coverage-v1`; an empty board is refused and never
  replaces the previous one.
- A rule change that should re-examine refused claims needs its cursor reset,
  an operator action on operational state; promotion stays idempotent.
- Prices and their claims stay outside the source-revision ledger, like
  `price_observations`; a READ projection over prices would need bump
  triggers first.
- The migration takes 0053, as assigned, because 0051 and 0052 are reserved
  by other pull requests of the same plan.

## Verification

- `packages/parsers`: boundary tests (an unknown field at each level, an empty
  board, a per-100 unit marker refused as an unknown field, a duplicate
  currency, unreadable cells) and the coverage-contract cases with frozen
  expectations.
- `packages/domain`: each rule's mapping and refusal, the basis check
  promoting VT and AAPL from the synthetic fixture and refusing tampered rows,
  a per-100 basis refused, the price id and effective-time rules.
- `packages/read-model`: selection by instant across offsets, a re-parse
  moving selection once published, unpublished parses ignored, append-only
  triggers, and a query plan that reaches prices by instrument without table
  statistics.
- `services/processor`: the lane over parsed synthetic fixtures, replay
  writing nothing, a re-parse adding rows, a pending parse holding the
  cursor, the budget, lane order, tick records and the migration pin.
- The production counts in the docs are read-only aggregates (counts and
  shapes, no values), taken on 2026-09-26.
