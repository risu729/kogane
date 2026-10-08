# Domain contracts (`packages/domain`)

`@kogane/domain` holds the pure contracts services persist, query and
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

## `civil-date.ts` — civil dates in named zones

- `civilDateOfInstant(text, zone)` and `canonicalZone(zone)` are the domain's
  only uses of zone data: the civil date of an instant in a named zone, and
  the runtime's spelling of a zone name, from the runtime's own
  `Intl.DateTimeFormat("en-CA", { timeZone })` (one formatter cached per
  zone). A non-instant, a malformed zone name or a zone the runtime does not
  know is `null`, never UTC, and no date becomes an instant. The module is
  separate from `time.ts`, which is in the parser digest closure
  (`packages/parsers/src/parsers/digests.ts`) and stays free of zone data.

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

## `market-data.ts` — as-of price and FX selection

[ADR 0056](adr/0056-as-of-price-fx-selection.md). Every function takes the
policy it applies; none has a default.

- `PriceSelectionPolicy` (admitted rules, price kinds, temporal bases, zone,
  freshness in calendar or business days, date-only rule, multi-source rule,
  candidate scope), `FxConversionPolicy` (pivot, quotable currencies, one
  selection policy with one kind, inverse rounding or none), `MarketCalendar`
  (supplied with evidence; none shipped) and `SelectionBound` (exclusive
  `effectiveBefore`, `asOfDate`, `current` or `known-at` knowledge). The
  validators reject unknown keys, empty or duplicated lists, bad day counts,
  zones the runtime does not know or spells differently, a bound that is not
  exactly the end of its date in the policy zone, and a known-at instant finer
  than a millisecond (`validKnownAtInstant`). A policy's digest is its
  `canonicalDigest`.
- `selectPrice(key, candidates, bound, policy, calendar)` runs six checks in
  order and returns one selected price (with its age and corroborating ids)
  or one closed refusal (`PRICE_SELECTION_REFUSALS`), with every removed
  candidate counted by `CANDIDATE_EXCLUSIONS`. Instants are compared through
  `parseInstant`, prices per unit of base with exact decimals.
  `selectFxRate(currency, …)` answers a currency outside the FX policy
  `unsupported_pair` and otherwise selects under the policy's selection policy.
- `fxPath`, `convertToBase` and `valueInBase` go through one pivot: into it
  exactly, out of it as one ratio rounded once with `RoundingInputs`, a missing
  or refused rate a refusal (`CONVERSION_REFUSALS`), never 1:1. An FX
  selection of another key or another selection policy throws.
- `freshnessWindowStart` and `selectionReadWindow` size the candidate read;
  `selectionManifest` builds the sorted input set whose digest is a context id.
  `isCurrencyCode` is the shared three-letter check.
- `PROPOSED_FX_SELECTION_POLICY_V1`, `PROPOSED_FX_CONVERSION_POLICY_V1` and
  `PROPOSED_EQUITY_SELECTION_POLICY_V1` hold recommended values only; their
  ids start with `PROPOSAL_POLICY_PREFIX`, which `selectMarketData` refuses,
  and a test fails if a production source, script or task outside the module
  names one.

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

## `event-families.ts` — which transaction families have an event writer

- `TRANSACTION_FAMILIES` is a closed list of 14 economic-event families
  (deposit-account movement, stored-value movement, FX, remittance, securities order/execution/settlement cash,
  crypto execution and fiat remittance, reward exchange, prepaid funding and
  notification, card purchase, card settlement);
  `FAMILY_UNSUPPORTED_REASONS`, `PROVIDER_LINK_CODES`, `EXTERNAL_ID_BASES` and
  the recorded origin keys and stage A readings are closed as well.
- `TRANSACTION_FAMILY_REGISTRY` has one entry per parser whose rows are
  transactions or positions: observation kinds, the external id basis and the
  `_kogane` key of its recorded origin and how stage A reads it, the status
  vocabulary, the provider-stated link fields, and the family memberships with
  writer status `supported` (card purchases from Vpass/MyJCB, card settlement
  debits from SMBC/SBI Shinsei) or `unsupported` with closed reasons.
  `FAMILY_SUPPORT` is the family-level statement.
