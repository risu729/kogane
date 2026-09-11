-- CORE source/visibility revision and fixed projection inputs (unified plan
-- 05 §2–§4, U10). Additive only: no existing table, column, view or trigger is
-- altered, and a Worker build that predates this migration keeps reading and
-- writing exactly as before because it never names the tables or the new
-- columns below.
--
-- Why a revision counter. The read model used to identify its input context by
-- `max(parse_run_id)` and a few row counts. That is not the identity of the
-- adopted set: moving an artifact's adopted parse from 100 to 150 while some
-- unrelated run 900 exists changes nothing in the maximum, and two opposite
-- changes can leave a count alone. `core_source_revision` is bumped by a
-- trigger inside the same transaction as every write the balance projection
-- depends on, so "did anything I read change?" is one integer comparison that
-- cannot miss a change, whoever wrote it — the pipeline, a maintenance script
-- or a later migration.
--
-- THE DEPENDENCY LEDGER. These tables bump `source_revision`; the list is
-- mirrored by SOURCE_REVISION_LEDGER in packages/read-model/src/source-revision.ts
-- and a test asserts that the triggers in the database are exactly the ones the
-- ledger declares, so a new dependency table cannot be added on one side only.
--
--   parse_runs, published_parse_runs, publication_events    (what is adopted)
--   balance_observations                                    (candidate facts)
--   observation_decimal_values                              (exact quantities)
--   parse_coverage_claims, dataset_snapshot_policies        (coverage, policy)
--   entity_relations, decision_revisions                    (judgements)
--   account_mappings, instrument_mappings, identity_observations,
--   identity_instrument_uses, identity_runs, identity_run_seals,
--   accounts, instruments, source_accounts, instrument_identifiers (identity)
--   calculation_policies                                    (calculation policy)
--   fetch_run_seals                                         (evidence becomes visible)
--
-- These two bump `visibility_revision` as well as `source_revision`, because a
-- restriction does not only hide rows: a subtotal computed before it is wrong,
-- so the affected snapshots have to be rebuilt, not filtered.
--
--   evidence_use_restrictions, fetch_run_annotations
--
-- DELIBERATELY EXCLUDED (05 §2): checkpoint, job, lease and projection-output
-- tables. Bumping the revision when the projection records its own progress
-- would make every build immediately stale and rebuild for ever:
--   balance_read_snapshots, current_balance_projection, scope_relations,
--   balance_snapshot_pointer, projection_input_records, decision_outbox,
--   operation_receipts, change_plans, approvals, observation_parse_jobs,
--   observation_work_items, observation_scan_state, observation_lane_state,
--   observation_replay_plans, calculation_runs, report_events, report_artifacts,
--   and the operations API request records ops_requests, ops_request_stages.
-- Also excluded: fetch_runs and fetch_artifacts. Evidence reaches a reader only
-- once its run is sealed and its parse published, and both of those are in the
-- ledger; the catalogue rows themselves would bump the revision on every
-- ingest without changing what the projection reads.

-- The single revision row. `source_revision` orders changes of the data the
-- projection reads; `visibility_revision` orders changes of what a reader may
-- see. Neither is a content digest: they detect and order change, and the
-- snapshot identity stays the digest of the captured input.
--
-- `core_epoch` distinguishes this CORE from a CORE restored from a backup. A
-- restore may rewind the counters, so a rewind is allowed only together with a
-- new epoch; a READ built under the old epoch is then never treated as the same
-- context (05 §2).
CREATE TABLE core_source_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64)
) STRICT;
INSERT INTO core_source_revision(id,source_revision,visibility_revision,core_epoch)
  VALUES(1,1,1,'core-epoch-1');
CREATE TRIGGER core_source_revision_single_row BEFORE INSERT ON core_source_revision
BEGIN SELECT RAISE(ABORT,'the core revision row is created once'); END;
CREATE TRIGGER core_source_revision_no_delete BEFORE DELETE ON core_source_revision
BEGIN SELECT RAISE(ABORT,'the core revision row is permanent'); END;
CREATE TRIGGER core_source_revision_forward_only BEFORE UPDATE ON core_source_revision
WHEN NEW.id<>OLD.id
 OR (NEW.core_epoch=OLD.core_epoch
     AND (NEW.source_revision<OLD.source_revision OR NEW.visibility_revision<OLD.visibility_revision))
BEGIN SELECT RAISE(ABORT,'a core revision rewind needs a new core epoch'); END;

