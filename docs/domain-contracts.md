# Domain contracts (`packages/domain`)

`@kogane/domain` holds the pure contracts that later PRs persist, query and
expose: exact quantities, role-typed time, metric definitions, scope and
adoption, coverage, contexts, decisions and the shared result shape. It has no
runtime dependencies, no I/O and no clock. Services import it by relative path
(`../../../packages/domain/src/...`), the same way they import the other
shared packages ([package layout](package-layout.md)). The architectural decision behind it
is [ADR 0001](adr/0001-domain-axes.md).

Every validator in the package rejects unknown keys. A new field is a reviewed
contract change, not a free extension. Every "cannot add / cannot adopt"
outcome is a typed result, never a thrown string.

## `values.ts` — exact quantities

- `ExactDecimal { coefficient, scale }` in the decimal-v1 canonical form (no
  trailing zeros, `-0` is `0`). `ValueState` is `exact | missing | unparsed |
conflict`; `Quantity { unitRef, value }`.
- Arithmetic on BigInt: `addDecimals`, `subtractDecimals`, `negateDecimal`,
  `multiplyDecimals`, `compareDecimals`, `sumDecimals`, scale alignment.
  `multiplyByRatio` and `divideDecimals` are exact or return
  `inexact_result` unless an explicit `Rounding { scale, mode }` is given, so a
  different policy can recompute from the same inputs.
- `addQuantities`, `subtractQuantities`, `sumQuantities`, `scaleQuantity`,
  `compareQuantities` return `unit_mismatch` for different units (INV03) and
  `value_not_exact` for missing, unparsed or conflicting operands (INV05).
  Nothing here turns an absent value into zero.
- `fromNormalizedDecimal` adapts the persisted `NormalizedDecimal` row
  (imported from the PoC, not copied) and carries its status through.

## `time.ts` — role-typed time

- `TemporalValue`: `instant` (RFC 3339 with offset, plus zone and basis),
  `local-date` (no time-of-day), `period` (`start`, `end`, `endExclusive`,
  granularity day/month/year) or `unknown` with a reason code.
  `TemporalReference { role, time }` names the role (effective, recorded,
  fetched, trade, settlement, due, expiry, ...).
- `compareTemporal` orders instants by absolute time and dates or periods as
  civil-day intervals; an instant against a date is ordered only when its own
  calendar date lies wholly outside the interval, otherwise `within_day` /
  `within_period`. A date is never promoted to an instant. `unknown` is
  `unknown_time`; different explicit zones are `zone_mismatch`.
- `temporalOrderingKey` is a total ordering for paging and tie-breaks only;
  unknown times sort last by reason code.
- Civil-day helpers (`daysFromCivil`, `addDays`, `daysBetween`, `addMonths`
  with `clamp` or `preserve-end-of-month`, `periodBounds`) are leap-year aware
  and DST-free. No time-zone database is embedded; `zone` names the deadline
  or display zone, the instant string carries the offset in effect.

## `metrics.ts` — what a number measures

- `MetricDefinition`: `metricId`, `providerMetric`, `measurementKind` (stock,
  flow, obligation, capacity, price, valuation, period-total,
  qualification), `subjectKind`, `unitDimension`, `signMeaning`, `timeBasis`,
  `aggregationRule` (sum-disjoint, select-one, non-additive,
  domain-specific), `overlapGroup`, `sourceAuthority`, `definitionRelease`,
  and `netAssetEligible: false` for every entry, exactly as today.
- `METRIC_REGISTRY` is seeded from the current `classifyBalance` and
  `classifyActivity` rules in `packages/observation-shared`. Each entry
  records the legacy classification it came from, and
  `test/metrics.test.ts` calls the PoC functions for every selector and
  compares. The PoC behaviour is unchanged.
- `resolveMetric(lookup)` returns the first matching entry in declaration
  order or `UNKNOWN_METRIC`, an explicit non-additive definition. Unknown
  metrics are kept and displayed, never summed.
- `additivityVerdict(a, b)` decides whether two measures may ever be summed
  (same metric, same dimension, both sum-disjoint, no shared overlap group).
  Scope disjointness is a separate question answered by `scope.ts`.
- `PriceObservation` states `quoteAmount` per `baseQuantity`; `valueAtPrice`
  checks the unit and price basis (12,500 fund units at 8,000 JPY per 10,000
  units is 10,000 JPY, not 12,500 × 8,000).

## `scope.ts` — what set a number covers, and adoption

- `ScopeDefinition` (perimeter, sorted source refs, account / product /
  pocket, instrument, time range, membership evidence) with `scopeDigest`
  over the canonical form. `ScopeRelationClaim` is `same | disjoint | subset
| overlaps | unknown` with evidence and decision references.
- `selectAdoptedSet(target, candidates, relations, options)` implements
  addendum 05 §5 steps 2–7 deterministically and returns `{ adopted,
excluded: [{ ref, reasonCode }], unresolved: [{ ref, reasonCode }],
adoptedTotal, completeness, warnings }`:
  1. candidates of another metric or unit are excluded;
  2. non-exact values and partial or unknown coverage are unresolved;
  3. `same` evidence is bundled when it agrees; disagreements stay
     `conflicting_evidence` unless `conflictRule: "prefer-lowest-rank"`;
  4. a total and its complete, pairwise-disjoint breakdown are alternatives
     (`preferBreakdown`, default true); a mismatch leaves both unresolved with
     a warning;
  5. ownership shares are applied exactly; unknown shares are never assumed
     to be half;
  6. everything adopted must be explicitly disjoint (or derivably disjoint
     through one `subset` step) from every other contender; an unknown or
     declared overlap leaves the worse `authorityRank` unresolved, equal ranks
     leave both. Unknown is never read as disjoint (INV06).
     `adoptedTotal` is `null` when nothing was adopted; a partial subtotal is
     never presented as a lower bound.
