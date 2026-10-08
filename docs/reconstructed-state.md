# Reconstructed state

What adopted events imply for an account's balances and holdings, folded from
a start snapshot and compared with what the provider reported at the end.
This is phase 11's first piece
([roadmap](roadmap.md#phases-8--11--dated-reported-and-reconstructed-state)),
decided in [ADR 0052](adr/0052-reconstructed-state-fold.md). It sits beside
[reported state on a date](reported-state.md) and never replaces it: the
reported figure and the reconstructed figure are two columns, and the
difference between them is shown, never absorbed.

**Today this is a pure engine only.** `packages/domain/src/reconstruction.ts`
computes it from inputs a caller supplies; there is no adapter over the stored
event rows, no query, no route and no page yet, so nothing in production
computes a reconstructed state.

| Piece     | Where                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Selector  | `selectKnowledge(set, { coreEpoch, commitSeq })`                         |
| Fold      | `reconstructState({ request, policy, start, end, selection, baseline })` |
| Late diff | `explainLate(baseline, now)`                                             |
| Manifest  | `canonicalReconstructionManifest(manifest)`, digested by the caller      |
| Policy    | `RECONSTRUCTION_FOLD_V1` (`reconstruction-fold-v1`), passed explicitly   |
| Tests     | `packages/domain/test/reconstruction.test.ts` (synthetic only)           |

## Inputs

- **Events**: `ProvisionalAdoptedEventSet`, contract
  `provisional-adopted-events-v1`. It is provisional: an adapter maps the
  stored rows onto it, and the #549/#550 hand-off contract replaces it. Each
  revision carries its `commitRef { coreEpoch, commitSeq }` (the history cursor of the
  common guard, ADR 0054 in preparation; null when none records it),
  `supersededBy`, typed times (`trade`, `settlement`, `posting`, `usage`,
  `value`), typed legs, `(book, key)` claims (`card-usage`, `cash-movement`,
  `security-quantity`), cited evidence ids and adapter flags. The set also
  carries family and history coverage per account and the versions the
  adapter read with. `resolution` says whether it holds full chains or a set
  the adapter already resolved at the cut. `recordedAt` (the stored
  `created_at`) is informational: it never selects or orders anything.
- **Start and end**: one reported side each (`StartSnapshot`, `EndReported`):
  balances with their metric id, measurement kind, sign meaning, decimal-v1
  value or its absence, snapshot ref and capture instant; positions with the
  instrument id (or none) and quantity; the requested accounts no reported
  container lists; the reported-state `contextId`.
- **Request**: accounts, start and end date, basis `cash`, `trade-date` or
  `settlement-date`, `knowledgeAt` and the cut it was resolved to.

Every validator rejects unknown keys. An input over 5,000 revisions or 20,000
legs is refused with `event_budget_exceeded`, a reported side over 5,000 rows
(balances and positions, counted per side) with `reported_budget_exceeded`,
over 1,000 family or history coverage rows with `coverage_budget_exceeded`;
nothing is cut to fit.

## Step 1: knowledge selection

`selectKnowledge` takes the whole chains and a cut. It selects the revisions
committed at or before the cut, resolves every event's active revision
(committed by the cut, no successor committed by it; supersession across
events included), and only then does the fold filter by range, account,
instrument, kind and leg. A date, account or instrument correction and a
dateless withdrawal therefore always decide which revision is active.

| Selection status     | When                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `active`             | Committed by the cut, no successor committed by it                                                      |
| `superseded_at_cut`  | Its successor was committed by the cut                                                                  |
| `recorded_after_cut` | Committed after the cut                                                                                 |
| `chain_inconsistent` | Two active revisions of one event, a cycle, a successor committed earlier, or a pointer the input lacks |
| `knowledge_unlogged` | No commit, or its successor has none: when it became known is not recorded                              |

Claim holders at the cut are the active revisions only; a `(book, key)` two
active events hold is listed in `duplicateClaims`.

## Steps 2–6: the fold

Cells are per (account, unit) and per (account, instrument). Each leg of a
cell gets exactly one disposition, decided in this order (the first rule
that matches):

| #   | Disposition (gap)                                                            | Rule                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `recorded_after_knowledge_time`, `superseded_at_knowledge_time`              | From the selection                                                                                                                                                                           |
| 2   | `other_basis`                                                                | The leg's basis is not the request's (cash → `cash-movement`, and so on); no fallback                                                                                                        |
| 3   | `knowledge_unlogged` (`knowledge_unlogged`)                                  | From the selection, whatever the date                                                                                                                                                        |
| 4   | `unknown_effect` (`revision_chain_inconsistent`)                             | From the selection, whatever the date                                                                                                                                                        |
| 5   | `identity_changed`, `alias_conflict`, `claim_conflict`, `writer_unsupported` | Adapter flags, whatever the date; also reach every requested cell the flagged revision's chain touched (its predecessors' legs, a legless withdrawal's included) and mark them `needsReview` |
| 6   | `unknown_effect` (`leg_effect_unknown`)                                      | A leg on the `unknown` basis: not even its time role is known                                                                                                                                |
| —   | —                                                                            | The leg is placed by the time of the basis's role (below)                                                                                                                                    |
| 7   | `correspondence_link`                                                        | A correspondence of a movement: never added                                                                                                                                                  |
| 8   | `breakdown_attribution`, or `unknown_effect` (`leg_sign_unknown`)            | A breakdown of a movement: never added; a negative one not outside the window is refused                                                                                                     |
| 9   | `state_no_effect`                                                            | `canceled`, `returned`, `unknown`                                                                                                                                                            |
| 10  | `outside_range`                                                              | Before the start capture or after the end capture                                                                                                                                            |
| 11  | `unknown_effect` (`leg_effect_unknown`)                                      | A state the policy does not map                                                                                                                                                              |
| 12  | `unknown_effect` (`leg_subject_unrecognized`)                                | A movement no account resolves                                                                                                                                                               |
| 13  | `unknown_effect` (`own_transfer_held`)                                       | Movements on two own accounts in one revision                                                                                                                                                |
| 14  | `unknown_effect` (`event_time_unknown`)                                      | No time to place it by                                                                                                                                                                       |
| 15  | `unknown_effect` (`leg_value_not_exact`)                                     | An inexact value                                                                                                                                                                             |
| 16  | `unknown_effect` (`leg_sign_unknown`)                                        | A negative value: the direction is the role, the value a magnitude                                                                                                                           |
| 17  | `boundary_same_day`                                                          | On a capture's boundary: a candidate, never adopted                                                                                                                                          |
| 18  | `applied`, `pending_shown_apart`                                             | `captured`/`debited`/`credited`/`confirmed`; `authorized`/`requested`/`in-transit`/`proposed`                                                                                                |

A movement no account resolves is classified against every requested cell of
its unit (with rule 12 in place of being counted) and recorded once, with its
most severe outcome in closed-code order; when no requested cell has its unit
it is classified against the requested range. Legs of no cell are recorded
once as `recorded_after_knowledge_time`, `superseded_at_knowledge_time`,
`other_basis` or `other_account`. A revision without legs gets one record:
`recorded_after_knowledge_time`, `superseded_at_knowledge_time`,
`knowledge_unlogged`, `unknown_effect` (an inconsistent chain, or an unmapped
state with `leg_effect_unknown`), its adapter flag, or `state_no_effect`.

Time is placed in Asia/Tokyo: capture instants (and event instants) are
rewritten with `+09:00` before `compareTemporal`, so a capture at `16:00Z`
belongs to the next Tokyo day. An event instant is ordered against a capture
instant exactly: before it is outside or in the start, after it is inside,
and only an equal instant is a boundary candidate. An event date on a
capture's Tokyo day is a boundary candidate; a period overlapping that day, a
date or period in another zone than Asia/Tokyo, an unknown time, no time of
the basis's role or two of them is `event_time_unknown`. The window runs from
the start capture to the end capture (a stale start capture counts the events
between its day and the start date; a stale end capture leaves the later
events outside); without a start it begins after the start date, without an
end it ends with the end date.

The start is one stock balance whose sign meaning is `asset-positive` or
`liability-positive` (negated, so every cell is asset-positive), or one
identified position. Otherwise the cell names why: `no_start_snapshot`,
`start_metric_not_stock`, `start_sign_unknown`, `start_ambiguous_metrics`,
`start_ambiguous_positions`, `start_value_not_exact`,
`instrument_not_identified`.

Each cell returns the start, the reconstructed figure (start plus applied
movements, exact, or absent with the first blocking reason), applied, pending
and boundary counts with exact totals kept apart, ignored counts by
disposition, unknown references, gap codes, the partition and `needsReview`.
Scope gaps (`family_not_evented`, `history_coverage_unknown`, `history_gap`)
keep the figure but make the partition `partial-verified-scope`; every other
gap makes it `not-computable`. Nothing is totalled across accounts:
`netWorth` is `"not-computed"`.

## Step 7: the explanation

| Status                               | When                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`                        | `no_reported_container`: a cell of an account no reported container lists                                                                                                  |
| `not_comparable`                     | `reported_end_missing`, `same_capture_as_start` (the end is the start capture read again), `snapshot_basis_unknown`, `reported_end_not_exact`, `reconstruction_incomplete` |
| `reconciled`                         | Complete cell, no boundary candidate, remainder zero                                                                                                                       |
| `consistent_with_boundary_exclusion` | Complete cell with boundary candidates, remainder zero                                                                                                                     |
| `consistent_with_boundary_inclusion` | Complete cell, remainder equal to the boundary candidates' total                                                                                                           |
| `difference_unexplained`             | Otherwise                                                                                                                                                                  |

`snapshot_basis_unknown` covers an end that is not one stock figure with a
known sign, a different metric from the start, an end captured before the
start, and every basis but cash: no container states which basis its figure
reflects (ADR 0004). The remainder `reported − reconstructed` is exact whenever
both are, an incomplete cell included, and is never written or absorbed. The
components shown beside it: late-recorded movements (`explainLate`, a diff of
the selection at the end capture's cut and at the asked cut, when the caller
supplies that baseline), pending movements and boundary candidates. Boundary
candidates are tried all in or all out; a subset is never tried, so start and
end candidates that only partly explain the remainder leave it
`difference_unexplained`.

## Step 8: the manifest

Schema `reconstructed-state-v1`, engine release, input contract, resolution,
policy ids, zone, basis, range, accounts, `knowledgeAt`, the cut and the
baseline cut, both reported context ids, event-set version, adapter release,
writers, identity, evidence-alias and coverage releases, the family and history
coverage rows in canonical order (so the id changes when coverage does), FX reference and
policy references. `canonicalReconstructionManifest` gives its canonical text
synchronously; `contextId = canonicalDigest(manifest)` is the caller's step.
Any input order gives the same output and the same id.

## Limits

- Cost: at the budget a fold takes about 0.45–0.8 s on `bun` locally, most of
  it re-checking each selection; not measured on workerd (ADR 0052).
- No read path: no adapter, query, route or page. The provisional input is
  not filled from the stored rows by anything yet.
- The input is provisional and is replaced by the hand-off contract; the
  questions it must answer are listed in ADR 0052.
- No stored revision has a commit sequence yet; until the common guard
  assigns one, the adapter cannot place today's rows at a cut.
- Card accounts have no reported container and their movements are on the
  purchase-recognition basis, so on the cash basis a card account produces no
  cell at all: its purchases are listed as `other_basis` and its account row
  shows no start or end container. Bank accounts' only events are reviewed
  card settlements, so their families are not evented.
- No parser emits transaction-history coverage, so every family's history
  coverage is `unknown`: no real account can be `complete` today.
- Own transfers are held, never applied; trade and settlement bases are never
  compared with a provider figure.
