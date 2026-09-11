# Fixed projection input, snapshot identity and completion

The latest-balance projection used to identify its input context by
`max(parse_run_id)` and a handful of row counts, re-read CORE on every
invocation of a bounded build, and report an outbox row as done as soon as its
processor returned anything. Migration `0038` and the changes around it fix
those three things (unified plan 05, 01 §5; acceptance G2-01 … G2-14).

Everything below was exercised locally against synthetic fixtures. Nothing
here is a claim about production data or production performance.

## Why the old identity was wrong

`PROJECTION_INPUTS_SQL` declared the inputs as `max(parse_run_id)` over
`published_parse_runs` plus four counts. Move one artifact's adopted parse from
run 100 to run 150 while an unrelated run 900 is published, and:

- the maximum is still 900;
- no count changed — one pointer moved, nothing was added or removed.

The snapshot id was the digest of those numbers, so the sealed snapshot kept
serving the old adopted set and every reader reported it as current.
`packages/read-model/test/source-revision.test.ts` runs exactly that case
(G2-01).

Those numbers are still computed and still logged: `PROJECTION_INPUTS_SQL` is
now an operational summary, and its `publishedHighWaterParseRunId` still pins a
snapshot's history window. It is no longer anybody's identity.

## The revision ledger

`core_source_revision` is a single row: `source_revision`,
`visibility_revision`, `core_epoch`. Every write to a table the projection
depends on bumps it **in the same transaction as the write**, through a trigger,
so a change cannot be missed whoever wrote it — the pipeline, a maintenance
script or a later migration.

The ledger is declared twice and checked against itself:
`SOURCE_REVISION_LEDGER` / `VISIBILITY_REVISION_LEDGER` in
`packages/read-model/src/source-revision.ts`, and the triggers migration 0038
creates. `source-revision.test.ts` asserts the two sets are equal, so a new
dependency table cannot be added to one side alone (G2-03).

| Group                                     | Tables                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is adopted                           | `parse_runs`, `published_parse_runs`, `publication_events`                                                                                                                                                    |
| Candidate facts                           | `balance_observations`, `observation_decimal_values`                                                                                                                                                          |
| Coverage and policy                       | `parse_coverage_claims`, `dataset_snapshot_policies`                                                                                                                                                          |
| Judgements                                | `entity_relations`, `decision_revisions`                                                                                                                                                                      |
| Identity                                  | `account_mappings`, `instrument_mappings`, `identity_observations`, `identity_instrument_uses`, `identity_runs`, `identity_run_seals`, `accounts`, `instruments`, `source_accounts`, `instrument_identifiers` |
| Calculation policy                        | `calculation_policies`                                                                                                                                                                                        |
| Evidence becoming visible                 | `fetch_run_seals`                                                                                                                                                                                             |
| Restrictions (also `visibility_revision`) | `evidence_use_restrictions`, `fetch_run_annotations`                                                                                                                                                          |

A restriction moves both counters because it does not only hide rows: a
subtotal computed before it is wrong, so the affected snapshots are rebuilt
rather than filtered (05 §7).

**Deliberately excluded** — checkpoint, job, lease and projection-output tables.
Bumping the revision when a build records its own progress would make every
build stale the moment it wrote a row, and rebuild for ever (05 §2, G2-04):
`balance_read_snapshots`, `current_balance_projection`, `scope_relations`,
`balance_snapshot_pointer`, `projection_input_records`, `decision_outbox`,
`operation_receipts`, `change_plans`, `approvals`, `observation_parse_jobs`,
`observation_work_items`, `observation_scan_state`, `observation_lane_state`,
`observation_replay_plans`, `calculation_runs`, `report_events`,
`report_artifacts`, and the operations API request records `ops_requests`,
`ops_request_stages` (an operator's request and its stage log say what was
asked, never what the projection reads). `fetch_runs` and `fetch_artifacts` are excluded for a
different reason: evidence reaches a reader only once its run is sealed and its
parse published, and both of those are in the ledger.

A revision never goes backwards while `core_epoch` stays the same. A CORE
restored from a backup may rewind the counters, and the trigger then demands a
new epoch, so a READ built under the old epoch is never treated as the same
context.

### One consequence to know about

