# Prices, calculation policies and fixed report artifacts

Architecture-addendum plan item A12, for findings AR03 (no boundary between a
disposable calculation and a report that must be preserved), AR12 (a policy
version does not fix the input set), AR17 (immutable evidence read as
unconditional permanent storage) and AR18 (protecting the record of truth
treated as forbidding a fast derived read model).

Nothing here concludes anything about tax, and nothing fetches a price from
outside. The verification section records synthetic component tests. The committed
Processor enables `REPORTS_ENABLED`, but that does not establish a complete
portfolio/P&L/tax product or fresh real-data coverage. See
[current status](current-status.md).

## Product implementation boundary

This document specifies calculation and retention components, not a complete
portfolio, cost-basis or tax product. In
[`packages/domain/src/calculation.ts`](../packages/domain/src/calculation.ts),
`costBasis()` returns `needs-policy` on every path, including when a caller
supplies a verified-policy marker. It does not allocate lots or calculate cost.
Likewise, `pnlDecomposition()` does not reconstruct a transaction history or
supply missing acquisition costs.

The [roadmap](roadmap.md) separates the remaining work: price/FX acquisition and
as-of valuation can start from reported holdings; lots and disposal allocation
then enable realized/unrealized P&L; verified jurisdiction/period rules enable
tax outputs. Investment analysis and tax calculations share evidence and events
but must retain distinct purposes and policies. Completion requires actual
inputs and explainable, reproducible results through the supported UI or MCP
flow.

## 1. A price is an observation with a basis

`price = 8,000` does not say whether it prices one share, one unit, 10,000 fund
units or one contract. `price_observations` therefore stores the amount **and**
the base quantity it is quoted for, plus the claim that asserted it:

| Column                                              | Meaning                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `base_instrument_ref`                               | What is priced. A price for another instrument is not a rate for this one. |
| `base_quantity_coefficient` / `base_quantity_scale` | 1 share, 1 unit, 10,000 fund units. Must be positive and non-zero.         |
| `quote_unit_ref`, `quote_amount_*`                  | What it is priced in, and how much.                                        |
| `price_kind`                                        | `execution` / `bid` / `ask` / `reference` / `nav` / `provider-value`.      |
| `effective_time`                                    | A serialized `TemporalValue`; a provider date stays a date.                |
| `source_claim_ref`                                  | Which claim said so. Prices are never fetched at read time.                |
| `market_ref`, `adjustment_policy_ref`               | Optional; keep two markets and two adjustment policies apart.              |

The table is append-only: a corrected price is a new row, which is what makes a
price correction produce a new context instead of changing an old answer
(UC36/AT36).

`valueHolding(quantity, price)` in `packages/domain/src/calculation.ts` applies
the basis: 12,500 fund units at 8,000 JPY per 10,000 units is **10,000 JPY**,
never 12,500 × 8,000 (SYN22). Derivative notional, margin requirements and
contract nominals are different metrics; the default instrument policy marks
them `unsupported`, so they show a quantity and whatever the provider reported
rather than an invented value.

### Price sources: provider claims promoted by rule

Nothing fetches a price. Every row in `price_observations` is a provider claim
that the Processor's `price_promotion` lane promoted by one rule of the closed
list in `packages/domain/src/price-sources.ts`
([ADR 0020](adr/0020-price-promotion-by-rule.md)), and
`price_observation_claims` (migration 0053) records which rule read which
observation, of which parse run, at which JSON path:

