# ADR 0001: Keep A/B/C/D as provenance, add independent domain axes

- Status: accepted (implementation step A01)
- Date: 2026-09-09
- Review basis: whole-architecture addendum 00, 04 (AR01–AR18), 05, 06, 13 §1–§3
  of the design review of commit `130912af`

## Context

`docs/design.md` classifies every piece of information as A (evidence),
B (observation), C (interpretation) or D (derived). That classification is
correct and stays. The review found that the classification alone does not
decide four things a personal finance system with UI and agent clients needs:

1. Whether two correct numbers may be added (a linked deposit shown by the bank
   and as broker buying power; a total and its breakdown; a statement amount
   and the outstanding debt; regular and restricted points). This is a
   question of metric, scope, rights and adoption, not of layer (AR05, AR06).
2. Which parts of C can be regenerated. Human account mappings, cost-basis
   choices and approvals cannot be re-derived from provider evidence and an
   agent will not reliably propose the same thing again (AR02).
3. Which parts of D must be kept. A submitted report is not a cache (AR03).
4. How the UI and an agent see the same result under the same conditions,
   and how a proposal becomes an adopted judgement without the agent granting
   itself authority (AR13, AR14).

## Decision

Keep A/B/C/D as the classification of where information comes from, and add
independent axes rather than more numbered layers:

| Axis                  | What it decides                                                                                                                       | Where it lives after A01                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Provenance (A/B/C/D)  | What was fetched, what the provider said, what we decided, what we computed                                                           | unchanged: `docs/design.md`, existing tables                                                                               |
| Business meaning      | Party, institution, source, connection epoch, account, product, pocket, instrument, holding, obligation; typed relations between them | `packages/domain` types (`metrics`, `scope`, `decisions`); persistence in later PRs                                        |
| Processing dependency | A versioned dependency graph: which parser build, metadata build, decision manifest, reference data, price and policy a result used   | `FinancialContext`, `TransformManifest`, `InterpretationContext` in `packages/domain/src/context.ts`                       |
| Update and retention  | Append-only A/B; DecisionLog as the source of truth for C judgements; rebuildable projections versus retained report artifacts in D   | `DecisionRevision`, `Actor`, `OperationReceipt` in `decisions.ts`; `Replayability` in `context.ts`; storage in A06/A09/A12 |
| Control               | Authorisation, adoption pointers, approvals, jobs, retention                                                                          | shared error codes and result contract in `result.ts`; services in A05/A09                                                 |
| Shared Query/Command  | One application service that UI, HTTP and MCP adapt; no client-side or LLM re-aggregation                                             | `QuerySpec`, `FinancialResult`, `Page` in `result.ts`; application package in A08                                          |

The following are explicitly rejected (addendum 04 §3, 13 §6): a physical
four-way split into services or databases, a linear A→B→C→D pipeline as the
whole architecture, a graph database, event sourcing for every write, a
general rules DSL, an optimiser over arbitrary measurement sets, automatic
transactions at institutions, arbitrary SQL through MCP, and a large
financial ontology.

Cloudflare Workers, D1 and R2 stay. Existing evidence integrity, pending
non-publication, leases and seals, manual-revision protection and the
`decimal-v1` normalisation are reused; none of them is replaced.

## Invariants adopted

