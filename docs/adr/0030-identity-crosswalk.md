# ADR 0030: A one-time, operator-accepted crosswalk from importer-era to collector-era account identities

- Status: proposed
- Date: 2026-09-27
- Carried by:
  `packages/storage-d1/src/core/identity-crosswalk.ts`,
  `packages/storage-d1/migrations/core/0058_identity_crosswalk.sql`,
  `packages/storage-d1/src/core/identity-store.ts` (`accountEntityId`),
  `packages/application/src/operations/identity-crosswalk.ts`,
  `packages/application/src/command/contract.ts` (`identity.crosswalk.accept`),
  `services/processor/src/change-commands.ts`,
  `services/processor/scripts/identity-crosswalk-proposals.ts`,
  [identity operations](../identity-operations.md#joining-importer-era-and-collector-era-identities-one-time),
  [change lifecycle](../change-lifecycle.md),
  `packages/storage-d1/test/identity-crosswalk.test.ts`,
  `packages/storage-d1/test/identity-crosswalk-migration.test.ts`,
  `packages/application/test/command.test.ts`,
  `services/processor/test/identity-crosswalk.test.ts`
- Related: [ADR 0023](0023-vpass-collector-card-binding.md) and
  [ADR 0027](0027-moneyforward-collector-account-identity.md) (the importer's
  entity for an identity value, whichever producer read it),
  [ADR 0017](0017-card-purchase-review-commands.md) (the last widening of the
  command vocabulary, which 0058 repeats),
  [ADR 0029](0029-data-classification-and-unkeyed-identity.md) (collectors
  that derive their identity values without the lost key)

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