-- One bump per write of a ledger table, in the same transaction as the write.
CREATE TRIGGER parse_runs_bump_revision_insert AFTER INSERT ON parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER parse_runs_bump_revision_update AFTER UPDATE ON parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER parse_runs_bump_revision_delete AFTER DELETE ON parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_revision_insert AFTER INSERT ON published_parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_revision_update AFTER UPDATE ON published_parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_revision_delete AFTER DELETE ON published_parse_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_revision_insert AFTER INSERT ON publication_events BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_revision_update AFTER UPDATE ON publication_events BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_revision_delete AFTER DELETE ON publication_events BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER balance_observations_bump_revision_insert AFTER INSERT ON balance_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER balance_observations_bump_revision_update AFTER UPDATE ON balance_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER balance_observations_bump_revision_delete AFTER DELETE ON balance_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER observation_decimal_values_bump_revision_insert AFTER INSERT ON observation_decimal_values BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER observation_decimal_values_bump_revision_update AFTER UPDATE ON observation_decimal_values BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER observation_decimal_values_bump_revision_delete AFTER DELETE ON observation_decimal_values BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_revision_insert AFTER INSERT ON parse_coverage_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_revision_update AFTER UPDATE ON parse_coverage_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_revision_delete AFTER DELETE ON parse_coverage_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_revision_insert AFTER INSERT ON dataset_snapshot_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_revision_update AFTER UPDATE ON dataset_snapshot_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_revision_delete AFTER DELETE ON dataset_snapshot_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER entity_relations_bump_revision_insert AFTER INSERT ON entity_relations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER entity_relations_bump_revision_update AFTER UPDATE ON entity_relations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER entity_relations_bump_revision_delete AFTER DELETE ON entity_relations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER decision_revisions_bump_revision_insert AFTER INSERT ON decision_revisions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER decision_revisions_bump_revision_update AFTER UPDATE ON decision_revisions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER decision_revisions_bump_revision_delete AFTER DELETE ON decision_revisions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER account_mappings_bump_revision_insert AFTER INSERT ON account_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER account_mappings_bump_revision_update AFTER UPDATE ON account_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER account_mappings_bump_revision_delete AFTER DELETE ON account_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_mappings_bump_revision_insert AFTER INSERT ON instrument_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_mappings_bump_revision_update AFTER UPDATE ON instrument_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_mappings_bump_revision_delete AFTER DELETE ON instrument_mappings BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_observations_bump_revision_insert AFTER INSERT ON identity_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_observations_bump_revision_update AFTER UPDATE ON identity_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_observations_bump_revision_delete AFTER DELETE ON identity_observations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_instrument_uses_bump_revision_insert AFTER INSERT ON identity_instrument_uses BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_instrument_uses_bump_revision_update AFTER UPDATE ON identity_instrument_uses BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_instrument_uses_bump_revision_delete AFTER DELETE ON identity_instrument_uses BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_runs_bump_revision_insert AFTER INSERT ON identity_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_runs_bump_revision_update AFTER UPDATE ON identity_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_runs_bump_revision_delete AFTER DELETE ON identity_runs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_run_seals_bump_revision_insert AFTER INSERT ON identity_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_run_seals_bump_revision_update AFTER UPDATE ON identity_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER identity_run_seals_bump_revision_delete AFTER DELETE ON identity_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER accounts_bump_revision_insert AFTER INSERT ON accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER accounts_bump_revision_update AFTER UPDATE ON accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER accounts_bump_revision_delete AFTER DELETE ON accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instruments_bump_revision_insert AFTER INSERT ON instruments BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instruments_bump_revision_update AFTER UPDATE ON instruments BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instruments_bump_revision_delete AFTER DELETE ON instruments BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER source_accounts_bump_revision_insert AFTER INSERT ON source_accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER source_accounts_bump_revision_update AFTER UPDATE ON source_accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER source_accounts_bump_revision_delete AFTER DELETE ON source_accounts BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_identifiers_bump_revision_insert AFTER INSERT ON instrument_identifiers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_identifiers_bump_revision_update AFTER UPDATE ON instrument_identifiers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER instrument_identifiers_bump_revision_delete AFTER DELETE ON instrument_identifiers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER calculation_policies_bump_revision_insert AFTER INSERT ON calculation_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER calculation_policies_bump_revision_update AFTER UPDATE ON calculation_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER calculation_policies_bump_revision_delete AFTER DELETE ON calculation_policies BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_revision_insert AFTER INSERT ON fetch_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_revision_update AFTER UPDATE ON fetch_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_revision_delete AFTER DELETE ON fetch_run_seals BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;