| ID    | Invariant                                                                                           | Enforced in A01 by                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV01 | Normal corrections to A/B are appended; the original claim is never overwritten                     | unchanged append-only tables; `DecisionRevision.supersedesRevisionRef` models supersession without deletion                                               |
| INV02 | Source ids, economic event ids, operation ids and evidence hashes are different identities          | separate `ref` fields on candidates, allocations, relations, receipts; no shared id type                                                                  |
| INV03 | Different units are never added directly; numeric exactness and semantic certainty are separate     | `addQuantities` / `sumQuantities` return `unit_mismatch`; `MetricDefinition.aggregationRule` and `additivityVerdict`                                      |
| INV04 | The same query in the same context returns the same adopted set, values and explanation             | `selectAdoptedSet` is deterministic and order-independent (tested); `canonicalDigest` for contexts and scopes                                             |
| INV05 | Unconfirmed, missing, unevaluated or partial is never converted to zero or to a complete set        | `ValueState` statuses, `value_not_exact`; `snapshotEligibility`; `adoptedTotal: null`; `compareTemporal` never invents a time-of-day                      |
| INV06 | Within one perimeter the same economic effect is never allocated twice                              | `selectAdoptedSet` step 7 (unknown overlap is unresolved, never disjoint); `checkSourceAllocations`, `checkObligationAllocations`, `checkFillAllocations` |
| INV07 | Automatic proposals do not change adopted economic state until accepted                             | `DecisionRevision.kind` proposal vs acceptance; `TypedRelation.status`; acceptance requires a `planDigest`                                                |
| INV08 | Earlier human judgements are retained as the source of truth needed for rebuilds                    | `DecisionRevision` with server-verified or `legacy-unknown` actor; release-override references the revision it overrides                                  |
| INV09 | A change of price, rule, decision or input creates a new context                                    | `changedContextInputs`, `contextInputsDigest`                                                                                                             |
| INV10 | Partial results before publication are not shown as one completed calculation                       | `FinancialResult.completeness`, `AdoptionResult.completeness`, `OperationReceipt.status` accepted vs published                                            |
| INV11 | A past context cannot bypass current view permissions or evidence exclusions                        | `Replayability.restricted`, `evidence_restricted` error code; enforcement is a service concern (A05/A09)                                                  |
| INV12 | UI and agents use the same business service and never treat their own totals as the source of truth | shared `QuerySpec` / `FinancialResult` contract; adapters in A08                                                                                          |

## Use cases mapped to types

"Represented" means the distinction the use case requires can be expressed
with the A01 types and, where a function exists, is exercised by a test or
fixture. "Deferred" means the type is missing or only a placeholder exists;
the column names the planned PR. Nothing below is a production feature yet.

