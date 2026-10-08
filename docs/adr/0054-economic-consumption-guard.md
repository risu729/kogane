# ADR 0054: One consumption guard for every economic writer: claims, seals and a commit log

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issues: #549, #550, #556
- Carried by: [economic events](../economic-events.md#common-consumption-guard-migration-0070),
  `packages/domain/src/economic-contract.ts`,
  `packages/storage-d1/migrations/core/0070_economic_commit_guard.sql`,
  `packages/storage-d1/src/atomic/economic-commit.ts`

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
  not monotonic. A resend returns the original receipt and sequence. Revisions
  written before the log, or by an older build after it, are listed by
  `unlogged_economic_revisions` and read as `knowledge_unlogged`, never
  backdated.
- **Identity pins and epochs.** Seals pin identity revisions; display names
  are not pinned. `economic_identity_epochs` is append-only, seeded with
  `identity-epoch-1`; a declared identity rewrite (as 0063 was) appends the
  next epoch. A commit whose member is sealed under a non-current epoch is
  refused (`identity_epoch_changed`) unless it is a reviewed identity
  resolution: kind `economic-event.resolve-identity` **and** an operation
  receipt of that kind for the commit's operation and principal. The
  receipt kind CHECK (0051) admits no such kind, so the exemption is closed
  until the vocabulary migration that adds it together with its planner; a
  rule writer, or any writer that only names the kind, is refused.
  That is all 0070 enforces about epochs: a new seal under the current
  epoch. It does **not** refuse a commit that supersedes a holder sealed
  under an older epoch, because it cannot tell which such supersession needs
  review: the card purchase lane under retire-before-recognise keeps
  auto-revising after a rewrite ([ADR 0002](0002-card-purchase-recognition.md)),
  and a reviewed correction or withdrawal is itself the explicit review.
  Routing old-epoch holders to needs-review (`identity_epoch_changed`, holder
  kept) is the planners' job (G3) and the selector's (#550, ADR 0058).
- **Knowledge selector interface** (#550, ADR 0056): a cut is
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
  duplicate storage; the lane is a rule writer under retire-before-recognise).
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
  every new kind is `unsupported_semantics`. Amends this ADR.
- **G3:** ADR 0055 and migration 0072, own-transfer proposals (proposal-only)
  and their planners, behind the production gate below.
- **Later:** widening the event kind CHECK (0032) for trades and FX, and the
  securities writer that admits `security-quantity`.

### Production gate

Own-transfer adoption cannot be enabled before both card writers write
claims, seals and commit rows, `unlogged_economic_revisions` has no row after
the log start, and the D1 compatibility tests are green (on an isolated
synthetic remote database).

### Rollback

Turn off the planner registration or flag. The migration stays: an older
build keeps working (the new triggers only refuse cross-writer double claims
and additions to sealed revisions, neither of which an older build makes),
and its revisions show as unlogged, read fail-closed. Schema-floor rules as in
[economic events](../economic-events.md#deploy-order-and-rollback).

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
  all 48 inputs of the closed shape.
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
  unit only; cross-writer one live holder in both orders; the legacy purchase
  key trigger; T2c; a released key with another live holder; T1 in both
  orders and its pinned legacy limit; T4; alias source; P11 (pins that a correction under the new epoch may supersede an old-epoch
  holder: routing is the planner's), T9 (also refused for a rule writer that names the resolution kind, and no
  receipt of that kind can be stored) and the reserved
  resolution kind; epochs append-only; every 0070 table append-only.
- `services/processor/test/lanes.test.ts`: the migration pin includes 0070;
  the whole processor suite runs against the new triggers.

Not tested here: W1, W4–W9 and W11 need a writer (G1b and G3); remote D1.