D1 counts rows written by triggers in `meta.changes` (workerd's `rowsWritten`),
and `packages/storage-d1`'s `bun:sqlite` double counts the same way (it reads
`total_changes()`). A statement that writes one ledger row therefore reports
**two** changes: the row and the revision bump. Nothing may derive a business
count from `meta.changes` on a ledger table. The three places that did now
count the rows their statement returns instead (`RETURNING`): the repaired
publications in `packages/storage-d1/src/atomic/publication.ts`,
`pointersMoved` in `services/observation-pipeline/src/release-adoption.ts`, and
the sealed runs in `packages/storage-d1/src/core/identity-store.ts`. Guards that
only ask "did this match a row?" are unaffected, and no guard that requires
exactly one row sits on a ledger table. `projection-input.test.ts` ("D1 counts
the revision bump in meta.changes") shows the two-versus-one count under
Miniflare, and `packages/storage-d1/test/decision-commit.test.ts` shows it for
a commit batch, so the reason is on record.

Every remaining `meta.changes` reader in `services/**` and `packages/**`, with
the table its statement writes, as audited for this change:

| Site                                                                                         | Table                                                | Use                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `worker.ts` parse claim, replay plans, job inserts                                           | `observation_parse_jobs`, `observation_replay_plans` | truthiness / sum, excluded tables |
| `worker.ts` publish batch `[0]`                                                              | `parse_runs` (ledger)                                | truthiness only (`2` is truthy)   |
| `release-adoption.ts` activation and rollback fence `[0]`                                    | `active_releases`                                    | truthiness                        |
| `reconciliation-job.ts` proposal insert                                                      | `reconciliation_proposals`                           | `=== 1`, not in the ledger        |
| `reconciliation-commands.ts`, storage-d1 `identity-commands.ts` `[0]`                        | `decision_operations`                                | `=== 1`, not in the ledger        |
| storage-d1 `decision-outbox.ts` completion and receipt publication                           | `decision_outbox`, `operation_receipts`              | `=== 1` / sum, excluded tables    |
| `balance-projection-job.ts` lease, checkpoint, seal, pointer                                 | `balance_read_snapshots`, `balance_snapshot_pointer` | `=== 1`, excluded tables          |
| `releases.ts` registration                                                                   | `parser_releases`                                    | sum, not in the ledger            |
| `report-job.ts` downgrade                                                                    | `calculation_runs`                                   | sum, excluded table               |
| `packages/application` plan, approve, commit `[0]` (through storage-d1's `command-store.ts`) | `change_plans`, `approvals`, `operation_receipts`    | `=== 1`, excluded tables          |

`services/raw-evidence` never reads `meta.changes`; its seals and statements
are `INSERT … WHERE NOT EXISTS` followed by a read.

## Capturing the input once

`captureFixedInput` in
`services/observation-pipeline/src/balance-projection-job.ts`:

```text
read revision r0
  → read candidates, relations and the declared releases
read revision r1
r0 == r1  → this is the input
r0 != r1  → discard it and retry, bounded (3 attempts, then `pending`)
```

A mixture of two contexts is never accepted, and an endlessly moving store
yields `pending(input_capture_unstable)` instead of spinning (G2-02).

The canonical bytes are written to the DATA bucket at
`projection-inputs/<inputDigest>/input.json` and recorded in
`projection_input_records` (digest, the job that captured it first,
`source_revision`, `visibility_revision`, `core_epoch`, contract version,
storage ref, byte size). Every later invocation of that build reads its
snapshot's `input_digest`, loads those bytes, verifies that the content hashes
to the recorded digest, and continues — it never re-reads CORE's current state
(G2-05). The record is per input, not per build: the snapshot id also carries
the build digest, so after a deploy that changes what the code makes of an
input the same input builds a new snapshot and shares the record; if the
stored object is gone, the next build of that input writes it back under the
record's pin. A build whose input cannot be read refuses
(`retryable(projection_input_unreadable)`); a `building` snapshot left over from
before this migration has no input record, so it is retired and the next tick
builds a new one from a fresh capture.

The stored object is an envelope — contract version, revision, epoch,
`capturedAt`, and `content`. Only `content` is hashed: the digest is the
identity of the data, so the same data captured a minute later is the same
snapshot. `capturedAt` is fixed in the envelope because a build that predicts
an expiry from "now" has fixed that instant too (05 §3).

### Budgets are refusals, never truncations

| Budget                      | Value | On overflow                                                              |
| --------------------------- | ----- | ------------------------------------------------------------------------ |
| Candidates                  | 5,000 | `refused(candidate_limit_exceeded)` — the existing read bound, unchanged |
| Coverage claims             | 5,000 | `refused(coverage_claim_budget_exceeded)`                                |
| Declared relations          | 5,000 | `refused(relation_budget_exceeded)`                                      |
| Derived relations stored    | 5,000 | `refused(scope_relation_budget_exceeded)`                                |
| Rows written per invocation | 1,000 | the build continues on the next tick                                     |

The 0040 operations API records (`ops_requests`, `ops_request_stages`) are
outside the ledger for the same reason as the job tables: they say what an
operator asked for, not what the projection reads.

Every one of them is fail-closed: the build seals nothing and the outbox row is
`blocked` with the budget's code, rather than a truncated set being sealed as if
it were complete (G2-06). The supporting sets are read with one row over the
bound so the overflow is detected instead of being cut to size.

## Snapshot identity

```text
snapshotId = sha256(inputContentDigest ‖ projectionBuildDigest ‖ contractVersion)
```

- `inputContentDigest` — sha256 of the canonical JSON of the captured content.
- `projectionBuildDigest` — the releases and bounds that decide what the input
  becomes (projection, metric registry, authority policy, scope relation
  release, disjointness and known-asset policies, adoption bound).
- `contractVersion` — `projection-input-v1`, the shape of the stored input.

`sourceRevision` detects and orders change; it is never the identity, because a
write that changes nothing the projection reads still moves it. Two captures of
the same data at two revisions produce the same snapshot, and the second is
recognised as already built.

Each snapshot also records `read_instance_id` and `core_epoch`. On the CORE
path the instance is the constant `core-d1`; in the READ database it is that
physical database's own id, generated when the first build claims it, so a
rebuilt database is never mistaken for the one whose cursors are still in flight
(U11).

## Writing, verifying and publishing

- **Lease and fence.** An invocation claims the build for 60 s and raises
  `writer_fence`; a writer whose lease was taken cannot write, seal or publish
  (G2-09). The lease is released at the end of the step, so the next tick takes
  the build straight over rather than waiting the lease out.
- **Chunk and checkpoint commit together.** Each 100-row chunk and the
  checkpoint that records it are one D1 batch, so a statement error rolls both
  back and a checkpoint can never claim rows that are not there (G2-08).
- **A re-sent chunk is decidable.** Every row carries a `row_digest`. The same
  content is an ignored duplicate; different content for a row that already
  exists raises `projection chunk conflict` in a trigger, which overrides the
  statement's `OR IGNORE` (G2-07).
- **Verify before sealing.** The written rows must match the build in count, in
  dense contract order and in per-row digest, or the build does not seal.
- **Seal and publish in one batch.** The snapshot becomes `complete` and
  `balance_snapshot_pointer` switches in the same D1 batch, under the lease. The
  pointer moves only to a snapshot at least as current as the published one, so
  a build that finishes late is complete but not published: the active
  `source_revision` never goes backwards (G2-10). The pointer statement names
  only a complete snapshot, so a writer whose lease was taken between its last
  chunk and its seal matches no row in either statement and reports
  `writer_lease_lost` rather than aborting the batch. A pointer trigger refuses
  a regression and refuses a snapshot that is not complete, for any writer that
  bypasses the statement.

The pointer's `source_revision` is the watermark "the published content was
verified against this revision". A later capture that digests to the same
snapshot advances the watermark without rebuilding anything, which is how a
decision that changes no row still becomes "published".

## Completion: the four outcomes

`OutboxProcessor` now returns one of four results, and **consumers must handle
all four**:

```ts
type ProcessorOutcome =
  | { status: "pending"; progress: string }
  | { status: "completed"; evidence: { code: OutboxCode; ref: string } }
  | { status: "retryable"; code: string }
  | { status: "blocked"; code: string };
```

Only `completed` sets `processed_at`, and only a processed row can publish its
operation's receipt. `building`, an unregistered processor, a flag that is off
and "the job was enqueued" are never completed (`contracts/stages.json`,
G2-13). A pending poll records `progress_code` and `pending_polls` and does not
burn the failure budget; a blocked row records `blocked_code` and is not
claimed again until an operator clears it.

`decision_outbox` gains `required_source_revision`, stamped on the first claim.
The decision's own write already moved the revision, so a published snapshot at
or above it carries the decision. The balance-projection processor therefore
answers one question — does the snapshot the read model publishes cover that
revision? — and:

- **never** completes because a rebuild was started (G2-11);
- converges after a lost response: the next delivery sees the active pointer
  already covering the revision and completes the row from it, without
  rebuilding and without re-consuming the approval (G2-12);
- records the snapshot as `evidence_ref` and the covered revision as
  `applied_source_revision`, so "this was completed" is checkable.

CORE is never completed before READ. There is no CORE+READ transaction; the
order is READ first, CORE second, and a lost response is resolved by re-reading
READ (05 §5).

## Flags

**None are added by this change.** U11 adds `READ_PROJECTION_ENABLED` (default
off) beside the flag below, which chooses the database the same build writes to;
see [The READ database](read-model-d1.md).

The original text: **none are added.** This replaces the internals of the existing
`BALANCE_PROJECTION_ENABLED` path, which is off by default in both the pipeline
and the evidence browser. With the flag off the job returns `skipped(flag_off)`
and its outbox rows stay pending, exactly as "nothing was updated" should read.

## Deploy order and rollback

1. **Schema** — apply migration `0038`
   (`packages/storage-d1/migrations/core/`). It is additive: new tables, new
   columns with defaults, and new triggers. A Worker build that predates it
   keeps working, because it never names any of them.
2. **Writer** — deploy `services/observation-pipeline`. Its wrangler config
   gains the `DATA` R2 binding, which points at the same physical bucket as
   `EVIDENCE` (`kogane-raw-evidence`); no new bucket is created, and no runtime
   resource identity changes.
3. **Reader** — deploy `services/evidence-browser`. "Is the snapshot behind?"
   becomes a revision comparison against the active pointer instead of a digest
   of counts.

**Rollback: deploy the previous Worker revision.** The migration stays; it is
additive and the old code neither reads nor writes the new tables and columns.
The revision triggers keep running, which costs one extra row write per ledger
write and is otherwise invisible — except that `meta.changes` on those tables
stays inflated, which is why the three counting call sites were changed to
`RETURNING` rather than left to be corrected by a rollback.

## Verified locally (synthetic data only)

| Acceptance                                                                                                                                                                                                                                                                            | Where                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| G2-01 the 100 → 150 counter-example, the trigger ledger, the snapshot identity                                                                                                                                                                                                        | `packages/read-model/test/source-revision.test.ts`                                                                |
| G2-03 a write in each dependency family, G2-04 checkpoints excluded and no silent rewind                                                                                                                                                                                              | `packages/read-model/test/source-revision.test.ts`, `services/observation-pipeline/test/projection-input.test.ts` |
| G2-02 capture discarded and bounded; G2-05 resume from the stored input and the shared record after a build-digest change; G2-06 budget refusals; G2-07/G2-08 chunk re-send and rollback; G2-09/G2-14 the fence writes nothing; G2-10 no pointer regression; G2-11 … G2-13 completion | `services/observation-pipeline/test/projection-input.test.ts`                                                     |
| The projection job end to end, the outbox routing and the sealed-snapshot invariants                                                                                                                                                                                                  | `services/observation-pipeline/test/balance-projection.test.ts`                                                   |
| The receipt that stays `accepted` while a target is blocked                                                                                                                                                                                                                           | `services/observation-pipeline/test/change-lifecycle.test.ts`                                                     |
| The v2 pages, cursors and the v1 parity over the new identity                                                                                                                                                                                                                         | `services/evidence-browser/test/balances-v2.test.ts`                                                              |

Not verified: production data volumes, a real concurrent second Worker (the
lease and the fence are exercised by simulating the displaced writer), R2
behaviour under failure injection, and the retention of stored inputs (their
collection is left to a later maintenance workflow).

## Known limits

- **A retired snapshot id was final — fixed in U11 for the READ database.** Migration 0030 lets a snapshot leave
  `retired` for nothing, and `projection_input_records` is append-only with
  one record per job. A capture whose content digests to a snapshot that was
  retired (the exact content of an earlier build coming back) is reported as
  `skipped(snapshot_retired)` and the pointer's watermark does not advance,
  so an outbox row waiting on that revision keeps polling
  `projection_behind_decision` until the content changes again. This predates
  0038 (the old identity had the same skip) and still describes the CORE path
  of this document.

  U11 fixes it where the projection is rebuildable. In the READ database the
  content identity and the row identity are separated: `content_key` is the id
  above, and `snapshot_id` carries an attempt that is allocated only when no
  `building` or `complete` build of that content exists. A build already under
  way or already published is reused; content whose builds were all retired
  starts a new attempt, so it is always buildable again. `retired` stays
  terminal, and the input record stays keyed by digest and shared. See
  [The READ database](read-model-d1.md).
