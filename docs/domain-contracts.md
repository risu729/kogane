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

## `instrument-temporal.ts` — pure temporal identity

`selectInstrumentTemporal` validates a complete, globally ordered acceptance
journal and all its mapping/`listed_as` members, resolves one common cut and
each series version, then applies the explicitly supplied interval contract
and effective reference. Missing validity, unsupported time/role/zone and
relevant unlogged legacy records remain unresolved; a rejected relation to
the selected target conflicts. No relation independently adopts a mapping.

The manifest pins complete selected versions, acceptance membership,
evidence, unresolved outcomes and the resolved sequence/time. Its
`setVersion` excludes the original knowledge request and cut standing;
the outer context retains both. Static bounds refuse whole inputs. See
[ADR 0055](adr/0055-instrument-candidates.md#amendment-2026-10-09-pure-temporal-selector).
This is a pure supplied-snapshot contract: it has no database writer/reader,
command or financial consumer, and cannot prove storage atomicity.

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

## `valuation-on-date.ts` — reported holdings valued at selected prices

[ADR 0056, amendment of 2026-10-09](adr/0056-as-of-price-fx-selection.md#amendment-2026-10-09-valuation-on-a-date-as-implemented);
[calculation and reports §2](calculation-and-reports.md#valuation-on-a-date).

- `valueHoldingsOnDate(input)` takes `HoldingOnDate`s (source, snapshot,
  its freshness and age, parse run, provider-scoped instrument reference,
  instrument identity status, quote unit, quantity), a `ValuationOnDatePolicy` (`price` with exactly one
  price kind, `fx`, `calendars`) or null, the base unit, the bound and the
  selections, and returns `needs-policy` (`policy_missing`,
  `policy_proposal`) or one `HOLDING_VALUE_OUTCOMES` code per holding
  (`valued`, `unpriced`, `unconverted`, `quantity_unknown`,
  `snapshot_stale`, `instrument_unresolved`, `policy_mismatch`), the counts,
  a total that is `exact` only when every holding is valued, all come from
  one source and no position container lacks a snapshot or has a stale one
  that listed no holding (`partial-verified-scope` with both counts when one
  does; else `absent` with
  a `TOTAL_ABSENCE_REASONS` code), and a manifest of ids and codes, including
  the reported state's context id, whose `canonicalDigest` is the context
  id. Claim adoption is not applied.
- `holdingPriceWant` and `fxCurrenciesFor` name exactly the selections a
  holding will read, so a caller selects nothing more; a selection it needs
  and was not handed, a duplicate, an invalid policy or base unit, or an
  as-of date other than the reported state's throws.
- `RESOLVED_INSTRUMENT_STATUSES` (`identified`, `provider-local`) are the
  instrument statuses under which a holding is valued. Amounts are added with
  `sumQuantities`; nothing is rounded except out of the FX pivot.

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
  debits from SMBC) or `unsupported` with closed reasons (SBI Shinsei
  settlement debits: `identity_origin_unrecorded`, since registry v2).
  `FAMILY_SUPPORT` is the family-level statement.
- `PROVIDER_IDENTITY_FUNCTIONS` (ADR 0054): the declared provider identity
  functions a human-adopted writer computes alias classes with, per source,
  parser and source-account scope, with their component fields and rule
  version: SMBC's `id` (`smbc-meisai-id-v1`) and SBI Shinsei's
  `txnReferenceNo` (`sbi-shinsei-txn-reference-no-v1`), each unique within one
  resolved account. `providerIdentityFunction` is the lookup.
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
  in a log or tick record. No gain, no tax conclusion
  ([ADR 0051](adr/0051-provisional-lot-engine.md)). The C adapter below
  produces these inputs from selected revisions; no writer feeds it real ones
  yet.

## `economic-contract.ts` — consumption, seals and commits

[ADR 0054](adr/0054-economic-consumption-guard.md); enforced by CORE 0070, built
by `packages/storage-d1/src/atomic/economic-commit.ts`. The card purchase lane
and the card settlement acceptance and withdrawal write through it since G1b
([economic events](economic-events.md#common-consumption-guard-migration-0070)).

- `BOOKS` (`card-usage`, `cash-movement`, `security-quantity`) and
  `ConsumptionKey`, the 5-tuple whose text (`consumptionKeyText`) equals
  SQLite's `json_array` of the same columns; `parseConsumptionKey` accepts only
  that canonical text. `AliasClass` (source, provider identity components,
  resolved account, rule version: never the producer, namespace or raw id
  text) and `aliasClassText`.
- Claim sets (`BookClaim`): no repeated (book, key), `sameBookClaims`,
  `releasedBookClaims` (what a correction or withdrawal releases),
  `bookClaimsJson` (the stored sorted set).
- `RevisionRef`, `HeadRef` (version 0 = the event never existed),
  `economicEventSubject` (`economic-event:<id>`), `CommitRef`, `KnowledgeCut`
  (a commit sequence or an instant inside one core epoch).
- The record shapes of the 0070 tables (`EconomicClaimRecord`,
  `EventTimeRecord`, `LegEffectRecord`, `RevisionSealRecord`, `CommitMember`,
  `CommitLogRecord`), each with an exact-key validator, and
  `commitMembersJson`.
- `ECONOMIC_GUARD_CODES`, the closed codes the 0070 triggers raise (a storage
  test compares them with the SQL), and `economicGuardCode`.
- `admitIdentity` over a closed input (origin basis, resolver declared, rule
  or human writer, retire-before-recognise) → admitted (with or without an
  alias class) or one of `identity_fingerprint_only`,
  `identity_origin_unrecorded`, `identity_digest_not_provider`,
  `identity_resolver_missing`, `identity_absent`. `IDENTITY_REFUSALS` adds the
  holder-dependent `duplicate_unresolved`, `alias_conflict`,
  `identity_rekeyed` and `identity_epoch_changed`.

## `economic-event-commands.ts` — the economic-event command vocabulary

[ADR 0054, G2 amendment](adr/0054-economic-consumption-guard.md#amendment-g2-as-implemented-2026-10-09);
admitted by CORE 0071, refused by the change lifecycle until a planner exists
([change lifecycle](change-lifecycle.md#economic-event-kinds-migration-0071)).

- `ECONOMIC_EVENT_COMMAND_KINDS`: `economic-event.adopt`, `correct`,
  `withdraw`, `move`; not the reserved `economic-event.resolve-identity`.
- `validEconomicEventCommandPayload`: exact keys per kind, a `family` from
  `TRANSACTION_FAMILIES` and a non-blank reason; adopt names a proposal,
  correct restates the whole revision and lists the claims it releases (none
  of them restated), withdraw names the revision and its adopting decision,
  move takes one claim off one restated member and onto another.
- `validRestatedRevision`: kind, state in the kind's family, unknown reason
  exactly when `unknown`, legs indexed 0..n−1 with `account:` subjects and a
  cited transaction row each, distinct claims; an `unknown` revision holds
  nothing and any other holds at least one leg and claim. No value is stated:
  a leg's value is its cited row's.

## `row-identity.ts` — may a human-adopted writer consume this row

[ADR 0054](adr/0054-economic-consumption-guard.md), identity rules.

- `rowOriginBasis` reads a stored row's origin basis from the registry entry of
  its parser and the row's own recorded `_kogane.identityOrigin`: a provider id
  is `provider-id` only when the row records `provider-id`, otherwise
  `unrecorded`; fingerprints, collector fingerprints and evidence digests keep
  their basis whatever the row records; a parser outside the registry is
  `unrecorded`.
- `declaredAliasClass` applies the declared provider identity function to a
  row and an account (null when none is declared, a component is missing or
  not text, or the class is not the contract's); the readiness read computes
  the same class in SQL.
- `humanAdoptedRowIdentity` admits the row through `admitIdentity` (writer
  `human`) and returns its alias class, or the closed refusal; a declared
  function whose field the row lacks is `identity_absent`.

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
  budget is refused, never cut. Stored rows reach it only through the
  knowledge selector and the B adapter below, as a `resolved-at-cut` set.

## `knowledge-selector.ts` — what was adopted as known at a cut

- [ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md):
  `selectAdopted(input)` takes the rows the SQL half
  (`packages/read-model/src/economic-selector.ts`) loaded for a scope (every
  revision of every touched event, legs, claims, times, effects, seals, the
  commits the seals name, identity epochs and pinned identity meanings) and a
  resolved cut, resolves each event's revision in force from the commit log's
  `supersedes` before any filter, then applies the scope. It reports
  `knowledge_unlogged` (`no_commit`, `other_core_epoch`,
  `successor_unlogged`), `chain_inconsistent`, `identity_changed`, key and
  alias conflicts (never resolved), unsupported shapes and the log's coverage
  of the cut; `setVersion` is the digest of the selection's at-cut body.
- `canonicalCutInstant` and `resolveInstantCut` are the pure form of the
  instant resolution. Closed codes, exact-key validators, bounds
  (`SELECTOR_BOUNDS`) refused never cut, no clock.

## `reconstruction-adapter.ts` — the B adapter

- `adaptSelection(selection)` hands the fold a `resolved-at-cut`
  `provisional-adopted-events-v1` set: typed leg effects (a legacy fee or
  unresolved leg is a correspondence of the revision's one movement on another
  basis, otherwise `writer_unsupported`), times as stored with no fallback,
  `sha256:` digests of claim keys, the selector's dispositions as fold flags
  or revisions without a commit, and no coverage declared
  (`coverage-producer-none-v1`). `explainLateSelections` diffs two selections.
  `KNOWN_WRITER_RELEASES` names the seal releases each fold writer stamps.

## `lot-adapter.ts` — the C adapter

- [ADR 0059](adr/0059-lot-adapter-from-selected-revisions.md):
  `adaptSelectionToLots(selection, request)` reads selected revisions with a
  `security-quantity` claim, a leg in a requested instrument unit or a
  reserved kind (`LOT_ADAPTER_KINDS`: `trade` mapped, `transfer` held
  `transfer_contract_pending`, `corporate_action` held
  `corporate_action_unsupported`) and maps a `trade` to an acquisition or
  disposal: one security movement, one cash movement with its fee breakdowns
  (or stated correspondences), `trade` and `settlement` times as stored
  (`time_role_missing`, never a fallback), holder `account:<id>` with the
  request's wrapper key, the instrument from the request's mapping when it is
  `identified` or `provider-local`, states a class and equals the seal's
  `instrument_mapping:` pin. Closed codes (`LOT_ADAPTER_CODES`); a book any
  held revision touches is not fed; the selector's dispositions hold books
  `indeterminate` or `needs_review`; key and alias conflicts among security
  claims are found again here.
- `lotsOnSelection(selection, request)` runs `computeLots` under the
  request's policy and returns a status (`unsupported`, `refused`,
  `indeterminate`, `needs_review`, `limited`, `complete`), every reason
  (`LOTS_ON_SELECTION_REASONS`), the adaptation, the engine's result and the
  outer manifest with its digest as `contextId`; the cut's standing is pinned
  and echoed, and a provisional cut is at most `limited` (`cut_provisional`).
  With no security claim the
  answer is `unsupported` (`security_quantity_writer_missing`), which is every
  real answer today. No FX rate, snapshot, split or transfer input is
  produced; no gain, no tax.

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
