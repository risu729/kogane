# ADR 0028: The SBI Shinsei parsers accept the shapes the stored captures carry, with the unknowns kept as reasons

- Status: proposed
- Date: 2026-09-27
- Carried by:
  `packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts` (0.1.2),
  `packages/parsers/src/parsers/sbi-shinsei-exchange-rate.ts` (1.0.1),
  `packages/domain/src/price-sources.ts` (`FxQuoteBasis.customerCategory`),
  `services/processor/src/price-promotion-job.ts`,
  `packages/storage-d1/migrations/core/0056_sbi_shinsei_exchange_rate_policy_version.sql`,
  [SBI Shinsei source note](../sources/sbi-shinsei-bank.md#parse-status-in-production-2026-09-26),
  [observations](../observations.md#sbi-shinsei-stored-capture-shapes-activity-parser-012-board-parser-101)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (accept only
  what evidence shows), [ADR 0018](0018-sbi-shinsei-bank-debit-adapter.md)
  (the settlement adapter that reads the activity rows),
  [ADR 0020](0020-price-promotion-by-rule.md) (the board and its price rule;
  amended alongside this ADR)

## Context

On 2026-09-26 CORE held 29 `top-accounts-balance-and-activity` captures, and
`sbi-shinsei-top-balances-and-activity` 0.1.1 had rejected every one
(`parser_rejected`). CORE keeps only the closed code, so why was not known.
The 29 `exchange-rate` boards had never been parsed successfully either:
ADR 0020 could not survey their bodies, which are in R2.

Survey of 2026-09-27. Method: the owner's local agent replayed stored
captures through the deployed parsers and reported structure and counts only
(no amounts, no labels, no dates of the captures). Observed:

1. **Activity.** Two captures (one from the importer era, one recent). Their
   key sets match 0.1.1's exactly. `activity.responseParam.fromDate`
   is present in `YYYY/MM/DD` form and `toDate` is an empty string;
   `activityDetails` has 10 rows in both. Replaying the stored bytes throws
   `incomplete activity window`: 0.1.1 demanded both ends or neither. That is
   the whole cause of the 29 rejections.
2. **Board.** `responseParam.exchangeRateInformation.responseParam` holds
   `transactionTime` and 67 `exchangeRates` rows of `{currency,
customerCategory, buyRate, sellRate, midRate}`: 13 currencies in 5
   `customerCategory` tiers each, CHF in one row, and one JPY row.
   `transactionTime` is 22 characters, `NNNN/NN/NN NN:NN:NN NN`: a
   19-character timestamp, a space and two more characters whose meaning
   nobody has observed. 1.0.0 rejects the board three ways: the timestamp form
   is not recognised, a currency appears more than once (the tiers), and a
   JPY row is present.

Nobody has observed what the empty `toDate` means, what the two trailing
characters mean, which tier applies to the owner, or whether a rate is per 1
or per 100 units.

## Options considered

1. **Keep rejecting, as today.** Safe, but no SBI Shinsei transaction or FX
   quote is ever published: card settlement review (ADR 0018) admits nothing
   from SBI Shinsei and the board is never read.
2. **Guess the semantics.** Read an empty `toDate` as the fetch date, the
   trailing characters as a fraction or a zone, and pick one tier (the first,
   or the cheapest) as "the" rate. Rejected under ADR 0004: each guess would
   produce a figure nobody has confirmed, and a wrong window end or tier is a
   wrong number, not a missing one.
3. **Accept the observed shape, and record each unknown as a reason on the
   observation instead of a value.** Chosen.

## Decision

- **`sbi-shinsei-top-balances-and-activity` 0.1.2.** A present `fromDate` with
  an empty or absent `toDate` is a window whose end the provider did not
  state. `fromDate` still bounds every posting date from below; no upper bound
  is checked and no end date is invented. Every observation of the activity
  block (its rows and `activity_current_balance`) records
  `_kogane.activityWindowEnd: "not-stated"`. The parser declares no requested
  range, so there is no range contract to amend; the marker is the whole
  record. A `toDate` without a `fromDate`, and rows without a `fromDate`, stay
  refused, and a stated `toDate` still bounds every posting date above.
  `compactDate` already read `YYYY/MM/DD`; a test now proves it. Every other
  rule is unchanged.
- **`sbi-shinsei-exchange-rate` 1.0.1.**
  - A `transactionTime` in a form `providerTimestamp` does not recognise no
    longer fails the board. The observations carry no provider time (`asOf` is
    absent), so every reader falls back to the artifact's fetch instant and
    marks it as the collector's (`priceEffectiveTime`, basis `collector`).
    Each observation records `_kogane.providerTimeBasis: "unrecognized"`, the
    text stays verbatim in `_kogane.providerContext`, and one `info` issue
    (`unknown_fields_preserved`, impact `field`) names the locator without the
    value. No part of the text is parsed. A recognised form with an impossible
    calendar value, or a non-string, still fails.
  - A row's identity is `(currency, customerCategory)`, the category compared
    as the provider sent it. Every tier gives its own three observations with
    the category verbatim in `extra`; the duplicate check applies to the pair.
    The container claim expects rows × 3 over all tiers.
  - A JPY row is not a quote. It is skipped with one `info` `row_unreadable`
    issue of impact `none` and left out of the expected count, so the board
    stays complete; a board with no quote row left is refused like an empty
    one.
- **The price rule picks no tier.** An admission in `SBI_SHINSEI_FX_QUOTE_BASIS`
  now names `(currency, customerCategory, basis)`; `fxBoardPrice` reads only
  rows of the admitted tier and counts every other row `unsupported_currency`.
  The promotion lane passes each row's `extra.customerCategory` to the rule
  (one projected column; the rows it selects are unchanged). The table stays
  empty. ADR 0020 is amended to say so.
- **Migration 0056** moves the board's `coverage-v1` policy row from
  `required_parser_version = '1.0.0'` to `'1.0.1'`: the selection matches the
  version exactly, so without it no 1.0.1 board could become current. The
  activity dataset's policy row names no version and needs no change.

## Consequences

- **What stays unsupported.** The window's end (only its start is enforced);
  the two trailing characters of `transactionTime` and therefore the board's
  own time (the fetch instant stands in, marked as the collector's); which
  `customerCategory` tier applies to the owner; each currency's quote basis.
  No FX row is promoted until a change admits a currency with its tier, basis
  and evidence and amends ADR 0020.
- Five tiers of one currency are five sets of valuation observations of the
  same account, subject and metric, told apart by `extra.customerCategory` and
  their raw locators. Nothing reads them as money; a reader that wants one
  rate per currency must choose a tier, and today only the price rule may, by
  admission.
- **Re-parse after deploy.** The repair lane's cyclic scan creates a job for
  every stored artifact whose (parser, version) has none, so it re-parses the
  29 activity captures at 0.1.2 and parses the 29 boards at 1.0.1 without an
  operator step, at its budget (28 jobs a tick,
  [observation lanes](../observation-lanes.md#repair-budget-and-drain-rate)).
  An operator can instead start a replay plan per dataset (`/replay/plan`,
  `/replay/start`) to do it at once. The boards become the first SBI Shinsei
  FX observations ever published, and the activity rows the first SBI Shinsei
  transactions the settlement adapter (ADR 0018) can admit.
- Whether every stored capture passes the checks after the first one is not
  known here: the replay reported the first throw only. Any remaining refusal
  shows as `parser_rejected` on the new version's jobs.
- The frozen coverage-contract outputs of every earlier case are unchanged:
  the freeze script regenerates the historical files byte for byte under the
  new versions.

## Verification

- `packages/parsers`: the observed activity shape (slash `fromDate`, empty
  `toDate`, 10 one-sided rows with slash posting dates) parses to 10
  transactions, each activity observation marked `activityWindowEnd:
"not-stated"`; a posting date before `fromDate`, an unstated or impossible
  start and a two-sided row still refuse; a stated `toDate` still bounds
  above. The observed board (13 × 5 + CHF + JPY, 22-character time) gives 198
  observations, complete, `expectedCount` 198, issues exactly the time and
  the JPY row, no provider time and no timestamp text in any issue or
  warning; changing the trailing characters changes no value; a recognised
  time still sets `asOf`; an impossible or non-string time, a JPY-only board
  and a pair listed twice still refuse. New coverage-contract cases with a
  frozen expectations file (`sbi-shinsei-observed-shapes-expected.json`) and
  digests for the two bumped parsers only.
- `packages/domain`: every tier is `unsupported_currency` with the production
  table and with an admission of another tier; an admission of one tier
  promotes that tier only; a numeric tier never matches its text.
- `services/processor`: the lane over the parsed observed board promotes
  nothing with the production table (198 unsupported) and exactly the admitted
  tier's three cells with a synthetic admission, at the fetch instant marked
  `collector`; every `coverage-v1` row that pins a version names a deployed
  parser; the migration pin is 0056.
- `packages/read-model` and `experiments/observation-pipeline-local`: the
  migrated policy row requires 1.0.1.
- The survey counts above are the owner's agent's (structure and counts, no
  values). Production was not read for this change, and no replay of the
  stored captures at the new versions has been run.