-- Restrictions move both counters: what a reader may see changed, and every
-- snapshot that aggregated the restricted evidence has to be rebuilt.
CREATE TRIGGER evidence_use_restrictions_bump_revision_insert AFTER INSERT ON evidence_use_restrictions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;
CREATE TRIGGER evidence_use_restrictions_bump_revision_update AFTER UPDATE ON evidence_use_restrictions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;
CREATE TRIGGER evidence_use_restrictions_bump_revision_delete AFTER DELETE ON evidence_use_restrictions BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_revision_insert AFTER INSERT ON fetch_run_annotations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_revision_update AFTER UPDATE ON fetch_run_annotations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_revision_delete AFTER DELETE ON fetch_run_annotations BEGIN UPDATE core_source_revision SET source_revision=source_revision+1,visibility_revision=visibility_revision+1 WHERE id=1; END;

-- The fixed input of one build (05 §3). A bounded build reads CORE once, at a
-- revision that did not move while it was reading, and every later invocation
-- of the same build reads this record and the stored bytes instead of CORE's
-- current state. Without it a resumed build mixes two contexts: the rows
-- written before a publication and the rows written after it.
--
-- `storage_ref` is the DATA R2 prefix `projection-inputs/<input_digest>`; the
-- canonical bytes live at `<storage_ref>/input.json` and hash to
-- `input_digest`, so a reader can prove it resumed from the input the record
-- names. The record is append-only: a build never changes its own input.
--
-- One record per input, not per build. The snapshot id also carries the build
-- digest, so the same input builds a different snapshot after a deploy that
-- changes what the code makes of it; those builds share the record, and each
-- finds it through its own `balance_read_snapshots.input_digest`. `job_id` is
-- the build that captured the input first.
CREATE TABLE projection_input_records (
  input_digest TEXT PRIMARY KEY
    CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  -- The build that captured this input; the balance projection uses its snapshot id.
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
  -- The revision the capture was pinned to (r0 = r1), and the epoch it was read in.
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 64),
  storage_ref TEXT NOT NULL CHECK(storage_ref GLOB 'projection-inputs/*'),
  byte_size INTEGER NOT NULL CHECK(byte_size>0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX projection_input_records_job ON projection_input_records(job_id);
CREATE TRIGGER projection_input_records_no_update BEFORE UPDATE ON projection_input_records
BEGIN SELECT RAISE(ABORT,'projection input records are append-only'); END;
CREATE TRIGGER projection_input_records_no_delete BEFORE DELETE ON projection_input_records
BEGIN SELECT RAISE(ABORT,'projection input records are append-only'); END;
CREATE TRIGGER projection_input_records_no_replace BEFORE INSERT ON projection_input_records
WHEN EXISTS(SELECT 1 FROM projection_input_records WHERE input_digest=NEW.input_digest)
BEGIN SELECT RAISE(ABORT,'projection input replacement is forbidden'); END;

-- Snapshot identity and the writer fence (05 §4). `input_digest` is the
-- content digest of the fixed input; `snapshot_id` is
-- sha256(input_digest || projection_build_digest || contract_version), so the
-- revision orders builds while the digest identifies their content.
-- `read_instance_id` and `core_epoch` say which physical read model and which
-- CORE the rows were built for; a snapshot restored next to a different one is
-- not silently the same context. `writer_fence` and `writer_lease` are the
-- fence of 05 §4: a writer that lost the lease cannot seal or publish, and
-- `writer_lease_until_ms` is what lets the next invocation take a build over
-- from a writer that crashed instead of leaving it building for ever.
ALTER TABLE balance_read_snapshots ADD COLUMN input_digest TEXT;
ALTER TABLE balance_read_snapshots ADD COLUMN source_revision INTEGER;
ALTER TABLE balance_read_snapshots ADD COLUMN visibility_revision INTEGER;
ALTER TABLE balance_read_snapshots ADD COLUMN core_epoch TEXT;
ALTER TABLE balance_read_snapshots ADD COLUMN read_instance_id TEXT;
ALTER TABLE balance_read_snapshots ADD COLUMN writer_lease TEXT;
ALTER TABLE balance_read_snapshots ADD COLUMN writer_lease_until_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE balance_read_snapshots ADD COLUMN writer_fence INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER balance_read_snapshots_identity_immutable BEFORE UPDATE ON balance_read_snapshots
WHEN (OLD.input_digest IS NOT NULL AND NEW.input_digest IS NOT OLD.input_digest)
 OR (OLD.source_revision IS NOT NULL AND NEW.source_revision IS NOT OLD.source_revision)
 OR (OLD.visibility_revision IS NOT NULL AND NEW.visibility_revision IS NOT OLD.visibility_revision)
 OR (OLD.core_epoch IS NOT NULL AND NEW.core_epoch IS NOT OLD.core_epoch)
 OR (OLD.read_instance_id IS NOT NULL AND NEW.read_instance_id IS NOT OLD.read_instance_id)
 OR NEW.writer_fence<OLD.writer_fence
BEGIN SELECT RAISE(ABORT,'snapshot identity is immutable and the fence never goes back'); END;

-- The active pointer (05 §5). Completing a snapshot and switching the pointer
-- happen in one batch; this table is what "active" means, so a late build that
-- finishes after a newer one cannot pull the read model back to an older
-- context. A rewind is possible only together with a new core epoch, which is
-- the restore case, not a normal build.
CREATE TABLE balance_snapshot_pointer (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 1 AND 64),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  switched_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER balance_snapshot_pointer_complete_only BEFORE INSERT ON balance_snapshot_pointer
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'the active snapshot must be complete'); END;
CREATE TRIGGER balance_snapshot_pointer_forward_only BEFORE UPDATE ON balance_snapshot_pointer
WHEN NEW.id<>OLD.id
 OR NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
   WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete')
 OR (NEW.core_epoch=OLD.core_epoch AND NEW.source_revision<OLD.source_revision)
