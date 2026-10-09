# ADR 0058: A knowledge selector reads adopted events at a commit-log cut, and a B adapter feeds the reconstruction fold

- Status: proposed (accepted when its pull request merges)
- Date: 2026-10-09
- Issue: #550 (指定日状態: 採用イベントから残高・保有数量を再構成する), the selector and B adapter slice
- Amends: [ADR 0052](0052-reconstructed-state-fold.md) (dated note there)
- Implements: [ADR 0054](0054-economic-consumption-guard.md), "Knowledge selector interface",
  "Typed movement", "Manifest pins", and acceptance tests B1–B6, B12, B13 (B side) and W11
- Carried by: `packages/domain/src/knowledge-selector.ts`,
  `packages/read-model/src/economic-selector.ts`,
  `packages/domain/src/reconstruction-adapter.ts`,
  `packages/application/src/query/reconstructed-state.ts`,
  [reconstructed state](../reconstructed-state.md)

## Context

[ADR 0052](0052-reconstructed-state-fold.md) built a pure fold over a
provisional input (`provisional-adopted-events-v1`) and left the adapter over
the stored rows, the query and the route to later pull requests.
[ADR 0054](0054-economic-consumption-guard.md) added the common consumption
guard (CORE 0070): claims, revision seals with identity pins and an identity
epoch, role-typed event times, typed leg effects, and a commit log whose dense
sequence orders knowledge. Since G1b (#589) both card writers seal every
revision they write and log one commit per batch. ADR 0054 fixed the
selector's interface (a cut by sequence or by instant, every touched event's
revision resolved at the cut before any filter, past holders from the selected
claims) and named this ADR as its owner.

What the stored rows are today, read from the code:

