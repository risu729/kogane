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
  `carry`, or null).
- **Gates.** Checked in this order, each refusing the whole run:
  `policy_missing` (no policy); `invalid_input` for a malformed policy;
  `policy_unsupported` for a well-formed rounding policy at another point or
  with another residual (largest-remainder needs every disposal up front,
  `leave` breaks conservation, `refuse` is what no rounding already does),
  checked before the tax gate; `tax_rules_unverified` for a `tax` purpose,
  decided by calling the unchanged `costBasis()` gate; `invalid_input` for
  inputs that are not a list, break the contract, or carry lot selections
  under FIFO or moving average (where they would be ignored);
  `duplicate_ref` (one ref twice in one book, or in two books of the same
  instrument unless every occurrence is a transfer); `same_event_revisions`
  (two revisions of one event); `same_observation_parse_runs` (one
  observation and JSON path under two parse runs; a re-parse that pins the
  same row under a different or null JSON path, or under a new observation
  id, is not caught). Per book: `unsupported_instrument` (only listed equity,
  fund units and crypto assets, long spot) and `transfer_contract_pending`
  (any transfer input).
- **Ordering.** Inputs are ordered by `compareTemporal` on the policy's basis.
  No id, ref, revision or recorded-at time ever decides an economic order.
  Inputs are laid out on one line and cut into groups so that every input of
  a later group is strictly after every input of every earlier group; an
  input joins the current group as soon as one earlier input is not strictly
  before it. Dates and periods sit at their civil days. Instants sit at their
  epoch in a book of instants only; in a book that also has dates or periods
  they sit at the start of their own calendar day (epoch + their own offset,
  the day `compareTemporal` uses against a date), and the instants of one day
  follow each other by epoch. Two instants are compared by epoch, two dates or
  periods by their day bounds, and an instant against a date or period by
  `compareTemporal`. A group of more than one input (same date, an instant
  inside a dated day, overlapping periods, two instants whose calendar-day
  and epoch orders disagree) is `order_tie`, except same-time acquisitions
  under moving average and same-time disposals under moving average without
  rounding, which commute. A cut after an input is allowed exactly when every
  later input is strictly after every earlier one; with one zone per book
  that holds when the latest epoch, instant calendar day and date or period
  end before the cut are below the earliest epoch, instant calendar day and
  date or period start after it, so the cut is decided from running extremes
  in constant time per input and no comparison window is involved. Two
  rules apply to the whole book: an unknown time is `unknown_time`, and dates
  or periods in two named zones, or an instant in another zone than the
  book's dates, are `order_tie` for every input, however far apart, because
  `compareTemporal` never orders a date against a date or instant in another
  named zone.
- **Allocation.** Partial consumption takes `cost × q / Q` of the lot's
  remaining cost through `multiplyByRatio`. Without rounding an inexact share
  is `inexact_allocation`; with rounding each share is rounded and keeps its
  `RoundingInputs`, and the consumption that empties a lot takes the exact
  remainder, so allocated + remaining always equals what entered; a rounded
  share that would exceed what is left or flip its sign is
  `inexact_allocation`. Moving average keeps exact pool totals and never
  stores a unit price. A split scales the remaining quantity of every lot
  still held by its exact ratio, keeps cost, acquisition time and the
  quantity as entered, and is recorded in the lot's lineage; consumed lots
  are left as they were. A ratio that does not scale a remainder exactly or
  disagrees with the stated post-split holding is
  `corporate_action_unsupported`.
- **Snapshots.** A snapshot with no earlier input in its book seeds a lot of
  unknown cost (`snapshot_only`); it never carries a cost, so a provider's
  stated acquisition cost is never seeded into a lot. A later snapshot is a
  check: disagreement is `snapshot_mismatch`. There is no separate
  `history_gap` reason: a gap between a history and a later snapshot surfaces
  as `snapshot_mismatch`, and a holding known only from a snapshot as
  `snapshot_only`.