BEGIN SELECT RAISE(ABORT,'the active snapshot never moves backwards'); END;
CREATE TRIGGER balance_snapshot_pointer_no_delete BEFORE DELETE ON balance_snapshot_pointer
BEGIN SELECT RAISE(ABORT,'the active pointer is switched, never removed'); END;

-- Chunk identity (05 §4). A re-sent chunk is a no-op only when its content is
-- the same; different content for a row already written is a conflict, not a
-- row silently kept out by INSERT OR IGNORE. RAISE(ABORT) overrides the
-- statement's conflict clause, so the re-send fails loudly even under IGNORE.
ALTER TABLE current_balance_projection ADD COLUMN row_digest TEXT;
CREATE TRIGGER current_balance_projection_chunk_conflict BEFORE INSERT ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM current_balance_projection r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.scope_key=NEW.scope_key
    AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'projection chunk conflict'); END;

-- Outbox completion (05 §6, 01 §5). A processor result is
-- pending / completed / retryable / blocked, and only `completed` sets
-- `processed_at`. `progress_code` and `pending_polls` record a build that is
-- still running without burning the failure budget; `blocked_code` stops the
-- row from being claimed again until an operator clears it; `evidence_ref` and
-- `applied_source_revision` are the evidence that the downstream effect really
-- landed — the snapshot that carries the decision, and the revision it covers.
-- `required_source_revision` is filled on the first claim: the decision's own
-- write already bumped the revision, so any snapshot at or above it includes
-- the decision.
ALTER TABLE decision_outbox ADD COLUMN progress_code TEXT
  CHECK(progress_code IS NULL OR length(progress_code) BETWEEN 1 AND 64);
ALTER TABLE decision_outbox ADD COLUMN pending_polls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decision_outbox ADD COLUMN blocked_code TEXT
  CHECK(blocked_code IS NULL OR length(blocked_code) BETWEEN 1 AND 64);
ALTER TABLE decision_outbox ADD COLUMN required_source_revision INTEGER;
ALTER TABLE decision_outbox ADD COLUMN evidence_ref TEXT;
ALTER TABLE decision_outbox ADD COLUMN applied_source_revision INTEGER;
CREATE TRIGGER decision_outbox_completion_guard BEFORE UPDATE ON decision_outbox
WHEN NEW.pending_polls<OLD.pending_polls
 OR (OLD.required_source_revision IS NOT NULL
     AND NEW.required_source_revision IS NOT OLD.required_source_revision)
 OR (NEW.processed_at IS NOT NULL AND NEW.evidence_ref IS NULL)
BEGIN SELECT RAISE(ABORT,'an outbox row is processed only with its completion evidence'); END;
