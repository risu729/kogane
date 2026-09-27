# ADR 0028: The SBI Shinsei parsers accept the shapes the stored captures carry, with the unknowns kept as reasons

- Status: proposed; amended 2026-09-27 (the trailing characters are letters;
  parser 1.0.2, migration 0059; see
  [the amendment](#amendment-2026-09-27-the-two-trailing-characters-are-letters-parser-102))
- Date: 2026-09-27
- Carried by:
  `packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts` (0.1.2),
  `packages/parsers/src/parsers/sbi-shinsei-exchange-rate.ts` (1.0.1; 1.0.2
  by the amendment),
  `packages/domain/src/price-sources.ts` (`FxQuoteBasis.customerCategory`),
  `services/processor/src/price-promotion-job.ts`,
  `packages/storage-d1/migrations/core/0056_sbi_shinsei_exchange_rate_policy_version.sql`,
  `packages/storage-d1/migrations/core/0059_sbi_shinsei_exchange_rate_policy_version_1_0_2.sql`,
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
  `toDate` as an empty string is a window whose end the provider did not
  state. An absent or null `toDate` beside a present `fromDate` was not
  observed and stays refused. `fromDate` still bounds every posting date from below; no upper bound
  is checked and no end date is invented. Every observation of the activity
  block (its rows and `activity_current_balance`) records
  `_kogane.activityWindowEnd: "not-stated"`. The parser declares no requested
  range, so there is no range contract to amend; the marker is the whole
  record. A `toDate` without a `fromDate`, and rows without a `fromDate`, stay
  refused, and a stated `toDate` still bounds every posting date above.
  `compactDate` already read `YYYY/MM/DD`; a test now proves it. Every other
  rule is unchanged.
- **`sbi-shinsei-exchange-rate` 1.0.1.**
  - A `transactionTime` of exactly the observed shape, 22 characters
    `NNNN/NN/NN NN:NN:NN NN` with a digit in every `N` place, no longer fails
    the board; it is matched as a shape and never parsed. Any other form
    `providerTimestamp` does not recognise still fails, as in 1.0.0. The observations carry no provider time (`asOf` is
    absent), so every reader falls back to the artifact's fetch instant and
    marks it as the collector's (`priceEffectiveTime`, basis `collector`).
    Each observation records `_kogane.providerTimeBasis: "unrecognized"`, the
    text stays verbatim in `_kogane.providerContext`, and one `info` issue
    (`unknown_fields_preserved`, impact `field`) names the locator without the
    value. No part of the text is parsed. A recognised form with an impossible
    calendar value, or a non-string, still fails. (If the trailing characters
    turn out not to be digits on some board, that board stays refused and
    shows as `parser_rejected`; nothing is guessed.)
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
  start, an absent or null `toDate` beside a stated start and a two-sided row
  still refuse; a stated `toDate` still bounds above. The observed board (13 × 5 + CHF + JPY, 22-character time) gives 198
  observations, complete, `expectedCount` 198, issues exactly the time and
  the JPY row, no provider time and no timestamp text in any issue or
  warning; changing the trailing characters changes no value; a recognised
  time still sets `asOf`; an impossible or non-string time, any unrecognised
  time of another shape (another length, a non-digit suffix, an ISO form), a
  JPY-only board and a pair listed twice still refuse. New coverage-contract cases with a
  frozen expectations file (`sbi-shinsei-observed-shapes-expected.json`) and
  digests for the two bumped parsers only.
- `packages/domain`: every tier is `unsupported_currency` with the production
  table and with an admission of another tier; an admission of one tier
  promotes that tier only; a numeric tier never matches its text.
- `services/processor`: the lane over the parsed observed board promotes
  nothing with the production table (198 unsupported) and exactly the admitted
  tier's three cells with a synthetic admission, at the fetch instant marked
  `collector`; a board whose tiers are numbers promotes under an admission of
  the same number and nothing under its digits as text (the tier reaches the
  rule through `json_extract` with its type); every `coverage-v1` row that
  pins a version names a deployed
  parser; the migration pin is 0056.
- `packages/read-model` and `experiments/observation-pipeline-local`: the
  migrated policy row requires 1.0.1.
- The survey counts above are the owner's agent's (structure and counts, no
  values). Production was not read for this change, and no replay of the
  stored captures at the new versions has been run.

## Amendment (2026-09-27): the two trailing characters are letters (parser 1.0.2)

**Context.** The owner's agent ran `replay-diagnostics` against production
after 1.0.1 was deployed and surveyed the provider's screens (report of
2026-09-27; structure and counts only, no values):

- The stored boards' `transactionTime` is 22 characters,
  `dddd/dd/dd dd:dd:dd aa`: a date, a time with seconds, a space and **two
  letters**, not two digits. The survey above wrote the shape as
  `NNNN/NN/NN NN:NN:NN NN` and 1.0.1 read every `N` as a digit, an assumption
  no board showed. So 1.0.1 matched no stored board: the replay selected 17
  boards and refused all 17 with the closed category "provider timestamp format
  is not recognized" (throw sites in `sbi-shinsei-common.ts`
  `providerTimestamp` and `sbi-shinsei-exchange-rate.ts`), and the report
  counted 33 `error` and 0 `ok` parse runs of the parser. All 17 are importer-era
  captures. The 17 boards the replay selected are not matched here to the 29
  stored `exchange-rate` artifacts of the 2026-09-26 survey, which carry 17
  distinct payloads.