- `transactionFamilyEntry`, `transactionFamilyEntries` and
  `familyUnsupportedReasons` are the pure lookups;
  `validTransactionFamilyEntry` rejects unknown keys and codes. The registry is
  a statement about the code, never adoption: nothing reads it to write
  ([economic events](economic-events.md#non-card-families-unsupported-today),
  [ADR 0053](adr/0053-transaction-family-registry.md)).

## `instrument-candidates.ts` — which identifiers may be one instrument

[ADR 0055](adr/0055-instrument-candidates.md); the read that feeds it is
described in [identity](identity.md#cross-identifier-instrument-candidates).

- `InstrumentIdentifierFacts` is what the identity rules stored about one
  identifier (ISIN, RIC, MIC, country, security code, share and product class,
  stated currencies, sources) plus its current mapping. The label is display
  only.
- `compareIdentifierFacts` returns closed codes, never a score: `evidence`
  (`isin-equal`, `ric-equal`, `security-code-equal`), `conflicts` (kind, ISIN,
  RIC, country, market, currency, share class, product class), `agreements`
  and `gaps` (a fact one side or both sides do not state, so ISIN, share
  class and product class are gaps on every pair while no rule records them).
- `instrumentCandidates` pairs only identifiers that share an evidence value.
  A pair on two instruments counts every identifier that maps to either
  instrument now (`via` names the others whose facts conflict). A pair with a
  conflict is `separated`; one without is a candidate whose
  `status` is `adopted` only when both map to one instrument and `rejected`
  only when a stored `listed_as` rejection names it, else `proposed`. Equal
  normalised names without evidence are `hints` with no status. A manually
  mapped or instrument-sharing identifier is always the anchor over one that
  is not; a proposed candidate whose subject is also settled carries a
  `CANDIDATE_HOLDS` code and names nothing to adopt (it can still be kept
  apart by a rejection). The answer is
  order-independent and refuses more than 5,000 pairs or 1,000 hints.
- `identifierResolutions` gives each identifier one of
  `IDENTIFIER_RESOLUTION_STATES`; an instrument shared without a manual
  mapping is `shared-without-decision`, never resolved.

## `lots.ts` — lots and disposal allocation over a provisional input

- `computeLots(inputs, policy)` is pure and deterministic: the same inputs in
  any order give the same result. Inputs (`LotInput`) carry the provisional
  tag `provisional-lot-input-v0`, a pinned `LotInputRef` (event at a
  revision, or observation in a parse run, with `lotInputRefText`), a kind
  (`acquisition | disposal | split | snapshot | transfer`), the book key
  (holder, instrument, opaque wrapper key), trade and settlement times,
  quantity, consideration, fees, an optional input FX rate, a split ratio and
  lot selections. `validLotInput`, `validLotInputRef` and `validLotPolicy`
  reject unknown keys.
- `LotPolicy` pins purpose, method (`fifo | moving-average |
specific-identification`), scope, time basis, ordering rule, fee and FX
  treatment, `fxPolicyRef`, `costUnitRef` and an optional `leg`/`carry`
  `RoundingPolicy`.
- Whole-run refusals, in order: `policy_missing`; `invalid_input` for a
  malformed policy; `policy_unsupported` for a rounding policy other than
  `leg`/`carry` (checked before the tax gate); `tax_rules_unverified` for a
  `tax` purpose, through the unchanged `costBasis()` gate; `invalid_input`
  for inputs that are not a list, break the contract or carry lot selections
  outside specific identification; `duplicate_ref` for one ref twice in a
  book or in two books of one instrument; `same_event_revisions`;
  `same_observation_parse_runs` (one observation and JSON path under two
  parse runs; a re-parse under a different or null JSON path is not caught).
  Per-book refusals: `transfer_contract_pending`, `unsupported_instrument`.
- Inside a book the first ambiguous or inconsistent input, or group of
  inputs the time does not order, is `indeterminateFrom` and later disposals
  are `upstream_indeterminate`. A `limited` disposal carries only
  `LOT_LIMITED_REASON_CODES`: `unknown_cost`, `unknown_acquisition_fee`,
  `unknown_proceeds`, `unknown_disposal_fee`, `fx_rate_missing`,
  `unit_mismatch`. Amounts that are not known are typed reasons, never zero,
  and costs in different units are never summed.
- Output: disposals with allocations (a pool allocation names how many of
  the pool's members had joined; `pools` lists each pool's members once),
  allocated cost, proceeds and disposal fees, outcome
  `allocated | limited | indeterminate`; remaining lots with a `lineage`; a
  manifest of policy, refs and the validated inputs for `canonicalDigest`, so
  equal digests mean equal results while `LOT_ENGINE_VERSION`, bumped on
  every allocation-rule change, is equal. The manifest holds amounts: it is a
  calculation input that a future writer stores only as a report body, never
  in a log or tick record. No gain, no tax conclusion. No adapter produces
  these inputs yet ([ADR 0051](adr/0051-provisional-lot-engine.md)).

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

## `reconstruction.ts` — reconstructed state from adopted events

- [Reconstructed state](reconstructed-state.md), [ADR 0052](adr/0052-reconstructed-state-fold.md):
  `selectKnowledge` resolves every event's active revision at a commit-sequence
  cut over the whole chains before any filter; `reconstructState` folds a
  start snapshot plus the selected movements per (account, unit) and
  (account, instrument) in exact decimals and explains the difference against
  the reported end with closed codes; `explainLate` diffs two selections.
- The event input (`provisional-adopted-events-v1`) is provisional and is
  replaced by the hand-off contract. The policy `reconstruction-fold-v1` is a
  required parameter and any other content under its id is refused. Absent
  stays absent, nothing is totalled across accounts, and an input over the
  budget is refused, never cut. No read path uses it yet.

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

With synthetic data only: `mise run //packages/domain:typecheck` and `bun test` in
`packages/domain` (today `mise run //packages/domain:ci`), the repository-wide guards
(today `mise run ci:root`), and `hk check`. Not verified: any
service integration, D1, Workers, production data or load.
