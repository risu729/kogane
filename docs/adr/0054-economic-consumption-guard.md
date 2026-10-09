# ADR 0054: One consumption guard for every economic writer: claims, seals and a commit log

- Status: accepted (merged 2026-10-08 in #586)
- Date: 2026-10-08
- Issues: #549, #550, #556
- Carried by: [economic events](../economic-events.md#common-consumption-guard-migration-0070),
  `packages/domain/src/economic-contract.ts`,
  `packages/storage-d1/migrations/core/0070_economic_commit_guard.sql`,
  `packages/storage-d1/src/atomic/economic-commit.ts`; since G1b also
  `packages/domain/src/row-identity.ts`,
  `packages/storage-d1/src/atomic/card-purchase-recognition.ts`,
  `services/processor/src/card-settlement-commands.ts` and
  `packages/read-model/src/card-settlement-readiness.ts`; since G2 also
  `packages/storage-d1/migrations/core/0071_economic_event_command_kinds.sql`
  and `packages/domain/src/economic-event-commands.ts`

## Context

Two writers adopt economic events today, and each guards only itself. The
card purchase lane holds a recognition key with one live holder (0047,
[ADR 0002](0002-card-purchase-recognition.md)); a card settlement reserves its
bank debit through `card_settlement_readiness.allocation_available` (0044),
which looks only at other settlements' allocations, and its allocations cite
`transaction:<observation id>`, which changes with every capture. Own
transfers (#549), the bank and securities reconstruction (#550) and lots
(#556) need the same row not to be consumed twice across writers, and need to
read what was adopted _as known at a point_, which nothing records today:
`created_at` is a writer clock, the event tables are outside the source
revision ledger, and D1 bookmarks are "at least this", not a past snapshot.

Five platform facts constrain the design:

1. A D1 `batch()` is one transaction: a statement that raises rolls the whole
   batch back. A conditional statement that matches 0 rows is not an error,
   so every statement carries its own guard (`decision-commit.ts`,
   `card-purchase-recognition.ts`). JavaScript that inspects results after the
   batch cannot roll anything back.
2. SQLite `RAISE(ABORT)` aborts the statement; the whole-batch rollback comes
   from D1's batch contract. Locally it is proven on workerd/Miniflare
   (`services/processor/test/card-purchase.test.ts`, the
   `card_purchase_key_held` test) and emulated by the `bun:sqlite` D1Like
   (`packages/storage-d1/test/sqlite.ts`). Remote D1 is not verified.
3. 0032's supersede trigger requires the successor revision to exist first,
   so inside a batch an event is briefly two-live. No partial unique index can
   say "one live revision per event".
4. SQLite does not push a correlated or trigger term into a `UNION` view: a
   trigger that reads such a view materializes every row of it.
5. The 5-tuple key `json_array(source_id, producer_id, external_id_namespace,
source_account, external_id)` names a row inside one collection path, not
   an economic fact. A producer change ([ADR 0014](0014-collector-producer-ids.md)),
   a client-declared namespace, a parser release that changes id text, the
   0063 identity rewrite and mirrored sources give one fact several keys;
   fingerprints can give two facts one key.

## Options considered

1. **Per-writer guards, as today.** Each writer checks its own table. Rejected:
   nothing stops an own transfer and a card settlement from consuming the same
   bank debit, and neither records when its adoption became known.
2. **A generic ledger or event bus** that every writer posts to and a
   projector folds. Rejected for now: it rewrites both working writers, moves
   the invariant out of the transaction that adopts, and needs a projector
   with its own consistency story. Deferred, not refused forever.
3. **An additive guard: claims, seals and a commit log with a finalization
   row**, enforced by triggers inside each writer's own batch, reading the
   legacy holders through views so nothing is backfilled. Chosen.

## Decision

- **Book.** A closed code for the dimension a row is consumed in:
  `card-usage` (a card usage row recognised as a purchase or refund),
  `cash-movement` (a posted movement of a cash or stored-value account: a
  settlement's bank debit, an own transfer's debit and credit),
  `security-quantity` (a holding-quantity movement; refused with
  `economic_claim_book_unsupported` until its writer has an ADR). One claim
  per book per row; a stated fee inside a row is a breakdown of that row's
  claim, never its own key.
- **Consumption key and alias class.** The claim's row key stays the 5-tuple
  (the 0047 recognition key, the 0044 `bank_key`), re-derived by the claim
  trigger from the cited observation and parse run, which it pins. A
  human-adopted writer also records an **alias class**:
  `json_array(source_id, provider identity components, resolved account id,
alias rule version)`, computed from a registry-declared, versioned
  provider-identity function, never from the raw external id text, the
  producer or the namespace. One live holder per (book, key)
  (`economic_claim_held`) and per (book, alias class) (`alias_conflict`),
  whoever wrote the holder.
- **Versions are separate** and none is inferred from another: revision
  content (its digest in the seal), proposal version (`proposal_digest`), head
  version (the event's highest revision, 0 when it never existed, plus
  liveness; expected-revision subject `economic-event:<id>`), decision id,
  commit sequence, and read source version (`core_epoch`, `source_revision`).
  `created_at` is never adoption evidence.
- **Seals.** `economic_revision_seals` states a revision's leg, claim, time
  and effect counts (checked equal to the stored rows), the writer release,
  a content digest, identity pins (`{subject: revision}` in the
  expected-revision vocabulary), the identity epoch, and the commit it
  belongs to. After the seal no leg, claim, time, effect, card purchase
  sidecar or key, and no accepted settlement decision naming the revision, can
  be added (`economic_revision_sealed`), generalising 0047's
  `card_purchase_recognition_legs_sealed`.
- **Entry and finalization.** Statement 1 is the entry and carries every
  precondition (the reviewed receipt reservation, or a rule writer's decision
  insert). Every later statement is `WHERE EXISTS(entry) AND NOT EXISTS(own
row)`, so a stale batch is an all-0-rows no-op and a replay writes nothing.
  A rule writer's entry condition is "this decision exists", not "this batch
  wrote it" (`decisionEntry`), so a replay finds it and writes whatever it
  has not written yet. **Decision for G1b:** from G1b on, the card purchase
  lane's decision digest includes the writer release, so every guard-era
  batch writes its own entry; where a pre-guard draft id is replayed anyway
  with the seal and commit appended, that legacy revision is sealed and
  logged then, with an honest later `known_at`, never backdated (test P9).
  The **last** statement inserts the `economic_commit_log` row. Its trigger is
  where the batch's invariants are enforced, after every mutation, in a fixed
  order with one code each: shape; dense sequence and non-decreasing
  `known_at`; every member live, newest, sealed for this commit, and the
  commit's seals exactly the members; identity epoch; every superseded prior
  points at its member (a 0-row compare-and-set raises
  `economic_commit_prior_not_superseded`), and every revision that points at
  a member is declared in its `supersedes`
  (`economic_commit_supersession_undeclared`: otherwise its claims would be
  released, or a conflict washed, without anyone saying so; a partial index on
  `superseded_by` finds them across event ids); no other live revision of a member's
  event; claims equal `claims_json` as a set; no outside live holder of a
  claimed key or alias class; `released_json` exactly the dropped claims and
  none still live elsewhere (`economic_claim_conflict_unresolved`: a
  pre-existing double holder is never washed); decisions under this
  operation and principal. "Accepted" means the commit row exists;
  "published" stays outbox state.
- **Correct, withdraw, move.** A correction is a new full revision (every leg
  and claim restated, nothing implicit), its prior superseded, released claims
  listed; a failure leaves the old state whole. A withdrawal is revision n+1
  in state `unknown` with no legs or claims, releasing every claim of n; 0070
  refuses it when a released key is in conflict, and its planner (G3) refuses
  a plan that names another decision epoch. A move is one commit with two members (X without the key, Y with
  it); withdraw-then-adopt as two operations surfaces `economic_claim_held`
  rather than hiding the race. The settlement withdrawals table stays the
  settlement writer's own record.
- **Commit sequence.** One dense counter per `core_epoch` (a restored CORE
  takes a new epoch, 0038), computed in SQL as `max + 1`; `known_at` is
  `max(worker now, previous known_at)`, also in SQL, because worker clocks are
  not monotonic. `known_at` has exactly one form, canonical UTC
  `YYYY-MM-DDTHH:MM:SS.sssZ` (checked by the table, `validKnownAt` and the
  builder), because the log and every instant cut compare it as text. A resend returns the original receipt and sequence. Revisions
  written before the log, or by an older build after it, are listed by
  `unlogged_economic_revisions` and read as `knowledge_unlogged`, never
  backdated.
- **Identity pins and epochs.** Seals pin identity revisions; display names
  are not pinned. `economic_identity_epochs` is append-only, seeded with
  `identity-epoch-1`; a declared identity rewrite (as 0063 was) appends the
  next epoch. A commit whose member is sealed under a non-current epoch is
  refused (`identity_epoch_changed`). The reviewed identity resolution that
  may one day be exempt has the reserved kind
  `economic-event.resolve-identity`, and 0070 refuses that kind outright, for
  every principal, with the same code. G2 opens it: it recreates the commit
  trigger so the exemption needs an operation receipt of that kind for the
  commit's operation and principal, and adds the kind to the receipt
  vocabulary with its planner (the receipt kind CHECK in force, 0058's, admits
  no such kind today). 0070 itself reads no command table, so G2 can rebuild
  them (see "Rebuilding a table 0070 reads"). _G2 did not open it: whether the
  kind and its receipt binding belong in the vocabulary is an open owner
  question, and the exemption stays closed
  ([amendment](#amendment-g2-as-implemented-2026-10-09))._
  That is all 0070 enforces about epochs: a new seal under the current
  epoch. It does **not** refuse a commit that supersedes a holder sealed
  under an older epoch, because it cannot tell which such supersession needs
  review: the card purchase lane under retire-before-recognise keeps
  auto-revising after a rewrite ([ADR 0002](0002-card-purchase-recognition.md)),
  and a reviewed correction or withdrawal is itself the explicit review.
  Routing old-epoch holders to needs-review (`identity_epoch_changed`, holder
  kept) is the planners' job (G3) and the selector's (#550, ADR 0058).
  _Pointer (2026-10-09): ADR 0057's planners route a correction or move of a
  holder sealed under an older epoch to review (stricter than this paragraph,
  as ADR 0057 states); they are not registered._
- **Knowledge selector interface** (#550, ADR 0058): a cut is
  `{coreEpoch, commitSeq}` or `{coreEpoch, instant}` resolved to the largest
  sequence whose `known_at` is at or before the instant (equal instants all
  included). The selector resolves every touched event's active revision at
  the cut, fully loaded (legs, claims, times, effects, seal), before any range,
  account, instrument or kind filter, and reads past holders from the selected
  claims, never from the `current_*` views.
- **Typed movement.** `economic_leg_effects` says whether a leg is a
  `movement`, a `breakdown` of another leg (same unit only) or a
  `correspondence`; a legacy leg without a row keeps its reading (increase and
  decrease move, fee and unresolved do not). 101 out = 100 principal + 1 fee
  counts 101 out once. `economic_event_times` carries `trade`, `settlement`,
  `posting`, `usage` and `value` times with no fallback between roles.
- **Manifest pins** (B and C): selector release and cut, set version,
  identity pins and epoch, alias rule version, coverage producer version,
  snapshot contexts, FX policy and rate refs, policy and engine versions.
- **Authority.** The principal comes from the Access subject and grants
  ([change lifecycle](../change-lifecycle.md#grants)); payloads have exact
  keys; no rule, AI or agent adopts, corrects, withdraws or moves an own
  transfer. A future rule needs an owner-authorised, versioned policy as
  [ADR 0034](0034-card-settlement-automation-prerequisites.md) required.
  _Pointer (2026-10-09): see [ADR 0057](0057-own-transfer-proposals.md): nothing adopts while the production gate is unmet; who may act is decided by the lifecycle's grants, with no principal-kind rule here._

### Identity: eight fail-closed rules

For human-adopted writers nothing is adopted automatically, and:

1. a fingerprint, occurrence or collector-fingerprint id (also when recorded
   under `externalIdOrigin`) is refused: `identity_fingerprint_only`;
2. an id without a recorded origin is refused until a parser release records
   it and a reviewed registry entry declares it: `identity_origin_unrecorded`;
3. rows that may be one fact are never asserted separate or the same:
   `duplicate_unresolved`;
4. exclusivity is decided on the alias class, never on raw id text, producer
   or namespace; a live holder in the class is `alias_conflict`, and this
   applies to new card settlement accepts too;
5. a family is usable only when a reviewed registry entry declares its
   provider identity function, evidence and scope: `identity_resolver_missing`;
6. a digest of stored content (V Point Pay's normalized event id, any message
   hash) is not a provider id: `identity_digest_not_provider`;
7. a parser release or identity rewrite that maps a held fact to a new key
   leaves the old holder; the new key is refused and needs review
   (`identity_rekeyed`); a declared rewrite opens a new identity epoch,
   pinned in seals and manifests (`identity_epoch_changed`); nothing is moved;
8. rule writers keep the bare 5-tuple only where retire-before-recognise is
   proven ([ADR 0002](0002-card-purchase-recognition.md), ADR 0014); an
   admitted rule writer states that property.

`admitIdentity` (`economic-contract.ts`) decides 1, 2, 5, 6 and 8 from a
closed input; CORE 0070 enforces 4 and refuses a new seal under a stale
epoch; 3, the rekey half of 7 and routing old-epoch holders to review are
decided by planners against stored holders (G3) and by the selector (#550).
_Pointer (2026-10-09): for own transfers, rule 3 is the proposal engine's
(`duplicate_unresolved`) and the rekey half of 7 the planners'
(`identity_rekeyed`), [ADR 0057](0057-own-transfer-proposals.md)._

**Finding:** today's card settlement readiness is producer-sensitive. 0052
partitions bank debits by producer and namespace (0052:31-32) and readiness
compares the full 5-tuple (0044:186,199), so the same debit collected under
two producers or namespaces could back two settlements. 0070 cannot see it:
legacy holders carry no alias class (a test pins this limit). G1b closes it by
recording the alias class on every new settlement accept.

## Consequences

- Nothing changes for the running writers in this PR: every new trigger on an
  existing table fires only once a seal or an `economic_claims` row exists,
  and no writer writes either yet. The processor suite passes unchanged.
- The legacy holders (card purchase keys, accepted settlements) are read by
  `economic_revision_claims` / `live_consumption_claims` with no backfill;
  existing inconsistencies show in `consumption_claim_conflicts` and
  `economic_event_live_conflicts` and are resolved only by an explicit
  reviewed decision naming every holder.
- The triggers spell out the three holder sources per lookup, each through an
  index (0070 adds `card_settlement_decisions_event`); the views are for
  readers. Their cost on remote D1 is not measured.
- New writes of `economic_event_revisions` dirty the purchase retirement
  proof (0064), which is safe; its cost is to be measured in G1b.
- The new tables are `core-keep` and append-only, and outside both
  source-revision lists: every batch that writes them inserts the
  `decision_revisions` row they hang from, which is in the ledger.

### Staged plan

- **G1a (this PR):** contract types, migration 0070, statement builders,
  synthetic tests, this ADR. No writer joins.
- **G1b:** both card writers join. `packages/storage-d1/src/atomic/card-purchase-recognition.ts`
  appends a seal and commit row after its keys (the keys are its claims; no
  duplicate storage; the lane is a rule writer under retire-before-recognise),
  and its decision digest gains the writer release so a guard-era batch never
  reuses a pre-guard decision id.
  `services/processor/src/card-settlement-commands.ts` writes an
  `economic_claims` row (cash-movement, `bank_key`, alias class), a seal and a
  commit row; its accepted decision row precedes the seal; its withdrawal is
  covered by the finalization. `packages/read-model/src/card-settlement-readiness.ts`
  gains a `claim_available` flag with the old SQL frozen and proven equal
  under the frozen-SQL differential rule. `packages/storage-d1/src/core/operations.ts`
  `REVISION_OF` gains the `economic-event:` prefix (`card-purchase:` keeps its
  meaning).
- **G2:** migration 0071, the command-kind vocabulary (`economic-event.adopt`,
  `correct`, `withdraw`, `move`) by the 0051 rebuild pattern; no planner, so
  every new kind is `unsupported_semantics`. Amends this ADR. No 0070 object
  reads the command tables, so their rebuild is unaffected. When G2 opens the
  identity-resolution exemption it drops and recreates
  `economic_commit_log_guard` with the receipt binding, and from then on any
  rebuild of `operation_receipts` must drop and recreate that trigger too.
  _As implemented, G2 adds the four kinds and leaves the exemption closed, so
  no 0070 object reads a command table yet
  ([amendment](#amendment-g2-as-implemented-2026-10-09))._
- **G3:** its own ADR and migration 0072, own-transfer proposals (proposal-only)
  and their planners, behind the production gate below.
  _Pointer (2026-10-09): G3-a is [ADR 0057](0057-own-transfer-proposals.md):
  the proposal engine, migration 0072 and the four planners, written and
  tested but not registered; the gate below is unchanged and not passed. The
  writer is G3-b._
- **Later:** widening the event kind CHECK (0032) for trades and FX, and the
  securities writer that admits `security-quantity`. The kind-CHECK widening
  rebuilds `economic_event_revisions`, which 0070 reads: that migration drops
  the 0070 objects listed below for it before the rename and recreates them
  after, and carries 0070's child tables as the 0051 rebuild carried its FK
  graph.

### Production gate

Own-transfer adoption cannot be enabled before both card writers write
claims, seals and commit rows, `unlogged_economic_revisions` has no row after
the log start, and the D1 compatibility tests are green (on an isolated
synthetic remote database). The second condition compares writer clocks:
`after_log_start` is `created_at` against the first commit's `known_at`, a
diagnostic, never adoption evidence. A revision an older build writes while
its clock lags the log can read as before the start; the operator checks the
view together with the deployed build versions, not the flag alone.

### Rollback

Turn off the planner registration or flag. The migration stays. An older
build keeps working with one deliberate exception: once a newer writer has
recorded an `economic_claims` row, an older card settlement build accepting a
settlement on the same bank debit is refused with `economic_claim_held` (and
an older purchase lane recognising a key held there likewise). That refusal is
correct (it is the double count the guard exists to stop) and surfaces as a
failed command, not as data. The new triggers refuse nothing else an older
build does: it never writes a seal, so nothing it writes is sealed. Its
revisions show as unlogged and are read fail-closed. Schema-floor rules as in
[economic events](../economic-events.md#deploy-order-and-rollback).

### Rebuilding a table 0070 reads

SQLite re-checks every trigger and view when a table is renamed, so the
create-copy-drop-rename rebuild of 0051 fails on a table that a 0070 trigger
or view reads, unless those objects are dropped first. Indexes and triggers
attached to the rebuilt table go with it, and foreign keys from the 0070
tables point at it. Any later migration that rebuilds one of the tables
below therefore drops the listed 0070 objects before the rename and recreates
them, unchanged, after it (child tables are carried as 0051 carried its FK
graph). `PRAGMA legacy_alter_table` is not relied on: its behaviour on remote
D1 is not verified. The list is pinned by a storage test (every 0070 index,
trigger and view reading or attached to a pre-0070 table, with the views that
read those views; the 0070 tables are the foreign-key children). Pre-0070
objects that read the same tables are the rebuild's own concern, as before.

| Table rebuilt                    | 0070 objects to drop before the rename and recreate after                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acquisition_sessions`           | `economic_claims_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `card_purchase_recognition_keys` | `card_purchase_recognition_keys_economic_claim_held`, `card_purchase_recognition_keys_economic_sealed`, `consumption_claim_conflicts`, `economic_claims_one_live_holder`, `economic_commit_log_guard`, `economic_revision_claims`, `economic_revision_seals_guard`, `live_consumption_claims`                                                                                                                                                                                                                                                                                  |
| `card_purchase_recognitions`     | `card_purchase_recognitions_economic_sealed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `card_settlement_candidates`     | `card_settlement_decisions_economic_claim_held`, `consumption_claim_conflicts`, `economic_claims_one_live_holder`, `economic_commit_log_guard`, `economic_revision_claims`, `economic_revision_seals_guard`, `live_consumption_claims`                                                                                                                                                                                                                                                                                                                                         |
| `card_settlement_decisions`      | `card_settlement_decisions_economic_claim_held`, `card_settlement_decisions_economic_sealed`, `card_settlement_decisions_event`, `consumption_claim_conflicts`, `economic_claims_one_live_holder`, `economic_commit_log_guard`, `economic_revision_claims`, `economic_revision_seals_guard`, `live_consumption_claims`                                                                                                                                                                                                                                                         |
| `core_source_revision`           | `economic_commit_log_guard`, `economic_revision_seals_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `decision_revisions`             | `economic_commit_log`, `economic_commit_log_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `economic_event_revisions`       | `card_purchase_recognition_keys_economic_claim_held`, `card_settlement_decisions_economic_claim_held`, `consumption_claim_conflicts`, `economic_claims`, `economic_claims_alias_one_live_holder`, `economic_claims_guard`, `economic_claims_one_live_holder`, `economic_commit_log_guard`, `economic_event_live_conflicts`, `economic_event_revisions_superseded_by`, `economic_event_times`, `economic_event_times_guard`, `economic_leg_effects_guard`, `economic_revision_seals`, `economic_revision_seals_guard`, `live_consumption_claims`, `unlogged_economic_revisions` |
| `economic_legs`                  | `economic_leg_effects`, `economic_leg_effects_guard`, `economic_legs_sealed`, `economic_revision_seals_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fetch_artifacts`                | `economic_claims_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fetch_runs`                     | `economic_claims_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `parse_runs`                     | `economic_claims`, `economic_claims_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `transaction_observations`       | `economic_claims`, `economic_claims_guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Migration number gap

0070 follows 0066 on main; 0067, 0068 and 0069 are held by other open pull
requests. Wrangler applies migrations by name and records each applied one,
and the repository's tests tolerate the gap (only 0001–0037 must be
contiguous). If those pull requests merge after 0070 is deployed, production
applies them after 0070 while a fresh database applies them before it; none
of them may therefore depend on 0070's objects or be depended on by it, and
`services/processor/test/lanes.test.ts` lists 0070 last today and must be
edited when they merge. If one of them rebuilds a table listed under "Rebuilding a table
0070 reads" and is applied after 0070 in production, it must drop and
recreate the listed 0070 objects as that section says.

### Deviations recorded in this PR

- **Account-prefixed leg subjects are not enforced.** The review wanted the
  seal to require `account:<id>` leg subjects for new writers; the card
  settlement writer still writes bare account ids (read through 0044's
  tolerance), and G1b keeps them until a reader audit. `account:` is the
  canonical form for every new writer.
- **Alias classes are checked in shape only.** 0070 checks that an alias class
  is a four-element array whose first element is the key's own source and
  whose component list is a non-empty array; it does not check that the
  account id is the row's currently mapped account, nor that each component
  is text. The writer's registry function is responsible for both
  (`validAliasClass` checks the types).
- **`after_log_start` is diagnostic only** (see the production gate).

### Acceptance tests B1–B13 (owner's list) and who owns them

None is tested here; each needs the selector or an engine adapter.

| Test                                                                    | Owner                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| B1 an old revision never returns at any cut after a correction          | #550 selector (ADR 0058)                                               |
| B2 a later commit does not change an earlier cut's result               | #550 selector (ADR 0058)                                               |
| B3 no double count raw/event, net/fee, trade/settlement (101 = 100 + 1) | #550 reconstruction and adapter (ADR 0058); the C side #556 (ADR 0059) |
| B4 an unknown snapshot boundary is indeterminate                        | #550 reconstruction (ADR 0058)                                         |
| B5 a zero remainder with incomplete coverage is never reconciled        | #550 reconstruction (ADR 0058)                                         |
| B6 unknown stays unknown                                                | #550 reconstruction (ADR 0058)                                         |
| B7 a lot that depends on an unknown order is held                       | #556 lots and adapter (ADR 0059)                                       |
| B8 a partial allocation keeps its basis                                 | #556 lots (ADR 0059)                                                   |
| B9 split and transfer lineage keep quantity and basis                   | #556 lots (ADR 0059)                                                   |
| B10 a sale after a withdrawal is never filled with a short              | #556 lots and adapter (ADR 0059)                                       |
| B11 a stale specific id is never reassigned                             | #556 lots (ADR 0059)                                                   |
| B12 history filled later gives a new cut and a new result               | #550 selector (ADR 0058) and #556 adapter (ADR 0059)                   |
| B13 the manifest is deterministic under permutation                     | #550 (ADR 0058) and #556 (ADR 0059)                                    |

Pointer (2026-10-09): B1, B2, B4–B6, the B side of B3, B12 and B13, and W11
are tested by [ADR 0058](0058-knowledge-selector-and-reconstruction-adapter.md#verification).

Pointer (2026-10-09): B7–B11 and the C side of B3, B12 and B13 are tested by
[ADR 0059](0059-lot-adapter-from-selected-revisions.md#verification) on
hand-built selections (no writer admits `security-quantity` yet); B9 is
tested as refused (`corporate_action_unsupported`,
`transfer_contract_pending`), the engine's own split lineage by ADR 0051.

### Not verified (owner items)

- Remote D1: that a trigger `RAISE` inside `batch()` rolls the whole batch
  back, and the CPU and statement limits of these JSON-heavy triggers. This
  needs an isolated synthetic remote database, which is a Cloudflare
  configuration change for the owner.
- SMBC `meisaiId` and SBI Shinsei `txnReferenceNo` stability and uniqueness
  across ranges and accounts.
- Whether production holds any SMBC or SBI Shinsei debit under two producers
  or namespaces.
- Whether the 0063 identity rewrite touched any key a live event holds.
- Whether an occurrence index shifts after a twin row disappears.

## External advice: adopted / adopted with change / deferred / rejected

The owner relayed advice (2026-10-08); a fresh design review compared each
item with the code. Its SQL sketches were not adopted as text.

| Advice                                                                                                      | Verdict                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Exclusivity on book × consumption key across every writer, card settlement included                      | Adopted with change: additive `economic_claims` plus views over the legacy holders; liveness from the claiming revision's `superseded_by`, never from allocation rows                                                                                                |
| Exclusivity unit = one economic fact, not an evidence row id; unresolved duplicates never asserted separate | Adopted with change: the 5-tuple stays the claim's row key; exclusivity for human-adopted writers is decided on a registry-declared provider-identity alias class. Refusals as in the eight rules above. Rule writers keep the 5-tuple under retire-before-recognise |
| 2. Separate revision content, proposal, head, decision, commit and read versions; seal children             | Adopted with change: seal table and commit log; existing digests and decision ids reused                                                                                                                                                                             |
| 3. Correct replaces whole; withdraw names the epoch; move verifies both heads atomically                    | Adopted; the settlement withdrawals table stays legacy; only `move` is atomic, withdraw-then-adopt surfaces `economic_claim_held`                                                                                                                                    |
| 4. A 0-row CAS is no error: an always-inserted, trigger-checked row                                         | Adopted with change: the commit row is the finalization, last in every economic batch                                                                                                                                                                                |
| 5. Identity meaning vs display; pins immutable; needs-review on change                                      | Adopted with change: identity pins and identity epoch in the seal                                                                                                                                                                                                    |
| 6. Select by knowledge cut before filtering; past holders from selected claims                              | Adopted (interface here; selector in #550)                                                                                                                                                                                                                           |
| 7. Type movement, breakdown, trade/settlement and snapshot boundary                                         | Adopted with change: additive `economic_leg_effects` and `economic_event_times`; an unknown snapshot boundary is indeterminate                                                                                                                                       |
| 8. Pin the lot policy fully; never order by ids or recorded time                                            | Adopted (in flight, #556)                                                                                                                                                                                                                                            |
| 9. Same-owner same-currency cash transfer first; securities transfers separate                              | Adopted; trade and FX kinds need their own migration                                                                                                                                                                                                                 |
| Staged migration without backfilling human decisions                                                        | Adopted with change: pure contract first, legacy holders through views, no backfill                                                                                                                                                                                  |
| Generic ledger / event bus; differential replay; complex cross-currency, many-to-many, short, tax           | Deferred                                                                                                                                                                                                                                                             |
| big.js / decimal.js / fast-check                                                                            | Rejected for now: exact decimals exist (INV03) and seeded random stores cover property testing                                                                                                                                                                       |
| Fingerprint-only identities for human-adopted writers                                                       | Rejected (refused: `identity_fingerprint_only`)                                                                                                                                                                                                                      |
| Do not claim atomicity across databases                                                                     | Adopted: the guard is one CORE batch; CORE and READ are separate bindings and nothing here spans them                                                                                                                                                                |
| A client-supplied actorKind is no approval proof; no AI approves                                            | Adopted (already true): the principal comes from the Access subject and grants, a commit requires a human, approvals are server-verified; no rule, AI or agent adopts own transfers                                                                                  |
| The manifest pins identity, aliases, coverage, snapshots, FX, policy and engine                             | Adopted: the interface is fixed here (Decision, manifest pins); #550 and #556 build the manifests                                                                                                                                                                    |
| The old card writers join the guard before own transfers are adopted in production                          | Adopted: the production gate                                                                                                                                                                                                                                         |
| D1 compatibility is tested on an isolated synthetic database, never by mutating production                  | Adopted; unverified until the owner creates one (Not verified)                                                                                                                                                                                                       |

Evidence for the alias-class row: ADR 0014 (producer change),
`descriptors.ts` (client-declared namespace), `docs/observations.md` (Vpass
1.1.0 and 1.2.0 id changes), ADR 0030 (0063 rewrite), 0052:31-32 and
0044:186,199 (producer-sensitive readiness), `docs/card-settlements.md`,
`packages/parsers/src/parsers/v-point-pay.ts` (digest ids).

## Verification

Synthetic data only. This PR tests:

- `packages/domain/test/economic-contract.test.ts`: key text equals SQLite's
  `json_array`; claim sets, release and sorting; heads, cuts, members and
  commit records with exact keys; alias classes carry no producer or
  namespace; `admitIdentity` cases T2a (occurrence fingerprints), T2b (a
  mirror's fingerprint id), T6a (digest ids), T7 (no recorded origin), T8
  (collector fingerprint under `externalIdOrigin`), the rule-writer case, and
  the pinned outcome of each of the 48 inputs of the closed shape.
- `packages/storage-d1/test/economic-commit-guard.test.ts`, on CORE migrated
  through every migration on main and then 0070: additivity (a store with a
  recognised purchase, two accepted settlements on one debit and an event
  with two live revisions has every row unchanged after 0070; the union view lists
  the legacy holders; the conflict and unlogged views list the
  inconsistencies); the current purchase and settlement writers unchanged;
  every raised code is the contract's; an adoption's claims, seal and commit
  row, and a replay that writes 0 rows; W2 (a supersede matching 0 rows
  raises `economic_commit_prior_not_superseded`, every table unchanged); P1
  and P2 (a correction or withdrawal that moves its prior's pointer without
  declaring it raises `economic_commit_supersession_undeclared`, so a dropped
  claim is never released silently and a double holder is never washed);
  the trigger lookups' query plans search indexes only; a
  stale batch writes 0 rows everywhere; a correction must list what it
  releases; W10 (same count, other key); dense sequence, `known_at`
  carried forward, gap and regression refused; seal counts; W3 (leg, claim,
  time, effect, and a card purchase key on a sealed purchase revision written
  by the lane's batch plus a G1b-style seal and commit); leg effects in one
  unit only; cross-writer one live holder in both orders, for settlements and
  for card purchase keys; T2c (two captures of one row sharing a 5-tuple); a
  released key with another live holder; T1 in both
  orders and its pinned legacy limit; T4; alias source; P11 (pins that a correction under the new epoch may supersede an old-epoch
  holder: routing is the planner's), T9 (the reserved resolution kind is refused outright, under the old
  epoch and the current one, and no receipt of that kind can be stored); the
  command tables can be rebuilt the 0051 way after 0070; epochs append-only; every 0070 table append-only.
- `services/processor/test/lanes.test.ts`: the migration pin includes 0070;
  the whole processor suite runs against the new triggers.

Not tested here: W1, W4–W9 and W11 need a writer (G1b and G3); remote D1.
G1b tests W1–W4 and W6–W9 and W5 for a two-member purchase split
([amendment](#amendment-g1b-as-implemented-2026-10-08)); W5 for `move`, W6's
re-adoption and W11 wait for G3 and #550. _Pointer (2026-10-09): see
[ADR 0057](0057-own-transfer-proposals.md#verification) for W5 (`move`) and
W6's re-adoption._

## Amendment: G1b as implemented (2026-10-08)

Status: accepted (merged 2026-10-09 in #589). Both card writers join the
guard. No migration: 0070 is unchanged and the schema ledger does not move.

### What each writer writes

- **Card purchase lane** (rule writer, retire-before-recognise;
  `packages/storage-d1/src/atomic/card-purchase-recognition.ts`). Every batch
  (recognize, revise, reanchor, retire, merge, split; rule or reviewed) appends,
  after its keys, one revision seal per member revision and the commit row,
  through `economicFinalizationWrites` under `decisionEntry` of the batch's
  first decision. The keys are the claims (book `card-usage`, through
  `economic_revision_claims`); no `economic_claims` row repeats them. Nothing is
  released: a revision restates its prior's keys, a merge's one member holds
  both events' keys and supersedes both, a split's two members (the retired
  merged event and the restored posted event) divide them; statement 1 checks
  each, and a draft that dropped a key is refused at the commit row
  (`economic_commit_released_mismatch`). Seal: writer release
  `card-purchase-recognition-v1:economic-guard-v1`
  (`CARD_PURCHASE_WRITER_RELEASE`), leg and key counts, the draft's content
  digest, no identity pin, the identity epoch the tick read
  (`CURRENT_IDENTITY_EPOCH_SQL`, once per tick; a reviewed merge or split reads
  it with the review). Commit row: kind `card-purchase.<action>`, principal the
  rule's actor (or the reviewer, with the operation), `payload_digest` the
  hex of the decision id, `known_at` the canonical instant of the lane's clock
  (`canonicalKnownAt`).
- **The decisionEntry decision.** The decision digest includes the writer
  release (`cardPurchaseDecisionId`), so no batch of this release reuses a
  pre-guard decision id. A pre-guard id replayed with the new tail while its
  revision is still live is sealed and logged then, with the replay's later
  `known_at` (test P9); one whose revision was superseded since is refused
  (`economic_seal_invalid`) and writes nothing. A guard-era revision that
  supersedes a pre-guard one is logged; its prior stays in
  `unlogged_economic_revisions`, never backdated.
- **Card settlement acceptance** (human-adopted writer;
  `services/processor/src/card-settlement-commands.ts`). After its decisions,
  event revision, legs and allocation: an `economic_claims` row (book
  `cash-movement`, the candidate's `bank_key`, re-derived by the 0070 trigger
  from the cited bank observation and parse run, the alias class below, the
  current identity epoch), then the accepted `card_settlement_decisions` row,
  then the seal (two legs, one claim, writer release
  `card-statement-settlement-v1:economic-guard-v1`, a content digest of the
  revision, its legs and claim, no identity pin), then the commit row (kind
  `card-settlement.accept`, the operation, the principal, the receipt's
  payload digest). The economic statements are entered on `receiptEntry` (the
  receipt for this operation, principal, payload digest and plan): the
  mutation planner receives the payload digest (`MutationInput.payloadDigest`).
- **Card settlement withdrawal.** Its `unknown` revision is sealed (no legs, no
  claims) and the commit row supersedes the accepted revision and releases its
  claim; the writer still writes `card_settlement_allocation_withdrawals` (its
  own legacy record). A release whose key another live holder also holds is
  refused (`economic_claim_conflict_unresolved`): the withdrawal plan reads the
  key half of `claim_available` (`CARD_SETTLEMENT_KEY_AVAILABLE_SQL`, by the
  candidate's id and the key index) and refuses with `needs_scope_resolution`
  and that code; a plan made before the second holder appeared is refused by
  the commit row and answered `commit_failed` with the code.
- **Ordering.** The commit row is the last _economic_ statement. The change
  lifecycle's approval, plan and outbox statements follow it in a reviewed
  batch, and the provider-linked merge's proposal, relation and resolution
  rows follow it in the lane; none of them is an economic row.
- **Evidence.** The settlement's event revisions cite the statement and bank
  rows as `SourceFactRef` objects; its decisions keep their id lists.

### Identity: the provider identity functions

`PROVIDER_IDENTITY_FUNCTIONS` in the transaction-family registry
(`packages/domain/src/event-families.ts`, registry version
`transaction-family-registry-v2`):

| Family (source, parser)                                     | Components (row `extra`) | Rule version                      | Scope                     |
| ----------------------------------------------------------- | ------------------------ | --------------------------------- | ------------------------- |
| `smbc-bank`, `smbc-direct-transactions`                     | `id` (the `meisaiId`)    | `smbc-meisai-id-v1`               | unique within one account |
| `sbi-shinsei-bank`, `sbi-shinsei-top-balances-and-activity` | `txnReferenceNo`         | `sbi-shinsei-txn-reference-no-v1` | unique within one account |

The alias class is `[source, components, resolved account id, rule version]`;
"within one account" is carried by the resolved account. Admission is
`humanAdoptedRowIdentity` (`packages/domain/src/row-identity.ts`): the
registry's external id basis, plus, for a provider id, the row's own
`_kogane.identityOrigin` (`provider-id` or the id counts as unrecorded). The
plan refuses with `unsupported_semantics` and the closed code as the second
ref; the commit's planner returns nothing for a refused row. Consequence:
**SBI Shinsei debits can no longer be accepted** (`identity_origin_unrecorded`,
rule 2): their parser records no origin, and no parser was changed here. Their
function is declared, so a parser release that records the origin admits them.
The only other route, treating ADR 0018's reviewed adapter evidence as the
declared origin, would need an owner-approved amendment of rule 2; it is not
taken.
The registry lists SBI Shinsei's card-settlement membership as unsupported.

**2026-10-09: a parser release records the origin.** The owner chose the
parser-release route over a rule exception
([ADR 0018 note](0018-sbi-shinsei-bank-debit-adapter.md#2026-10-09-release-013-records-the-provider-id-origin)).
`sbi-shinsei-top-balances-and-activity` 0.1.3 records
`_kogane.identityOrigin: provider-id` on every activity row, with the external
id and every other field unchanged, and the declared function above admits
such a row; rule 2 and the function are unchanged. The registry becomes
`transaction-family-registry-v3`: the entry records its origin under
`identityOrigin`, and SBI Shinsei's card-settlement membership is `supported`
again. The admission still reads each stored row, so a row a 0.1.2 run stored
is refused (`identity_origin_unrecorded`) until the repair lane has re-parsed
its capture under 0.1.3. The release is deployed by the CD release of the
commit that merges it (`deploy.yml` releases every green CI run on main), and
the repair lane then re-parses the stored captures without an operator step:
the owner's merge is the deploy and re-parse decision. The reference's stability and
uniqueness stay as listed under Not verified: the owner's read-only
confirmation covers the captured range only, and nothing shows the provider
never reuses a reference.

### Readiness, heads and refusals

- `card_settlement_readiness`'s keyed CTEs gain `claim_available`: no live
  holder, other than the candidate's own accepted event, of its `bank_key` in
  `economic_claims` or among accepted settlements, nor of its debit's alias
  class (`providerAliasClassSql`, the SQL form of `declaredAliasClass`). The
  plan read and the acceptance guard require it; on 0 the plan answers
  `stale_context` with `economic_claim_held` (the key is held) or
  `alias_conflict`. The four existing columns keep the text frozen at 4a64ba0
  (`packages/read-model/test/card-settlement-readiness-ctes-legacy-sql.ts`,
  digest-pinned), compared on the random and scaled stores.
- `REVISION_OF` answers `economic-event:<id>` as the highest revision while it
  is live, its negation once it is superseded without a newer revision of its
  own (merged away), and 0 when there is none: one integer carrying head and
  liveness. The settlement plans pin it (0 for an acceptance, the accepted
  revision for a withdrawal); `card-purchase:` keeps its meaning.
- A batch a 0070 trigger refuses is answered by the commit with the code as
  the second ref: `stale_context` for `economic_claim_held`, `alias_conflict`,
  `identity_epoch_changed`, `economic_commit_prior_not_superseded`,
  `economic_event_live_conflict`, `economic_revision_sealed`; `commit_failed`
  for the others. Other batch errors propagate as before. The lane counts a
  refused batch as `failed`.

### Limits kept

- Leg subjects stay bare account ids for the settlement (read through 0044's
  tolerance); `account:` stays the canonical form for new writers, and
  changing the settlement needs a reader audit (not done).
- The settlement withdrawals table stays the settlement writer's own record.
- Settlements accepted before G1b carry no alias class: the same debit under
  another key is not seen as their alias.
- The alias class carries the resolved account, so one debit collected under
  two producers or namespaces is caught only when both source accounts resolve
  to one account (as after an operator's identity assignment for a producer
  switch); while they are two accounts they are two classes. Whether production
  holds such a debit is not verified.
- Neither writer pins an identity revision in its seals (only the identity
  epoch), and neither writes event times or leg effects.
- The `カード照合` list does not show `claim_available` (its review contract has
  no field for it); a review it shows as ready can be refused at plan time.
- Two concurrent batches of one operation: the second is refused by the 0029
  operation ledger (a raise, nothing kept) or replays; a resend then returns the
  receipt. Unchanged by G1b.
- When a held key and a held alias class both refuse a claim, which code is
  raised is the order in which SQLite fires the two triggers; on workerd and
  bun:sqlite it is `alias_conflict`, and nothing relies on it.
- Not verified: remote D1 (rollback, CPU and statement limits of the triggers,
  as before); SMBC `meisaiId` and SBI Shinsei `txnReferenceNo` stability and
  uniqueness; the cost of the new trigger and readiness work on remote D1.

### Deviations recorded in this amendment

- The decision called SMBC "one account". It is declared for every SMBC source
  account and made unique within one resolved account through the alias class,
  because the class already carries the account; a narrower source-account
  list would only make a future SMBC account unsupported, never stop a double
  count.
- The lane's commit `payload_digest` is the decision digest (a rule writer has
  no receipt).
- `economic-event:` carries liveness as a sign, since an expected revision is
  one integer.
- The commit row is the last economic statement, not the last statement of a
  reviewed batch (above).

### Verification of the amendment (synthetic data only)

- W1 PROC (`services/processor/test/economic-card-settlement.test.ts`): the
  real settlement writer and a synthetic own-transfer-shaped writer on one
  `bank_key`, in both orders, through plan, approve and commit: the second is
  refused with `economic_claim_held` (by the writer's trigger, by the plan, by
  the reservation guard of an earlier plan, and by the claim trigger when that
  guard is dropped), every table unchanged. W1 SD1 stays the G1a statement-shape
  tests: a storage test cannot run the processor's planner.
- T1 PROC: one SMBC debit under two producers and namespaces, resolved to one
  account: settled on A, B is `alias_conflict` (plan, earlier plan, trigger),
  every table unchanged, while the 0044 view still calls B ready.
- W2 PROC (a withdrawal pointer matching no row) and SD1 (G1a); W3 PROC
  (settlement) and SD1 (purchase merge); W4 PROC (a synthetic correction onto a
  debit a settlement holds: refused, every table unchanged, the old claim
  held); W5 SD1 (`packages/storage-d1/test/economic-card-purchase-lane.test.ts`:
  the two-member split fails whole at any statement, its second half
  included); W6 PROC (a withdrawal planned before another withdrawal:
  `stale_context`, no commit row); W7 and W8 PROC; W9 PROC (a failure at every
  statement of an acceptance) and SD1 (the split). W10 SD1 (G1a).
- A withdrawal that would wash a pre-existing double holder (two settlements
  accepted on one debit the pre-G1b way): refused at plan time and, for a plan
  made before the second holder, at commit, every table unchanged (PROC; the
  plan's refusal also in `packages/application/test/card-settlement-plan.test.ts`,
  its SQL against the CTEs and its plan in the readiness test). An SBI Shinsei
  acceptance made before G1b still reserves every candidate of its provider id
  in the view and in `claim_available`, and the G1b withdrawal releases it
  (`services/processor/test/card-settlement-sbi-shinsei.test.ts`).
- Deferred, with the reason: W5 for `move` and W6's re-adoption need the own
  transfer writer (G3); W11 needs the knowledge selector (#550, ADR 0058).
  _Pointer (2026-10-09): W5 for `move` and W6's re-adoption are tested by
  [ADR 0057](0057-own-transfer-proposals.md#verification) against its
  planners and a synthetic writer (no own-transfer writer ships)._
- Purchase lane: sealed and logged batches, replays, released-key refusal,
  pre-guard replays, merge and split commits, stale epochs and the
  `economic-event:` head (SD1); the job sealing under the epoch its tick read
  (`services/processor/test/card-purchase.test.ts`).
- Identity: `packages/domain/test/row-identity.test.ts` (every refusal, the
  scope, classes free of producer, namespace and id text) and the plan's
  refusals (`packages/application/test/card-settlement-plan.test.ts`). T3's
  human side is the Vpass fingerprint refusal there; its rule side is the
  lane's existing ordinal and producer-switch tests, which now also seal.
- Readiness: `packages/read-model/test/card-settlement-readiness.test.ts`
  (frozen columns, `claim_available` against its definition, six mutations,
  plan without statistics) and
  `packages/application/test/card-settlement-review-scale.test.ts` (scaled
  store).

## Amendment: G2 as implemented (2026-10-09)

Status: accepted (merged 2026-10-09 in #591). G2 is the command-kind
vocabulary only: four kinds, their payload shapes and their refusal. No
planner, no writer, no own transfer.

### The vocabulary

Migration `0071_economic_event_command_kinds.sql` rebuilds `change_plans`,
`approvals`, `operation_receipts` and `decision_outbox` as one foreign-key
graph, statement by statement as 0058 did (itself 0051): create the
`*_expanded` tables, copy every row with explicit column lists, drop the old
tables leaf-first, rename, and recreate every index and trigger unchanged. The
only difference is the kind CHECK on `change_plans.kind` and
`operation_receipts.operation_kind`, which gains `economic-event.adopt`,
`economic-event.correct`, `economic-event.withdraw` and `economic-event.move`.
The same four are `ECONOMIC_EVENT_COMMAND_KINDS`
(`packages/domain/src/economic-event-commands.ts`), the tail of `CHANGE_KINDS`
(`packages/application/src/command/contract.ts`).

Payloads take exact keys (`validEconomicEventCommandPayload`, which
`validPayload` calls). Every one names a `family` from the transaction-family
registry (`TRANSACTION_FAMILIES`), so a planner can refuse a family it does
not cover, and a non-blank `reason` of at most 1000 characters. No payload
carries an amount: a restated leg cites its transaction row, and the value is
that row's.

| Kind                      | Payload                                                                                   | Checked                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `economic-event.adopt`    | `{ family, proposalId, reason }`                                                          | the proposal reference, text of at most 512 characters                                                                                                                                             |
| `economic-event.correct`  | `{ family, eventId, priorRevision, revision, releasedClaims, reason }`                    | `priorRevision` ≥ 1 is superseded by the restated `revision`, which is not `unknown` (that is a withdrawal); `releasedClaims` is a claim set (at most 64) of which no claim is restated            |
| `economic-event.withdraw` | `{ family, eventId, revision, decisionRevisionId, reason }`                               | `revision` ≥ 1, the revision withdrawn; `decisionRevisionId` the decision that adopted it (its epoch), text of at most 256 characters                                                              |
| `economic-event.move`     | `{ family, claim, from, to, reason }`, each member `{ eventId, priorRevision, revision }` | two different events, `priorRevision` ≥ 1 each; `claim` is absent from `from`'s restated claims and present in `to`'s; `to` is not `unknown` (`from` may be, when the moved claim was all it held) |

A restated revision is `{ kind, state, unknownReason, legs, claims }`: the
state belongs to the kind's state family, `unknownReason` is set exactly when
the state is `unknown`, an `unknown` revision has no legs and no claims (the
withdrawal shape) and any other has at least one of each; at most 64 legs,
indexed 0..n−1 once each, and at most 64 distinct claims. A leg is
`{ legIndex, subjectRef, role, basis, source }` with `subjectRef` in the
canonical `account:<id>` form and `source` a `SourceFactRef` of kind
`transaction`. What a prior revision held, whether the proposal, event or
decision exists, and what a move's `from` member drops besides the moved claim
are a planner's to read against the store (G3); the shapes are exercised only
by validation and refusal tests today.

### Refusal, for every principal

`ECONOMIC_EVENT_PLANNERS` (`packages/application/src/operations/targets.ts`)
is empty, so `resolveAndSimulate` answers `unsupported_semantics` with the
kind as its ref, and:

| Step       | Human operator                                                                                                                                                                                                                 | Agent (also one carrying `interpretation.accept`) |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `plan`     | `unsupported_semantics`, no row                                                                                                                                                                                                | `unsupported_semantics`, no row                   |
| `simulate` | `unsupported_semantics`                                                                                                                                                                                                        | `unsupported_semantics`                           |
| `approve`  | `unsupported_semantics`, no approval (new: `approve` re-checks an economic-event plan's eligibility)                                                                                                                           | `approval_required`, before the plan is read      |
| `commit`   | `unsupported_semantics`, nothing written: `commit` re-checks the plan's eligibility before any writer runs, so even a writer slot that would write is never called (the processor's slot `economicEventMutation` answers null) | `approval_required`                               |

The `approve` and `commit` rows hold for a plan row, and an approval row,
inserted directly: the lifecycle never writes either for these kinds. A
malformed payload is still `invalid_command`, before the missing planner. No
rule writer uses the change lifecycle, and the authority rule above (no rule,
AI or agent adopts, corrects, withdraws or moves an own transfer) is not
loosened by anything here. _Pointer (2026-10-09): see [ADR 0057](0057-own-transfer-proposals.md): nothing adopts while the production gate is unmet; who may act is decided by the lifecycle's grants, with no principal-kind rule here._

### The identity-resolution exemption stays closed (owner question)

The Decision said G2 would open the reserved `economic-event.resolve-identity`:
add it to the receipt vocabulary with its planner and recreate
`economic_commit_log_guard` so the exemption needs a receipt of that kind. G2
does neither. The kind is not in either CHECK, not in `CHANGE_KINDS`, and 0070
keeps refusing it outright for every principal (`identity_epoch_changed`);
0071 drops and recreates no 0070 object. Opening an exemption to the epoch
rule without a reviewed resolution flow, a planner and an owner decision would
be a guess. Open owner question, as written:

> Should `economic-event.resolve-identity` become a command kind, and should
> CORE's commit trigger then let a commit of that kind seal a member under an
> identity epoch that is no longer current when an operation receipt of that
> kind exists for the commit's operation and principal? Until the owner
> answers, 0070 keeps refusing the kind for every principal, no plan or
> receipt of it can be stored, and no migration recreates
> `economic_commit_log_guard`.

Consequence: the rule that a later rebuild of `operation_receipts` must drop
and recreate `economic_commit_log_guard` does not apply yet, because no 0070
object reads a command table. It applies from the migration that adds the
binding, if the owner chooses one.

### The rebuild and "Rebuilding a table 0070 reads"

0070 reads no command table, so 0071 drops nothing of 0070's: it drops
exactly the four old command tables. Proven on a store migrated through 0070
with history of every earlier kind and status
(`packages/storage-d1/test/economic-command-kinds-migration.test.ts`): every
row of every table, every index and trigger (byte-identical SQL) and the
column and foreign-key shape are unchanged, with `PRAGMA foreign_key_check`
empty after each statement; the table SQL differs only in the widened CHECK;
every 0070 index, trigger and view (by name, from applying 0070 to a store
migrated through 0069) has the same `sqlite_master` row before and after, as
does every object outside the four tables; a fresh store migrated through 0071
has the same 0070 objects as one stopped at 0070; the four kinds are admitted
and `economic-event.resolve-identity` and look-alike kinds refused in both
tables; the append-only and forward-only triggers still fire; an interrupted
0071 rolls back whole. The G1a test that rebuilds `operation_receipts` the
0051 way now runs on a store that includes 0071.

### Migration number gap

0071 follows 0070. 0067 is still held by an open pull request, so the gap
rule above applies unchanged: if it merges after 0071 is deployed, production
applies it after 0071 while a fresh store applies it before, neither may
depend on the other, and `services/processor/test/lanes.test.ts`, which lists
0071 last today, is edited when it merges. A later rebuild of the four command
tables carries 0071's kind list.

### Limits kept

- Nothing is executable: no planner, no writer, no own transfer; the
  production gate is unchanged.
- `economic_commit_log.kind` stays free text (0070). Nothing ties a commit
  row's kind to the command vocabulary; no writer writes these kinds, and
  binding them (through the receipt the commit is entered on) is G3's.
  _Pointer (2026-10-09): still open; ADR 0057 (G3-a) adds no writer, so the
  binding belongs to the writer (G3-b)._
- The confirmation screen has no label for the four kinds; no plan of them
  can exist and no screen offers them.
- A `correct` or `move` with many legs and claims can exceed the command API's
  16 KiB body limit (`services/app/src/command-api.ts`); the planner that
  reads them decides how a large restatement is split.
- Not verified: applying 0071 to remote D1.

### Deviations recorded in this amendment

- The identity-resolution exemption is not opened (above).
- `approve` now refuses a plan of an economic-event kind while its planner
  refuses it; a planted plan of a card review kind is still approvable and
  refused only at commit, as before.
- `commit` re-checks an economic-event plan's eligibility (its planner)
  before it calls the kind's writer, not only after a writer answered null.
  Defence in depth found by the G2 review: a writer slot registered without
  its planner, given a planted plan and approval, would otherwise have
  committed its writes. The shipped slot answers null, so this was not live;
  the check means G3 cannot open a writer without its planner.
- The `family` field is required by the payload contract, not by a CHECK:
  like 0045, 0051 and 0058, 0071 changes the kind lists and nothing else.

### Verification of the amendment (synthetic data only)

- `packages/storage-d1/test/economic-command-kinds-migration.test.ts` (6
  tests): the rebuild proof above.
- `packages/domain/test/economic-event-commands.test.ts` (6 tests): the four
  kinds without the reserved one; exact keys, closed family and reason per
  kind, with amounts, approvals and revision pins refused and no kind's
  payload read as another's; adopt and withdraw references; correct's
  restatement and released claims; a restated revision's completeness, leg
  shape and absence of values; move's two members.
- `packages/application/test/economic-event-plan.test.ts` (10 tests): no
  planner registered; the reserved kind refused as an unknown kind; per kind,
  plan refused for a human, an agent and an over-granted agent with no row
  written and a malformed payload still `invalid_command`; per kind, a planted
  plan refused at simulate, approve (human: `unsupported_semantics`; agents:
  `approval_required`) and, with a planted approval, at commit (with an empty
  slot, no slot, and a slot whose writer would write a valid row), every
  table of the store (command, economic, decision and outbox tables
  included) compared row for row after each refused step, and the approval
  unspent.
  `packages/application/test/command.test.ts`: the closed kind list and the
  dispatch to the vocabulary's validator.
- `services/processor/test/change-lifecycle.test.ts`: every kind through the
  processor's command routes (plan, simulate, approve, commit) as a human and
  as an agent, refused with nothing written, and each kind's writer slot.
- `services/processor/test/lanes.test.ts`: the migration pin includes 0071.