| Rule                              | Claim                                                                        | Price                                                                                              | Basis check                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fx-sbi-shinsei-board-v1`         | an `sbi-shinsei-exchange-rate` valuation (`bank_mid/buy/sell_rate`)          | base the currency, quote JPY, per 1 unit; mid → `reference`, buy → `bid`, sell → `ask`             | the currency is one of the 13 the provider's public pages quote per 1 unit (`SBI_SHINSEI_FX_PER_UNIT_CURRENCIES`; never CHF or JPY) and the row's `customerCategory` is strictly equal to the one stage category the same collection run's balance summary states ([ADR 0031](adr/0031-sbi-shinsei-stage-category-fx-tier.md)); or the manual table `SBI_SHINSEI_FX_QUOTE_BASIS` admits the currency in that tier (empty) |
| `sbi-domestic-current-price-v1`   | an `sbi-domestic-cash-positions` `current_price` valuation                   | base `instrument:sbi-securities:<market>:<code>`, quote JPY, per 1 share, `reference`              | exactly one position and one `market_value` in the same MTS record (the `POSITION_VALUATIONS_SQL` locator rule), and quantity × price = market value exactly                                                                                                                                                                                                                                                              |
| `sbi-foreign-stock-price-last-v1` | an `sbi-foreign-cash-positions` position, `$.stockPrice.last` in its element | base `instrument:sbi-securities:<market>:<code>`, quote the position's `currencyCode`, per 1 share | quantity × `stockPrice.last` = `evaluationProfitLoss.frnEvaluationAmount` of the same element exactly                                                                                                                                                                                                                                                                                                                     |

The base instrument reference is the report job's
(`instrument:<source>:<market>:<code>`). A claim whose check fails is counted
as `basis_unverified`; a currency a rule does not admit, as
`unsupported_currency`; a board row of a per-1-unit currency of another code
than the stage its run states, as `tier_unmatched`, and one whose run states
no stage or more than one, as `stage_unstated`. None writes anything and none
is retried under
the same rules. A board row whose run still has its balance summary to parse
(a job of the deployed stage parser that can still run, and no published
parse of that page) is not judged yet: the tick stops before it, counts the
rest of its page as `stage_pending`, and the cursor waits there until that
job publishes, fails or runs out of attempts; a price is never rescaled, rounded or defaulted. Execution
prices are never valuation prices, so no rule reads one. The effective time is
the provider's own instant when the claim states one (the board's
`transactionTime`, basis `provider`), otherwise the artifact's fetch instant
with basis `collector`. The price id is `price_<sha256(rule, claimRef)>`, where
the claim reference (`source_claim_ref`) is
`<kind>_observations/<id>#<json path>`, so a re-parse, which writes new
observations, yields new price rows, and replaying the lane over the same
claims writes nothing.

Survey (2026-09-26, read-only aggregates over the currently published parses,
no values): of 936 domestic positions, 666 carry a `current_price` and 635 of
those reconcile with their `market_value`; of 290 foreign positions, all carry
`stockPrice.last` and 276 reconcile with `frnEvaluationAmount`. The counts were
taken with floating-point arithmetic in SQL to size the lane; the lane itself
decides each row with exact decimals.

**Selection** (`packages/read-model/src/price-selection.ts`, `selectPrices`):
for each (base, quote, kind) asked for, the latest price whose effective
instant is at or before the cutoff and whose claim's parse run is currently
named by `published_parse_runs`. Instants are compared as instants, not as
text; ties go to the later `recorded_at`, then the higher id. A re-parse moves
selection to its own prices once it is published, and the old rows stay for
the contexts that used them. A price with a date-only effective time is never
selected against an instant cutoff, and an instrument without a selectable
price is absent from the result, never zero. `selectPrices` has no production
caller; its text is frozen by a digest test.