- The screens explain nothing about the letters. The logged-in top shows 5
  currencies with a mid rate only and a time `yyyy/mm/dd hh:mm更新`; the FX
  savings page shows 13 currencies (USD, EUR, CAD, AUD, GBP, NZD, SGD, HKD,
  ZAR, NOK, CNY, TRY, BRL) with buy, mid and sell and a time
  `yyyy/mm/dd hh:mm`; the public rate page shows the same 13 with TTS, TTB and
  mid and a time in Japanese date form. No screen shows seconds or the two
  letters, **CHF appears on no screen**, and no screen shows a per-100 unit:
  the top labels a row by a digit and the currency's name, and the public page
  states its fees per 1 base currency unit and its rates in yen.

**Options considered.**

1. Keep 1.0.1: every stored board stays `parser_rejected`, as today.
2. Read the letters (as a meridiem, a zone or a sequence). Rejected under
   ADR 0004: nothing on the provider's screens or pages says what they are.
3. Match the observed letter shape exactly, as 1.0.1 meant to, and keep the
   digit form 1.0.1 invented alongside it. Rejected: the digits were never
   observed, and keeping them would leave an unobserved form accepted.
4. **Match the observed letter shape exactly and drop the digit form.**
   Chosen.

**Decision.** `sbi-shinsei-exchange-rate` 1.0.2 matches a `transactionTime`
of exactly `^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2} [A-Za-z]{2}$`: 22 characters,
two ASCII letters after the space, in either case (the report says letters
and not their case, and the letters are never read, so the case changes no
value). Everything else is as 1.0.1: the text is matched as a shape and never
parsed; the observations carry no provider time, so readers use the fetch
instant marked as the collector's; each records
`_kogane.providerTimeBasis: "unrecognized"`, the text stays verbatim in the
provider context, and one `info` `unknown_fields_preserved` issue names the
locator without the value. The two-digit suffix 1.0.1 accepted is refused
again, as is every other unrecognised form (another length, a letter and a
digit, a letter outside ASCII, a missing space): each still throws in
`providerTimestamp` and shows as `parser_rejected`. **Migration 0059** moves
the board's `coverage-v1` row from `required_parser_version = '1.0.1'` to
`'1.0.2'`, with the conditional UPDATE of 0056.

**Consequences.**

- After deploy the repair lane's cyclic scan creates a 1.0.2 job for every
  stored board: jobs are keyed by (artifact, parser, version), and a failed
  1.0.1 job does not stop a 1.0.2 one. No operator step is needed; a replay
  plan for the dataset does it at once. The board's own time, the tier that
  applies to the owner and each currency's basis stay unknown, as before; the
  basis is now recorded from the provider's public pages in the ADR 0020
  amendment, and no price is admitted.
- The meaning of the two letters stays unsupported. If a later board carries
  another suffix, it is refused and found the same way, with
  `replay-diagnostics`.
- The board lists CHF (one row) though no screen shows it; nothing about CHF
  is decided here.

**Verification.** `packages/parsers`: the synthetic observed board now ends
in two letters and parses complete to 198 observations with no provider time;
the suffix in either case falls back at exactly 22 characters; the two-digit
suffix, a letter and a digit, a full-width or accented letter, one character
more or fewer, and a missing space are refused; the other 1.0.1 tests are
unchanged; the coverage-contract expectations change in the 198 verbatim
`transactionTime` values only, and every other frozen file re-freezes byte for
byte. `services/processor`: the lane test seeds a board with a failed 1.0.1
job and shows the repair scan creating and running a 1.0.2 job, with the
policy row at 1.0.2; the parser-rejection classifier maps the two-digit form
to "provider timestamp format is not recognized" and its closure test still
covers every throw site; the migration pin is 0059. `packages/read-model` and
`experiments/observation-pipeline-local`: the migrated row requires 1.0.2.
The report's counts are the owner's agent's; production was not read for this
change, and no replay at 1.0.2 has been run.
