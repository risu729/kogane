# ADR 0031: The owner's SBI Shinsei stage category, as the same run states it, selects the FX board tier

- Status: proposed
- Date: 2026-09-27
- Carried by:
  `packages/parsers/src/parsers/sbi-shinsei-balance-summary-and-stage.ts` (0.1.0),
  `packages/domain/src/price-sources.ts` (`SBI_SHINSEI_FX_PER_UNIT_CURRENCIES`,
  `FxStageCategory`, `stageMatches`, `fxBoardPrice`),
  `services/processor/src/price-promotion-job.ts` (`STAGE_SQL`,
  `tier_unmatched`, `stage_unstated`),
  `packages/application/src/collection/descriptors.ts` (the
  `balance-summary-and-stage` dataset),
  `services/processor/scripts/parser-rejection.ts` (the new parser's throw
  sites),
  [SBI Shinsei source note](../sources/sbi-shinsei-bank.md#stage-category-and-the-board-tier-adr-0031-2026-09-27),
  [calculation and reports §1](../calculation-and-reports.md#price-sources-provider-claims-promoted-by-rule)
- Amends: [ADR 0020](0020-price-promotion-by-rule.md) (a second admission path
  for `fx-sbi-shinsei-board-v1`; a dated note there points here)
- Related: [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), [ADR 0022](0022-registration-artifact-datasets.md)
  (the dataset table for shared-R2 registration; amended with a note),
  [ADR 0028](0028-sbi-shinsei-observed-capture-shapes.md) (the board is tiered
  by `customerCategory`), [ADR 0029](0029-data-classification-and-unkeyed-identity.md)
  (names are avoided in CORE)

## Context

**The board is tiered.** The FX board SBI Shinsei returns on every run
(`IFCM_CommonAdapter/getExchangeRate`,
`responseParam.exchangeRateInformation.responseParam.exchangeRates[]`, rows of
`currency`, `customerCategory`, `buyRate`, `sellRate`, `midRate`, all
strings) lists 13 currencies once in each of 5 `customerCategory` values and 2
currencies (CHF, JPY) in one row each
([ADR 0028](0028-sbi-shinsei-observed-capture-shapes.md)). ADR 0020's
amendment made every admission name `(currency, customerCategory, basis)` in
the manual table `SBI_SHINSEI_FX_QUOTE_BASIS`, which is empty, so no FX row has
ever been promoted.

**The owner's stage is captured and was unread.** Every run also calls
`IFTP_TopAdapter/getBalanceSummaryAndStage` and stores the response as the
`balance-summary-and-stage` artifact (`raw-balance-summary-and-stage.json`,
collector schema `sbi-shinsei-balance-summary-v1`). Its
`responseParam.category.responseParam.customerCategory` is the customer's
Step-Up stage, beside `freeTransferCount`, `atmFee`, `allowedAtmWithFreeCnt`
and `balanceAtmWithFreeCnt`. No parser read that artifact, and the shared-R2
dataset table gave it no dataset (ADR 0022). The field is not in the top page
(`raw-top-accounts-balance-and-activity.json`, which has only the overview and
activity blocks), so the top-page parser is unchanged.

**Observed on 2026-09-27** (the owner's agent, structure and match results
only, no values): on a stored run of 2026-09-10, on the live API in one
session, and on the logged-in FX savings page (外貨普通預金), the stage
category is a one-character string in the same scheme as the board's five
codes, and it is strictly equal (`===`) to exactly one of them. Of that
session's five USD rows, the one whose `customerCategory` equals the stage is
the one whose buy and sell rates the FX page shows (the mid rate is the same
in all five). The page labels the stage 「今月のステージ」 (this month's stage),
so it can change from month to month. The owner confirmed that the five board
values are the five stages. Which code is the owner's is not recorded here,
and nothing depends on it.

**The quote basis.** The provider's public rate page and its beginners' page
state the 13 listed currencies in yen, with fees per 1 base currency unit
(USD worked per 1 unit) (survey of 2026-09-27; recorded as the provider's
documentation in ADR 0020's amendment of that date, #286). CHF appears on no
page or screen, and JPY is not a quote. BRL is on the public page but not on
the logged-in FX page (12 currencies there).

**Why not ask the owner per currency.** A manual entry per currency and tier
is the owner's reading of the board, typed once and wrong the month the stage
changes. The provider states both sides itself on every run: the board names
each row's tier, the balance summary names the customer's stage. Matching
them needs no owner judgement and follows a stage change on the next run.

## Options considered

1. **Owner-typed admissions.** The owner names the tier per currency in
   `SBI_SHINSEI_FX_QUOTE_BASIS`. Rejected as the path for the owner's tier:
   it restates what the provider states, and needs a code change every time
   the monthly stage changes. It stays as a manual override, empty.
2. **Hard-code the owner's tier.** Admit the rows of one fixed code. Rejected:
   it goes stale when the stage changes, and it would put the owner's stage in
   code.
3. **Parse the stage and admit by equality.** A parser emits the stage category
   verbatim; the rule admits a board row whose category is strictly equal to
   the stage stated by the same collection run. Chosen.

For where the stage is stored, a new observation kind with its own table was
rejected for one value per run: it needs a migration, append-only triggers,
the writer, the decimal trigger, the identity audit and every evidence reader
to learn it. The valuation kind already holds provider statements that are
not holdings (the board's rates, account `sbi-shinsei:fx-board`), and a
valuation row may carry no amount. For which stage is current, "the latest
published stage" was rejected: the stage is monthly, which stage a board row
got would depend on the order in which the parse lanes published, and a
freshness window would have to be invented. The same run is where the
provider states both, in one session.

## Decision

- **Parser.** `sbi-shinsei-balance-summary-and-stage` 0.1.0 reads the
  `balance-summary-and-stage` dataset. It validates the whole response exactly
  as the collector does (an unknown field fails the artifact) and emits one
  valuation-kind observation: account `sbi-shinsei:customer`, subject
  `customerCategory`, metric `provider_customer_category`, currency `XXX`
  (ISO 4217: no currency involved), no amount, the category verbatim in
  `extra.customerCategory` with `_kogane.valueType` and
  `_kogane.amountDisposition: "not-an-amount"`, and the category block's other
  fields as provider context. A category that is absent, null, empty, boolean
  or structured fails the artifact. Nothing else leaves the artifact: the
  summary block's names (class d) and balances (already reported by the top
  page, INV06) and the branch block are validated only.
- **Dataset.** Shared-R2 registration maps `raw-balance-summary-and-stage.json`
  to `balance-summary-and-stage`, the dataset name the retired importer used.
  No snapshot policy row is added: nothing selects these observations as a
  container snapshot, so no migration is needed.
- **Rule.** `fx-sbi-shinsei-board-v1` admits a board row by either path:
  - a manual entry for its currency in `SBI_SHINSEI_FX_QUOTE_BASIS` (as
    before; the table stays empty, and an entry decides its currency alone);
  - otherwise, when the currency is one of the 13 in
    `SBI_SHINSEI_FX_PER_UNIT_CURRENCIES` (never CHF or JPY) and the row's
    `customerCategory` is strictly equal to the stage category of the row's
    own collection run: same JSON type and value, compared as JSON text, so
    `"5"` is not `5`, and nothing is trimmed, folded or mapped. The price is
    per 1 unit, quote JPY, as before.
- **Only the matching row.** Only a row whose code equals the stage is the
  owner's rate. A currency listed once, in a code that is not the stage, has
  no owner's rate on that board; it is refused, and no other row, tier or run
  stands in for it (INV05: a missing match is a reason, never a fallback).
- **Current stage.** The stage of a board row is what the published
  `sbi-shinsei-balance-summary-and-stage` observations of the balance-summary
  artifacts of the **same fetch run** state. Exactly one distinct category
  admits; none, or more than one, admits nothing. A stage from any other run
  is never used.
- **Closed reasons.** A row of a per-1-unit currency that the stage path
  refuses is counted, in the lane's result, log line and tick record (counts
  only), as `stage_unstated` when its run states no stage or more than one,
  and as `tier_unmatched` when the run states one stage and the row is of
  another code or has none. CHF, JPY and every unlisted currency stay
  `unsupported_currency`.
- **Lane.** The promotion lane makes one more read per tick, `STAGE_SQL`, and
  only when its page holds board rows: per board observation, its category
  and the run's stated categories. Every table is reached by key from the
  page's own rows (plan checked without statistics). A tick makes at most
  nine D1 calls.
- **No operator step (INV06, INV07).** A price is derived state, not an
  adopted decision: ADR 0020 promotes provider claims by a closed rule into
  append-only rows that a reader selects at read time, with no approval, and
  that argument is unchanged. The stage match is part of the rule, not a
  heuristic proposing anything; it never changes adopted state, and the price
  id stays `price_<sha256(rule, claimRef)>`, so nothing is counted twice.

## Consequences

- **Expected counts per stored board** (67 rows; the JPY row is skipped by the
  parser): 39 promoted cells (13 currencies × 3 rates in the owner's tier),
  156 `tier_unmatched` (the other 4 tiers) and 3 `unsupported_currency` (CHF),
  when the run's balance summary is parsed and published; with no stage for
  the run, 195 `stage_unstated` and 3 `unsupported_currency`.
- **If the notations ever diverge,** nothing is promoted: every per-1-unit row
  counts `tier_unmatched`. A mapping between two notations would be a new
  decision, not something this rule guesses.
- **The check the owner can do.** The promoted row's buy and sell rates should
  equal the rates the logged-in FX savings page shows at the same time (the
  check the owner's agent made on 2026-09-27). If they differ, the stage
  match picked a tier the owner does not get, and the rule must be stopped
  (revert, or an empty per-unit list) before any report uses it.
- **Order dependence is bounded, not removed.** A board row is judged when the
  lane reaches it. If the same run's balance-summary parse is not yet
  published then (its job failed and retries later, or the artifact was
  registered without a dataset), the row is `stage_unstated` and, like every
  refusal, not retried under the same rules; re-examining it needs the
  valuation cursor reset, an operator action on operational state that writes
  nothing twice. Within a run the collector reads the balance summary before
  the board, and parse jobs of one lane run in artifact-id order after
  priority and availability, so a fresh run's stage is expected to be
  published first; that the registered artifact ids follow the read order is
  not verified.
- **Registration window.** A v2 registration made before this change deploys
  keeps its balance-summary artifact without a dataset, so its boards find no
  stage. A balance-summary artifact stored with the dataset (the retired
  importer registered this dataset name; how many stored artifacts carry it
  was not surveyed) is parsed by the repair lane without an operator step.
  The stored boards have no observations yet (the owner's agent reported on
  2026-09-27 that parser 1.0.1 refused every stored board), so each is judged
  when a board parser that accepts it writes its rows, against the stage its
  run has published by then.
- **What stays manual.** `SBI_SHINSEI_FX_QUOTE_BASIS` is unchanged and empty.
  CHF stays out until a page or screen states its basis. BRL is admitted on
  the public page's statement although the logged-in FX page does not list
  it. The per-1-unit list is the provider's documentation of today; a change
  of convention would not be detected by the parser (`quoteBasis:
"not-stated"` on every row).
- **The stage observation is visible evidence.** It appears among valuation
  observations with currency `XXX` and no amount (its decimal row is
  `missing`, never zero); the financial-product reader stops at it as it does
  at the board's rows. No snapshot policy selects it, so no current or dated
  state lists it.
- **Names in the raw artifact.** `raw-balance-summary-and-stage.json` also
  stores `customerName`, `customerNameKanji` and `customerNameKana` under
  `responseParam.summary.responseParam` in R2 (ADR 0029 class d: names are
  avoided); this parser never copies them, and redacting them from the stored
  artifact going forward is left to a separate change.

## Verification

- `packages/parsers/test/sbi-shinsei-parsers.test.ts`: routing to the new
  parser; the synthetic fixture
  (`tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/balance-summary-and-stage.json`)
  gives exactly one observation with the category verbatim; names, balances
  and the branch appear nowhere in the result; a number stays a number and a
  string a string; an absent, empty, null, boolean or structured category and
  an unknown field anywhere fail the artifact.
- `packages/domain/test/price-sources.test.ts`: the per-1-unit list is the 13
  currencies, never CHF or JPY; of five tiers only the stated one promotes;
  a currency listed once in another tier is `tier_unmatched` and promotes
  only in the stated tier; `"3"` against `3`, a leading space or a case
  change never match; `true`, `null`, `""`, objects and invalid JSON never
  match; an absent or disagreeing stage is `stage_unstated`; a manual entry
  decides its currency alone.
- `services/processor/test/price-promotion-stage.test.ts`, over parsed
  synthetic runs: the stated tier promotes USD and EUR per 1 unit with exact
  counts (33 scanned, 6 promoted, 24 `tier_unmatched`, 3
  `unsupported_currency`); a number-notation board against a string stage
  promotes nothing; a stage stated only by another run promotes nothing
  (`stage_unstated`); two disagreeing pages in one run promote nothing and
  two agreeing ones promote; a page the parser refuses promotes nothing; a
  currency listed once promotes only in the stated tier; and `STAGE_SQL`'s
  plan on a store migrated through every core migration, without statistics,
  scans none of its tables and reaches them by
  `idx_fetch_artifacts_run_role`, the publication key,
  `idx_val_obs_parse_run` and primary keys.
- `services/processor/test/price-promotion.test.ts`, `lanes.test.ts` and
  `lane-ticks.test.ts`: the existing lane cases with the new counters, and the
  tick record keeps both.
- `services/processor/test/parser-rejection.test.ts`: the new parser's two
  throw sites map to named categories in the replay diagnostics.
- `scripts/artifact-datasets.test.ts`: the balance-summary artifact gets its
  dataset and the new parser is reachable from a shared-R2 artifact.
- Production was not read for this change; the observations above are the
  owner's agent's report of 2026-09-27 (structure and match results only).
