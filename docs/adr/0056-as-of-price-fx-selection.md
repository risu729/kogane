# ADR 0056: Price and FX selection at an as-of under an explicit, versioned policy

- Status: accepted (merged 2026-10-08 in #581)
- Date: 2026-10-08
- Issue: #552 (this record covers its selection part; acquisition stays open)
- Carried by: `packages/domain/src/market-data.ts`,
  `packages/domain/src/civil-date.ts` (`civilDateOfInstant`, `canonicalZone`),
  `packages/read-model/src/price-selection.ts` (`PRICE_CANDIDATES_SQL`,
  `PRICE_CANDIDATES_KNOWN_AT_SQL`, `selectPriceCandidates`),
  `packages/application/src/query/market-data.ts` (`selectMarketData`),
  [calculation and reports §1–§2](../calculation-and-reports.md#1-a-price-is-an-observation-with-a-basis),
  [domain contracts](../domain-contracts.md#market-datats--as-of-price-and-fx-selection)
- Amends: [ADR 0020](0020-price-promotion-by-rule.md) (its Selection
  decision; a dated note there points here)
- Amended: 2026-10-09, [valuation on a date as implemented](#amendment-2026-10-09-valuation-on-a-date-as-implemented)
  (`packages/domain/src/valuation-on-date.ts`,
  `packages/application/src/query/valuation-on-date.ts`; proposed until its
  pull request merges)
- Related: [ADR 0019](0019-dated-reported-state.md) (the exclusive bound of a
  date), [ADR 0004](0004-payment-type-shapes-from-evidence.md) (unobserved
  semantics stay unsupported), [ADR 0031](0031-sbi-shinsei-stage-category-fx-tier.md)
  (which FX board rows are promoted at all)

## Context

Prices are provider claims promoted by a closed rule list into append-only
`price_observations`, each with its claim in `price_observation_claims`
([ADR 0020](0020-price-promotion-by-rule.md)). Issue #552 asks for prices and
exchange rates to be acquired continuously and for the price used at a point
in time to be chosen explicitly. This record decides the second half only:
how a price and a rate are chosen for an as-of, from what is already stored.
Nothing is fetched from outside.

What existed before this change:

- `selectPrices` (`packages/read-model/src/price-selection.ts`) takes the top
  row per (base, quote, kind) whose instant is at or before a cutoff and whose
  parse run is currently published. It has no freshness rule, breaks a tie
  between two different prices at one instant silently (later `recorded_at`,
  then higher id), skips date-only prices, and `continue`s past a top row whose
  stored effective time the domain does not accept, which leaves the key with
  no price rather than the next one. It has no knowledge cutoff and no
  production caller.
- The report job values a holding only with a price claimed from the holding's
  own parse run (`SNAPSHOT_PRICE_SQL`), and has no FX step.
- `valueHolding` (`packages/domain/src/calculation.ts`) has a
  `freshnessFloor` option that nothing sets, and default parameters for its
  instrument policy.
- `published_parse_runs` names only the current parse per artifact and
  parser; `publication_events` is the append-only history of every pointer
  change (migration 0026, index `publication_events_target`).
- The only FX rule (`fx-sbi-shinsei-board-v1`) quotes 13 currencies in JPY per
  1 unit, never CHF or JPY. Every promoted effective time is an instant
  (provider basis, or the fetch instant with collector basis).
- No policy object, freshness rule, calendar, multi-source rule or
  disagreement check existed, and `calculation_policies` has never been
  seeded; its `kind` CHECK allows `rounding`, `pnl-decomposition`,
  `cost-basis` and `fx`.

## Options considered

1. **Extend `PRICE_SELECTION_SQL` with freshness and knowledge.** Rejected: it
   moves shipped text that has to stay provably equal, a SQL top-1 cannot see
   two different prices at one instant, and calendar and freshness rules do
   not belong in SQL.
2. **Latest available price with a staleness flag.** Rejected: "latest" is an
   implicit policy, and a flagged old price is still used as a value (INV05).
3. **A selected-price projection table.** Rejected: a migration, bump
   triggers and a ledger change for a read that is cheap per request; prices
   stay outside the source-revision ledger
   ([calculation and reports §1](../calculation-and-reports.md#1-a-price-is-an-observation-with-a-basis)).
4. **Seed `calculation_policies` now.** Rejected: its `kind` CHECK has no
   selection kind, and nothing stores a calculation run that would reference
   a policy row; a policy is fixed by its digest in the manifest instead.
5. **Knowledge at K from the current `published_parse_runs`.** Rejected: it
   would show a re-parse published after K, and lose a rollback, as if it had
   been known at K.
6. **A bounded candidate read in SQL and a pure policy in the domain, with
   closed codes and a manifest.** Chosen.

## Decision

- **Policy objects, no defaults.** `PriceSelectionPolicy` names the admitted
  rules, price kinds and temporal bases, the zone, the freshness
  (`calendar-days` or `business-days` with a calendar reference), the
  date-only rule (`exclude` or `civil-date-in-zone`), the multi-source rule
  (`refuse-on-overlap` or `priority-order`) and the candidate scope
  (`latest-in-window` or `same-snapshot`). `FxConversionPolicy` names a pivot,
  the currencies an admitted rule can quote against it, its selection policy
  (exactly one price kind) and an inverse rounding (mode and scale per unit)
  or none. Validators reject unknown keys, empty or duplicated lists, a
  negative or non-integer day count, and a zone the runtime does not know or
  that is not spelled as the runtime spells it (`canonicalZone`), so a
  policy's digest has one form. No function takes a default policy.
- **Six checks in order** (`selectPrice`): (1) filter, counting every
  removed candidate by a closed code: `recorded_after_known_at`,
  `rule_not_admitted`, `kind_not_admitted`, `price_not_positive` (the table's
  CHECK allows a zero or negative amount), `invalid_effective_time`,
  `basis_not_admitted`, `date_only_excluded` or
  `effective_at_or_after_bound`; (2) none left → `missing`; (3) more than one
  admitted rule with a candidate that could still be fresh (its latest
  possible civil day on or after the first day of the freshness window) under
  `refuse-on-overlap` → `sources_overlap`, so a stale row of another rule never
  refuses a fresh one and the answer does not depend on how much history the
  read returned (`priority-order` takes the first rule that yields a
  selection); (4) rank by instant, a date-only price by its civil date in the
  policy zone, and a top that cannot be ordered → `time_incomparable`; (5) age
  from the top's civil date to the as-of date, in calendar days or in open
  days of a calendar that covers the span (else `calendar_missing`), older
  than allowed → `stale` with the ids and the age, never the value; (6)
  candidates at the top instant must state the same price per unit of base
  exactly, else `disagree`; agreeing ones are corroboration, and the later
  recorded, then the higher id, is selected. Instants are compared through the
  instant parser, never as text. `selectFxRate` answers a currency outside the
  FX policy's currencies `unsupported_pair` without a read.
- **The bound.** `effectiveBefore` is exclusive, as the dated state's
  `fetched_at < (D + 1) 00:00` Asia/Tokyo is
  ([ADR 0019](0019-dated-reported-state.md)); `asOfDate` is the civil date
  ages count to, and `validSelectionBound` requires `effectiveBefore` to be
  exactly the end of that date in the policy's zone (`selectMarketData`
  checks it in the zone of both the price and the FX selection policy, so the
  two share a zone). A date-only price of the policy zone is eligible when it
  is not after the as-of date; one of another zone or none is only known to
  within two days (zones run from UTC−12 to UTC+14) and refuses the selection
  when it might be the newest. A stored zone is the policy's when the runtime
  spells it the same; an alias the runtime keeps (`Japan`) stays another zone.
- **Knowledge.** `current` reads the parses `published_parse_runs` names now.
  `known-at` K reads prices recorded at or before K, of the parse run adopted
  by the newest `publication_events` row of the claim's artifact and parser at
  or before K. The two modes are two SQL texts. SQLite compares times in
  milliseconds, so K may carry at most three fractional digits
  (`validKnownAtInstant`; a finer K is refused), and the domain re-checks
  every candidate's `recorded_at` against K exactly (`recorded_after_known_at`,
  which also counts a recorded time that does not parse). A publication
  event's time is compared at the millisecond only; every writer stores
  milliseconds. The manifest records the mode and the newest `recorded_at`
  actually used, not K, so a later K that changes nothing keeps the context.
- **The candidate read.** Per wanted key, every row effective inside a coarse
  window (the earliest possibly fresh civil date minus two days, to the bound
  plus two days, compared through `julianday`: a date of another zone, or of
  none, may lie two days from its value, so such a row that could be fresh is
  always read), every row of the newest instant
  before the window, and every row SQL cannot place, each with its claim, rule,
  recorded time and parse run. A key may be narrowed to one parse run
  (`same-snapshot`). More than 500 keys or 2,000 rows is refused, never cut.
  `PRICE_SELECTION_SQL` and `selectPrices` stay byte-identical.
- **FX.** One pivot. Into it is one exact hop (`valueAtPrice`). Out of it, or
  between two other currencies, is one exact ratio rounded once under the
  policy's inverse rounding at the target unit's scale, with the operands and
  the exact value (when finite) kept as `RoundingInputs`; without one the
  conversion is `rounding_policy_missing`. A pair the policy's currencies do
  not cover is `unsupported_pair`. A missing, stale or disagreeing rate is that
  refusal for the FX leg, and a selection holding a zero or negative price is
  `price_not_positive`; nothing is converted 1:1 and nothing becomes zero.
  `valueInBase` reports both legs with price ids, effective times and ages.
  An FX selection of another key, or made under another selection policy than
  the conversion policy's (`fx_selection_policy_mismatch`), is a caller error
  and throws. That check compares policy ids only; two policies that share an
  id with different content are refused where they enter, at
  `selectMarketData` (`invalid_policy`), not in `convertToBase`.
- **Identity.** A price is keyed by the provider-scoped base reference the
  promotion rule wrote (`instrument:<source>:<market>:<code>`, an ISO code for
  FX); another source's price for the same instrument is not used.
- **Manifest.** `market-data-selection-v1`: policies and calendars by id (and
  version) and digest, the bound, the knowledge mode and boundary, the
  selected ids and each refusal with its key and candidate ids, sorted. Its
  `canonicalDigest` is the selection's context id. The context id identifies
  the outcome, not the request: neither K nor a requested snapshot run is in
  it, so two requests that select and refuse the same things under the same
  policies share it.
- **Mapping onto unvalued reasons** (for the change that writes valuation
  cells; nothing writes them yet): `stale` → `stale-price`;
  `instrument_mismatch` → `unresolved-identity`; `quantity_not_exact` →
  `missing-quantity`; every other selection or conversion refusal →
  `missing-price`, with the closed code kept beside it. The seven-reason CHECK
  of `calculation_results` is mapped onto, not widened.
- **Proposed values are not decisions.** `PROPOSED_FX_SELECTION_POLICY_V1`,
  `PROPOSED_FX_CONVERSION_POLICY_V1` and `PROPOSED_EQUITY_SELECTION_POLICY_V1`
  hold the recommendations below as named constants whose ids start with
  `proposal:`; nothing in production code uses them, a test fails if a
  production source, script or task outside the domain module names one or
  its id, and `selectMarketData` refuses any policy whose id starts with
  `proposal:` (`invalid_policy`).

## Consequences

- **No migration.** The candidate read uses existing indexes
  (`price_observations_instrument`, the claims primary key,
  `published_parse_runs_run`, the `parse_runs` primary key and
  `publication_events_target`); policies are fixed by digest in the manifest
  rather than rows in `calculation_policies`; the unvalued-reason CHECK is
  mapped onto. No table, ledger classification or migration pin changes.
- **No library and no external source.** Civil dates come from the runtime's
  own `Intl.DateTimeFormat` (the pattern the collection schedule model already
  uses), in its own module `civil-date.ts`: `time.ts` is in the parser
  digest closure (`packages/parsers/src/parsers/digests.ts`) and is
  unchanged, so no parser's code digest moves. Arithmetic is the domain's
  exact decimals. Nothing is fetched, and no
  provider's terms were assumed.
- **No route and no UI.** `selectMarketData` has no caller in a service yet;
  valuation cells, the API and the page are a later change.
- **Cost grows with each key's whole history.** One read per call, the keyed
  rows materialized once and shared by the three arms of the union. Each key
  is reached by index, but every row of that key's history is read: the
  window bounds what the read returns, not what it reads, and the 2,000-row
  bound applies to the rows returned. Measured on `bun:sqlite` without table
  statistics, 13 currencies on a board published four times a day: the
  independent review found 1,000 boards (13,000 rows) at 84 ms current and
  97 ms known-at against 63 ms for `selectPrices`, and 4,380 boards (three
  years, 56,940 rows) at 422 and 504 ms against 292 ms;
  `price-candidates-scale.test.ts` at full scale measured 89 / 91 / 72 ms and
  359–389 / 391–448 / 295–303 ms. That test holds the plan to index searches
  on such a store. Bounding the read by time (an index on the effective
  instant, or a stored julianday column) would need a migration and is left
  until the history makes it matter.
- **Limits.** Exclusion counts cover the rows the read returns (rows far after
  the bound are not read). The row that explains `stale` is the newest before
  the window whatever its rule, kind, basis or effective-time shape (it may be
  a date-only row, or one the domain cannot read), so a key whose newest old
  row is not admitted reads `missing` rather than `stale`. In `known-at` mode
  a row whose `recorded_at` or event time SQLite cannot read as a time is not
  shown to be known and is not read. A business-day rule refuses until a
  calendar is supplied; none is shipped.
- `selectPrices` keeps its behaviour, including the skipped invalid row, for
  any caller that relies on it; there is none in production.

## Verification

With synthetic data only:

- `packages/domain/test/civil-date.test.ts`: `civilDateOfInstant` equals the dated
  state's capture date in Asia/Tokyo across midnight, applies offsets and DST,
  and is null for an unknown zone, a non-instant and an era-rendered year;
  `canonicalZone`.
- `packages/domain/test/market-data.test.ts`: every exclusion code counted,
  including a recorded time after K (exactly) and a zero or negative price;
  date-only exclusion, civil-date eligibility on D and not D + 1, zoneless and
  other-zone dates two days off (UTC−11 against UTC+14), zone spelling, a
  date and an instant on one day; freshness at and past the limit, a stale
  rate refusing a conversion, a date after the as-of date; disagreement,
  corroboration, per-1 against per-10 bases, one instant in two offsets,
  nanosecond order, overlap among possibly fresh candidates only and
  priority; business days Friday to Monday, a closed date, missing, foreign
  or partial calendars, a century over 20,000 closed dates counted exactly and
  quickly, the read window; FX paths, a missing rate never 1:1, CHF
  unsupported, JPY to JPY, `rounding_policy_missing`, a rate selected under
  another policy refused, 12 × 130.70 USD × 146.25 equal to `valueAtPrice`
  twice, JPY → AUD and USD → AUD rounded once with operands; validators
  (including the bound at the end of its date), proposals, digests, the
  manifest and the guard that no production source, script or task names a
  proposal.
- `packages/read-model/test/price-candidates.test.ts`: on migrated CORE
  SQLite, re-parse supersession in both modes through `publication_events`,
  rollback, ties at K and a recorded time a fraction of a millisecond after
  it, same-snapshot scope, overlap the same inside and outside the margin, the
  before-window row turning missing into stale, unreadable effective times
  counted, bounds refused, plans without statistics for both texts, a
  differential against `selectPrices` on 30 random tie-free stores (unbounded
  and 0–4 day freshness, through the before-window arm), a known-at
  differential on 30 random publication histories against an in-JS oracle
  over the events, and frozen digests of the shipped `PRICE_SELECTION_SQL`,
  `selectPrices` and `priceSelectionArgs`.
- `packages/read-model/test/price-candidates-scale.test.ts`: 200 boards of 13
  currencies in CI (4,380 at full scale): no statistics, index searches only,
  only the window returned, the same prices as `selectPrices`.
- `packages/application/test/market-data-query.test.ts`: selections and a
  two-hop value end to end; the same inputs give the same context id, a new
  price, a policy change or the knowledge mode a new one; a currency outside
  the FX policy is `unsupported_pair`; malformed requests, misaligned bounds,
  ambiguous policy ids and proposals refused.
- `mise run //packages/domain:ci`, `mise run //packages/read-model:ci`,
  `mise run //packages/application:ci` and `mise run ci:root`. No production
  data, D1 or Workers were involved.

## Open policy questions

None of these is decided here. Each recommendation is a **recommendation**,
held only in a `PROPOSED_*` constant where it is a value.

1. **FX freshness for `fx-sbi-shinsei-mid-v1`.** Recommendation: 4 calendar
   days (the plan's figure; covers a weekend and a holiday).
2. **Which price values a dated holding.** Recommendation: same-snapshot
   only, as the report job does.
3. **Equity freshness against D.** Recommendation: 3 calendar days, the dated
   state's `recent`.
4. **Collector basis.** Recommendation: accept the fetch instant for board
   and SBI prices, and show the basis beside the price.
5. **Disagreement and multiple sources.** Recommendation: refuse, with zero
   tolerance; no averaging and no priority until a second source exists.
6. **Knowledge mode per surface.** Recommendation: UI and API read `current`;
   a fixed report reads `known-at` its knowledge cutoff.
7. **Date-only prices.** Recommendation: exclude in v1 (no rule produces one).
8. **A non-JPY base.** Recommendation: ship JPY only; if one is wanted,
   half-even once per cell at the base unit's minor-unit scale. Until then
   `rounding_policy_missing`.
9. **FX kind.** Recommendation: the mid rate (`reference`).
10. **Aligning the price and FX times.** Recommendation: no alignment rule;
    each leg is checked against the as-of on its own and both are reported.
11. **A stale candidate.** Recommendation: show its id and age, never its
    value.
12. **Using another broker's price for the same instrument.** Recommendation:
    refuse until cross-source instrument identity (#546) and an owner decision
    exist.
13. **Market calendars.** Recommendation: ship none; business-day freshness
    waits for a calendar with evidence.
14. **External price and FX sources.** Recommendation: the owner verifies
    terms, cost and permission before any source is added; #552 stays open for
    acquisition.

## Amendment (2026-10-09): valuation on a date as implemented

- Status: proposed (accepted when its pull request merges)
- Issue: #552 (its second slice; acquisition, the route and the page stay open)

### Context

The selection above answers which price and which rate hold for an as-of; it
values nothing. Issue #552 asks for the reported holdings on a date to be
valued in a base unit, reproducibly, with the unvalued part named. The report
job values a holding only at a price claimed from the holding's own snapshot
and has no FX step ([ADR 0020](0020-price-promotion-by-rule.md),
`SNAPSHOT_PRICE_SQL`). The reported state on a date
([ADR 0019](0019-dated-reported-state.md)) lists positions with their
quantity as provider text, their instrument mapping and their snapshot, but
not their parse run or their decimal-v1 quantity, and applies no adoption
across sources.

### Options considered

1. **Extend the report job.** Rejected: it writes fixed report artifacts whose
   context and body must not move (AT36, AT60); a policy-selected price and an
   FX step there would change what an existing context means.
2. **Add the parse run and the decimal quantity to `DATED_POSITIONS_SQL`.**
   Rejected: that text serves the reported-state route and its cost is
   documented; a second, keyed read by position id carries the two facts
   without moving it.
3. **A partial subtotal over the valued holdings.** Rejected: a sum that
   leaves holdings out is silently partial (INV05), and `summarizeValuation`'s
   subtotal is not used here.
4. **Write valuation cells to `calculation_results`.** Rejected for now:
   nothing stores a run of this query, and its outcome codes would be mapped
   onto the seven-reason CHECK by a writer that does not exist yet.
5. **A pure domain function over the reported state and `selectMarketData`'s
   selections, composed by an application query with no route.** Chosen.

### Decision

- **Domain.** `valueHoldingsOnDate` (`packages/domain/src/valuation-on-date.ts`)
  takes the holdings, the policy (`price`, `fx`, `calendars`), the base unit,
  the bound and the selections, and decides each holding in the valuation
  order (with the exception below: claim adoption is not applied), ending in
  exactly one of `instrument_unresolved` (the reported state has no
  instrument mapping with status `identified` or `provider-local`),
  `snapshot_stale` (the reported state classifies the holding's snapshot
  `stale` under its own `dated-state-freshness-v1`, more than 3 days before D;
  the holding's quantity on D is not known, so no price is selected for it and
  its snapshot ref and age are kept; no new threshold is introduced),
  `quantity_unknown` (the decimal-v1 quantity is not exact; its status and
  reason are kept), `policy_mismatch` (`price_selection_policy`,
  `price_selection_scope`, `fx_selection_policy`, `fx_selection_key`: a
  selection handed in under another policy, from another snapshot, or of
  another key), `unpriced` (the price selection's refusal code with its
  candidate ids and age, `unsupported_pair` for a position whose currency is
  not a currency code, `price_not_positive`, or `rounding_policy_missing` for
  a price basis that does not divide the quantity exactly), `unconverted`
  (the FX leg's refusal code, with the exact value in the price's unit and
  the price leg kept) or `valued` (exactly, in the price's unit and in the base
  unit, with every leg's price id, effective time and age). A price key is the
  provider-scoped instrument reference, the position's currency and the
  policy's one price kind (a price policy must name exactly one); a
  `same-snapshot` policy narrows it to the position's own parse run.
- **Totals.** A total is stated only when every holding is valued and all
  holdings come from one source; otherwise it is `absent` with
  `holding_not_valued`, `adoption_not_applied` (see below) or `no_holdings`,
  beside the counts per outcome. When every listed holding is valued but a
  container of the perimeter that holds positions
  (`DATED_POSITION_CONTAINER_PARSERS`: the SBI Securities domestic and
  foreign positions and SBI VC Trade's position summary, checked against the
  parsers that emit position observations) has no snapshot on D, the total is
  `partial-verified-scope` with the number of such containers, never
  `exact`: a partial result is never labelled a whole total (calculation and
  reports §2), and it is not a lower bound either. The same holds, counted
  beside it as `stalePositionContainersWithoutHoldings`, for a position
  container whose chosen snapshot the reported state lists as `stale` and
  from which no holding came: its old "nothing" is not read as nothing on D
  (INV05; a partial scope rather than an absent total, so the two cases read
  alike). Values are added with
  `sumQuantities`. There is no subtotal over some valued holdings, no gain, no
  cost basis and no tax; a provider's own valuation of a holding is never its
  value.
- **Claim adoption is not applied.** The valuation order starts with claim
  adoption, so that an overlap is reported as an overlap and not as an
  unpriced holding, and [ADR 0019](0019-dated-reported-state.md) leaves
  `selectAdoptedSet` to this phase. This query does not apply it: no relation
  claims exist for positions, and which route adopts a holding two sources
  report is not decided. What follows: a holding two sources report is
  valued once per listing, each on its own row; only the total is withheld,
  with `adoption_not_applied`, whenever the holdings come from more than one
  source. Today only `sbi-securities` and `sbi-vc-trade` produce positions,
  and they cannot list one holding, but the rule does not know that, so a
  total without a source filter is withheld whenever both report positions.
- **The gate.** A null policy answers `needs-policy` with `policy_missing`,
  the shape `costBasis()` has; a policy whose id starts with `proposal:`
  answers `policy_proposal`. No function has a default policy.
- **Manifest.** `valuation-on-date-v1`: the engine version
  (`valuation-on-date-engine-v1`), the as-of (date, `effectiveBefore`,
  knowledge mode), the base unit, the three policies by id and digest, the
  reported state's date, cutoff, filters, quantity policy (`decimal-v1`),
  context id and position containers without a snapshot, every snapshot with its parse run, every holding by ref with its outcome,
  reason, price id and FX price ids, and the selection manifest with its
  digest, recomputed from the selections handed in. It holds ids and codes,
  never an amount. Its `canonicalDigest` is the context id: equal inputs give
  one id in any order, and a corrected price, a changed policy, a changed
  outcome or a different reported-state answer on D (its context id moves
  with any statement or settlement it lists, too) gives another.
- **Application.** `queryValuationOnDate`
  (`packages/application/src/query/valuation-on-date.ts`) refuses
  `policy_missing` before any read, then `invalid_policy` (invalid parts, two
  price kinds, a proposal, an ambiguous id, or a zone in which the Tokyo date
  does not end at `reportedStateCutoff(D)`), `invalid_request`,
  `date_in_future` (after the caller's stated today; the query has no clock),
  `unknown_source` (`SOURCE_EXISTS_SQL`) and `unknown_account`
  (`ACCOUNT_EXISTS_SQL`), each by primary key. It then reads
  the reported state on D under the requested source and account
  (`queryDatedState`), each position's parse run and decimal-v1 quantity
  (`DATED_POSITION_QUANTITIES_SQL`, by primary keys), and selects one price per
  distinct want and one rate per currency on a wanted price's path to the base
  unit with `selectMarketData` at the end of D. More than 500 holdings
  (`holding_limit_exceeded`), more than 500 price keys and currencies
  (`selection_limit_exceeded`), more than 2,000 candidate rows
  (`candidate_limit_exceeded`) or more than 5,000 reported-state rows
  (`dated_state_limit_exceeded`) is refused, never cut. The answer carries the
  reported state's context id and its containers without a snapshot and stale
  snapshots beside the valuation.
- **Relation to ADR 0020 and the report job.** The report job, its
  `SNAPSHOT_PRICE_SQL` and its fixed reports are unchanged: they value a
  holding only at a price claimed from its own snapshot, with no freshness
  rule and no FX. This query values at a policy-selected as-of price (a
  `same-snapshot` policy reproduces the report job's narrowing, a
  `latest-in-window` one does not) and names the policies in its manifest.
  Neither replaces the other today, and nothing here decides which one a
  surface uses.
- **No open question is decided.** The fourteen questions above stay the
  owner's; the tests construct explicit synthetic policies, and no production
  source names a proposal.

### Consequences

- No migration, no route, no service wiring and no page: nothing outside the
  tests calls `queryValuationOnDate`. The route, the page and external price
  and FX acquisition stay open in #552.
- **Limits.** The knowledge mode bounds prices and rates only: positions,
  identities and account mappings are read as they are now (the reported
  state's own limits), so a `known-at` answer is not the holdings as known at
  K. The total covers the holdings the reported state lists: a position
  container without a snapshot makes it `partial-verified-scope`, and cash
  balances are not valued. A holding of a `recent` snapshot (1–3 days old)
  is valued at prices for D; only `stale` snapshots are refused. A holding is valued at
  its position's currency only; another source's price for the same
  instrument is not used. Values rounded out of the pivot are rounded per
  holding before the total adds them. The query as a whole was not measured
  at scale: its parts are the reported-state reads (about 400 ms on the
  statement-scale store, [reported state: cost](../reported-state.md#cost)),
  the keyed quantity read and the candidate read (above).

### Open items for the owner

- **The adoption rule for holdings.** Whether, and by which relation claims
  and authority, a holding reported by two sources is adopted once before
  valuation (`selectAdoptedSet`), and so whether a cross-source total may be
  stated, is the owner's decision; until then the total is withheld
  (`adoption_not_applied`). Not decided here.
- The fourteen selection questions above, and which surface uses this query
  or the report job.

### Verification

With synthetic data only:

- `packages/domain/test/valuation-on-date.test.ts`: every outcome code,
  `snapshot_stale` (40 days, no price wanted) beside a `recent` snapshot
  valued, `partial-verified-scope` with one lacking container and with one
  stale snapshot that listed no holding, a different
  reported-state context giving a new context, a
  provider-local mapping valued, a stale price `unpriced` with its id and age
  and the same price valued at the limit, zero and negative prices excluded
  from selection and refused when handed in selected, an inexact basis
  `unpriced`, a missing, stale or unquotable rate `unconverted` with the price
  leg kept, each policy mismatch, the total absent for one unpriced holding,
  for two sources and for none, USD into AUD rounded once with three legs,
  `rounding_policy_missing` without an inverse, the gate (`policy_missing`,
  `policy_proposal`), caller errors, a context id equal across permuted equal
  inputs with no amount in the manifest, and a new one for a corrected price
  or a changed policy.
- `packages/read-model/test/dated-state.test.ts`: `DATED_POSITION_QUANTITIES_SQL`
  returns each position's parse run and decimal-v1 quantity (an unreadable one
  `unparsed`) and, without table statistics, searches positions and decimals
  by primary key only; `DATED_POSITION_CONTAINER_PARSERS` equals the parsers
  that emit a position observation, found through the parser registry, each
  parser's defining module and its local import closure.
- `packages/application/test/valuation-on-date-query.test.ts`: on migrated
  CORE with synthetic snapshots, identities, snapshot prices and an
  exchange-rate board: two holdings valued (one in two exact hops) with an
  exact total; the same context on the same store, a new one after a
  corrected rate, and the first rate under `known-at` before the correction
  was recorded; a 40-day-old snapshot's holding `snapshot_stale` under a
  `latest-in-window` policy with a fresh price available, and the total
  absent; a recent snapshot's own price older than the policy allows
  `unpriced` `stale`; the same holdings `partial-verified-scope` when the
  VC position container has no snapshot, and when its only snapshot is a
  complete-empty capture 40 days old; unresolved instruments and unreadable quantities select no
  price; no holdings, no total; the source and account filters,
  `unknown_source` and `unknown_account`; a card statement changing the
  reported state's context and so the valuation's;
  `policy_missing` with no read; invalid policies and requests;
  `date_in_future`; 501 holdings and 501 selections refused, 500 answered;
  the account and source checks' plans without statistics.
- `mise run //packages/domain:ci`, `//packages/read-model:ci`,
  `//packages/application:ci`, `//packages/parsers:test` and `mise run ci:root`.