| UC                                          | Type / module                                                                                     | Status                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| UC01 direct vs MoneyForward                 | `connection_contains` vs `same_account` relations; scope relations (SC06 fixture)                 | represented                                                            |
| UC02 credential replacement                 | `ConnectionEpoch` entity                                                                          | deferred (A06)                                                         |
| UC03 family card user vs debtor             | `liable_party`, `beneficial_owner` relation kinds                                                 | represented (relations); per-party aggregation deferred (A07)          |
| UC04 rename, merge, split                   | `replaces_identifier` with `validity`; supersession revisions                                     | represented (relations); migration of existing mappings deferred (A06) |
| UC05 account exists, product unconfirmed    | `CoverageClaim.absenceMeaning`, `ValueState` missing                                              | represented                                                            |
| UC06 self / joint / household               | `ScopeDefinition.perimeterRef`, `Ownership` share or unknown                                      | represented                                                            |
| UC07 linked deposit in bank and broker      | `measurementKind` stock vs capacity, `selectAdoptedSet` (SC01)                                    | represented                                                            |
| UC08 boxes and jars                         | `subset` relations, total-vs-breakdown step                                                       | represented                                                            |
| UC09 current vs available                   | stock vs capacity metrics                                                                         | represented                                                            |
| UC10 multi-currency latest balances         | per-unit `Quantity`, `QualityDimension.freshness`                                                 | represented (units); FX valuation deferred (A12)                       |
| UC11 term deposit maturity                  | obligation and projection types                                                                   | deferred (A10)                                                         |
| UC12 loans and offset                       | `liability-positive` sign, non-additive rule                                                      | deferred (A10)                                                         |
| UC13 pending to posted                      | `pending_to_posted` relation, refund allocation (SC03)                                            | represented                                                            |
| UC14 pending disappeared                    | `snapshotEligibility` on a complete container                                                     | represented                                                            |
| UC15 statement vs debit                     | `card.statement-*` metrics sharing `myjcb:statement` overlap group; settlement allocations (SC02) | represented                                                            |
| UC16 instalments and fees                   | `checkObligationAllocations` (SC04)                                                               | represented                                                            |
| UC17 partial refunds                        | `Allocation.role = refund`, `checkSourceAllocations`                                              | represented                                                            |
| UC18 one card, several modes                | payment-instrument mode history                                                                   | deferred (A06)                                                         |
| UC19 same-currency self transfer            | `checkTransferConservation`; candidate matching                                                   | represented (conservation); matching deferred (A10)                    |
| UC20 remittance with explicit fee           | cross-unit `unit_mismatch`; fee legs (SC05)                                                       | represented                                                            |
| UC21 reference-rate difference              | `PriceObservation.priceKind = reference`; estimate kept apart from fee                            | represented                                                            |
| UC22 in-transit, returned                   | remittance state machine                                                                          | deferred (A10)                                                         |
| UC23 reimbursement vs transfer              | manual `DecisionRevision`, `beneficial_owner`                                                     | represented (records); matching deferred (A10)                         |
| UC24 missing FX, direction, rounding        | `valueAtPrice`, explicit `Rounding`, `inexact_result`                                             | represented                                                            |
| UC25 order, execution, settlement           | `TemporalRole` trade/settlement, `QuerySpec.basisRefs`                                            | represented (types); state machine deferred (A12)                      |
| UC26 split fills                            | `checkFillAllocations` (SC07)                                                                     | represented                                                            |
| UC27 dividends and withholding              | gross/net legs                                                                                    | deferred (A12)                                                         |
| UC28 splits and mergers                     | exact `multiplyByRatio` (SC08); cost-basis policy                                                 | represented (arithmetic); policy deferred (A12)                        |
| UC29 broker transfers                       | transfer relations with cost carry-over                                                           | deferred (A12)                                                         |
| UC30 provider vs own P&L                    | `sourceAuthority`; decomposition test SYN23                                                       | represented (attributes); calculation deferred (A12)                   |
| UC31 same ticker, different asset           | opaque `unitRef`, `same_underlying`, `listed_as`                                                  | represented                                                            |
| UC32 exchange to wallet                     | `checkTransferConservation` (SC09)                                                                | represented                                                            |
| UC33 multi-output chain transaction         | per-output allocations                                                                            | deferred (A10)                                                         |
| UC34 staking, locks                         | pocket and capacity metrics                                                                       | deferred (A11)                                                         |
| UC35 derivatives and margin                 | `unsupported_semantics` error code                                                                | deferred                                                               |
| UC36 price corrections                      | `PriceObservation.sourceClaimRef`, `referenceManifestRef`, `changedContextInputs`                 | represented                                                            |
| UC37 cash-like vs non-withdrawable          | wallet capacity vs nominal (SC11)                                                                 | represented                                                            |
| UC38 card, wallet, shop                     | funding / purchase / settlement events (SC02)                                                     | represented                                                            |
| UC39 points plus cash tender                | multi-tender allocations                                                                          | deferred (A10)                                                         |
| UC40 Suica history vs live balance          | `prepaid.sf-balance-after-transaction` event-reported select-one; window coverage                 | represented                                                            |
| UC41 point transfer request                 | request / debit / credit stages (SC13)                                                            | represented (fixture); state machine deferred (A11)                    |
| UC42 gift cards and regional limits         | issuer and refundability constraints                                                              | deferred (A11)                                                         |
| UC43 regular and limited buckets            | `reward.bucket-balance` with `pocketRef` (SC11)                                                   | represented                                                            |
| UC44 lot-level expiry                       | lot model                                                                                         | deferred (A11)                                                         |
| UC45 inactivity expiry                      | qualifying activity plus `addMonths` (SC12)                                                       | represented (fixture); versioned rule storage deferred (A11)           |
| UC46 tier-dependent terms                   | relation `validity` periods                                                                       | deferred (A11)                                                         |
| UC47 miles vs status points                 | `measurementKind = qualification` (SC11)                                                          | represented                                                            |
| UC48 earned, pending, held                  | `reward.previous-month-earned` period-total                                                       | represented                                                            |
| UC49 minimum, increment, cap                | explicit `Rounding` down on increments (SC14)                                                     | represented (test); offer type deferred (A11)                          |
| UC50 campaign rates                         | offer validity and membership                                                                     | deferred (A11)                                                         |
| UC51 lead time vs expiry                    | `daysBetween`                                                                                     | deferred (A11)                                                         |
| UC52 award value                            | `priceKind = provider-value`; valuation policy                                                    | deferred (A12)                                                         |
| UC53 conversion routes                      | hop-by-hop check (SC14); no optimiser                                                             | deferred (A11)                                                         |
| UC54 award cancellation                     | return claims                                                                                     | deferred (A11)                                                         |
| UC55 platform sales, fees, payout           | net arithmetic (SC10)                                                                             | represented (arithmetic); allocation model deferred (A10)              |
| UC56 reserves and disputes                  | availability states                                                                               | deferred (A10)                                                         |
| UC57 accrued vs paid interest               | accrual model                                                                                     | deferred (A12)                                                         |
| UC58 recurring due amounts                  | projection type                                                                                   | deferred (A12)                                                         |
| UC59 JP / AU rule sets                      | `needs_rule_verification`, `calculationPolicyRef`                                                 | deferred (A12)                                                         |
| UC60 submitted reports                      | `Replayability`, `InterpretationContext.snapshot`                                                 | represented (context); `ReportArtifact` deferred (A12)                 |
| UC61 30-day history                         | `CoverageClaim.mode = window`                                                                     | represented                                                            |
| UC62 empty, failed, partial                 | `snapshotEligibility` (SC15)                                                                      | represented                                                            |
| UC63 later corrections                      | `knowledgeCutoff`, `effectiveTime`, interpretation modes                                          | represented (types); read paths deferred (A04/A06)                     |
| UC64 date-only and time zones               | `TemporalValue`, `compareTemporal`                                                                | represented                                                            |
| UC65 parser updates and rollback            | `TransformManifest`; adoption pointer                                                             | represented (manifest); adoption deferred (A04)                        |
| UC66 evidence exclusion                     | `Replayability.restricted`, `evidence_restricted`                                                 | deferred (A05/A09 enforcement)                                         |
| UC67 agent reads all accounts               | `FinancialResult` coverage and quality, `QueryIntent`                                             | represented (contract); service deferred (A08)                         |
| UC68 agent proposes                         | proposal revisions with agent actor                                                               | represented                                                            |
| UC69 human approves                         | acceptance bound to `planDigest`                                                                  | represented (record); approval flow deferred (A09)                     |
| UC70 concurrency and retries                | `OperationReceipt`, `stale_context`, `idempotency_conflict`                                       | represented (types); enforcement deferred (A09)                        |
| UC71 hostile text in statements             | untrusted-content labelling                                                                       | deferred (A08/A09)                                                     |
| UC72 humans and agents see the same numbers | shared `QuerySpec` / `FinancialResult`                                                            | represented (contract); adapters deferred (A08)                        |

