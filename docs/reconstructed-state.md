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
legs is refused with `event_budget_exceeded`, over 5,000 reported rows with
`reported_budget_exceeded`; nothing is cut to fit.

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
cell gets exactly one disposition, decided in this order:

| Disposition                                                                  | Rule                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recorded_after_knowledge_time`, `superseded_at_knowledge_time`              | From the selection                                                                                                                                                                                                                                                                               |
| `other_basis`                                                                | The leg's basis is not the request's (cash → `cash-movement`, and so on); no fallback                                                                                                                                                                                                            |
| `knowledge_unlogged`                                                         | From the selection; blocks the figure                                                                                                                                                                                                                                                            |
| `unknown_effect` (`revision_chain_inconsistent`)                             | From the selection; blocks the figure                                                                                                                                                                                                                                                            |
| `identity_changed`, `alias_conflict`, `claim_conflict`, `writer_unsupported` | Adapter flags; block the figure and mark the cell `needsReview`, together with every requested cell the flagged revision's chain touched (its predecessors' legs, a legless withdrawal's included)                                                                                               |
| `breakdown_attribution`, `correspondence_link`                               | A breakdown or correspondence of a movement: never added                                                                                                                                                                                                                                         |
| `state_no_effect`                                                            | `canceled`, `returned`, `unknown`                                                                                                                                                                                                                                                                |
| `unknown_effect`                                                             | A state the policy does not map or a leg on the `unknown` basis (`leg_effect_unknown`), movements on two own accounts (`own_transfer_held`), no time of the basis's role (`event_time_unknown`), an inexact value (`leg_value_not_exact`), a negative movement or breakdown (`leg_sign_unknown`) |
| `outside_range`                                                              | Before the start capture or after the end capture                                                                                                                                                                                                                                                |
| `boundary_same_day`                                                          | On a capture's Tokyo day: a candidate, never adopted                                                                                                                                                                                                                                             |
| `applied`, `pending_shown_apart`                                             | `captured`/`debited`/`credited`/`confirmed`; `authorized`/`requested`/`in-transit`/`proposed`                                                                                                                                                                                                    |

Legs outside every cell are recorded once as `other_basis`, `other_account`
or, for a movement no account resolves, `unknown_effect` with
`leg_subject_unrecognized` on every requested cell of its unit.

Time is placed in Asia/Tokyo: capture instants are rewritten with `+09:00`
before `compareTemporal`, so a capture at `16:00Z` belongs to the next Tokyo
day. The window runs from the start capture to the end capture (a stale start
capture counts the events between its day and the start date); without a
start it begins after the start date, without an end it ends with the end
date.

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

| Status                               | When                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `unavailable`                        | `no_reported_container`: the account has no reported container (card accounts)                          |
| `not_comparable`                     | `reported_end_missing`, `snapshot_basis_unknown`, `reported_end_not_exact`, `reconstruction_incomplete` |
| `reconciled`                         | Complete cell, no boundary candidate, remainder zero                                                    |
| `consistent_with_boundary_exclusion` | Complete cell with boundary candidates, remainder zero                                                  |
| `consistent_with_boundary_inclusion` | Complete cell, remainder equal to the boundary candidates' total                                        |
| `difference_unexplained`             | Otherwise                                                                                               |

`snapshot_basis_unknown` covers an end that is not one stock figure with a
known sign, a different metric from the start, an end captured before the
start, and every basis but cash: no container states which basis its figure
reflects (ADR 0004). The remainder `reported − reconstructed` is exact whenever
both are, an incomplete cell included, and is never written or absorbed. The
components shown beside it: late-recorded movements (`explainLate`, a diff of
the selection at the end capture's cut and at the asked cut, when the caller
supplies that baseline), pending movements and boundary candidates.

## Step 8: the manifest

Schema `reconstructed-state-v1`, engine release, input contract, resolution,
policy ids, zone, basis, range, accounts, `knowledgeAt`, the cut and the
baseline cut, both reported context ids, event-set version, adapter release,
writers, identity, evidence-alias and coverage releases, FX reference and
policy references. `canonicalReconstructionManifest` gives its canonical text
synchronously; `contextId = canonicalDigest(manifest)` is the caller's step.
Any input order gives the same output and the same id.

## Limits

- No read path: no adapter, query, route or page. The provisional input is
  not filled from the stored rows by anything yet.
- The input is provisional and is replaced by the hand-off contract; the
  questions it must answer are listed in ADR 0052.
- No stored revision has a commit sequence yet; until the common guard
  assigns one, the adapter cannot place today's rows at a cut.
- Card accounts have no reported container, so their reconstruction is
  `unavailable`; bank accounts' only events are reviewed card settlements, so
  their families are not evented.
- No parser emits transaction-history coverage, so every family's history
  coverage is `unknown`: no real account can be `complete` today.
- Own transfers are held, never applied; trade and settlement bases are never
  compared with a provider figure.