- The card purchase lane writes `account:<id>` leg subjects; the card
  settlement writer writes bare account ids (read under 0044's tolerance).
- Neither writer writes `economic_event_times` or `economic_leg_effects`. 0070
  says a time role without a row is unknown, "never the effective time of
  0032".
- Revisions written before G1b have no seal or commit
  (`unlogged_economic_revisions`); nothing backdates them.
- Seals pin no identity revision, only the identity epoch.
- No parser emits transaction-history coverage, and no producer of family or
  history coverage exists.
- Card accounts have no reported container; bank accounts have snapshots.

## Options considered

1. **Feed the fold its own full chains**, with each revision's `commitRef`
   taken from its seal. Rejected: the fold resolves supersession from the
   stored pointer, cannot read seals, epochs, pins or the commit log's
   `supersedes`, and marks every event with any revision outside the log as
   unlogged for ever, so every card purchase with pre-G1b history would stay
   unplaceable after it is re-revised under the guard.
2. **Read the current views (`live_consumption_claims`, `superseded_by IS
NULL`) and filter by creation time.** Rejected by ADR 0054 (item 6):
   `created_at` is a writer clock, and the views only say what is live now.
3. **Map the 0032 `effective_time_json` to a role per writer** (ADR 0052 held
   item 2 assumed settlements → `posting`). Rejected: 0070 forbids that
   fallback, and the assumption is no writer's declared meaning.
4. **A pure selector over loaded rows, a keyed SQL loader, and an adapter that
   hands the fold a set already resolved at the cut.** Chosen.

## Decision

### Cuts

A cut is `{coreEpoch, commitSeq}` or `{coreEpoch, instant}`. An instant is
floored to the stored `known_at` form (`YYYY-MM-DDTHH:MM:SS.sssZ`;
`canonicalCutInstant`) and resolved in SQL to the largest sequence whose
`known_at` is at or before it, every commit of an equal instant included
(`INSTANT_CUT_SQL`; the pure `resolveInstantCut` is its oracle). Sequence 0
is the cut before the first commit. A sequence past the log's last commit, or
a cut of another core epoch, is refused (`cut_after_log_end`,
`cut_epoch_not_current`). The query's default cut is the latest commit of the
current core epoch, or, for an empty log, the caller's `now` as an instant;
the requested and resolved cut and the resolved commit's `known_at` are
always echoed in the manifest.

### Loading (`economic-selector.ts`)

For the scope's accounts the loader reads, each statement by key: the events
whose legs name an account as `account:<id>` or as the bare id
(`economic_legs_subject`); then, until nothing is added, every revision of
those events, the events their `superseded_by` names and the events whose
revisions point at them (`economic_event_revisions_superseded_by`), their
claims through the 0070 view `economic_revision_claims` (legacy purchase keys
and accepted settlements included), and every other event holding one of
those (book, key) or (book, alias class) pairs, by each source's key index;
then the closure's legs, times, effects and seals, the commits the seals name,
the account each leg subject names (`accounts` by id; both forms of one
subject naming two accounts is unrecognized), the current identity epoch, and
the current revision of each pinned subject (`account_mapping:` and
`instrument_mapping:` as `REVISION_OF` answers them; any other prefix is not
read). The load is cut-independent: one load answers any cut of the epoch.
Bounds (`SELECTOR_BOUNDS`): 2,000 events, 5,000 revisions, 20,000 legs and
claims, 25,000 times, 20,000 effects, 5,000 commits and subjects, 1,000 pins;
past any of them the load is refused (`selector_bound_exceeded`), never cut.

### Resolution (`knowledge-selector.ts`, `selectAdopted`)

1. A revision is **visible** when its seal names a commit row in the cut's
   epoch at or before the cut that lists it as a member, **later** when that
   commit is after the cut, and **unlogged** otherwise: no seal or no commit
   (`no_commit`), or a commit of another core epoch (`other_core_epoch`).
2. A revision is **superseded at the cut** when a visible commit's member
   names it in `supersedes`. The stored pointer is checked against it
   (`supersession_pointer_mismatch`), as is the order of the two commits
   (`successor_committed_first`).
3. Per event, over every loaded revision and before any filter: the in-force
   revisions are those not superseded at the cut. The event is
   `chain_inconsistent` when the log and the stored rows disagree: a pointer
   or commit check of step 2 failed, a visible pointer names a visible
   revision no commit declared (`supersession_undeclared`), a seal's counts
   differ from the stored rows (`seal_count_mismatch`), a seal names a commit
   that does not list it (`seal_commit_mismatch`), a pointer or a superseded
   revision is missing, or two visible revisions are in force
   (`two_in_force_at_cut`, decided only when none of them is unlogged);
   otherwise `knowledge_unlogged` when an in-force revision is unlogged, or a
   visible one points at an unlogged successor (`successor_unlogged`);
   otherwise `active` with its one visible revision, or not in force at all.
   A pre-log revision a visible commit superseded is history, not unknown
   knowledge.
4. The selected revisions are fully loaded: legs with the resolved account,
   the subject form, the value (exact, or absent with the stored reason), role,
   basis and stored effect (`undeclared` without a row); times by role; claims;
   seal; commit; `supersedes`. A stored pointer to a revision recorded after
   the cut is not shown.
5. **Scope after resolution.** A revision is in scope when its kind matches
   and a leg it reaches (its own, or one of a revision it superseded by the
   cut, transitively) matches every given dimension: account, unit, effect,
   basis and a range read from one time role. An event is in scope when one of
   its selected revisions is. So an account correction keeps the new revision
   in the old account's scope (with its legs elsewhere), and the old revision
   never returns (B1).
6. **Holders and conflicts.** The holders at the cut are the claims of the
   selected revisions, never a current view. A (book, key) held by two events,
   or a (book, alias class) held under two (event, key) pairs, is a conflict,
   listed with every holder (in scope or not) and flagged on the in-scope
   holders (`claim_conflict`, `alias_conflict`); nothing resolves it.
7. **Identity.** A selected revision whose seal's identity epoch is not the
   current one, or whose pinned subject's current revision differs from the
   pin or cannot be read, is `identity_changed` (`identity_epoch_changed`,
   `identity_pin_moved`, `identity_pin_unreadable`); its claims stay listed.
8. **Unsupported.** A book no writer is admitted for, a key that is not a
   canonical consumption key, a time row that is not a temporal value, a leg
   value, role or basis outside the contract, an effect row that names no leg
   or names a target that does not move, a movement on a fee or unresolved
   leg, a kind, state or reason outside the contract, unreadable pins.
9. **Coverage.** `indeterminate` for an empty log (`log_empty`) or a cut
   before its first commit (`cut_before_log_start`); `partial` when an
   in-scope event is `knowledge_unlogged`; else `logged`. The log's first
   commit is reported; its last is not, because it moves with every later
   commit.
10. **Set version** is `sha256` of the canonical selection body: the cut,
    scope, current identity epoch and every selected row in its at-cut form.
    A row recorded after the cut is read but does not enter it, so a later
    commit leaves an earlier cut's set version and answer unchanged (B2); any
    order of the loaded rows gives the same version (B13).

All codes are closed lists in the module; every validator rejects unknown
keys; there is no clock.

### The B adapter (`reconstruction-adapter.ts`)

`adaptSelection` hands the fold a `resolved-at-cut` set: chain resolution is
the selector's, and the fold only checks that no event has two committed
revisions. Every selected revision is handed over: an active one with its
commit, the revisions of a `knowledge_unlogged` event (the unlogged ones with
no commit, so the fold holds their cells whatever their date), those of a
`chain_inconsistent` event with their commits.

- **Typed movement.** An effect row decides: `movement` (increase or
  decrease), `breakdown` of a movement in its unit, `correspondence` to a
  movement. A legacy increase or decrease is a movement. A legacy fee or
  unresolved leg has no effect of its own (0070): when its revision has
  exactly one movement and the leg is on another basis, it is a
  `correspondence` of that movement (the settlement writer's obligation leg
  beside its cash debit); otherwise its effect is undeclared and the revision
  is `writer_unsupported`. So 101 out = 100 principal + 1 fee counts 101 once,
  and a fee is never added a second time (B3).
- **Times.** `economic_event_times` roles as stored; the fold's basis reads
  exactly its own role (cash → `posting`), and a missing role is its
  `event_time_unknown`. The 0032 effective time is not read.
- **Claims.** `(book, key)` with the key as `sha256:<hex>` of its stored text
  (the fold bounds a key at 512 characters; the selector keeps the text).
- **Dispositions.** `identity_changed`, `claim_conflict` and `alias_conflict`
  become fold flags; selector-unsupported shapes, a kind no fold writer covers
  (only purchases and refunds from the card purchase lane, settlements from the
  settlement review), and a seal of another writer release (pinned to the
  writers' constants by a test) become `writer_unsupported`. A revision the
  fold would refuse whole is left out by name (`revision_left_out`), never
  failing the set.
- **Coverage.** No producer exists, so none is declared: the pinned coverage
  release is `coverage-producer-none-v1`, and the fold names every scope
  `family_not_evented` and `history_coverage_unknown` (B5).
- **Late part.** `explainLateSelections(baseline, now)` diffs two selections
  through the fold's `explainLate`; no timestamp is read.

### The query (`reconstructed-state.ts`, `queryReconstructedState`)

One account, one range (at most 366 days, not after the caller's date), the
cash basis only, at one cut. Without every 0070 object it answers
`unavailable` (`economic_guard_missing`). Otherwise it loads once, selects at
the asked cut and, when the account's end balances share one capture instant
whose cut is not after the asked one, at that cut for the late part
(`lateUnavailable`: `no_end_capture`, `end_captures_differ`,
`baseline_after_cut`); reads the reported state at both dates
(`queryDatedState`); calls an account without a reported container when none
of its mapped sources is in the reported-state perimeter; and folds. Positions
are counted, never folded (they carry provider text only).

The answer's status, by precedence: `unavailable` (`economic_guard_missing`,
`no_reported_container`), `indeterminate` (`log_empty`,
`cut_before_log_start`, `knowledge_unlogged`, `snapshot_boundary_unknown` when
any cell has a boundary candidate: B4), `needs_review` (`identity_changed`,
`claim_conflict`, `alias_conflict`, `revision_chain_inconsistent`,
`writer_unsupported`, `revision_left_out`), `incomplete` (every other cell
gap, `nothing_to_reconstruct`, `positions_not_folded`), else `complete`. Every
applicable reason is listed. The outer manifest pins the query schema,
selector, adapter and engine releases, the fold policy, account, range, basis,
requested and resolved cut and its `known_at`, set version, baseline cut and
set version, identity epoch and the selected seals' pins, alias rule versions,
coverage producer, both snapshot context ids and the digest of the fold's own
manifest; `contextId` is its digest (B12, B13).

Nothing here writes, adopts or approves anything, and nothing is totalled
across accounts.

## Consequences

- The fold's own resolution over full chains stays for its tests and other
  callers; stored rows reach it only through the selector (ADR 0052 amended).
- `reconciliationSignals` in `packages/read-model/src/events.ts` is unchanged.
- No migration: every read uses an index 0032, 0044, 0047 or 0070 created.

### Limits

- **Today's answers.** A card account is `unavailable`
  (`no_reported_container`), its purchases listed as `other_basis`. A bank
  account is at best `incomplete` (`family_not_evented`,
  `history_coverage_unknown`): no coverage producer exists. Neither writer
  writes event times, so every settlement leg is listed as `unknown_effect`
  with `event_time_unknown` and the bank cell has no figure; a settlement
  accepted before G1b makes the account `indeterminate`
  (`knowledge_unlogged`). The settlement writer writing a `posting` time is a
  writer change of its own, not done here.
- **No route, page or service** calls the query yet; that is the next step.
- **Knowledge.** Only cuts of the current core epoch are answered; commits of
  another epoch read as unlogged. A revision an older build writes later
  without a commit changes the answer at earlier cuts (B2 holds for logged
  history only); such a revision is reported, never applied.
- **Identity.** Only `account_mapping:` and `instrument_mapping:` pins are
  read; any other pinned subject is `identity_pin_unreadable`. Neither writer
  pins a subject today, so only the epoch is compared. The card purchase lane
  re-revises after an epoch change; its revisions not yet re-revised read
  `identity_changed`.
- **Holders.** Alias conflicts are found only among `economic_claims` rows:
  legacy holders carry no alias class.
- **Shapes.** A one-revision `chain_inconsistent` event (impossible under
  0070's triggers) reaches the fold as `writer_unsupported`, the selector
  naming the real reason; a fee or unresolved leg the legacy rule cannot place
  makes its revision `writer_unsupported`; a revision the fold would refuse
  (an event id containing `@`) is left out and the scope needs review.
  Evidence ids are not handed to the fold.
- **One account, cash basis, balances only**: trade and settlement bases,
  positions and several accounts are refused or not folded (ADR 0004).
- **Cost.** The load reads the whole history of every touched event, and the
  instant resolution walks the commits made after the instant along the
  primary key (no index orders `known_at`). Measured once on `bun:sqlite`
  locally, not asserted: 1,500 touched events with 4,500 revisions among
  64,500 commits loaded in 63–76 ms, selected in 198–257 ms, and an instant
  near the log's start resolved in 17–20 ms. Not measured on workerd or D1;
  the size of a JSON id list bound as one parameter on remote D1 is not
  verified.

## Verification

Synthetic data only; no production data, D1 or Workers.

- `packages/domain/test/knowledge-selector.test.ts` (20 tests): instant
  resolution with equal instants and flooring; B1 (account correction at every
  later cut); the scope after resolution (a withdrawal without legs); B2 (a
  later commit leaves the earlier cut equal); B13 (reversed rows); the cut
  before the log; unlogged, older-build and other-epoch revisions; two in
  force, an undeclared pointer, a seal count mismatch, a pointer mismatch;
  key and alias conflicts; identity epoch and pins; unsupported shapes; an
  absent value; bounds, unknown keys and orphan rows refused.
- `packages/domain/test/reconstruction-adapter.test.ts` (17 tests): B3
  (101 = 100 + 1, a legacy fee, a settlement's obligation leg, trade and
  settlement legs, one row two events claim), B4 (boundary day, another role
  only), B5, B6, unlogged revisions, identity and alias flags, unsupported
  writers, the handed-over shape, the late part, B13 on the fold's manifest,
  and the writer releases against the writers' constants.
- `packages/read-model/test/economic-selector.test.ts` (39 tests) over a
  history written through 0070's triggers: sequence and instant cuts, refused
  cuts, an empty log, B1, B2 and B12, both subject forms, holders before and
  after a release, a legacy double holder and an out-of-scope holder found by
  key, legacy settlements through the view, pre-log and older-build
  revisions, identity epochs and pins, a cross-event merge, scope dimensions,
  the event bound, availability, and every statement's plan on the complete
  CORE schema without table statistics (keyed, with the named indexes).
- `packages/read-model/test/economic-selector-random.test.ts` (25 tests: 24
  seeds and a coverage check): on random histories written with the triggers
  dropped, the loaded rows equal an independent closure, every sequence and
  instant cut equals a replay oracle (revisions and statuses, claims,
  conflicts, identity changes, unlogged entries), shuffled rows keep the set
  version, and W11: at the last commit an active revision is the stored live
  one and its claims are `live_consumption_claims`. By hand (not in CI),
  dropping the commit-log supersession, shifting the cut by one, ignoring an
  unlogged successor, not following predecessors, skipping the pointed-by
  step, losing the purchase-key holder arm or using `<` for the instant each
  failed seeds.
- `packages/application/test/reconstructed-state-query.test.ts` (12 tests):
  without 0070, an empty log, a logged settlement, a settlement as written
  today, a pre-log settlement, a card account, a declared identity epoch, B4,
  B12, B13, and the refused inputs and cuts.
- `mise run //packages/domain:ci`, `//packages/read-model:ci`,
  `//packages/application:ci`, `//packages/parsers:test`, `mise run ci:root`
  and the format, lint and typo checks locally.