**As-of selection under a policy**
([ADR 0056](adr/0056-as-of-price-fx-selection.md)). `selectMarketData`
(`packages/application/src/query/market-data.ts`) takes a bound, the price and
FX policies and any calendars, with no defaults, and refuses a proposed
policy (`proposal:` id), two policies sharing an id with different content, a
malformed key or more than 500 keys. The bound is `effectiveBefore`, an
exclusive instant that must be exactly the end of the as-of date in the
policies' zone (for a date D in Asia/Tokyo, `(D + 1) 00:00 +09:00`, as the
dated state's capture bound), the as-of date that ages are counted to, and a
knowledge mode: `current` reads the parses `published_parse_runs` names now;
`known-at` K reads prices recorded at or before K, of the parse run the newest
`publication_events` row of the claim's artifact and parser at or before K
adopted, so a later re-parse or a rollback is seen as it stood at K. K may
carry at most three fractional digits, the precision SQLite compares at, and
the domain re-checks each price's `recorded_at` against K exactly. One read
(`selectPriceCandidates`, two SQL texts `PRICE_CANDIDATES_SQL` and
`PRICE_CANDIDATES_KNOWN_AT_SQL`) returns per key every row in a coarse window
around the freshness span, the rows of the newest instant before it and every
row SQL cannot place, and refuses more than 500 keys or 2,000 rows rather than
cutting. A key may be narrowed to one parse run (`same-snapshot`). The
domain's `selectPrice` (`packages/domain/src/market-data.ts`) then filters,
counting each removed row by a closed code (`recorded_after_known_at`,
`rule_not_admitted`, `kind_not_admitted`, `price_not_positive`,
`invalid_effective_time`, `basis_not_admitted`, `date_only_excluded`,
`effective_at_or_after_bound`), and selects one price or refuses with
`missing`, `sources_overlap` (two admitted rules with prices that could still
be fresh), `time_incomparable`, `calendar_missing`, `stale` (ids and age
reported, the price never used) or `disagree` (two prices at the top instant
that differ per unit of base). Agreeing prices at one instant corroborate the
later recorded one. A currency the FX policy cannot quote is
`unsupported_pair` without a read. The result carries a manifest (policies and
calendars by digest, the bound, the knowledge mode, the newest `recorded_at`
used, the selected ids and each refusal) whose digest is the context id; it
identifies the outcome, not the request.

**What the report job reads.** The report job (§4) values a holding only with
a price claimed from the holding's own snapshot: a price whose claim names an
observation of the same parse run as the position, under a rule of the closed
list, whose parse run is currently published, quoted in the report's base unit
and effective and recorded at or before the knowledge cutoff
(`SNAPSHOT_PRICE_SQL` in `services/processor/src/report-job.ts`). A holding
whose own row was refused by the basis check (the survey counted 31 domestic and
14 foreign such rows) is therefore `missing-price`; it is never
valued at an approximate price or at the price of an older snapshot, and a
price row with no claim values nothing. Foreign holdings are quoted in their
own currency, so a JPY report still leaves them `missing-price`: nothing is
converted 1:1.

**Limits.** No selection policy is adopted: the freshness windows, accepted
bases, overlap rule and FX pivot in `PROPOSED_*` constants are
recommendations, and ADR 0056 lists the fourteen questions the owner has not
decided. Nothing in a service calls `selectMarketData`, so no valuation on a
date, valuation cell, route or page uses it yet. No market calendar is
shipped, so a business-day rule refuses with `calendar_missing`. A price is
keyed by the provider-scoped base reference, so another source's price for the
same instrument is never used. Exclusion counts cover only the rows the read
returns. The row that explains `stale` is the newest before the window
whatever its rule, kind, basis or effective-time shape (a date-only row, or
one the domain cannot read), so such a key reads `missing` rather than
`stale`. In `known-at` mode a row whose `recorded_at` SQLite cannot read as a
time is not read. Nothing fetches a price or rate from an external source.
The candidate read reaches each key by index but reads that key's whole
history (the window bounds what it returns, not what it reads): 13 currencies
four times a day took about 90 ms over 1,000 boards and 360–500 ms over 4,380
boards (three years), against 70–300 ms for `selectPrices` (ADR 0056;
`price-candidates-scale.test.ts`).
SBI Shinsei's board is a customer rate tiered by `customerCategory` (5 tiers for most
currencies on the stored boards, [ADR 0028](adr/0028-sbi-shinsei-observed-capture-shapes.md)),
not a market reference. The rule reads the tier the same run's balance
summary names as the owner's stage (ADR 0031); the two were observed on
2026-09-27 to use one scheme, and the matching row is the one the logged-in
FX page shows. `price_observations` and `price_observation_claims` are outside the
source-revision ledger: valuation reads CORE per request, and a READ
projection over prices would need bump triggers first.

