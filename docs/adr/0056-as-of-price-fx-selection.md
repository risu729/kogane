# ADR 0056: Price and FX selection at an as-of under an explicit, versioned policy

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issue: #552 (this record covers its selection part; acquisition stays open)
- Carried by: `packages/domain/src/market-data.ts`,
  `packages/domain/src/time.ts` (`civilDateOfInstant`),
  `packages/read-model/src/price-selection.ts` (`PRICE_CANDIDATES_SQL`,
  `PRICE_CANDIDATES_KNOWN_AT_SQL`, `selectPriceCandidates`),
  `packages/application/src/query/market-data.ts` (`selectMarketData`),
  [calculation and reports §1–§2](../calculation-and-reports.md#1-a-price-is-an-observation-with-a-basis),
  [domain contracts](../domain-contracts.md#market-datats--as-of-price-and-fx-selection)
- Amends: [ADR 0020](0020-price-promotion-by-rule.md) (its Selection
  decision; a dated note there points here)
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
  negative or non-integer day count and a zone the runtime does not know. No
  function takes a default policy.
- **Six checks in order** (`selectPrice`): (1) filter, counting every
  removed candidate by `rule_not_admitted`, `kind_not_admitted`,
  `invalid_effective_time`, `basis_not_admitted`, `date_only_excluded` or
  `effective_at_or_after_bound`; (2) none left → `missing`; (3) more than one
  admitted rule with a candidate that could still be fresh (its latest
  possible civil day on or after the first day of the freshness window) under
  `refuse-on-overlap` → `sources_overlap`, so a stale row of another rule never
  refuses a fresh one and the answer does not depend on how much history the
  read returned (`priority-order` takes the first rule that yields a
  selection); (4) rank by
  instant, a date-only price by its civil date in the policy zone, and a top
  that cannot be ordered → `time_incomparable`; (5) age from the top's civil
  date to the as-of date, in calendar days or in open days of a calendar that
  covers the span (else `calendar_missing`), older than allowed → `stale`
  with the ids and the age, never the value; (6) candidates at the top
  instant must state the same price per unit of base exactly, else
  `disagree`; agreeing ones are corroboration, and the later recorded, then
  the higher id, is selected. Instants are compared through the instant
  parser, never as text.
- **The bound.** `effectiveBefore` is exclusive, as the dated state's
  `fetched_at < (D + 1) 00:00` Asia/Tokyo is ([ADR 0019](0019-dated-reported-state.md));
  `asOfDate` is the civil date ages count to. A date-only price of the policy
  zone is eligible when it is not after the as-of date; one of another zone or
  none is only known to within a day and refuses the selection when it might
  be the newest.
- **Knowledge.** `current` reads the parses `published_parse_runs` names now.
  `known-at` K reads prices recorded at or before K, of the parse run adopted
  by the newest `publication_events` row of the claim's artifact and parser at
  or before K. The two modes are two SQL texts. SQLite compares times in milliseconds, so K may carry at most three fractional digits (`validKnownAtInstant`; a finer K is refused), and the domain re-checks every candidate's `recorded_at` against K exactly (`recorded_after_known_at`, which also counts a recorded time that does not parse). A publication event's time is compared at the millisecond only; every writer stores milliseconds. The manifest records the mode
  and the newest `recorded_at` actually used, not K, so a later K that changes
  nothing keeps the context.
- **The candidate read.** Per wanted key, every row effective inside a coarse
  window (the earliest possibly fresh civil date minus one day, to the bound
  plus one day, compared through `julianday`), every row of the newest instant
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
  refusal for the FX leg; nothing is converted 1:1 and nothing becomes zero.
  `valueInBase` reports both legs with price ids, effective times and ages.
- **Identity.** A price is keyed by the provider-scoped base reference the
  promotion rule wrote (`instrument:<source>:<market>:<code>`, an ISO code for
  FX); another source's price for the same instrument is not used.
- **Manifest.** `market-data-selection-v1`: policies and calendars by id (and
  version) and digest, the bound, the knowledge mode and boundary, the
  selected ids and each refusal with its key and candidate ids, sorted. Its
  `canonicalDigest` is the selection's context id.
- **Mapping onto unvalued reasons** (for the change that writes valuation
  cells; nothing writes them yet): `stale` → `stale-price`;
  `instrument_mismatch` → `unresolved-identity`; `quantity_not_exact` →
  `missing-quantity`; every other selection or conversion refusal →
  `missing-price`, with the closed code kept beside it. The seven-reason CHECK
  of `calculation_results` is mapped onto, not widened.
- **Proposed values are not decisions.** `PROPOSED_FX_SELECTION_POLICY_V1`,
  `PROPOSED_FX_CONVERSION_POLICY_V1` and `PROPOSED_EQUITY_SELECTION_POLICY_V1`
  hold the recommendations below as named constants; nothing in production
  code uses them, and a test fails if production source outside the domain
  module names one.

## Consequences

- **No migration.** The candidate read uses existing indexes
  (`price_observations_instrument`, the claims primary key,
  `published_parse_runs_run`, the `parse_runs` primary key and
  `publication_events_target`); policies are fixed by digest in the manifest
  rather than rows in `calculation_policies`; the unvalued-reason CHECK is
  mapped onto. No table, ledger classification or migration pin changes.
- **No library and no external source.** Civil dates come from the runtime's
  own `Intl.DateTimeFormat` (the pattern the collection schedule model already
  uses); arithmetic is the domain's exact decimals. Nothing is fetched, and no
  provider's terms were assumed.
- **No route and no UI.** `selectMarketData` has no caller in a service yet;
  valuation cells, the API and the page are a later change.
- **Cost.** One read per call, the keyed rows materialized once and shared by
  the three arms of the union; per key it reads only that key's rows by
  index. Plans were checked without table statistics.
- **Limits.** Exclusion counts cover the rows the read returns (rows far after
  the bound are not read). The row that explains `stale` is the newest before
  the window whatever its rule, kind or basis, so a key whose newest old row
  is not admitted reads `missing` rather than `stale`. In `known-at` mode a
  row whose `recorded_at` or event time does not parse is not shown to be
  known and is not read. A business-day rule refuses until a calendar is
  supplied; none is shipped.
- `selectPrices` keeps its behaviour, including the skipped invalid row, for
  any caller that relies on it; there is none in production.

## Verification

With synthetic data only:

- `packages/domain/test/time.test.ts`: `civilDateOfInstant` equals the dated
  state's capture date in Asia/Tokyo across midnight, applies offsets and DST,
  and is null for an unknown zone, a non-instant and an era-rendered year.
- `packages/domain/test/market-data.test.ts`: every exclusion code counted;
  date-only exclusion, civil-date eligibility on D and not D + 1, zoneless and
  other-zone dates, a date and an instant on one day; freshness at and past
  the limit, a stale rate refusing a conversion, a date after the as-of date;
  disagreement, corroboration, per-1 against per-10 bases, one instant in two
  offsets, nanosecond order, overlap and priority; business days Friday to
  Monday, a closed date, missing, foreign or partial calendars, the read
  window; FX paths, a missing rate never 1:1, CHF unsupported, JPY to JPY,
  `rounding_policy_missing`, 12 × 130.70 USD × 146.25 equal to `valueAtPrice`
  twice, JPY → AUD and USD → AUD rounded once with operands; validators,
  proposals, digests, the manifest and the guard that production code names
  no proposal.
- `packages/read-model/test/price-candidates.test.ts`: on migrated CORE
  SQLite, re-parse supersession in both modes through `publication_events`,
  rollback, ties at K, same-snapshot scope, the before-window row turning
  missing into stale, unreadable effective times counted, bounds refused,
  plans without statistics for both texts, a differential against
  `selectPrices` on 30 random tie-free stores, and frozen digests of the
  shipped `PRICE_SELECTION_SQL`, `selectPrices` and `priceSelectionArgs`.
- `packages/application/test/market-data-query.test.ts`: selections and a
  two-hop value end to end; the same inputs give the same context id, a new
  price, a policy change or the knowledge mode a new one; inapplicable
  requests and policies refused.
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