## Explicitly not decided yet

From addendum 13 §1 (right column) and §6:

- A general rules DSL for all reward programs: start with a few versioned
  functions; generalise only after counter-examples exist.
- Canonical identity for every institution: provider-local and unresolved
  identities remain first-class.
- All analytics and tax computations: only ranges with a verified policy
  package are published; no jurisdiction rules are asserted here.
- Database product: D1/R2 stay until load measurements say otherwise.
- The concrete persistence of DecisionLog, adoption pointers, coverage claims
  and read models: A03–A07 decide the tables; this ADR fixes only the
  contracts.
- Automatic transactions at institutions, unlimited point-conversion
  optimisation, arbitrary SQL through MCP, whole-system event sourcing and a
  graph database are out of scope.

## Consequences

- New pure code lives under `packages/<name>/` and is imported by relative
  path; services keep their own lockfiles. `packages/domain` has no runtime
  dependencies and no I/O.
- Every "not additive" outcome is a typed result (`unit_mismatch`,
  `value_not_exact`, `overlap_unknown`, ...), never a thrown string, so
  adapters can return machine-usable errors.
- The metric registry is seeded from the existing `classifyBalance` and
  `classifyActivity` rules and compared against them in tests; the PoC rules
  are unchanged and remain the display path until A07.
- Later PRs must add a metric definition when they add a metric, a coverage
  claim when they add a parser, and a decision revision when they write a
  judgement; the validators reject unknown keys so contract growth is
  reviewed.

## Verification

Locally with synthetic data only: `mise run domain:typecheck` and `bun test` in
`packages/domain` (SYN01–SYN24 and per-module unit tests),
`mise run ci:domain`, `mise run ci:root`, and
repository lint via `hk`. No production data, D1 or Workers were involved.
