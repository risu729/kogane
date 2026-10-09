# ADR 0058: A knowledge selector reads adopted events at a commit-log cut, and a B adapter feeds the reconstruction fold

- Status: accepted (merged 2026-10-09 in #592)
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

An instant at or after the log's last `known_at` answers with
`cutStanding: "provisional"`; every other cut is `final`. `known_at` is
`max(worker now, previous known_at)`, so a later commit from a lagging worker
clock can land at or before such an instant and resolve it to a later
sequence (log `[1 at 00:00:00]`: the instant `00:00:05` resolves to 1; a
commit at `00:00:02` makes it resolve to 2). The resolved sequence, pinned in
the manifest, reproduces either answer.

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
Each read stops one row past its bound, the pointed-by and holder reads
included.

### Resolution (`knowledge-selector.ts`, `selectAdopted`)

1. A revision is **visible** when its seal names a commit row in the cut's
   epoch at or before the cut that lists it as a member, **later** when that
   commit is after the cut, and **unlogged** otherwise: no seal or no commit
   (`no_commit`), or a commit of another core epoch (`other_core_epoch`).
2. A revision is **superseded at the cut** when a visible commit's member
   names it in `supersedes`. The stored pointer is checked against it
   (`supersession_pointer_mismatch`), as is the order of the two commits
   (`successor_committed_first`).
   A revision known at the cut (unlogged, or committed by it) whose stored
   pointer names an unlogged revision that is superseded at the cut, or
   replaced this way, is replaced too, transitively: its pointer was written
   with its successor, before that successor was superseded. So a pre-log
   chain of any length (within one event or merged across events) ends where a
   logged correction supersedes its last revision. A pointer to a logged
   revision is never followed: 0070 makes that revision's commit declare what
   it supersedes, so an undeclared one is `supersession_undeclared` (step 3),
   reported and never turned into history.
3. Per event, over every loaded revision and before any filter: the in-force
   revisions are those not superseded or replaced at the cut. The event is
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
10. **Set version** is `sha256` of the canonical selection body without the
    requested cut: the resolved cut and its `known_at`, scope, current
    identity epoch and every selected row in its at-cut form. One sequence
    asked by number or by instant has one set version (the outer manifest
    pins how it was asked), and `cutStanding` is not digested. A row recorded
    after the cut is read but does not enter it, so a later commit leaves an
    earlier sequence's set version and answer unchanged (B2). B2 holds for
    sequence cuts and for instants strictly before the log's last `known_at`;
    an instant at or after it is `provisional` (above). Any order of the
    loaded rows gives the same version (B13).

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
  and a fee is never added a second time (B3). A raw movement and its event
  can never both count: B reads no raw movement at all, only adopted
  revisions, so the "raw and event" B3 case is one provider row that two
  events claim, which is a conflict applied by neither.
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
  through the fold's `explainLate`; no timestamp is read. The query diffs the
  two selections twice: inside the fold (each cell's late total and legs) and
  through `explainLate` (the revisions that entered or left the scope), since
  the fold does not return the second; no row is read twice.

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
manifest; `contextId` is its digest (B12, B13). The cut's standing
(`final` or `provisional`) is returned beside the cut, outside the manifest.

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
  (`knowledge_unlogged`) until a logged revision supersedes it. The
  settlement writer writing a `posting` time is a writer change of its own,
  not done here, and it fixes only future acceptances: a sealed revision
  takes no time row after its seal (`economic_revision_sealed`), so a
  settlement accepted before that change stays `event_time_unknown` until a
  new revision restates it with a time. The 0032 effective time is not shown
  on the listed leg either (not done: it would be a value of no declared
  role).
- **Route, agent tool and page**: served since the amendment below
  ("Route and page as implemented (2026-10-09)").
- **Knowledge.** Only cuts of the current core epoch are answered; commits of
  another epoch read as unlogged. A revision an older build writes later
  without a commit changes the answer at earlier cuts (B2 holds for logged
  history only); such a revision is reported, never applied. An instant at
  or after the log's last `known_at` is `provisional`.
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
- **Whole history.** The closure is cut- and range-independent: an account
  whose legs, supersessions and claim holders touch more than 2,000 events
  (or 5,000 revisions, 20,000 legs) is refused at every range and every cut.
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

- `packages/domain/test/knowledge-selector.test.ts` (27 tests): instant
  resolution with equal instants and flooring; B1 (account correction at every
  later cut); the scope after resolution (a withdrawal without legs); B2 (a
  later commit leaves the earlier cut equal); B13 (reversed rows); the cut
  before the log; unlogged, older-build and other-epoch revisions; a pre-log
  chain of two revisions ended by a logged correction, within one event and
  merged across events; a committed revision, an older build's unlogged
  successor and a logged correction; W1 and W2 (undeclared pointers to logged
  revisions stay `chain_inconsistent`, never history); one set version for one sequence asked by number and
  by instant; `provisional` instants at or after the last `known_at`; two in
  force, an undeclared pointer, a seal count mismatch, a pointer mismatch;
  key and alias conflicts; identity epoch and pins; unsupported shapes; an
  absent value; bounds, unknown keys and orphan rows refused.
- `packages/domain/test/reconstruction-adapter.test.ts` (18 tests): B3
  (101 = 100 + 1, a legacy fee, a settlement's obligation leg, trade and
  settlement legs, one row two events claim), W2 through the fold (needs review, no exact
  figure), B4 (boundary day, another role
  only), B5, B6, unlogged revisions, identity and alias flags, unsupported
  writers, the handed-over shape, the late part, B13 on the fold's manifest,
  and the writer releases against the writers' constants.
- `packages/read-model/test/economic-selector.test.ts` (41 tests) over a
  history written through 0070's triggers: sequence and instant cuts, refused
  cuts, an empty log, B1, B2 and B12, both subject forms, holders before and
  after a release, a legacy double holder and an out-of-scope holder found by
  key, legacy settlements through the view, pre-log and older-build
  revisions, a pre-log chain ended by a logged correction, a lagging clock's
  commit resolving an earlier `provisional` instant to a later sequence, identity epochs and pins, a cross-event merge, scope dimensions,
  the event bound, availability, and every statement's plan on the complete
  CORE schema without table statistics (keyed, with the named indexes).
- `packages/read-model/test/economic-selector-random.test.ts` (25 tests: 24
  seeds and a coverage check): on random histories written with the triggers
  dropped, including pre-log chains of two or more revisions that a logged
  revision ends and stored pointers no commit declared, the loaded rows equal an independent closure; every sequence
  cut, an instant before the log and instants strictly between commits equal
  a replay oracle that walks stored pointer chains forward through unlogged
  revisions only and reports a pointer to a committed revision that did not
  declare it (revisions and
  statuses, claims, conflicts, identity changes, unlogged entries); each
  commit's own `known_at` resolves to the last commit sharing it; shuffled rows
  keep the set version; and W11: at the last commit an active revision is the
  stored live one and its claims are `live_consumption_claims`. By hand (not
  in CI), each of these mutations failed seeds (failing of 25): commit-log
  supersession ignored (25), the cut shifted by one (25), an unlogged
  successor ignored (13), predecessors not followed (23), the pre-log chain
  rule dropped (18), the chain rule widened to logged targets (11), an
  undeclared pointer not reported (12), the pointed-by step skipped (14), the
  purchase-key holder arm on the wrong book (3), `<` for the instant (25).
- `packages/application/test/reconstructed-state-query.test.ts` (13 tests):
  without 0070, an empty log, a logged settlement, a settlement as written
  today, a pre-log settlement, a pre-log chain then a logged correction, a card account, a declared identity epoch, B4,
  B12, B13, and the refused inputs and cuts.
- `mise run //packages/domain:ci`, `//packages/read-model:ci`,
  `//packages/application:ci`, `//packages/parsers:test`, `mise run ci:root`
  and the format, lint and typo checks locally.

## Amendment: Route and page as implemented (2026-10-09)

- Status: proposed (accepted when its pull request merges)
- Date: 2026-10-09
- Issue: #550, the route, page and difference-explanation slice
- Carried by: `packages/application/src/query/reconstructed-state-read.ts`,
  `services/app/src/reconstructed-state-api.ts`, `services/app/src/agent-service.ts`,
  `services/app/src/mcp.ts`, `packages/observation-shared/src/reconstructed-state-contract.ts`,
  `apps/web/src/pages/ReconstructedState.tsx`,
  [reconstructed state](../reconstructed-state.md#http-agent-tool-and-page),
  [agent API](../agent-api.md#reconstructed-state)

### Context

The decision above left `queryReconstructedState` without a caller. The owner
asked for the route, the page and the difference explanation in the UI, and
for an agent read over the same application layer: what a person can read on
the page, an agent holding an owner-delegated grant reads through the same
service, with the same bounds and codes.

### Options considered

1. **The route calls the query and the agent tool calls it again**, each
   validating its own input. Rejected: two sets of request rules and refusal
   codes for one read drift apart.
2. **A shared-query intent (`kogane.financial.query`)**. Rejected: the answer
   is not a `financial-result-v1` page of rows; it has its own manifest,
   context id and statuses, and the intent table's filters cannot say a cut.
3. **One application service both transports call**, as
   `kogane.purchases.explain` does for the card purchase page. Chosen.

### Decision

- **Service.** `readReconstructedState({ grant, sql, body, now })` checks the
  grant first (`records.read`, a whole-store perimeter, since the answer reads
  the account's reported state through every mapped source and its events
  through every claim holder), then validates the body into the query's input,
  checks the account against `accounts` by primary key, calls the query, and
  refuses a pinned `setVersion` the answer no longer has. Every refusal is one
  closed code with one HTTP status (`RECONSTRUCTED_STATE_REFUSALS`); the
  agent error carries it as its first ref (`refusal:<code>`) under its
  `financial-error-v1` category. `reconstructedStateBodyFromQuery` turns the
  route's query string into the same body.
- **Request.** One `account` (several, `accounts`, `instrument` or
  `instruments` are `scope_unsupported`: positions are never folded); `from`
  before `to`, at most `RECONSTRUCTION_RANGE_MAX_DAYS` (366) days apart, `to`
  not after today in Tokyo; `basis` absent or `cash`; a cut
  `{coreEpoch, commitSeq}` with `commitSeq` at least 1 (`validKnowledgeCut`
  takes a commit reference; the cut before the log is asked as an instant) or
  `{coreEpoch, instant}` with a UTC instant not after the caller's clock; an
  optional 64-hex `setVersion`. A rejected value is never echoed in a ref.
- **Route.** `GET /api/v2/reconstructed-state` (GET and HEAD) under the reader
  authority the other GET routes have (`readerGrant` of the subject the
  Access gate proved); no new authentication. It exists, and `/api/meta`
  advertises `reconstructedStateOnDate`, where `/api/v2/reported-state` does:
  the two dated reads it compares need the same views. Without CORE 0070 it
  answers `200` `unavailable` (`economic_guard_missing`), as the query does.
  Registered in its own module; `worker.ts` gains the registration and the
  log label.
- **Agent tool.** `kogane.reconstructed-state.read`
  (`POST /api/agent/v1/reconstructed-state.read` and MCP `tools/call`),
  read-only, listed and callable exactly while the route is served, with a
  closed input schema whose patterns are the service's.
- **Wire contract.** `validReconstructedState` takes exactly the query's
  fields: an adjustment, a total, a net worth, an unknown status, reason,
  gap, disposition or explanation code, a computed answer without reasons or
  a `complete` one with them, or an answer without a reconstruction that is
  not the missing guard, is refused rather than displayed. Its code lists are
  restated (the client bundle does not import the query's SQL) and pinned to
  the query's by a test.
- **Page.** `残高の再構成` (`/reconstruction`): per currency the start's
  reported value, the reconstructed value, the end's reported value and
  `reported − reconstructed` with the fold's explanation status and reason,
  the applied, pending, same-day and late components and the gaps; the
  status and reasons; the knowledge used (requested and resolved cut,
  `known_at`, `final` or `provisional`, set version, identity epoch, log
  coverage, the selector's diagnostics); the late part; every leg's
  disposition; refusals with their codes. Every code is shown beside its
  words. No valuation is shown. `ApiError` now carries a server's closed
  `error` code when the body has one, so a refusal is shown by its code;
  messages stay fixed.

### Consequences

- The agent tool list grows by one wherever the reported state is served;
  the tests that pinned the five tools now pin six there.
- `kogane.capabilities` reports `reconstructedStateOnDate` through the same
  capability object `/api/meta` returns.
- No migration and no new index: the route adds only the `accounts` primary
  key lookup to the query's reads.

### Cost

`packages/application/test/reconstructed-state-scale.test.ts` runs the
service end to end on the statement-scale store of
`packages/read-model/test/card-usage-scale-fixture.ts` (every CORE migration,
no table statistics) with settlements on its SMBC account written through
CORE 0070's triggers, records every statement the service runs, and fails on
any whole scan that the test owning that statement does not already accept
(the dated reads' artifact pass and statement ranking, the selector's view
arms and epoch read, the mapping table by account). Measured on `bun:sqlite`
locally, medians of three, not asserted; then the same store on workerd
(below).

| Store                                     | Settlements (revisions) | Commits | Latest cut | Sequence, mid-log | Instant, log start |
| ----------------------------------------- | ----------------------- | ------- | ---------- | ----------------- | ------------------ |
| `STATEMENT_CI_SCALE` (CI)                 | 150 (300)               | 373     | 200–356 ms | 146–186 ms        | 189–432 ms         |
| `STATEMENT_SCALE` (`KOGANE_…_SCALE=full`) | 1,500 (4,500)           | 9,899   | 1,913 ms   | 1,126 ms          | 2,024 ms           |

The full row is one run on a machine shared with other test processes; the
CI row is the range over three runs (two for the instant, whose first run
asked an earlier instant). Most of a full answer is work measured before, now
done in one request: two dated reads (346–398 ms each at this store,
[reported state](../reported-state.md#cost)), the selector's load and two
selections (the asked cut and the end capture's cut for the late part) and
the fold with a baseline (0.92–1.38 s at its budget, ADR 0052).

**On workerd.** `services/app/scripts/reconstructed-state-workerd.ts` (by
hand, not in CI) builds the same store on `bun:sqlite`, puts it in the SQLite
file of a local Miniflare D1 under `wrangler dev`, and runs
`readReconstructedState` on workerd over the D1 binding, as the route does
after its Access and grant checks. "Wall" is the wall time of one request
from the harness, median of three after a warm-up. On three further
instrumented runs the Worker records each statement's interval (after a
zero-delay timer, since workerd's clock only moves on I/O); "D1" is their
union, the time the Worker waited on D1, and "rest" is the instrumented wall
time minus it: the Worker's own work (selection, adapter, fold, JSON) plus the
local transport, an upper bound on its CPU time. One answer runs 26 D1
statements at either scale.

| Store, workerd (local D1) | Latest cut: wall (D1 / rest) | Sequence, mid-log      | Instant, log start     |
| ------------------------- | ---------------------------- | ---------------------- | ---------------------- |
| `STATEMENT_CI_SCALE`      | 199 ms (123 / 103)           | 127 ms (119 / 54)      | 174 ms (162 / 104)     |
| `STATEMENT_SCALE`         | 1,721 ms (1,082 / 611)       | 1,275 ms (1,311 / 219) | 1,729 ms (1,219 / 653) |

One run each, on a shared machine (the store's answer is `indeterminate`
there, as on `bun`). Workers do not count time spent waiting on D1 as CPU
time. `services/app/wrangler*.jsonc` sets no `limits.cpu_ms`, so the plan's
default applies: on Workers Paid, which the processor's limits are written
against ([observation lanes](../observation-lanes.md)), 30 s of CPU per HTTP
request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time),
read 2026-10-09; 10 ms on Workers Free). The full-scale "rest", about 0.6 s,
is about 2% of that default. Remote D1 (its network round trips and its own
query time) is not measured; locally the D1 wait is most of the answer.

The route bounds one answer by the range (366 days), the selector's bounds
(2,000 events, 5,000 revisions; past them `413 result_limit_exceeded`), the
fold's budgets and the reported state's 5,000 rows per read; nothing is
paged or cut.

### Limits

- **Open owner items.** The claim-adoption rule (which claims make an event
  a holder when two writers claim one row) is still the selector's reading of
  0070, not an owner rule. Provisional cuts are shown and labelled, not
  hidden or refused; whether the UI should default to the latest sequence
  rather than offer an instant at or after the log's end is the owner's call.
  No coverage producer exists, so no real account is `complete`.
- **Audit slot.** The service receives the principal through the existing
  `Grant` and the agent error carries the existing `requestId` field (a fixed
  `reconstructed-state.read`, as `purchases.explain` uses its own); the
  Worker's per-request id, the channel (ui, mcp, api), a correlation id and
  an idempotency key have no slot in the read service's input. The shared
  audit contract for human and agent operations (ADR 0063/0064, reserved)
  owns that slot; this read does not design it.
- **Grants.** Today's grant scopes list sources and provider accounts
  (`source_account`), not resolved account ids, so a listed perimeter is
  refused rather than mapped onto this read; that is today's grant model, to
  change with the grant contract, not a rule of this read.
- **Scope.** One account, the cash basis, balances only; instrument
  quantities stay unfolded (`positions_not_folded`). Today's answers are
  those listed above (`unavailable` for card accounts, at best `incomplete`
  for bank accounts).
- **Time.** `to` and an instant cut are checked against the Worker's clock;
  the empty log's default cut is that clock, so two such answers differ in
  their cut and context id.

### Verification

Synthetic data only; no production data, remote D1 or deployed Worker.

- `packages/application/test/reconstructed-state-read.test.ts`: answers for a
  bank account (reported 10,000 → reconstructed 9,000 beside a reported
  8,500, difference −500 kept), a card account, a pre-log settlement, an empty
  log (provisional), a store without 0070; sequence and instant cuts, a
  pinned set version; every refusal code; the grant refusals before any read;
  nothing written.
- `packages/application/test/reconstructed-state-scale.test.ts`: the plan
  check and the timings above.
- `services/app/test/reconstructed-state-api.test.ts` on workerd: Access,
  GET-only, every refusal code with its status, `unavailable` without 0070,
  `413` past the selector's bound, `404` and an unadvertised capability
  without the views, nothing written; the agent tool listed, answering what
  the route answers, refusing with the route's codes, absent with the route.
- `apps/web/test/reconstructed-state-contract.test.ts` and
  `apps/web/test/reconstructed-state.browser.test.ts` (production bundle,
  Chromium): the wire contract, the page's columns and difference, an
  unexplained difference shown as such, the knowledge panel and pinning,
  refusals, the missing guard and a card account, provisional cuts, the
  bound, and a 390 px width.
