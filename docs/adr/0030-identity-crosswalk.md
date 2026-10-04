# ADR 0030: A one-time identity-value rewrite from importer-era to collector-era account identities (first decided as a crosswalk)

- Status: the crosswalk decision (2026-09-27, merged in
  [#279](https://github.com/risu729/kogane/pull/279)) is superseded by the
  [amendment of 2026-09-28](#amendment-2026-09-28-a-one-time-identity-value-rewrite-replaces-the-crosswalk),
  accepted for its staging migration 0062
  ([#357](https://github.com/risu729/kogane/pull/357)); its rewrite migration
  0063 is proposed and accepted when the change that carries it merges. The
  file keeps its name so that links to it stay valid.
- Date: 2026-09-27; amended 2026-09-28; 0063 recorded 2026-09-29
- Carried by (amendment):
  `packages/storage-d1/migrations/core/0062_identity_value_rewrite_staging.sql`,
  `packages/storage-d1/migrations/core/0063_identity_value_rewrite_apply.sql`,
  `packages/storage-d1/src/core/identity-store.ts` (`sourceAccountId`),
  `scripts/core-schema-ledger.ts`,
  [identity operations](../identity-operations.md#one-time-identity-value-rewrite),
  `packages/storage-d1/test/identity-value-rewrite-migration.test.ts`,
  `services/processor/test/moneyforward-producer-switch.test.ts`,
  `packages/application/test/command.test.ts`
- Carried by (crosswalk, removed by the amendment):
  `packages/storage-d1/src/core/identity-crosswalk.ts`,
  `packages/application/src/operations/identity-crosswalk.ts`,
  `services/processor/scripts/identity-crosswalk-proposals.ts`, the
  `identity.crosswalk.accept` kind and its tests;
  `packages/storage-d1/migrations/core/0058_identity_crosswalk.sql` stays as
  history.
- Related: [ADR 0023](0023-vpass-collector-card-binding.md) and
  [ADR 0027](0027-moneyforward-collector-account-identity.md) (the importer's
  entity for an identity value, whichever producer read it),
  [ADR 0017](0017-card-purchase-review-commands.md) (the last widening of the
  command vocabulary, which 0058 repeats),
  [ADR 0029](0029-data-classification-and-unkeyed-identity.md) (collectors
  that derive their identity values without the lost key),
  [mutation policy](../design.md#mutation-policy)

The sections from Context to Verification are the crosswalk decision as it
was made on 2026-09-27. The code they name no longer exists; what replaced it
is the [amendment](#amendment-2026-09-28-a-one-time-identity-value-rewrite-replaces-the-crosswalk).

## Context

The retired importer (`collector-r2-importer`) registered every Vpass card
under a token `vpass-card-v1-<64 hex>` and every MoneyForward ME account
under an identity `moneyforward-account-v1-<64 hex>`, each an HMAC under the
importer's secret key. That key is lost. A collector that derives its values
any other way (another key, or the keyless derivation ADR 0029 adopts,
`vpass-card-v2-…` and `moneyforward-account-v2-…`) produces a different
value for the same card or account. ADR 0023 and ADR 0027 derive the account
entity of a value from the importer's reference for that value, so a
different value is a different entity: the UI shows two accounts per card or
account, with the history split at the producer switch (2026-09-12).

The stored evidence already says which old value a new one continues: the
importer and the collector captured some of the same provider rows, the
importer under the old value and the collector under the new one. The owner
decided that this one time the two are joined by hand, from that overlap.

Two facts about the rows decide how the overlap can be measured:

- A Vpass statement line's external id is derived from the sanitized row, the
  card ordinal, the month, the family and the page (parser 1.2.0), not from
  the token, so both producers' captures of one line carry the same id when
  both numbered the card and the page alike.
- A MoneyForward transaction's external id is
  `moneyforward-monthly:<fingerprint>:<occurrence>`, and the fingerprint
  covers the account identity. The same row therefore has two different ids
  in the two eras. What the fingerprint covers besides the identity (the
  selected month, the date, the description and the amount) plus the
  occurrence counter is the same. The comparison reads the stored
  observation's `amount_text` (the parsed signed amount), not the cell text
  the fingerprint hashed; two cells that differ only in formatting compare
  equal, which a capture of one row by two producers cannot tell apart
  anyway.

## Options considered

1. **Do nothing.** Rejected by the owner: every card and MoneyForward account
   the importer knew stays two accounts, and nothing keyed by the entity
   (label, role, status, ownership links, card purchase `account_id`) follows
   the account across the switch.
2. **Merge automatically by overlap.** Rejected: an overlap is a heuristic
   (INV07). Two accounts can show identical rows (the same merchant, date and
   amount on two cards; two MoneyForward accounts with identical rows), a
   collector capture may overlap nothing, and an automatic join cannot be
   told apart from a mistake afterwards. Heuristics only propose.
3. **An operator-accepted crosswalk from proposals.** Chosen. A read-only
   script measures the overlap and prints counts and a verdict; the operator
   records one crosswalk per card or account through the change lifecycle,
   which pins the counts and re-measures them inside the commit; the identity
   store reads the recorded row.

For how the decision is recorded:

4. **An ops route behind the operator subject** that writes the row. The
   brief's fallback. Not needed: the lifecycle already has what this needs
   (plan digest, server-side re-measurement, human-only approve and commit,
   a guarded batch), and a kind costs one vocabulary widening that 0051
   already rehearsed.
5. **A new change kind, `identity.crosswalk.accept`.** Chosen. No rejection
   kind: not recording is the rejection.

## Decision

- **Proposal (read-only).** `services/processor/scripts/identity-crosswalk-proposals.ts`
  runs one SELECT (`CROSSWALK_PROPOSALS_SQL`) through
  `wrangler.diagnostic.jsonc` and prints one JSON line per (new value, old
  candidate): `{source, newKeyRef, oldKeyRef, sharedRows, newOnlyRows,
oldOnlyRows, months, verdict}`, then `{summary}` with a count per verdict.
  The rows compared are the current transaction observations
  (`current_identity_observations`, published parses of successful runs)
  that the identity layer filed under a value: `["vpass:card", <token>]` or
  `["moneyforward-me:<identity>"]`, `v1` or `v2`, 64 lowercase hex. A value
  is importer-era when its source account's producer is
  `collector-r2-importer`, collector-era otherwise. A row is its external id
  (Vpass) or the fingerprint inputs other than the identity plus the
  occurrence (MoneyForward). `months` counts the distinct `as_of` months of
  the shared rows. The verdict is `unique` when the new value shares rows
  with exactly one old value and that old value shares rows with no other new
  value, `ambiguous` for any other shared row, and `none` when nothing is
  shared (then `oldKeyRef` and `oldOnlyRows` are null: there is no old side
  to count). A collector-era value the importer also carries (a collector
  that held the importer's key) is already the importer's entity and is not
  listed. Only identity values (opaque hashes) and counts leave the SQL.
- **Command.** `identity.crosswalk.accept` with payload
  `{source, fromRef, toRef, sharedRows, newOnlyRows, oldOnlyRows, months,
reason}` (`fromRef` the old value, `toRef` the new; both values of the
  source's shape; `sharedRows` and `months` at least 1; no other key). The
  plan recomputes the pair (`CROSSWALK_PAIR_SQL`) and refuses:
  `target_ambiguous` when either value is already in a crosswalk, or the pair
  is not one-to-one; `incomplete_evidence` when nothing is shared;
  `stale_context` when the counts differ from the payload's; `target_missing`
  when the importer-era entity or the collector's source account is absent.
  Its expected revisions pin the decision subject
  `proposal:identity-crosswalk|<source>|<fromRef>|<toRef>` (the existing
  `proposal:` revision rule: the highest decision revision recorded about it)
  and the current mapping revision of every collector source account that
  carries the new value. Agents may plan it; only a human approves and commits
  it (`approval_required` otherwise), as every kind.
- **Commit.** The reservation carries `CROSSWALK_PRECONDITION_SQL`: the pair
  measured again inside the write equals the pinned counts and is still
  one-to-one, neither value is in a crosswalk, and the importer-era entity
  exists. Under the receipt it appends a `decision_operations` row, a
  `decision_revisions` row (`relation`, the subject above, `accept`,
  `manual`, the operator), the `account_identity_crosswalk` row (evidence
  `{sharedRows, newOnlyRows, oldOnlyRows, months, proposalDigest}`), and for
  each pinned collector source account whose current mapping is automatic,
  unprotected and points elsewhere, a new `rule` mapping revision that points
  at the importer-era entity with the same policy version, reason, label and
  status. Nothing is updated or deleted. A manual decision on a collector
  source account is left as it is.
- **Table (migration 0058).** `account_identity_crosswalk`: id, `source_id`
  (`vpass` or `moneyforward-me`), `from_account_ref`, `to_account_ref`,
  `evidence_json`, `decision_revision_id`, `operation_id`, `actor_id`,
  `created_at`; UNIQUE per (source, old) and per (source, new); value shapes
  and `from<>to` checked; append-only triggers. Classified `core-keep`
  (decisions and relations). It is outside the source-revision ledger: no
  projection reads it, and what it changes reaches projections through
  `decision_revisions` and `account_mappings`, which are in it. The same
  migration rebuilds `change_plans`, `approvals`, `operation_receipts` and
  `decision_outbox` exactly as 0051 did, adding the one kind to both kind
  CHECK constraints.
- **Entities.** `accountEntityId` first looks the value up
  (`SELECT from_account_ref … WHERE source_id=? AND to_account_ref=?`, the
  UNIQUE index) for a trusted Vpass token or a MoneyForward identity, `v1` or
  `v2`. With a row, the entity is the importer-era value's; without one,
  nothing changes. Only the new value is looked up, and only for those two key
  shapes.

## Consequences

- **One time, not a merge feature.** The kind joins one collector-era value
  to one importer-era value of the same source, on stored overlap, once per
  value. It cannot join two importer-era values, two collector-era values,
  or values of other sources, and a crosswalk is not undone by a command
  (it would need its own decision; none exists).
- **What joins.** From the commit on, the collector's source account for the
  new value maps to the importer-era entity by rule, and so does every later
  identity run of it. What is keyed by the entity carries over as in ADR 0023
  and ADR 0027; what is keyed by the importer's source account (its mapping
  revisions and manual decisions) does not. The collector-era entity the
  value had before stays in `accounts` (append-only) with no current mapping
  to it from that source account.
- **What does not change.** No observation, parse or snapshot moves, and
  which capture is current does not change. For MoneyForward the current
  snapshot is ranked per unit key and month, and the unit key is the
  identity, so the months both producers captured stay two snapshots: after
  the crosswalk the transactions read still lists those rows under two
  source accounts, now of one account entity (ADR 0027's limit; MoneyForward
  emits transactions only, so no balance or total is computed over them).
  For Vpass, card-month currentness in the purchase lane ignores the producer
  (ADR 0014), as before.
- **Coincidental rows.** A row key is not an account identifier. Two
  accounts can carry an identical row (for MoneyForward the same month,
  date, description, amount and occurrence; for Vpass the same external id,
  which needs the same card ordinal and page as well). Such a row in another
  account turns a real match into `ambiguous`, which cannot be recorded, and
  a new value whose true counterpart the importer never captured can be
  `unique` against another account on coincidental rows alone. The verdict
  is therefore only a proposal: the operator reads `sharedRows` against
  `newOnlyRows` and `oldOnlyRows` (a real continuation shares most of the
  months both captured) before planning, and nothing is recorded without
  that decision.
- **No overlap, no join.** A card or account whose collector capture shares
  no stored row with the importer's (the collector captured only later
  months, or the Vpass card or page numbering changed) is `none` and stays
  split. So does an `ambiguous` one. Both are listed as limits
  ([roadmap](../roadmap.md#current-position)).
- **Vpass today.** The collector's statement pages are registered without a
  parser dataset (ADR 0023), so no collector-era Vpass row is identified and
  every Vpass proposal is empty until that is released. The MoneyForward
  proposals can be run now.
- **Card purchases.** The purchase lane revises an event whose account
  mapping changed ([economic events](../economic-events.md#revisions-retirement-and-idempotency)),
  so a Vpass event recognised on the collector-era entity would move to the
  importer-era one. None exists today (above), and this change adds no test
  of it.
- **Production.** Nothing here reads production. The owner runs the script
  and decides.

## Verification

- `services/processor/test/identity-crosswalk.test.ts` (whole CORE schema,
  Miniflare): a Vpass card captured by the importer (April, May) and by the
  collector under another token (May) proposes exactly one `unique` line with
  2 shared, 0 new-only, 1 old-only rows in 1 month; a second importer-era
  value sharing one line makes both candidates `ambiguous`, a collector card
  that shares nothing is `none`, and an ambiguous pair cannot be planned; the
  command: counts the server does not measure are refused before a plan
  exists, an agent may plan but its approval is `approval_required`, a
  commit after the collector captured April too is `stale_context` and
  writes no crosswalk, decision, mapping or receipt, the re-measured
  proposal (3 shared, 2 months) commits, recording the row with counts-only
  evidence, an `accept` decision and a `rule` revision 2 on the collector's
  source account pointing at the importer-era entity (revision 1 kept, the
  importer's mapping untouched), a second approved plan of the same pair is
  `stale_context` and a new plan for the same values `target_ambiguous`; after
  the crosswalk a new collector capture is attributed to the importer-era
  entity with no extra revision, and a newer policy run's rule revision names
  that entity, where without a crosswalk it names the collector's own; a
  MoneyForward account captured by the importer under a `v1` identity and by
  the collector under the `v2` identity it derives from the page (ADR 0029),
  whose four February rows carry four distinct external ids, proposes
  `unique` (2 shared, 2 old-only, 1 month); before the crosswalk the `v2`
  value maps to its own entity, the committed crosswalk maps the collector's
  source account to the importer-era entity, and a newer policy run's rule
  revision names that entity. The collector-era Vpass tokens are
  `vpass-card-v2-` values bound in the collector's own run.
- `packages/storage-d1/test/identity-crosswalk-plan.test.ts` (whole CORE
  schema, no table statistics): the resolver's read is one SEARCH of the
  UNIQUE (source, new value) index; the proposal and the pair re-measurement
  reach observations through `identity_observation_lookup` and rows and
  source accounts by key, never by scanning them.
- `packages/storage-d1/test/identity-crosswalk.test.ts`: both value
  derivations of both sources are values and nothing else is; the
  importer-era entity equals the one the importer's reference derives; the
  verdict rule in both directions; every line has exactly the eight fields,
  identity values or counts.
- `packages/storage-d1/test/identity-crosswalk-migration.test.ts`: 0058 on a
  store migrated through 0057 with history of all 13 earlier kinds keeps every
  row, index, trigger and FK of the four rebuilt tables, differs only in the
  kind CHECK, accepts the new kind and refuses unknown ones, keeps the
  append-only and forward-only guards, rolls back whole when interrupted; the
  crosswalk table refuses a second row for the same old or new value, a value
  of the wrong source, prefix, case or length, a self-map, an unknown
  decision, and any update or delete.
- `packages/application/test/command.test.ts`: the closed kind list, and the
  payload accepts `v1`/`v2` values of the named source only, with no extra
  key (no caller-supplied entity, verdict or revisions).
- `services/processor/test/lanes.test.ts` pins migrations through 0058;
  `infra/schema/core-ledger.*` regenerated with the table classified.

## Amendment (2026-09-28): a one-time identity-value rewrite replaces the crosswalk

- Status: accepted for 0062 ([#357](https://github.com/risu729/kogane/pull/357));
  0063 proposed, accepted when the change that carries it merges. It is
  carried out by two migrations in two changes: 0062 stages the pairs and
  retires the crosswalk; 0063 performs the rewrite
  ([as implemented](#0063-as-implemented-2026-09-29)).
- Date: 2026-09-28
- Supersedes: the crosswalk decision above (options 3 and 5, the Decision,
  and the Consequences that follow from them)

### Context

The owner decided on 2026-09-28 that the importer-era and collector-era
values of one card or account are not joined by a crosswalk record at all:
the old identifier is overwritten by the new one, once, as a declared special
case. The crosswalk works, but it leaves the old value as the identity
everywhere in stored rows, adds a table read to every account resolution
for good, needs one reviewed command per value, and still lists the
MoneyForward months both producers captured under two source accounts,
because the transactions read ranks snapshots per unit key and month. No
crosswalk has been recorded: the roadmap says no proposal has been run
against production, and 0062 refuses to proceed if one has.

What the value is inside the store decides how it can be rewritten:

- The value is text in a few columns: the importer runs' fetch unit key
  (`fetch_units.unit_key`, both sources), the Vpass identity pin
  (`identity_vpass_bindings.card_token`), the importer's source-account
  reference (`source_accounts.reference_json`, `["vpass:card", <token>]` or
  `["moneyforward-me:<identity>"]`), the MoneyForward importer parses'
  `transaction_observations.source_account`, and the importer's account
  connection reviews (`account_connection_reviews.connection_key`).
- The value is also hashed into ids: a source account's id is
  `identityKey("sa", [source, producer, key])`, the account entity of an
  identity value is derived from the importer producer's source-account id
  for it (ADR 0023, ADR 0027), and a mapping id from the source-account id.
  D1's SQL has no SHA-256, so no migration can recompute them, and they are
  referenced from about ten append-only tables.
- A Vpass pin is valid only while its token equals the trusted view's token,
  which is the binding run's fetch unit key (`eligible_identity_runs`,
  migration 0057), so the pin and the unit key must change together.
- After a swap, re-identifying an importer parse would hash a new
  source-account id for a (source, producer, reference) that already exists
  under the old id, which `UNIQUE(source_id, producer_id, reference_json)`
  and `source_accounts_no_replace` refuse. The identity store must find the
  existing source account by that natural key before it hashes one.

### Options considered

1. **Keep the crosswalk.** Rejected by the owner: a record and a command per
   value, a lookup on every resolution from then on, and the old value stays
   the identity in every stored row.
2. **Rewrite the value in place and keep the importer-era entity.** Chosen.
   The text columns above take the new value; every hashed id stays, so the
   importer-era source account keeps its id, mappings and decisions, and its
   entity (`E_o`) is the account's entity from then on.
3. **Rekey everything: recompute every id from the new value.** Rejected:
   there is no SHA-256 in D1's SQL, and a new source-account id cascades
   through about ten append-only tables (mappings, identity observations,
   decisions, connection reviews, purchase recognitions and their keys).
4. **Assign each collector source account by hand (`identity.assign`).**
   Rejected: one manual decision per source account and per future producer,
   the values stay different, and the MoneyForward months are still listed
   twice.
5. **A runtime job in the Processor.** Rejected: the rewritten tables are
   append-only by trigger, so the rewrite has to drop and recreate triggers,
   and schema changes belong in migrations, which D1 applies atomically.

### Decision

- **Two migrations and a staging table.** Migration 0062:
  1. aborts if `account_identity_crosswalk` holds any row;
  2. creates `identity_value_rewrites(source_id, old_value, new_value,
basis)`: source `vpass` or `moneyforward-me`; `old_value` of the `v1`
     shape and `new_value` of the `v2` shape of that source (prefix and 64
     lowercase hex); `basis` `shared-rows` or `owner-recomputed`; UNIQUE per
     (source, old) and per (source, new); classified `operational-mutable`;
  3. validates every insert by trigger: the old value is importer-era
     (exactly one `collector-r2-importer` source account carries it and at
     least one importer fetch unit is keyed by it,
     `identity_value_rewrite_old_unknown` otherwise); the new value is
     collector-era (no importer source account carries it and a fetch unit of
     another producer is keyed by it, `identity_value_rewrite_new_unknown`);
     neither value is staged yet on either side
     (`identity_value_rewrite_not_one_to_one`), so no pair is many-to-one and
     no chain can form;
  4. stages the MoneyForward pairs the stored evidence proves, with basis
     `shared-rows`: the rule of the crosswalk proposals above, moved into the
     migration and restricted to `moneyforward-me` and to `unique` pairs of a
     `v1` old value and a `v2` new value (uniqueness is measured over every
     pair before that shape filter);
  5. drops `account_identity_crosswalk`.
- **Between the migrations, the owner** runs read-only preflight counts,
  inserts the Vpass pairs (basis `owner-recomputed`; no collector-era Vpass
  row is parsed, so the shared-rows rule cannot see them) and confirms the
  stage. The owner recomputes each Vpass pair on their own machine from the
  card's tuple: the `v1` token as the importer's HMAC under the importer's
  key, which the owner still holds outside the platform (no deployed
  component has it), and the `v2` token as the collectors' unkeyed digest
  (ADR 0029). The trigger checks only that both values are stored where
  their era says, not how they were derived ([identity operations](../identity-operations.md#one-time-identity-value-rewrite)).
  A staged MoneyForward pair is a proposal (INV07): the owner deletes a row
  that is wrong before the rewrite, and nothing adopted changes until the
  owner has confirmed the stage and the change carrying 0063 is merged.
- **Migration 0063**, in one atomic migration: checks
  that every staged pair is still valid; drops the `*_no_update` triggers of
  the five tables above; updates the five columns for the importer's rows of
  each staged old value; appends, for each collector source account of a
  staged new value, a `rule` mapping revision to `E_o` with the same policy
  version, label and status and the reason `identity-value-rewrite`
  (aborting when that source account's mapping is manual or protected);
  checks that no staged old value remains; recreates the dropped triggers
  with their exact text; drops `identity_value_rewrites`. An empty stage
  changes nothing but the drop. With it, the identity store resolves a
  source account by its natural key before it hashes one, so the importer's
  source account (old id, new reference) keeps being found and its entity
  stays `E_o`.
- **The crosswalk is retired.** Its store module, application planner,
  proposal script, the `identity.crosswalk.accept` kind (contract, commit,
  targets, subject ref, planner registration, confirmation label) and the
  crosswalk branch of `accountEntityId` are removed; migration 0058 stays as
  history. The retired kind stays admitted by the kind CHECK constraints of
  `change_plans` and `operation_receipts`: removing it would rebuild four
  command tables for no row, and the closed vocabulary in
  `packages/application/src/command/contract.ts` refuses it before any row
  is written.

### Consequences

- **One declared exception to "evidence is never rewritten".** 0063 is
  the only migration that updates evidence rows, and only the
  platform-derived identity value (a digest the platform computed, not a
  claim of the provider) in the five columns above, of the importer's rows
  of the staged pairs, once. No other migration may do this without a new
  ADR; [the mutation policy](../design.md#mutation-policy) points here and
  gains the exception itself with 0063.
- **What stays immutable.** Raw objects in R2 and their digests; every
  observation column other than the MoneyForward importer rows'
  `source_account`, including external ids (a MoneyForward external id keeps
  the fingerprint of the old value), amounts, dates and `extra_json`; every
  hashed id (source accounts, entities, mappings, identity runs and
  observations); the identity run policies' dependency JSON and digest;
  `accounts`; every decision, mapping revision (new ones are appended) and
  audit row. Only rows with the old value change; collector rows and
  unstaged values are untouched.
- **What joins.** After 0063 the importer's source account carries the new
  value and keeps `E_o`; the collector's source accounts of that value map to
  `E_o`; every later capture of the value resolves there. For MoneyForward
  the importer's and the collector's snapshots of a month share one unit key,
  so the months both captured are read once (the newer capture), as ADR 0027
  does for one value read by two producers.
- **What stays.** The collector-era entity `E_n` stays in `accounts`
  (append-only) with no current mapping. A value that is not staged stays as
  it is: an unpaired `v2` value keeps its own entity, and so does a collector
  Vpass token with no staged pair.
- **Coincidental rows.** The shared-rows limit of the crosswalk proposals
  holds for the staged MoneyForward pairs: an identical row in another
  account makes a real pair not `unique` (not staged), and coincidental rows
  alone could stage an unrelated pair. The owner confirms the stage before 0063.
- **Abort instead of a partial stage.** If a pair the rule proposes fails
  the validation trigger, 0062 aborts as a whole and the deploy stops; it
  never stages part of the evidence silently.
- **Production.** Nothing here reads production. The owner runs the
  preflight and confirms the stage before the rewrite is merged. The owner's
  reports of 2026-09-28 expect MoneyForward 4 and Vpass 6 pairs; that is the
  expectation the confirmation is read against, not a count this change
  verifies.

### Verification

- `packages/storage-d1/test/identity-value-rewrite-migration.test.ts`
  (CORE migrations through 0061 over the Layer A stub; the current-identity
  view replaced by a table the test fills): 0062 stages exactly one
  MoneyForward pair from importer and collector histories with made-up
  values, and not an ambiguous pair (one old value, two new), a value that
  shares nothing, or a Vpass pair whose rows are shared; a competitor of
  another shape or an importer that carries the new value stages nothing;
  staging changes no source account, fetch unit or observation; an empty
  store stages nothing; with a crosswalk row the migration aborts and the
  schema is unchanged. The trigger admits the owner's valid Vpass pair and
  refuses a bad shape, source or basis, an unknown old value (no importer
  source account, or no importer fetch unit), an unknown or importer-carried
  new value, a many-to-one pair in either direction and a chain; the table
  and trigger SQL digests equal the committed CORE ledger, which no longer
  lists the crosswalk.
- `services/processor/test/moneyforward-producer-switch.test.ts` (whole
  CORE schema, Miniflare, runs registered through the pipeline): the
  staging statement of 0062, run against the real current-identity view,
  stages exactly the importer's `v1` and the collector's `v2` identity of the
  split account.
- `packages/application/test/command.test.ts`: the closed kind list without
  `identity.crosswalk.accept`, which `isChangeKind` refuses.
- `services/processor/test/lanes.test.ts` pins migrations through 0062;
  `infra/schema/core-ledger.*` regenerated.
- The rewrite (0063) is verified below.

### 0063 as implemented (2026-09-29)

- Status: proposed; accepted when the change that carries 0063 merges.
- Production preconditions the owner reported before it (counts only, read
  with the queries of [identity operations](../identity-operations.md#one-time-identity-value-rewrite)):
  `moneyforward-me` / `shared-rows` 4 pairs (4 distinct old and 4 distinct
  new values), `vpass` / `owner-recomputed` 6 (6 and 6), 0 held mappings,
  and 0 MoneyForward `v1` values in balance, position, valuation and
  scheduled-payment observations. This repository does not verify them.

`packages/storage-d1/migrations/core/0063_identity_value_rewrite_apply.sql`
does what the Decision states, with these choices the Decision left open:

- **`E_o`** is the account of the importer's source account's `rule`
  revisions (every one of them names the same entity, since the identity
  store derives it from that source account's id; the guard aborts with
  `identity_value_rewrite_entity_ambiguous` otherwise). A manual mapping of
  the importer's own source account does not change `E_o`, as it does not
  change what the identity store derives.
- **"The same policy version, label and status"** are those of the
  collector source account's current revision, which the new revision
  supersedes: only the entity changes, and a later capture under the same
  policy version appends nothing. The id is that revision's id base with
  `-r<revision>`, the form the identity store gives a later automatic
  revision.
- **Guards** are named CHECK constraints, so an abort names its closed code:
  `identity_value_rewrite_stage_invalid`, `identity_value_rewrite_entity_ambiguous`,
  `identity_value_rewrite_mapping_held` before the rewrite;
  `identity_value_rewrite_old_value_remains`, `identity_value_rewrite_importer_unmoved`,
  `identity_value_rewrite_collector_unjoined` after it. The "no old value
  remains" check covers the five columns in every producer's rows and the
  MoneyForward `source_account` of balance, position, valuation and
  scheduled-payment observations.
- **Rows it updates** are the importer's only: fetch units of the importer's
  runs of the pair's source; Vpass pins whose financial unit is an importer
  unit; the importer's source account; transaction observations of parses of
  the importer's MoneyForward artifacts; the importer's connection reviews.
- **`fetch_units_no_update`** (Layer A, 0001) is dropped with `IF EXISTS`:
  the test stubs of Layer A declare `fetch_units` without its guards yet run
  every CORE migration. Every deployed CORE database has it, and the
  recreated text is 0001's. The other four guards are dropped without
  `IF EXISTS`, so a missing one aborts the migration.
- **What else keeps the old value.** Besides what the Consequences list, the
  importer's MoneyForward runs carry the `v1` value in two Layer A
  registration labels, `fetch_unit_reports.report_key` and
  `fetch_run_ranges.range_key`, and each Vpass identity run policy carries its
  token in `dependency_set_json` (and so its digest). None is read as an
  account identity, and all stay as recorded; the importer's manifests in R2
  keep the `v1` value too.
- **The identity store** resolves a source account by
  `(source_id, producer_id, reference_json)` before it hashes one
  (`sourceAccountId`), both for the source account a row is filed under and
  for the importer's source account an entity is derived from. For every
  source account the store wrote itself the two ids agree, so nothing
  changes except for the rewritten importer source accounts.

Verification:

- `packages/storage-d1/test/identity-value-rewrite-migration.test.ts`
  (CORE migrations through 0062 over the Layer A stub with 0001's
  `fetch_units` guard added; a Vpass card through the real trusted binding,
  pin and identity run, a MoneyForward account of both eras with its
  connection reviews, an unpaired collector value; synthetic values): with
  both pairs staged, every table keeps its row count and rowids except
  `account_mappings` (+2) and the dropped staging table; a changed cell is one
  of the five columns and equals the old cell with the old value replaced;
  the importer's references equal `JSON.stringify` of the new keys; the two
  appended revisions are exactly the expected rows; no old value remains but
  in `identity_run_policies.dependency_set_json`; every schema object other
  than the staging table (the recreated guards included) has the same SQL
  text; `eligible_identity_runs`, `current_identity_observations`, the
  trusted binding (token aside) and the aggregate identity audit are
  unchanged; every current observation of a pair resolves to `E_o`, the
  unpaired value to its own entity; integrity and foreign-key checks pass.
  An empty stage changes nothing but the staging table. A manual mapping, or
  an active override under a later rule revision, on a collector source
  account of a staged new value aborts with `identity_value_rewrite_mapping_held`;
  a pair invalidated after staging aborts with `identity_value_rewrite_stage_invalid`;
  a MoneyForward balance row under an old value aborts with
  `identity_value_rewrite_old_value_remains`; each abort leaves every row and
  the schema unchanged. On the whole CORE schema, the five guards' SQL equals
  their defining migrations' text and the committed ledger.
- `services/processor/test/moneyforward-producer-switch.test.ts` (whole CORE
  schema through 0062, Miniflare, runs registered through the pipeline, the
  pair staged by 0062's own statement, then 0063): the importer's source
  account keeps its id and entity and both source accounts carry the `v2`
  reference and map to `E_o`; the month both producers captured is read once
  (INV06); a new collector capture adds no mapping revision and every current
  observation resolves to `E_o`; re-identifying the importer's parses under a
  newer policy reuses the importer's source account (before `sourceAccountId`
  it aborted with `identity replacement is forbidden`), and re-identifying the
  collector's parse appends a revision to `E_o`; an unpaired `v2` value keeps
  its own entity.
- `services/processor/test/lanes.test.ts` pins migrations through 0063;
  `infra/schema/core-ledger.*` regenerated without `identity_value_rewrites`.