- **Outcomes.** A disposal is `allocated` when every unit came from a lot and
  cost, acquisition fees, proceeds and disposal fees are all known. It is
  `limited` when every unit came from a lot but something is unknown or not
  summable; its reasons are only these closed codes
  (`LOT_LIMITED_REASON_CODES`): `unknown_cost`, `unknown_acquisition_fee`,
  `unknown_proceeds`, `unknown_disposal_fee`, `fx_rate_missing` and
  `unit_mismatch`. It is `indeterminate` when nothing was allocated.
- **Stops.** The first input, or group of inputs the time does not order,
  that makes a book ambiguous or inconsistent (`negative_holding`,
  `order_tie`, `unknown_time`, `snapshot_mismatch`, `lot_selection_missing`,
  `unknown_lot`, `lot_selection_mismatch`, `inexact_allocation`,
  `value_not_exact`, `unit_mismatch` in a pool,
  `corporate_action_unsupported`) is `indeterminateFrom` with all its refs; a
  group is judged as a whole, never by ref order. Later disposals are
  `upstream_indeterminate` and remaining lots are not reported. A disposal is
  never filled by a synthetic short, and a stale specific-identification
  selection is never reassigned to another lot.
- **Output.** Per book: disposals with allocations (lot, its acquisition ref
  or, for a moving-average pool, how many of the pool's members had joined,
  quantity, cost, acquisition fees, FX basis, rounding inputs), allocated
  cost or null, proceeds and disposal fees side by side, the outcome and its
  reason codes; the book's moving-average pools, each listed once with its
  members in join order (so output grows with the inputs, not with inputs ×
  disposals); remaining lots with a `lineage` (origin ref, origin acquisition
  time, origin cost unit, `fragmentOf`, splits). A lot's id is its
  acquisition's (or seeding snapshot's) ref text; a moving-average pool's is
  `pool:<first ref>`, the first acquisition or snapshot since the holding was
  last empty. A manifest of the contract, the engine version, the policy, the
  sorted refs and the validated inputs themselves (copied, sorted by book and
  ref) is returned for the caller to digest with `canonicalDigest`. The
  manifest therefore fixes the inputs: equal digests mean equal inputs,
  policy and engine, and so an equal result. `LOT_ENGINE_VERSION` is bumped
  on every change to an allocation rule so that this keeps holding across
  releases; this first merge keeps `lot-engine-v0`. There is no realized gain
  and no tax conclusion.

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
- The manifest holds amounts and quantities: it is a calculation input, not
  an operational record. A future writer stores it only as a report body
  (retention class `report`), never in a log line, tick record or lane state,
  which carry counts and closed codes only.
- Measured cost (Bun 1.4.2 in a development container, one book of
  synthetic inputs of 1 unit each, results not retained between runs). The
  densest case is moving-average fills one second apart inside a single day,
  alternating buy and sell, every input within a day of every other:
  20,000 fills 546 ms (488 ms with one dated acquisition two days earlier,
  which switches the layout to calendar days), 50,000 fills 1,022 ms
  (1,040 ms), 100,000 fills 2,291 ms (3,117 ms). Before the cut rule used
  running extremes, 20,000 and 50,000 such fills took 5.8 s and 45.5 s.
  Sparser books are cheaper: 5,000 daily inputs 160 ms FIFO and 149 ms moving
  average, 5,000 acquisitions on one date 73 ms and 85 ms, 20,000 daily
  inputs 466 ms FIFO, 20,000 daily moving-average inputs (two buys, one sell)
  about 0.4 s with 21.8 MB of output. Growth is close to linear in the number
  of inputs (a sort, then constant work per input and per allocation; output
  grows with the allocations), a little worse than linear at 100,000 inputs.
  Per-input work is not constant everywhere: a split visits every lot still
  held, and specific identification sorts each disposal's selections. No
  input budget is set; a caller feeding books well beyond 100,000 inputs
  should measure again.
- `calculation_results` cannot hold the lot reason codes (its reason CHECK is
  the valuation list), so a retained lot result would be a later report
  purpose, not a row there.