- It is not an optimiser: relations must be supplied, contradicting claims
  degrade to unknown with a `relation_conflict` warning, and the result is
  independent of input order.

## `coverage.ts` — what a fetch proves

- `CoverageClaim` (claimId, scopeKey, mode complete-container | window |
  event-feed | evidence-only, completeness, membershipComplete,
  observedCount, expectedCount, evidenceRefs, policyVersion, failureCause,
  absenceMeaning) and `ParseIssue` (code, locator, severity, impact none |
  field | membership | whole-artifact, message) as in root review 02.
  `coverageClaimViolations` checks the cross-field rules.
- `snapshotEligibility(claim)` encodes SC15: only a complete,
  membership-complete container snapshot replaces the previous holdings, even
  when it has zero rows; partial pages, failed fetches and an empty complete
  history window never do. `strongestImpact` ranks issues by impact, not
  severity.

## `context.ts` — fixing the inputs of a result

- `FinancialContext` (schema `financial-context-v1`): query semantics
  version, perimeter, effective time, knowledge cutoff, publication and the
  manifest references for source selection, parser build, metadata build,
  identity decisions, event decisions, reference data, calculation policy and
  the evaluation clock. `changedContextInputs` lists any differing input; a
  difference requires a new `contextId` (INV09).
- `TransformManifest` (root review 03, D03) identifies a transformation by
  code digest and contract versions, not by semver alone.
- `Replayability`: `replayable | artifact-preserved | restricted |
unavailable`. `InterpretationContext`: `latest | as-recorded | snapshot`
  with the release identifiers used (root review 04).
- Canonical form `canonical-json-v1`: object keys sorted by UTF-16 code
  units, arrays in given order, strings as JSON, booleans, null and safe
  integers only. Floats, NaN, Infinity, bigint, undefined and class instances
  are rejected (`CanonicalFormError`); decimals travel as `ExactDecimal`
  objects. `canonicalDigest` is SHA-256 (Web Crypto) over that text as
  lowercase hex. This is the only form digests in this repository's domain
  layer are computed from.

## `decisions.ts` — judgements, relations, allocations

- `RelationKind` is a closed union: `same_account`, `connection_contains`,
  `account_has_pocket`, `statement_covers`, `funded_by`, `liable_party`,
  `beneficial_owner`, `same_underlying`, `listed_as`, `replaces_identifier`,
  `provider_same`, `supersedes`, `supports`, `contradicts`,
  `pending_to_posted`. `TypedRelation` carries validity, evidence, status
  (proposed | adopted | rejected | superseded) and the decision revision.
- `Actor` is server-verified; `legacy-unknown` is allowed for migrated rows
  and never replaced by an invented approver. `DecisionRevision` kinds are
  proposal, acceptance (requires a `planDigest`), rejection, supersession and
  release-override (both require the revision they replace). Proposals do
  not change adopted state (INV07); earlier judgements are retained (INV08).
- `OperationReceipt` binds an idempotency key, principal, payload digest,
  expected revisions and a status that distinguishes `accepted` from
  `published`.
- `Allocation` and the conservation checks of addendum 07 §4:
  `checkTransferConservation` (`source decrease = destination increase +
explicit fees + declared unresolved difference`, per unit, gap reported not
  absorbed), `checkObligationAllocations`, `checkFillAllocations` and
  `checkSourceAllocations` (sums never exceed the limit; negative allocations
  rejected).

## `result.ts` — the shape UI and agents share

- `QuerySpec` with the intents of addendum 09 §1 (holdings, reported-state,
  net-worth, liquidity, cash-flow, obligations, activity, income,
  performance, reward-forecast) plus `coverage` — what the authorised
  perimeter covers, the question asked before any figure means anything
  (addendum 10 §7) — a perimeter, effective time, basis and filter records.
- `FinancialResult<T>` with `completeness`, `coverage` defined inside the
  authorised scope, five `QualityDimension`s (identity, freshness, numeric,
  reconciliation, valuation), cursor, explanation references and typed
  warnings; `Page<T>` with `dataCoverage`.
- `FinancialErrorCode`: the codes of addendum 10 §9 plus `context_expired`,
  `unauthorized` and `invalid_query`. Messages carry no provider content,
  tokens or raw exceptions.

## Fixtures

`packages/domain/fixtures/` holds the synthetic inputs and expected adopted
sets for the three vertical slices (V1 SC01/SC06/SC15, V2 SC02–SC04, V3
SC11–SC14); see its README. `test/scenarios.test.ts` runs SYN01–SYN24 from
addendum 14 §7 against them and the helpers.

## Deploy order, rollback, flags

- This package is pure TypeScript with no deployment of its own. Nothing in
  `poc/` or `services/` imports it yet, and there are no migrations.
- Deploy order for consumers (later PRs): schema, then writer, then reader;
  each consumer documents its own order. A01 changes none of them.
- Rollback target: revert the A01 commits. No stored data depends on this
  package.
- Feature flags: none. The package changes no visible result set.

## Verified locally

With synthetic data only: `mise run domain:typecheck` and `bun test` in
`packages/domain`, the offline CI plan `bun run scripts/ci-package.ts
packages/domain`, `bun test scripts/`, and `hk check`. Not verified: any
service integration, D1, Workers, production data or load.
