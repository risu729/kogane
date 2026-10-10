# ADR 0066: Current economic-row evidence readiness before event writers

- Status: proposed
- Date: 2026-10-10
- Issues: #549, #550, #556
- Scope: internal S0 query only; no transport, adoption, policy or writer activation

## Context

The economic-events/cost plan starts with evidence admission, not another lot
engine. A published transaction is not necessarily reusable, mapped, owned by
the operator, provider-identifiable or free of another live holder. Existing
own-transfer planners do not yet revalidate that complete chain. Securities
execution fingerprints do not become provider-issued identities when a person
confirms them. No principal-to-beneficial-owner-party contract is established.

## Options considered

1. Enable the own-transfer or securities writer first. Rejected: it would
   precede the missing evidence and ownership contracts.
2. Read each dependency separately and compare the source revision. Rejected:
   that revision does not cover every economic claim/revision change.
3. An internal bounded current diagnostic, with one coherent SQL statement and
   no writes. Chosen. Shared identity/ownership/alias semantics are reused.

## Decision

`queryEconomicRowReadiness` accepts exact keys `schema`, `family`, `rows`,
`knowledge`: schema `economic-row-readiness-v1`, family `bank-movement` or
`securities-execution`, current knowledge only, 1–64 distinct observation IDs
each with a positive safe-integer parse ID. Duplicate observations, even with
different parse IDs, are refused. No caller-supplied account, policy, origin,
owner, instrument, wrapper, FX or old context is accepted.

One SQL statement loads requested transaction/parse pairs, publication,
visibility, eligible sealed identity, current mappings, ownership, the
5-tuple consumption key and registry-derived alias, live key/alias holders,
and metadata. Missing rows remain explicit. Mapping count must be one and
status `identified`; ambiguous, aggregate, provider-local or unresolved
mapping is not a resolved ownership assertion. The existing keyed
`cardSettlementOwnershipCtes("transaction")` defines relation semantics.
Mapping explanation IDs and revision-key source-account IDs are kept distinct
inside the digest, never reinterpreted as command guards.

### Restrictions and data boundary

This query defines the following CORE0034 evidence-ref convention, in addition
to CORE's existing financial visibility views:

| Evidence    | Exact restriction ref          |
| ----------- | ------------------------------ |
| Transaction | `transaction:<observation-id>` |
| Parse       | `parse_run:<parse-run-id>`     |
| Artifact    | `artifact:<fetch-artifact-id>` |
| Capture     | `fetch_run:<fetch-run-id>`     |
| Raw object  | `raw:<sha256>`                 |

Any recorded `no-reuse`, `deleted` or `key-destroyed` restriction at any of
these refs blocks the row. `since` is recorded metadata, not permission to
reuse until a future clock. Restricted rows enter no payload-bearing safe CTE:
source account, external ID, extras, mapping/owner and holder derivation are
absent. Metadata necessary to find the restriction and pin visibility is
still read. No raw object is fetched. This is a local convention for this
query; it does not claim to retrofit unrelated read paths or restriction
writers. Future restriction writers and transport must use the convention.

Internal alias/provider components and relation refs are only diagnostic
inputs; output contains row refs, closed codes, counts and digests. No amount,
description, account label, raw key, party ref or provider text is returned or
logged. No diagnostic is a replayable report, writer receipt or SQL guard.

### Readiness and closed reasons

The existing `humanAdoptedRowIdentity` is the identity admission authority;
`providerAliasClassSql` is exported from the existing settlement read and
reused, not duplicated. Key validity uses `parseConsumptionKey`. Cash holder
checks include both economic claims and legacy accepted card settlements,
with each source reached by its key index; the UNION live view is not
materialized. Other books do not block the requested book.

Row readiness is `admitted | blocked | unavailable`, separately from identity
admission. **S0 currently returns no overall admitted rows**: even a unique
accepted beneficial-owner relation does not identify the operator's principal.
Such rows carry `ownership_unresolved` until S1 establishes that contract.
Provider-ID identity itself can be admitted; fingerprints cannot. This is an
intentional fail-closed refinement of the plan's positive bank example, not
an invented self-ownership rule.

Additional row reasons are `observation_missing`, `evidence_not_current`,
`evidence_restricted`, `evidence_unavailable`, `family_mismatch`,
`account_mapping_unresolved`, `account_mapping_ambiguous`,
`ownership_unresolved`, `economic_claim_held`, `alias_conflict`, and
`identity_key_invalid`, plus the existing identity admission refusal codes.
Missing rows or invisible evidence are unavailable; restrictions are blocked
before identity evaluation. Invalid input is a whole-query `invalid_request`.
Missing CORE dependencies/guard objects or a failed read is a whole-query
`readiness_store_unavailable`, with no exception text or partial results.

`proposalEnabled` and `writerEnabled` are always false. Securities separately
report unsupported book, selector and event vocabulary plus unknown class and
wrapper; the query does not infer direction, fees, cost or provider semantics.
History coverage remains unknown, including zero admitted rows.

### Coherent pins and context

The single SQL snapshot includes CORE epoch/source/visibility revisions,
current identity epoch and economic commit sequence, publication tuple,
current mapping rows/revisions, ownership relations and decision revisions,
restriction rows/codes and live holders. The application hashes private pins,
keys and aliases and then hashes the ordered safe manifest with evaluator
and registry versions. Input order is irrelevant. Publication rollback,
mapping/ownership revisions, restriction changes, claim acquisition/release
and identity epochs alter context. The global source and commit counters may
conservatively invalidate unrelated rows; they are not used as a substitute
for snapshot coherence. No clock invents an economic ordering or historical
knowledge cut.

No schema migration, transport/catalogue entry, report retention, operation
receipt, decision, proposal, claim or event writer is added. A future S0b
service must authorize row scope before reading. S1/S2 must independently
revalidate current restrictions, publication, mapping, ownership and holders
inside guarded command entry; this manifest cannot authorize a commit.

## Consequences

This makes missing evidence diagnosable without choosing a financial policy
or weakening existing admission. It deliberately does not complete #549,
#550 or #556 and does not depend on the unmerged #546 temporal journal.
Current store dependencies and restrictions are fail-closed. The caller must
not interpret `ok` as admission: it means the diagnostic itself completed.

## Verification

Synthetic domain tests cover exact input, security fingerprints, missing
identity/origin, mapping ambiguity and closed refusal codes. Application
tests use every CORE migration, confirm one read statement and whole-table
before/after equality, input-order determinism, missing pairs, stale and
rollback publication, mapping/owner changes, restrictions at all five levels,
claim acquisition/release and cross-producer aliases. Read-model tests compare
key/alias holders with `live_consumption_claims`, including actual legacy
settlement rows in random stores, and compare owner/alias semantics to the
existing helpers. A 4,000-unrelated-row fixture and statistics-free plans
check keyed reads without transaction/holder-history scans.

Not verified: remote D1 behavior/performance, production evidence, principal
ownership mapping, transport authorization or any financial writer activation.