## 2. The valuation order and typed unvalued reasons

Addendum 09 section 3 fixes the order, and the order matters: a scope overlap
is decided before a price is looked for, so an overlapping holding is reported
as an overlap, not as "unpriced".

```text
permitted perimeter
  -> claim adoption
  -> identity / ownership / scope
  -> quantity by unit
  -> instrument valuation method
  -> FX conversion into the base unit
  -> rounding and aggregation
  -> coverage, uncertainty and explanation
```

A cell is either exact or explicitly unvalued with one of
`missing-quantity`, `unresolved-identity`, `overlap`, `stale-price`,
`missing-price`, `unsupported-instrument`, `incomplete-liabilities`. There is no
third shape: `calculation_results` has a CHECK that an `exact` row has a
coefficient and no reason, and an `unvalued` row has a reason and no
coefficient. A missing FX price never becomes a 1:1 conversion and never
becomes zero (AT24, INV05).

**FX path** (`fxPath`, `convertToBase`, `valueInBase` in
`packages/domain/src/market-data.ts`). Every rate is selected against one
pivot, the quote of the FX rule (JPY). The same unit needs no rate. A currency
into the pivot is one exact hop through `valueAtPrice`, so 12 shares at
130.70 USD at a 146.25 mid is exactly 229,378.5 JPY, both legs reported with
price ids, effective times and ages. Out of the pivot, or between two other
currencies, is one exact ratio rounded once under the conversion policy's
inverse rounding at the target unit's scale, with the operands and the exact
value kept as `RoundingInputs`; a policy without one refuses with
`rounding_policy_missing`, before any rate is read. A pair outside the
policy's currencies (CHF, an instrument code) is `unsupported_pair`, and a
missing, stale or disagreeing rate is that refusal for the FX leg. A holding
of another instrument than the price's is `instrument_mismatch`, a quantity
that is not exact is `quantity_not_exact`, and a selection holding a zero or
negative price (the table's CHECK allows one; selection never picks it)
converts nothing (`price_not_positive`). An FX selection of another key, or
made under another selection policy than the conversion policy's, throws
(`fx_selection_policy_mismatch`).

**Refusal mapping.** ADR 0056 maps these codes onto the seven reasons above
for the change that writes valuation cells: `stale` → `stale-price`,
`instrument_mismatch` → `unresolved-identity`, `quantity_not_exact` →
`missing-quantity`, every other selection or conversion refusal →
`missing-price` with the closed code beside it. No code writes that mapping
yet, and the `calculation_results` CHECK is not widened.

Results are partitioned into `complete`, `partial-verified-scope` and
`not-computable`. A partial result is never labelled as a whole-portfolio
total, and it is not a lower bound either. `netWorth` returns a net worth only
when liability coverage is `complete`; otherwise it returns a
`known-assets-subtotal` with the reason `incomplete-liabilities`.

## 3. Rounding and P&L attribution are versioned inputs

`calculation_policies` stores `rounding`, `pnl-decomposition`, `cost-basis` and
`fx` policies with a version, a definition, a `verified` / `unverified` flag and
evidence references. It is append-only: a revision is a new policy id.

A rounding policy names **where** it rounds (`leg` / `execution` / `statement` /
`aggregate`), the mode, the precision and what happens to the residual
(`carry` / `largest-remainder` / `leave` / `refuse`). Three amounts of 0.5
rounded half-even per leg total 0; rounded once at the aggregate they total 2.
Both are legitimate; which one you get is the policy, so the pre-rounding
operands and the policy are kept in `calculation_results.rounding_inputs_json`
and another policy can recompute from them.

P&L decomposition is not an observation. With `ΔV = q(P₁R₁ − P₀R₀)`:

| Policy   | market       | fx           | q=10, P 100→110, R 100→105 |
| -------- | ------------ | ------------ | -------------------------- |
| policy-a | `q(P₁−P₀)R₀` | `qP₁(R₁−R₀)` | market 10,000 / fx 5,500   |
| policy-b | `q(P₁−P₀)R₁` | `qP₀(R₁−R₀)` | market 10,500 / fx 5,000   |

Both total 15,500 (SYN23). `pnlDecomposition` returns `factual: false` on every
result: only the total is derived from observations; the split of the cross term
is a choice.

`costBasis()` is a contract and a gate, not a calculation. This repository holds
no verified JP or AU rule package, so every request returns `needs-policy` with
`taxConclusion: null` and the list of inputs it does not have (AT59). The
provider's reported cost is stored beside our own numbers as
`provider.<metric>` rows and is never promoted to the single truth (UC30/AT30).

## 4. Reports are not projections

| Kind                   | May be discarded and rebuilt?     | Where it lives                                |
| ---------------------- | --------------------------------- | --------------------------------------------- |
| Rebuildable projection | Yes                               | Read models, caches (retention class `cache`) |
| Calculation run        | Re-runnable if the inputs survive | `calculation_runs`, `calculation_results`     |
| Report artifact        | **No**                            | `report_artifacts` + R2 body (class `report`) |

`report_artifacts` is append-only and its `storage_ref` is
`reports/<content_digest>`: the stored bytes are the canonical form the digest
was taken over, so a reader can verify `sha256(bytes) == content_digest` without
re-serializing. Generated, confirmed, shared, submitted, corrected and
superseded are separate rows in `report_events`; a correction names the report
it corrects. A later rule, price or classification change produces a new report,
never an edit of an old one (AT60).

Three operations are deliberately distinct:

| Operation                       | What it does                        | Where                                         |
| ------------------------------- | ----------------------------------- | --------------------------------------------- |
| `re-display`                    | Return this exact stored body       | `GET /api/v2/reports/{id}` (this change)      |
| `recompute-under-current-rules` | New run, new context, new report    | Authenticated command (A09); not a route here |
| `share-corrected-version`       | New report plus a `corrected` event | Authenticated command (A09); not a route here |

An agent therefore cannot rewrite a submission through one ambiguous
"regenerate".

## 5. The context is the input set, not a timestamp

`services/processor/src/report-job.ts` builds a
`ReportInputManifest` — the perimeter, the base unit, the effective knowledge
boundary, the decimal and instrument-valuation policy ids, and the sorted ids of
every position observation, valuation observation and price observation it used.
The context id is the digest of that manifest, so:

- re-running with unchanged inputs reuses the stored report, including at a
  later clock: the manifest records the newest moment any _included_ evidence
  was recorded, not the instant the sweep asked for, so a five-minute cron does
  not mint a new context every time the clock moves;
- one corrected price changes the manifest, so the run gets a new context id and
  a new report, and the old one is untouched;
- evidence recorded after the requested knowledge cutoff is excluded, decided by
  `recorded_at_ms` (when Kogane learned it) rather than `fetched_at_ms`, so a
  late import of an old file is not back-dated into an old context (UC63/AT63).
  Excluding a row changes the id set, so it changes the context too.

## 6. Replayability and evidence-use restrictions

`replayabilityFor` derives, it does not assert:

| State                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `replayable`         | Inputs, implementation and rules are present; it can be recomputed. |
| `artifact-preserved` | The body survives; a full re-run from the inputs does not.          |
| `restricted`         | Evidence use or authorization forbids re-running or explaining.     |
| `unavailable`        | Required inputs are gone.                                           |

A restriction always wins. `evidence_use_restrictions` records `no-reuse`,
`deleted` and `key-destroyed` with the manifests they affect, the actor and the
reason, append-only. When one names a report's context:

- the reader refuses `/explanation` and `/export` with `evidence_restricted`,
  while `re-display` still returns the preserved body and reports
  `replayability: "restricted"`;
- `purgeRestrictedExplanations()` in the pipeline deletes the cached explanation
  node (retention class `cache`) and downgrades the calculation run's
  replayability. The report body itself is never deleted here: a fixed
  deliverable stays fixed, and deleting stored bytes is a privileged operation
  outside this job (UC66/AT66).

Holding a digest of deleted bytes is not reproducibility, and current
authorization outranks a past context: returning a stored report already
requires the Access gate the Worker applies before any of this runs.

## 7. Deploy order and rollback

The migration/first-activation sequence below is historical. Current releases
follow [rollout controls](rollout.md#4-deployment-order), and rollback targets
must satisfy its current schema/resource/alarm floor. An old component-level
compatibility test does not authorize a pre-alarm production rollback.

1. Apply migration `0034_reports.sql` (additive; no existing table, view,
   trigger or row is touched).
2. Deploy `services/processor` with `REPORTS_ENABLED` unset or
   `"false"`. The scheduled handler then behaves exactly as before: the report
   stage is not even added to the stage list, so no extra log line and no write.
3. Deploy `services/app`. `/api/v2/reports/{id}` returns 404 until
   a report exists; every other route is unchanged.
4. Turn the flag on (`REPORTS_ENABLED="true"`) when the report job should start
   writing.

Rollback: set `REPORTS_ENABLED` back to `"false"` (or redeploy the previous
Worker). The tables stay; they are additive and a Worker that predates them
never touches them. Do not restore the whole database to roll this back — that
would discard later collection and later decisions (docs/operations.md).

## 8. Verified locally

- `packages/domain/test/calculation.test.ts` — price basis (SYN22), each
  unvalued reason and their order, unsupported instruments, result partitions,
  net worth versus known-assets subtotal, rounding points and residual rules,
  both P&L policies (SYN23), the cost-basis gate (AT59), SYN11-SYN15.
- `packages/domain/test/market-data.test.ts` — each exclusion code, the six
  checks in order, date-only and zone rules, freshness at and past the limit,
  business days over a synthetic calendar (a century counted exactly and
  quickly), disagreement and corroboration, overlap among possibly fresh
  candidates and priority, FX paths, exact two-hop values, inverse rounding
  once with its inputs, policy mismatches, non-positive prices, validators,
  digests, the manifest, and a guard that no production source, script or task
  names a proposal; `civil-date.test.ts` — `civilDateOfInstant`, `canonicalZone`.
- `packages/read-model/test/price-candidates.test.ts` — both candidate texts
  on migrated CORE: re-parse and rollback in current and known-at modes, ties
  and sub-millisecond times at the knowledge instant, same-snapshot scope,
  overlap independent of the read margin, stale told from missing, unreadable
  effective times counted, bounds refused, plans without statistics, a
  differential against `selectPrices` on random tie-free stores (unbounded and
  0–4 day freshness), a known-at differential against an oracle over random
  publication histories, and the frozen digest of the shipped selection text;
  `price-candidates-scale.test.ts` — the plans and answers on a scaled store.
- `packages/application/test/market-data-query.test.ts` — `selectMarketData`
  end to end; the same inputs give the same context id, a new price a new one;
  unquotable currencies, malformed requests, misaligned bounds, ambiguous ids
  and proposals.
- `packages/domain/test/reports.test.ts` — body validation and digest
  stability, storage key, event shapes, replayability and capabilities (AT66).
- `services/processor/test/reports.test.ts` — migration 0034 on
  0017-0037, append-only triggers, retention-class seed, the flag, provider
  value beside own valuation (AT30), reuse, a corrected price giving a new
  context while the submitted report keeps its digest (AT36/AT60), the
  knowledge cutoff (AT63), and the restriction purge (AT66).
- `services/app/test/reports-api.test.ts` — re-display, Access and
  method gates, refusal of explanation and export under a restriction, and the
  decimal policy selection contract.
- `services/app/test/load.test.ts` — opt-in D1 budgets
  (docs/operations.md).
