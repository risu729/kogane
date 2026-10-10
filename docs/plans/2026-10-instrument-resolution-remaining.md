# Plan: finish instrument resolution after anchor pinning and recorded history

- Status: proposed; implementation/test plan, not shipped behavior.
- Written: 2026-10-09, baseline `ba775d914b3d3a54c489719a93823ab743db19f4`.
- Issue: #546 remains open; #629 delivers only candidate anchor protection
  and grant-graded UI history.
- Design: [ADR 0055 effective-identity proposal](../adr/0055-instrument-candidates.md#design-proposal-2026-10-09-evidence-backed-effective-identity).
- No new login, collection, provider registration, production query,
  grant, secret, schema, deployment or financial policy is made by this
  document. Repository metadata was read; raw/provider bodies were not.

## Pure selector implementation boundary (2026-10-09)

The additive `selectInstrumentTemporal` domain module now implements the
supplied-snapshot selector/manifest with synthetic tests. The scenarios below
remain the full acceptance matrix. The original selector slice supplied only
pure malformed-member and input-preservation checks for B14/B15/B16/B20;
the local journal and refusal slices below add their bounded coverage. B21 checks
only unsupported reference/basis refusal; listing, quote units, currency and
exact quantity adapters remain pending. The additive journal leaves all
current-view SQL unchanged. Real second-source evidence, a registered temporal
command, transport and financial consumer gates remain open. See the
[implementation amendment](../adr/0055-instrument-candidates.md#amendment-2026-10-09-pure-temporal-selector).

## Local journal primitive slice (2026-10-10)

CORE 0079 and `storage-d1/src/core/instrument-temporal.ts` now provide sealed
journal members, a typed mutation-write builder and a bounded coherent loader.
Local SQLite/native D1 tests cover the common receipt/approval batch, racing
reservations, rollback for missing membership/seal, nondecreasing global clock,
legacy preservation and refusal instead of mixed reads. This is partial
B15/B16/B17/B20 coverage, not a registered temporal command or production proof.
The next slice must add a closed payload and common planner that validates
immutable temporal provenance, binds all series/legacy revisions and produces
the actual decision/audit in the same batch. Shared guarded transport and
financial consumers remain later gates. Do not bypass the separately reviewed
B14 temporal-to-current refusal or reinterpret a current mapping command.

## B14 refusal slice and the next storage connection (2026-10-10)

The selector now returns an additive labelled `contextRef`, and common
commands refuse explicit temporal provenance rather than applying a current
assignment/release/relation. The Processor no longer defaults a malformed
explicit context to current. This proves only a refusal path, not the
positive prepare/simulate/approve/commit requirements in B14.
No journal, temporal writer, migration, loader, temporal transport or
price/quantity/cost consumer is delivered by the B14 refusal slice itself.
The local journal primitive slice above now provides the additive journal
and bounded loader in items 1 and 3 below; their common-command integration
and transport/consumer gates remain open. Both slices are combined locally,
with no positive temporal command enabled.

The complete connection still requires these concrete ports:

1. **Additive CORE journal and sealed membership.** Reuse `core_source_revision`
   epoch identity and the acceptance-order pattern from CORE 0070, not the
   common audit as a substitute journal. Allocate one sequence and
   nondecreasing server acceptance time for a complete mapping/relation
   bundle; enforce exact members and one successor per series. Preserve
   legacy rows without manufacturing interval or acceptance metadata.
   The local primitive uses 0079 after integration with main
   `f761630da082d879b331402127d898948792daf1`: CORE 0078 now belongs to
   maintenance change provenance. The B14 refusal slice itself reserves no
   number. Schema ledger/table classifications and the Processor lane
   migration pin include both migrations; recheck numbering before publication.
2. **Common command and atomic writer.** Add a closed temporal payload and
   planner to `packages/application/src/command/contract.ts` and
   `operations/targets.ts`, with explicit contract, interval bundle,
   expected set/member/series revision and server-verified context binding.
   Reuse `commit.ts`, storage `atomic/decision-commit.ts` receipt reservation,
   and Processor `changeMutationPlanners`; append the journal, versions,
   decision, receipt and existing common audit in the same guarded batch.
   The actor and prepared payload cannot supply accepted server time/sequence.
   A losing concurrent correction must leave no effect or approval consumption.
   Do not open the current command through a prefix exception.
3. **Coherent bounded loader.** Capture the common journal head once and load
   immutable complete membership/version rows through that sequence for
   `selectInstrumentTemporal`. Bound all rows before returning; concurrent
   append must yield the captured cut or refuse, never mixed series. Legacy
   coverage requires an equally coherent snapshot/revision check. Preserve
   current-view SQL and prove it unchanged; test B16/B17/B20 on real SQLite
   and the native Worker D1 path, not supplied-array tests alone.
4. **Shared service, transport and consumers.** Follow the grant-graded
   `readInstrumentHistoryForGrant` pattern, with exact request validation and
   common HTTP/MCP/UI service. Add no grant by configuration. Integrate #638/
   #641's delegated family, confirmation, audit and reversal checks rather
   than overwriting them; completed exact replay stays ahead of fresh-effect
   checks. Only a later independently reviewed consumer may use the manifest
   for listing/unit/price/quantity/cost; all missing semantics remain unknown.

Second-provider evidence is still limited to the inventory in section 4.
No new provider, login, acquisition or production financial write is needed
or authorized by these local implementation steps.

## 1. Shipped and remaining are distinct

#629 verifies candidate provenance in the shared planner, pins anchor and
subject mappings, refuses legacy subject-only candidate plans and exposes
the existing append-only history through a grant-graded service, UI route
and page. It does not pin the entire candidate evidence graph. It does not
make recorded history into effective-date identity, connect provider-local
holding/price keys to canonical mappings, or supply another broker's real
observations. Its synthetic tests are not production proof.

## 2. AI/HTTP/MCP recorded-history parity after common audit integration

Dependency: actual integration of #619's shared audit service with #629's
plan/approve/commit/worker changes, independently reviewed. The shared
audit catalogue must not be copied or bypassed. No product transport file
is changed while #619 is still independently modifying those entrypoints.

Proposed adapter: `kogane.instruments.history` through the existing agent
HTTP dispatch and MCP tool registration, calling only
`readInstrumentHistoryForGrant` with the caller's existing grant and D1
executor. One identifier per call, exact argument shape, no pagination or
partial result. Add its operation to the actual common audit catalogue
according to that catalogue's read-operation convention, not a parallel
audit writer. The UI continues to use the same application service.

Affected integration surfaces: `services/app/src/agent-service.ts`,
`services/app/src/mcp.ts`, agent API docs, their HTTP/MCP tests and the
common audit catalogue as integrated from #619. No new capability or
grant entry is needed: `records.read`, whole-store sources/accounts and
`maxRows` are the shipped service contract.

Verification matrix:

- HTTP, MCP and UI service return identical history and total for synthetic
  append-only mapping correction, rejection and relation sequences.
- Missing capability, source/account attenuation, unknown identifier and
  budget excess refuse before history content is read. A concurrent append
  after the indexed count cannot return an over-budget answer.
- Unknown/duplicate input keys, invalid identifier and an extra identifier
  refuse; MCP's declared schema matches runtime validation.
- Dedicated MCP Access principal and existing audience/subject guards stay
  intact; a body cannot select its own principal or grant.
- Audit success/refusal/failure paths use the integrated common service and
  contain only its permitted safe fields. No history text or amount leaks
  into audit output. Use #619's exact read-audit convention rather than
  inventing a per-read idempotency policy here.
- The command regression suite retains both mappings in the atomic batch,
  legacy candidate-plan rejection, idempotency and #619 audit receipt
  behavior. Fresh reviewer verifies the real integrated diff.

This slice needs no new financial-policy choice. It does not satisfy the
effective-time or second-provider acceptance criteria.

## 3. Effective-time contract tests proposed before schema work

All values, dates, identifiers and amounts below are synthetic. The tests
are a specification to review, not executable evidence already obtained.

| Case                     | Synthetic arrangement                                                                                                                  | Required outcome under the recommended contract                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 boundary              | A covers `[2099-01-01,2099-02-01)`, B starts on `2099-02-01`                                                                           | Jan 31 selects A; Feb 1 selects B exactly once                                                                                                                                                                                             |
| B2 absent validity       | Current mapping exists, no interval set                                                                                                | `validity_unknown`; never all-time A                                                                                                                                                                                                       |
| B3 explicit open end     | Owner states A from Jan 1 with explicit open end/evidence                                                                              | Future comparable dates select A; absent metadata cannot create this result                                                                                                                                                                |
| B4 overlap               | Two intervals overlap, same or different targets                                                                                       | Invalid set; no silent priority or deduplication                                                                                                                                                                                           |
| B5 reused code           | Same provider code, proved non-overlapping A then B                                                                                    | Separate products at their respective dates; code equality adopts nothing                                                                                                                                                                  |
| B6 correction            | V2 recorded later supersedes complete V1                                                                                               | Known-at before V2 selects V1; current selects V2; V1 rows stay unchanged                                                                                                                                                                  |
| B7 broken chain          | Missing predecessor, duplicate accepted successor, or cut cannot place record                                                          | Refused, no latest-id tie break                                                                                                                                                                                                            |
| B8 undated               | Fact lacks trusted effective role/time/zone                                                                                            | Unresolved, never substitute fetched or recorded time                                                                                                                                                                                      |
| B9 role mismatch         | Trade before boundary, settlement after boundary                                                                                       | Identity uses trade role; lot time-basis policy cannot remap it                                                                                                                                                                            |
| B10 relation             | Dated rejection covers only February; undated legacy rejection also exists                                                             | Dated decision applies only in February; undated decision does not prove all-time separation                                                                                                                                               |
| B11 contradiction        | Applicable accepted mapping and rejected relation conflict                                                                             | Refused with both evidence versions, not latest-write-wins                                                                                                                                                                                 |
| B12 retained result      | Retained manifest pins V1; V2 accepted later                                                                                           | Retained context unchanged; fresh current evaluation has new context                                                                                                                                                                       |
| B13 manifest determinism | Reorder identical requests/evidence; alter one decision version                                                                        | Same pinned inputs give same digest; changed version changes digest                                                                                                                                                                        |
| B14 command provenance   | Temporal context with omitted/tampered/stale set or other target                                                                       | Prepare/simulate/approve/commit refuse; cannot fall back to manual                                                                                                                                                                         |
| B15 atomic race          | Competing correction supersedes expected version just before batch                                                                     | No mapping, result, receipt, outbox or approval consumption from loser                                                                                                                                                                     |
| B16 migration            | Existing mapping and relation rows have no proved periods                                                                              | Counts/content unchanged; no fabricated interval rows or unbounded adoption                                                                                                                                                                |
| B17 common clock         | Accept initial versions for different identifiers and a relation with lagging clocks, plus same-millisecond successors                 | Atomic global sequence/known-at never regress; instant includes all same-time members; provisional re-resolution may advance, pinned sequence reproduces the old set; later higher time finalizes standing without changing its setVersion |
| B18 relation past cut    | Reject February before K, then correct/accept/release after K on the same directed pair                                                | Resolve relation version at K first; later periods/dispositions do not leak backward; release withdraws without resurrecting an older rejection; competing successors refuse                                                               |
| B19 legacy relations     | Relevant undated, dated without zone, ambiguous one-sided endpoints or unlogged acceptance; then an honest new version supersedes them | Legacy remains unresolved/unknown and unusable by price, quantity or cost; no generated zone/end convention/knowledge time; new version resolves only at its logged cut                                                                    |
| B20 coherent current     | Capture common head, then accept mapping/relation changes during successive loader reads                                               | All rows resolve at captured sequence or entire read refuses/retries; never a mixed mapping/relation manifest; missing batch member refuses                                                                                                |
| B21 basis adapter        | Midnight, differing zones, DST transition, collector-versus-provider basis, per-1/per-10 quote units, other listing and quote currency | Existing time/civil-date/exact-decimal helpers compare only declared bases; ambiguous or unconfirmed conversion/zone/listing/unit/currency refuses, never same-name or 1:1 fallback                                                        |

Before a query rewrite: preserve shipped SQL, compare frozen/differential
results on random and scaled stores, inspect indexed plans without table
statistics and refuse over explicit budgets, never truncate. If the new
selector is additive, explicitly prove the old current view remains
unchanged; do not claim equivalence between current and temporal semantics.
Migration work must classify new append-only tables in the schema ledger,
use the then-free migration number and update the lane migration pin.

## 4. Second-provider evidence inventory from repository metadata only

This is not a live registry/production audit. The checked-in registry
declares sources but does not establish enabled collection, live grants or
stored observations. The account inventory is a planning snapshot, not
proof of holdings. No raw object, original statement or amount was read.

- **SBI Securities:** the only implemented securities identity rule
  (`packages/identity/src/sbi.ts`). Existing positions/trades provide
  within-provider pairs, not a second broker.
- **SBI VC Trade:** explicit exchange asset codes and provider products
  stay separate (`packages/identity/src/other.ts`). Not a second securities
  broker; a product suffix or equal crypto ticker proves no underlying.
- **MoneyForward ME:** registered aggregator with retained account index,
  detail and monthly fragments documented in
  `docs/sources/moneyforward.md`. Index/detail are deliberately
  evidence-only in `packages/parsers/src/parsers/moneyforward.ts`; monthly
  JPY activity cannot establish a security identifier, class, quantity or
  second-broker listing. A mirror is not an independent broker source.
- **Rakuten:** the registered research scope is card/point/cash, explicitly
  excludes Rakuten Securities (`docs/sources/rakuten.md`). Its provider
  name must not be treated as evidence of a registered securities source.
- **Mercari family / Mercoin:** registered source and a planning inventory
  entry for BTC. Dated research documents monthly crypto reports and their
  identity/quantity/time shapes (`docs/sources/mercari-family.md`), but no
  Mercoin financial parser or identity rule is registered. This is the
  nearest existing-source candidate for a future second-exchange crypto
  experiment, not proof of a second broker or of available saved reports.

Recommendation: first finish temporal contracts and within-SBI provider-key
adapters with existing parser fixtures. For real cross-exchange evidence,
inspect only already retained Mercoin report metadata if a present,
explicitly authorized read surface exists; otherwise report that specific
missing surface/permission. Do not start a login or acquisition to fill
it. No unique supported second-securities-broker candidate is proved by
the repository. A broker-specific implementation would require an actually
observed dataset and rule; choosing a new provider is outside this inventory.

## 5. Price, quantity and cost: ordered consumers, no financial fallback

1. **Provider-key identity adapter (#546):** map the existing
   `instrument:<source>:<market>:<code>` holding/price base to the exact
   stored identifier with provenance. The source rule, market, code,
   share/product class and unit basis must be explicit. Ambiguous or
   missing links refuse. Synthetic fixtures cover within-SBI trade versus
   position keys without adopting their equality automatically.
2. **Temporal mapping/relation selector (#546):** reviewed interval-set
   decision and additive storage, then the pure selector/manifest and
   shared guarded command. This produces dated identity, not a valuation.
3. **Quantity and price adapter (#546 / ADR 0056):** join only under pinned
   identity and listing/unit evidence; keep exact decimal quantity and a
   declared price base (one share versus fund-unit convention). Equal
   product identity alone cannot substitute another listing's quote,
   currency or source. Preserve existing price-source/freshness/FX policy
   objects and require an explicit selection; no 1:1 or same-name fallback.
4. **Securities event writer (ADR 0054 / #556 dependency):** current CORE
   0070 refuses `security-quantity`, and the selected-event path has no
   adopted trade kind. A reviewed writer and selector release must supply
   consumption claims, typed quantity movements, independent trade and
   settlement roles, fees and consideration evidence, and seal pins. Raw
   broker rows cannot bypass this path.
5. **Lot/cost adapter integration (ADR 0051 / 0059):** connect dated mapping
   version to selected-revision seals only after the writer exists. The
   existing book is holder x instrument x explicit wrapper; method, time,
   fees, FX and rounding remain caller policies. No cross-broker pooling
   or tax conclusion is selected by this plan. A provider-reported cost
   never seeds verified lot cost. Missing history keeps unknown cost.

Parallel safe work is the history transport/audit slice and the pure
provider-key shape audit. Temporal semantics must precede any adapter that
can change historical product assignment. Real second-source evidence and
end-to-end price/quantity/cost proof remain separate acceptance gates;
passing these synthetic cases alone does not complete #546.
