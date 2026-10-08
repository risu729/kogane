# ADR 0051: A pure lot engine over a provisional input contract

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issue: #556

## Context

Lots, acquisition history and disposal allocation are the step between
reported holdings and realized/unrealized P&L
([roadmap](../roadmap.md#current-position), phases 12 + 14). Before this
change the repository had only the gate: `costBasis()` in
[`calculation.ts`](../../packages/domain/src/calculation.ts) returns
`needs-policy` on every path and allocates nothing.

Three facts constrain what can be built now:

1. The hand-off from economic events and observations to the cost-basis
   layer is not decided. Which event kinds, states and legs become an
   acquisition, a disposal, a fee or a consideration; trade or settlement
   basis; how a revision is selected at a knowledge cutoff; how a book is
   keyed (holder, instrument, wrapper); and how duplicates are removed first
   are open questions for a common contract shared with the B-side work.
2. The evidence that exists is partial. Broker trade rows carry a date
   without a time, one settlement amount whose fee inclusion is not
   confirmed, and foreign rows without fee or FX fields. Provider position
   rows carry acquisition prices and costs, which are provider claims, not
   our cost ([calculation and reports §3](../calculation-and-reports.md#3-rounding-and-pl-attribution-are-versioned-inputs)).
   No own-account security transfer and no corporate-action dataset has been
   observed.
3. The allocation arithmetic itself does not depend on those answers: given
   an ordered list of acquisitions, disposals, splits and snapshots with
   exact amounts and an explicit policy, FIFO, moving average and specific
   identification are deterministic and testable with synthetic inputs.

## Options considered

- **No engine until the event contract is fixed.** Nothing to get wrong, but
  the allocation rules, their refusals and their exactness guarantees would
  be written in the same PR as the contract and the adapter, and reviewed
  together with them. The arithmetic is the part that can be settled now.
- **An engine over the raw event tables now.** It would encode answers to the
  open questions above (which leg is the consideration, what a same-day order
  is, how a revision is chosen) in SQL or adapter code without a decision,
  and would read fee and FX semantics nobody has confirmed (ADR 0004).
- **An engine over a provisional input contract (chosen).** A pure function
  takes inputs tagged `provisional-lot-input-v0` and an explicit policy. The
  contract carries only what allocation needs; producing it from evidence is
  the later, decided adapter's job.

## Decision

Add [`packages/domain/src/lots.ts`](../../packages/domain/src/lots.ts):
`computeLots(inputs, policy)`, pure, synchronous and deterministic.

- **Input.** Every `LotInput` carries `contract: "provisional-lot-input-v0"`,
  a pinned ref (`event:<id>@<revision>` or
  `<factKind>:<observation id>@parse_run:<n>[#<jsonPath>]`), a kind
  (`acquisition | disposal | split | snapshot | transfer`), the book key
  (`holderRef` `account:…`, `instrumentRef`, an opaque caller-supplied
  `wrapperKey`), the instrument class, the time on both bases
  (`{ trade, settlement }`), the quantity, the consideration (or null), the
  complete fee list, an optional input FX rate with its ref, a split ratio
  and specific-identification selections. Validators reject unknown keys.
- **Policy.** `LotPolicy` pins every choice; none has a default: purpose
  (`investment-analysis | tax`), method
  (`fifo | moving-average | specific-identification`), scope
  (`holder-instrument-wrapper`), time basis (`trade-date | settlement-date`),
  ordering rule (`temporal-then-indeterminate`, the only one), acquisition fee
  (`capitalize | exclude`), disposal fee (`reduce-proceeds | separate`), FX
  (`lot-currency | convert-at-input-rate`) with `fxPolicyRef` and, when
  converting, `costUnitRef`, and rounding (a `RoundingPolicy` at `leg` with
  `carry`, or null). A null policy is `policy_missing`; a `tax` purpose is
  refused `tax_rules_unverified` by calling the unchanged `costBasis()` gate.
- **Gates.** Whole-run refusals: `policy_missing`, `tax_rules_unverified`,
  `invalid_input`, `duplicate_ref` (one ref in one book twice, or in two
  books of the same instrument unless every occurrence is a transfer),
  `same_event_revisions` (two revisions of one event) and
  `same_observation_parse_runs` (one observation and JSON path under two
  parse runs). Per book:
  `unsupported_instrument` (only listed equity, fund units and crypto assets,
  long spot) and `transfer_contract_pending` (any transfer input).
- **Ordering.** Inputs are ordered by `compareTemporal` on the policy's basis.
  No id, ref, revision or recorded-at time ever decides an economic order.
  Two inputs the time does not order (same date, an instant inside a dated
  day, overlapping periods, conflicting zones) are `order_tie`, except
  same-time acquisitions under moving average and same-time disposals under
  moving average without rounding, which commute. An unknown time is
  `unknown_time` for the whole book.
- **Allocation.** Partial consumption takes `cost × q / Q` of the lot's
  remaining cost through `multiplyByRatio`. Without rounding an inexact share
  is `inexact_allocation`; with rounding each share is rounded and keeps its
  `RoundingInputs`, and the consumption that empties a lot takes the exact
  remainder, so allocated + remaining always equals what entered. Moving
  average keeps exact pool totals and never stores a unit price. A split
  scales quantities by its exact ratio, keeps cost and acquisition time, and
  is recorded in the lot's lineage; a ratio that does not scale exactly or
  disagrees with the stated post-split holding is
  `corporate_action_unsupported`.
- **Snapshots.** A snapshot with no earlier input in its book seeds a lot of
  unknown cost (`snapshot_only`); it never carries a cost, so a provider's
  stated acquisition cost is never seeded into a lot. A later snapshot is a
  check: disagreement is `snapshot_mismatch`.
- **Stops.** The first input that makes a book ambiguous or inconsistent
  (`negative_holding`, `order_tie`, `snapshot_mismatch`,
  `lot_selection_missing`, `unknown_lot`, `lot_selection_mismatch`,
  `inexact_allocation`, `value_not_exact`, `unit_mismatch` in a pool,
  `corporate_action_unsupported`) is `indeterminateFrom` (its refs; a group of
  inputs the time does not order is reported as a whole, decided on the
  group, never on ref order); later disposals are
  `upstream_indeterminate` and remaining lots are not reported. A disposal is
  never filled by a synthetic short, and a stale specific-identification
  selection is never reassigned to another lot.
- **Output.** Per book: disposals with allocations (lot, quantity, cost,
  acquisition fees, FX basis, rounding inputs), allocated cost or null,
  proceeds and disposal fees side by side, an outcome
  (`allocated | limited | indeterminate`) and closed reason codes; remaining
  lots with a `lineage` (origin ref, origin acquisition time, origin cost unit,
  `fragmentOf`, splits). A manifest of the sorted refs, the policy, the
  contract and the engine version is returned for the caller to digest with
  `canonicalDigest`. There is no realized gain and no tax conclusion.

## Consequences

- The event-to-lot mapping and own-account transfers stay held pending the
  hand-off contract decision. No adapter, writer, migration, route or UI
  exists; nothing in production calls this module.
- Provider-stated acquisition costs on snapshots remain claims. A holding
  known only from a snapshot keeps an unknown cost; a history gap filled
  later is simply a new run over new inputs, and the earlier result is not
  edited.
- Method, fee and FX treatment are explicit policy inputs, not defaults. A
  caller must choose them, and the manifest pins the choice.
- `costBasis()` is unchanged and still returns `needs-policy` for every
  request; a tax purpose cannot reach a number through this engine.
- `calculation_results` cannot hold the lot reason codes (its reason CHECK is
  the valuation list), so a retained lot result would be a later report
  purpose, not a row there.
- Same-date trades under FIFO or specific identification are order ties, and
  the observed date-only broker rows will therefore be indeterminate wherever
  two of them for one instrument fall on one day, until evidence or a decided
  rule orders them.

External advice relayed by the owner on 2026-10-08 was reviewed against the
code before this decision (external advice: adopted / changed / deferred):

| Advice                                                                                         | Status   | Where                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Pin method, scope, basis, ordering and FX version in the policy                                | Adopted  | `LotPolicy` fields with no defaults; a null policy is `policy_missing`                                                                 |
| Pin rounding scale, mode and residual; FIFO has a residual problem too                         | Changed  | `RoundingPolicy` pinned; only `leg` with `carry` is accepted, anything else is `invalid_input`; no rounding means `inexact_allocation` |
| Never derive economic order from UUIDs, ids or recorded-at                                     | Adopted  | `temporal-then-indeterminate` is the only rule; ties are `order_tie`                                                                   |
| Keep lot origin, original acquisition time, cost unit and fragment lineage                     | Adopted  | `lineage` reserved on every lot; transfers deferred to the common contract PR                                                          |
| Fee and FX treatment as explicit policy                                                        | Adopted  | `acquisitionFee`, `disposalFee`, `fx`, `fxPolicyRef`, `costUnitRef`                                                                    |
| Tax purpose refused without verified rules                                                     | Adopted  | `tax_rules_unverified` through the unchanged `costBasis()`                                                                             |
| No synthetic short; no automatic reassignment of a stale selection                             | Adopted  | `negative_holding`, `lot_selection_mismatch`, `unknown_lot`                                                                            |
| Unknown snapshot boundary is indeterminate; a filled gap is recomputed                         | Adopted  | `unknown_time` on the policy's basis; a new run over new inputs                                                                        |
| Adapter from the common knowledge selector; manifest pins of identity, coverage and FX sources | Deferred | A later PR; this manifest pins refs, policy, contract and engine version only                                                          |

## Verification

`packages/domain/test/lots.test.ts`, synthetic inputs only (invented
instrument, holder and wrapper ids, round numbers): each method's partial
disposal spanning lots with the exact check allocated + remaining = total;
100 / 3 refused without rounding and carried with half-even leg rounding;
acquisition fee modes, an empty fee list and `fee_unknown`; disposal fee
modes; FX lot-currency never summing USD and JPY, `convert-at-input-rate`
recording the rate ref, and `fx_rate_missing`; a split, a reverse split and
unsupported ratios; a snapshot-only lot giving a limited disposal with null
cost, a snapshot carrying cost refused, `snapshot_mismatch`, and an unknown
snapshot boundary; `negative_holding` then `upstream_indeterminate`;
missing, unknown, stale and mismatched selections; `duplicate_ref` and
`same_event_revisions`; same-date ties, moving-average commuting, `within_day`
and `unknown_time` under the chosen time basis; the gates (tax, null policy,
non-leg rounding, margin class, transfer); identical results and manifest
digests under input permutation; validators rejecting unknown keys. Not
verified: any real evidence, any adapter, D1, Workers or production data.
