# Prices, calculation policies and fixed report artifacts

Architecture-addendum plan item A12, for findings AR03 (no boundary between a
disposable calculation and a report that must be preserved), AR12 (a policy
version does not fix the input set), AR17 (immutable evidence read as
unconditional permanent storage) and AR18 (protecting the record of truth
treated as forbidding a fast derived read model).

Nothing here concludes anything about tax, and nothing fetches a price from
outside. Everything below was exercised locally against synthetic data; no
production claim is made.

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

`services/observation-pipeline/src/report-job.ts` builds a
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

1. Apply migration `0034_reports.sql` (additive; no existing table, view,
   trigger or row is touched).
2. Deploy `services/observation-pipeline` with `REPORTS_ENABLED` unset or
   `"false"`. The scheduled handler then behaves exactly as before: the report
   stage is not even added to the stage list, so no extra log line and no write.
3. Deploy `services/evidence-browser`. `/api/v2/reports/{id}` returns 404 until
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
- `packages/domain/test/reports.test.ts` — body validation and digest
  stability, storage key, event shapes, replayability and capabilities (AT66).
- `services/observation-pipeline/test/reports.test.ts` — migration 0034 on
  0017-0037, append-only triggers, retention-class seed, the flag, provider
  value beside own valuation (AT30), reuse, a corrected price giving a new
  context while the submitted report keeps its digest (AT36/AT60), the
  knowledge cutoff (AT63), and the restriction purge (AT66).
- `services/evidence-browser/test/reports-api.test.ts` — re-display, Access and
  method gates, refusal of explanation and export under a restriction, and the
  decimal policy selection contract.
- `services/evidence-browser/test/load.test.ts` — opt-in D1 budgets
  (docs/operations.md).
