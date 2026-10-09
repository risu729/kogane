# Reconstructed state

What adopted events imply for an account's balances and holdings, folded from
a start snapshot and compared with what the provider reported at the end.
This is phase 11's first piece
([roadmap](roadmap.md#phases-8--11--dated-reported-and-reconstructed-state)),
decided in [ADR 0052](adr/0052-reconstructed-state-fold.md). It sits beside
[reported state on a date](reported-state.md) and never replaces it: the
reported figure and the reconstructed figure are two columns, and the
difference between them is shown, never absorbed.

`packages/domain/src/reconstruction.ts` folds; the knowledge selector
([ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md)) reads
the stored event rows at a cut of the economic commit log, the B adapter turns
its selection into the fold's input, and `queryReconstructedState` composes
them for one account, one range, on the cash basis. One application service,
`readReconstructedState`, serves it as `GET /api/v2/reconstructed-state`, as
the agent tool `kogane.reconstructed-state.read` and through the
`残高の再構成` page (`/reconstruction`); see
[below](#http-agent-tool-and-page). It is computed per request and never
stored.

| Piece             | Where                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge, SQL    | `packages/read-model/src/economic-selector.ts`: `loadSelectorRows`, `resolveSelectorCut`                                                                                                                                         |
| Knowledge, pure   | `packages/domain/src/knowledge-selector.ts`: `selectAdopted(input)`                                                                                                                                                              |
| B adapter         | `packages/domain/src/reconstruction-adapter.ts`: `adaptSelection`, `explainLateSelections`                                                                                                                                       |
| Fold's own step 1 | `selectKnowledge(set, { coreEpoch, commitSeq })`                                                                                                                                                                                 |
| Fold              | `reconstructState({ request, policy, start, end, selection, baseline })`                                                                                                                                                         |
| Late diff         | `explainLate(baseline, now)`                                                                                                                                                                                                     |
| Manifest          | `canonicalReconstructionManifest(manifest)`, digested by the caller                                                                                                                                                              |
| Policy            | `RECONSTRUCTION_FOLD_V1` (`reconstruction-fold-v1`), passed explicitly                                                                                                                                                           |
| Query             | `packages/application/src/query/reconstructed-state.ts`: `queryReconstructedState(sql, input)`                                                                                                                                   |
| Service           | `packages/application/src/query/reconstructed-state-read.ts`: `readReconstructedState({ grant, sql, body, now })`, `reconstructedStateBodyFromQuery`                                                                             |
| Route, tool       | `services/app/src/reconstructed-state-api.ts` (`GET /api/v2/reconstructed-state`), `kogane.reconstructed-state.read` (`src/agent-service.ts`, `src/mcp.ts`)                                                                      |
| Wire contract     | `packages/observation-shared/src/reconstructed-state-contract.ts`: `validReconstructedState`                                                                                                                                     |
| Page              | `apps/web/src/pages/ReconstructedState.tsx` (`/reconstruction`)                                                                                                                                                                  |
| Tests             | `packages/domain/test/{reconstruction,knowledge-selector,reconstruction-adapter}.test.ts`, `packages/read-model/test/economic-selector*.test.ts`, `packages/application/test/reconstructed-state-query.test.ts` (synthetic only) |

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

## Reading the stored rows: the knowledge selector and the B adapter

[ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md) decides
this; the summary:

- **Cut.** `{coreEpoch, commitSeq}`, or `{coreEpoch, instant}` resolved in SQL
  to the largest sequence whose `known_at` is at or before the instant
  (floored to milliseconds; every commit of an equal instant included).
  Sequence 0 is before the first commit. A sequence past the log's end and a
  cut of another core epoch are refused. The query's default is the latest
  commit of the current epoch.
- **Load.** Every event whose legs name the account as `account:<id>` or as
  the bare id, closed under supersession (both ways, across event ids) and
  under claim holders (the same key or alias class), with all their legs,
  claims (legacy purchase keys and accepted settlements through
  `economic_revision_claims`), times, effects, seals and commits; bounded and
  refused past its bounds, every statement by key.
- **Resolution, before any filter.** A revision is known at the cut when its
  seal's commit is at or before it, and superseded at the cut when such a
  commit declares it in `supersedes`, or when its stored pointer names an
  unlogged revision that is so superseded or replaced (a pre-log chain ends at
  the logged correction of its last revision; a pointer to a logged revision
  that never declared it is `chain_inconsistent`, never history). An event is `active` (one revision in
  force), `knowledge_unlogged` (an in-force revision without a commit, written
  before the log or by an older build, or pointing at one), or
  `chain_inconsistent`. Only then is the scope applied, through every leg a
  revision reaches by its supersessions, so a corrected date or account never
  revives the old revision.
- **What it reports.** Holders at the cut from the selected claims, conflicts
  of a key or alias class (never resolved), `identity_changed` (a seal under
  another identity epoch or with a moved or unreadable pin; the holder kept),
  unsupported shapes, unlogged entries, and the log's coverage of the cut
  (`logged`, `partial`, `indeterminate`). Its set version digests every
  selected row in its at-cut form (not how the cut was asked), so a later
  commit leaves an earlier sequence's answer and version unchanged; an instant
  at or after the log's last `known_at` is marked `provisional`.
- **B adapter.** A `resolved-at-cut` input: leg effects from
  `economic_leg_effects` (a legacy fee or unresolved leg is a correspondence of
  its revision's one movement on another basis, otherwise
  `writer_unsupported`), times from `economic_event_times` only (the 0032
  effective time is not read), claim keys digested, the selector's dispositions
  as fold flags or revisions without a commit, and no coverage declared
  (`coverage-producer-none-v1`).

## The query

`queryReconstructedState(sql, { account, from, to, basis, cut, now })`:
one account, at most 366 days ending no later than the caller's date, `cash`
only. It answers `unavailable` without CORE 0070 (`economic_guard_missing`)
or for an account no reported container lists (`no_reported_container`), then
by precedence `indeterminate` (`log_empty`, `cut_before_log_start`,
`knowledge_unlogged`, `snapshot_boundary_unknown`), `needs_review`
(`identity_changed`, `claim_conflict`, `alias_conflict`,
`revision_chain_inconsistent`, `writer_unsupported`, `revision_left_out`),
`incomplete` (every other cell gap, `nothing_to_reconstruct`,
`positions_not_folded`) or `complete`, listing every reason. It returns the
cut, the selector's diagnostics, both reported context ids, the fold's state,
the late part (at the cut of the end capture, when the account's end balances
share one capture), and an outer manifest pinning the releases, the cut, the
set version, the identity epoch and pins, alias rule versions, the coverage
producer, both snapshot contexts and the fold manifest's digest, with its
`contextId`.

## HTTP, agent tool and page

`GET /api/v2/reconstructed-state?account=…&from=YYYY-MM-DD&to=YYYY-MM-DD`
with optional `basis=cash`, a cut (`coreEpoch` with exactly one of
`commitSeq`, at least 1, or `instant`, a UTC instant) and `setVersion` (the
set version the answer must still have). GET and HEAD only, under the reader
authority every signed-in subject has over the GET routes, like
`/api/v2/reported-state`; no new authentication. It exists, and `/api/meta`
advertises `reconstructedStateOnDate`, exactly where the reported state's
views exist (`404` elsewhere); without CORE 0070 it answers `200` with
`unavailable` (`economic_guard_missing`) and nothing computed. The answer is
`{ apiVersion: 2, ...queryReconstructedState(...) }`.

Refusals, one closed code each (the same codes the agent tool carries as
`refusal:<code>`, [agent API](agent-api.md#reconstructed-state)):

| Status | Code                                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_query`, `scope_unsupported` (several accounts, an instrument), `invalid_account`, `invalid_date`, `invalid_range`, `range_too_long` (over 366 days), `range_in_future` (after today in Tokyo), `basis_unsupported`, `invalid_cut`, `cut_in_future`, `cut_after_log_end` |
| 404    | `unknown_account` (no `accounts` row)                                                                                                                                                                                                                                            |
| 409    | `cut_epoch_not_current`, `set_version_changed`                                                                                                                                                                                                                                   |
| 413    | `result_limit_exceeded`: a selector, fold or reported-state bound, refused rather than cut                                                                                                                                                                                       |

The page `残高の再構成` (`/reconstruction`, shown while the capability is)
asks for one account (the accounts reported on the end date are offered), a
range and a cut (latest, a sequence or an instant). Per currency it shows the
start's reported balance, the reconstructed balance, the end's reported
balance and the difference `reported − reconstructed` with the fold's
explanation status and reason, the applied, pending, same-day and
late-recorded components and the cell's gaps; then the status and every
reason, the knowledge used (requested and resolved cut, `known_at`,
`final` or `provisional`, set version, identity epoch, log coverage, the
selector's unlogged, inconsistent, identity, conflict and unsupported
entries), the late part and each leg's disposition. Every code is shown
beside its words. A difference is shown as a difference, never as an
adjustment or a zero; an absent figure is shown with its reason; a refusal is
shown with its code. A pin button re-asks the resolved sequence. The page
writes, adopts and approves nothing, and shows no valuation.

## Step 1: knowledge selection

This is the fold's own step 1. Stored rows reach it already resolved
(`resolved-at-cut`, above), so for them it only checks that no event has two
committed revisions. With full chains, `selectKnowledge` takes the whole
chains and a cut. It selects the revisions
committed at or before the cut, resolves every event's active revision
(committed by the cut, no successor committed by it; supersession across
events included), and only then does the fold filter by range, account,
instrument, kind and leg. A date, account or instrument correction and a
dateless withdrawal therefore always decide which revision is active.

| Selection status     | When                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`             | Committed by the cut, no successor committed by it                                                                                                              |
| `superseded_at_cut`  | Its successor was committed by the cut                                                                                                                          |
| `recorded_after_cut` | Committed after the cut                                                                                                                                         |
| `chain_inconsistent` | Two active revisions of one event, a cycle, a successor committed earlier, or a pointer the input lacks                                                         |
| `knowledge_unlogged` | No commit, a commit of another epoch, or a successor without one: when it became known is not recorded in this history; every revision of the event is affected |

Claim holders at the cut are the active revisions only; a `(book, key)` two
active events hold is listed in `duplicateClaims`.

## Steps 2–6: the fold

Cells are per (account, unit) and per (account, instrument). Each leg of a
cell gets exactly one disposition, decided in this order (the first rule
that matches):

| #   | Disposition (gap)                                                            | Rule                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `recorded_after_knowledge_time`, `superseded_at_knowledge_time`              | From the selection                                                                                                                                                                                                       |
| 2   | `other_basis`                                                                | The leg's basis is not the request's (cash → `cash-movement`, and so on); no fallback                                                                                                                                    |
| 3   | `knowledge_unlogged` (`knowledge_unlogged`)                                  | From the selection, whatever the date                                                                                                                                                                                    |
| 4   | `unknown_effect` (`revision_chain_inconsistent`)                             | From the selection, whatever the date                                                                                                                                                                                    |
| 5   | `identity_changed`, `alias_conflict`, `claim_conflict`, `writer_unsupported` | Adapter flags, whatever the date; also reach every requested cell the flagged revision's chain touched (the legs of its predecessors superseded by the cut, a legless withdrawal's included) and mark them `needsReview` |
| 6   | `unknown_effect` (`leg_effect_unknown`)                                      | A leg on the `unknown` basis: not even its time role is known                                                                                                                                                            |
| —   | —                                                                            | The leg is placed by the time of the basis's role (below)                                                                                                                                                                |
| 7   | `correspondence_link`                                                        | A correspondence of a movement: never added                                                                                                                                                                              |
| 8   | `state_no_effect`                                                            | `canceled`, `returned`, `unknown`                                                                                                                                                                                        |
| 9   | `breakdown_attribution`, or `unknown_effect` (`leg_sign_unknown`)            | A breakdown of a movement: never added; a negative one not outside the window is refused                                                                                                                                 |
| 10  | `outside_range`                                                              | Before the start capture or after the end capture                                                                                                                                                                        |
| 11  | `unknown_effect` (`leg_effect_unknown`)                                      | A state the policy does not map                                                                                                                                                                                          |
| 12  | `unknown_effect` (`leg_subject_unrecognized`)                                | A movement no account resolves                                                                                                                                                                                           |
| 13  | `unknown_effect` (`own_transfer_held`)                                       | Movements on two own accounts in one revision                                                                                                                                                                            |
| 14  | `unknown_effect` (`event_time_unknown`)                                      | No time to place it by                                                                                                                                                                                                   |
| 15  | `unknown_effect` (`leg_value_not_exact`)                                     | An inexact value                                                                                                                                                                                                         |
| 16  | `unknown_effect` (`leg_sign_unknown`)                                        | A negative value: the direction is the role, the value a magnitude                                                                                                                                                       |
| 17  | `boundary_same_day`                                                          | On a capture's boundary: a candidate, never adopted                                                                                                                                                                      |
| 18  | `applied`, `pending_shown_apart`                                             | `captured`/`debited`/`credited`/`confirmed`; `authorized`/`requested`/`in-transit`/`proposed`                                                                                                                            |

A movement no account resolves is classified against every requested cell of
its unit (with rule 12 in place of being counted) and recorded once, with its
most severe outcome in closed-code order; when no requested cell has its unit
it is classified against the requested range. In each cell of its unit its
outcome adds to the ignored counts (counts only, never a total), so one such
leg can be counted in several cells. Legs of no cell are recorded
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

- Cost: at the budget a fold takes about 0.45–0.72 s on `bun` locally without
  a baseline and 0.92–1.38 s with one, most of it re-checking each selection;
  not measured on workerd (ADR 0052).
- Knowledge, chain and adapter-flag blocks apply whatever the date: a flagged
  chain dated outside the window still blocks the cell, and a flagged leg no
  account resolves blocks every requested cell of its unit.
- Route cost: one answer for an account with 1,500 settlements (4,500
  revisions) on the statement-scale store took about 1.1–2.0 s on
  `bun:sqlite` (ADR 0058, amendment of 2026-10-09); not measured on workerd or
  D1, and not checked against Workers' CPU limit.
- The page and the route answer one account and a range; an instrument
  quantity is never folded (positions are counted), and no valuation is shown.
- The input is provisional. Of ADR 0052's held questions, 2 and 8 are
  answered, 1 mostly and 5 partly; 4, 7 and 10 are narrowed but still held,
  and 3, 6, 9 and 11 are held as written (ADR 0052, amendment).
- Revisions written before the guard (G1b) have no commit. While one is in
  force at the cut (no logged revision superseded it, directly or through a
  pre-log chain), the account is `indeterminate` (`knowledge_unlogged`); one
  a logged correction replaced is history.
- An instant cut at or after the log's last `known_at` is `provisional`: a
  later commit from a lagging worker clock can still resolve it to a later
  sequence. The resolved sequence reproduces the answer.
- The load is whole-history: an account touching more than 2,000 events is
  refused at every range.
- Neither writer writes event times, so a settlement's cash leg has no
  `posting` time and is `event_time_unknown`: a bank account's cell has no
  figure while a settlement touches it.
- Card accounts have no reported container and their movements are on the
  purchase-recognition basis, so on the cash basis a card account produces no
  cell at all: the query answers `unavailable` (`no_reported_container`), its
  purchases listed as `other_basis`. Bank accounts' only events are reviewed
  card settlements, so their families are not evented.
- No producer states family or history coverage (`coverage-producer-none-v1`),
  so no real account can be `complete` today.
- Positions carry provider text only and are counted, never folded; only the
  cash basis and one account are answered.
- Selection cost: one load reads the whole history of every touched event;
  measured once on `bun` locally (not asserted), 1,500 events with 4,500
  revisions loaded in 63–76 ms and selected in 198–257 ms; not measured on
  workerd or D1 (ADR 0058).
- Own transfers are held, never applied; trade and settlement bases are never
  compared with a provider figure.