- Same-date trades under FIFO or specific identification are order ties, and
  the observed date-only broker rows will therefore be indeterminate wherever
  two of them for one instrument fall on one day, until evidence or a decided
  rule orders them.
- A snapshot dated the same day as a trade of its book is an order tie as
  well: a date-only position row cannot say whether it includes that day's
  trade. Every daily position row next to a same-day trade therefore stops
  its book unless the snapshot's boundary is stated more precisely.

External advice relayed by the owner on 2026-10-08 was reviewed against the
code before this decision (external advice: adopted / changed / deferred):

| Advice                                                                                         | Status                                     | Where                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin method, scope, basis, ordering and FX version in the policy                                | Adopted                                    | `LotPolicy` fields with no defaults; a null policy is `policy_missing`                                                                                      |
| Pin rounding scale, mode and residual; FIFO has a residual problem too                         | Changed                                    | `RoundingPolicy` pinned; only `leg` with `carry` is supported, any other well-formed policy is `policy_unsupported`; no rounding means `inexact_allocation` |
| Never derive economic order from UUIDs, ids or recorded-at                                     | Adopted                                    | `temporal-then-indeterminate` is the only rule; ties are `order_tie`                                                                                        |
| Keep lot origin, original acquisition time, cost unit and fragment lineage                     | Adopted (field); transfer lineage deferred | `lineage` reserved on every lot with splits recorded; `fragmentOf` stays null until the common contract PR decides transfers                                |
| Fee and FX treatment as explicit policy                                                        | Adopted                                    | `acquisitionFee`, `disposalFee`, `fx`, `fxPolicyRef`, `costUnitRef`                                                                                         |
| Tax purpose refused without verified rules                                                     | Adopted                                    | `tax_rules_unverified` through the unchanged `costBasis()`                                                                                                  |
| No synthetic short; no automatic reassignment of a stale selection                             | Adopted                                    | `negative_holding`, `lot_selection_mismatch`, `unknown_lot`                                                                                                 |
| Unknown snapshot boundary is indeterminate; a filled gap is recomputed                         | Adopted                                    | `unknown_time` on the policy's basis; a new run over new inputs                                                                                             |
| Adapter from the common knowledge selector; manifest pins of identity, coverage and FX sources | Deferred                                   | A later PR; this manifest pins the inputs, refs, policy, contract and engine version only                                                                   |

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
missing, unknown, stale and mismatched selections; `duplicate_ref` in one
book and across books of one instrument, the transfer exemption,
`same_event_revisions` and `same_observation_parse_runs`; same-date ties,
moving-average commuting, `within_day` and `unknown_time` under the chosen
time basis; closure grouping (a dated acquisition beside same-day instants, a
period overlapping later inputs, instants with different offsets); the
whole-book zone rule and overlapping versus adjacent periods; group failures
reported as a whole whatever the ref names; an unknown excluded acquisition
fee kept limited; a rounded share that would overshoot refused; splits
skipping consumed lots; the gates (tax, null policy, `policy_unsupported` for
`leg`/`refuse`, `aggregate` and largest-remainder rounding, malformed
rounding as `invalid_input`, selections under FIFO and moving average, a
non-list input, margin class, transfer); identical results and manifest
digests under input permutation, and different digests for a different
input under the same ref; validators rejecting unknown keys; an evening
instant at a negative offset ordered before the next day's dated sale;
inputs about two days apart (instants at +14:00 and −12:00 three calendar
days apart, and two calendar days apart with inverted epochs, which tie;
dates against instants 47 to 49 hours away); moving-average pools listed once with
the number of members each allocation drew on; `unknown_disposal_fee`; every
limited outcome using only the six limited codes. Review scripts outside the
repository (input permutation, conservation over random histories, random
grouping against pairwise `compareTemporal`, and 60,000 random books giving
byte-identical results before and after the cut rule moved to running
extremes) found no unsound outcome. Not verified: any real evidence, any adapter, D1, Workers or production data.
