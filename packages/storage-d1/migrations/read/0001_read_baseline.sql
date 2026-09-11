-- READ baseline: the rebuildable balance read model (unified plan 04, 05; U11).
--
-- This database holds nothing that is a record of what a provider reported. It
-- holds one projection of CORE, built from a fixed input, plus the operational
-- state of the builds (leases, checkpoints, the active pointer). Losing it
-- costs a rebuild and every open cursor; it costs no evidence, no decision and
-- no receipt (04 §1, 15 §3).
--
-- Three rules this file keeps:
--
--   * no foreign key names a CORE table. Two D1 databases cannot be joined and
--     cannot commit together (04 §1), so a CORE reference is carried as a
--     verified copy in `snapshot_input_refs` and never as a constraint (04 §3);
--   * every table is STRICT. Operational tables are mutable on purpose — this
--     database is rebuildable, so append-only guards would only make a rebuild
--     harder without protecting anything that is not also in CORE;
--   * a reader that selects `complete` rows through `balance_snapshot_pointer`
--     can never observe a partial build, a build of another physical READ
--     database, or a build that went backwards.
--
-- SNAPSHOT IDENTITY, AND WHY IT CARRIES AN ATTEMPT.
--
-- CORE's migration 0030 made a snapshot id final: `retired` is a terminal
-- state, so content that was retired and later came back (the exact content of
-- an earlier build returning) hit the retired row and the build was skipped,
-- leaving the pointer's watermark where it was. Here the content identity and
-- the row identity are separated:
--
--   content_key = sha256(input_digest ‖ build_digest ‖ contract_version)
--   snapshot_id = sha256(content_key ‖ ':' ‖ attempt ‖ ':' ‖ contract_version)
--
-- A build looks for a `building` or `complete` snapshot of its content key and
-- continues or reuses it. If it finds only retired ones it takes the next
-- attempt, which is a new `snapshot_id` and a new row, so the same content can
-- always be built again. `retired` stays terminal: a retired build is never
-- revived, its rows are deleted, and no cursor that names it is ever served.

-- The identity of this physical READ database. One row, written once by the
-- first writer that finds the table empty; a dropped and re-created database
-- gets a new id, which is exactly what makes every cursor from the lost
-- instance `context_expired` rather than silently answered from new rows
-- (05 §7, 15 §3). A migration cannot generate it, so this table starts empty.
CREATE TABLE read_instance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 8 AND 64),
  created_at TEXT NOT NULL,
  -- The shape of everything in this database; a change of shape is a new
  -- baseline and a new database (06 §2).
  contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 64)
) STRICT;
CREATE TRIGGER read_instance_single_row BEFORE INSERT ON read_instance
WHEN EXISTS(SELECT 1 FROM read_instance)
BEGIN SELECT RAISE(ABORT,'the read instance row is created once'); END;
CREATE TRIGGER read_instance_immutable BEFORE UPDATE ON read_instance
BEGIN SELECT RAISE(ABORT,'the read instance identity is immutable'); END;
CREATE TRIGGER read_instance_no_delete BEFORE DELETE ON read_instance
BEGIN SELECT RAISE(ABORT,'the read instance row is permanent'); END;

-- One build of the balance projection.
--
-- `source_revision`, `visibility_revision` and `core_epoch` are copied from the
-- fixed input, not read from CORE: they say which CORE context these rows were
-- built for. A reader compares them with CORE's current values, which is how a
-- restore that rewinds the counters (new epoch) and a restriction change (new
-- visibility revision) invalidate a snapshot instead of being filtered out of
-- it row by row (05 §2, §7).
--
-- `output_digest` is the digest of every row digest in contract order. It is
-- what makes "did this build already finish?" answerable after a lost response
-- without rebuilding anything (05 §5).
CREATE TABLE balance_read_snapshots (
  snapshot_id TEXT PRIMARY KEY
    CHECK(length(snapshot_id)=64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  -- sha256(input_digest ‖ build_digest ‖ contract_version): the content this
  -- build is of. Not unique: a retired build's content can be built again.
  content_key TEXT NOT NULL
    CHECK(length(content_key)=64 AND content_key NOT GLOB '*[^0-9a-f]*'),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  input_digest TEXT NOT NULL
    CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  build_digest TEXT NOT NULL
    CHECK(length(build_digest)=64 AND build_digest NOT GLOB '*[^0-9a-f]*'),
  contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 64),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 8 AND 64),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('building','complete','retired')),
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  relation_count INTEGER NOT NULL DEFAULT 0 CHECK(relation_count>=0),
  output_digest TEXT
    CHECK(output_digest IS NULL OR (length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*')),
  -- The writer fence of 05 §4: a writer whose lease was taken cannot write,
  -- seal or publish, and a crashed writer's build is taken over on the next
  -- tick rather than staying `building` for ever. On a complete build the
  -- lease is the one that sealed it, which is what lets the seal and the
  -- pointer switch of one batch refuse a displaced writer together.
  writer_lease TEXT,
  writer_lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(writer_lease_until_ms>=0),
  writer_fence INTEGER NOT NULL DEFAULT 0 CHECK(writer_fence>=0),
  -- The operational summary of the input (published high-water parse run and
  -- the declared releases), copied so a page needs no CORE read to pin the
  -- history window it belongs to.
  input_manifest_json TEXT NOT NULL
    CHECK(json_valid(input_manifest_json) AND json_type(input_manifest_json)='object'),
  projection_release TEXT NOT NULL CHECK(length(projection_release) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(content_key,attempt),
  -- A complete build has its evidence; a building one has none yet. A retired
  -- build keeps whatever it had, so neither check may be an equivalence.
  CHECK(status<>'complete' OR (completed_at IS NOT NULL AND output_digest IS NOT NULL)),
  CHECK(status<>'building' OR (completed_at IS NULL AND output_digest IS NULL))
) STRICT;
CREATE INDEX balance_read_snapshots_status ON balance_read_snapshots(status,created_at);
CREATE INDEX balance_read_snapshots_content ON balance_read_snapshots(content_key,attempt);

-- Rows are only ever built for the instance that owns this database. A dump
-- restored next to another instance's rows is refused rather than read as if
-- it were the same context (04 §3).
CREATE TRIGGER balance_read_snapshots_instance BEFORE INSERT ON balance_read_snapshots
WHEN NOT EXISTS(SELECT 1 FROM read_instance i
  WHERE i.id=1 AND i.read_instance_id=NEW.read_instance_id)
BEGIN SELECT RAISE(ABORT,'a snapshot belongs to this read instance only'); END;

-- building -> complete -> retired, never back, and the identity of a build
-- never changes. The fence only ever rises.
CREATE TRIGGER balance_read_snapshots_transition BEFORE UPDATE ON balance_read_snapshots
WHEN NEW.snapshot_id<>OLD.snapshot_id OR NEW.content_key<>OLD.content_key
 OR NEW.attempt<>OLD.attempt OR NEW.input_digest<>OLD.input_digest
 OR NEW.build_digest<>OLD.build_digest OR NEW.contract_version<>OLD.contract_version
 OR NEW.read_instance_id<>OLD.read_instance_id OR NEW.created_at<>OLD.created_at
 OR NEW.source_revision<>OLD.source_revision
 OR NEW.visibility_revision<>OLD.visibility_revision OR NEW.core_epoch<>OLD.core_epoch
 OR NEW.input_manifest_json<>OLD.input_manifest_json
 OR NEW.projection_release<>OLD.projection_release
 OR NEW.writer_fence<OLD.writer_fence
 OR (OLD.output_digest IS NOT NULL AND NEW.output_digest IS NOT OLD.output_digest)
 OR NOT ((OLD.status='building' AND NEW.status IN ('building','complete','retired'))
      OR (OLD.status='complete' AND NEW.status IN ('complete','retired'))
      OR (OLD.status='retired' AND NEW.status='retired'))
BEGIN SELECT RAISE(ABORT,'invalid read snapshot transition'); END;

-- One candidate measurement per row, in the same shape the CORE projection of
-- migration 0030 has, so the read SQL of packages/read-model runs unchanged
-- against this database. `row_digest` is mandatory here: a re-sent chunk is
-- decidable from the first build (05 §4).
CREATE TABLE current_balance_projection (
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 1024),
  subject_scope_key TEXT NOT NULL CHECK(length(subject_scope_key) BETWEEN 1 AND 1024),
  row_seq INTEGER NOT NULL CHECK(row_seq>=0),
  representative_observation_ref TEXT NOT NULL,
  member_evidence_refs_json TEXT NOT NULL
    CHECK(json_valid(member_evidence_refs_json) AND json_type(member_evidence_refs_json)='array'),
  member_metrics_json TEXT NOT NULL
    CHECK(json_valid(member_metrics_json) AND json_type(member_metrics_json)='array'),
  evidence_count INTEGER NOT NULL CHECK(evidence_count>=1),
  metric_id TEXT NOT NULL,
  definition_release TEXT NOT NULL,
  quantity_coefficient TEXT,
  quantity_scale INTEGER,
  value_status TEXT NOT NULL CHECK(value_status IN ('exact','missing','unparsed','conflict')),
  unit_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('adopted','excluded','unresolved','conflict','stale')),
  reason_code TEXT,
  as_of_role TEXT NOT NULL,
  as_of_kind TEXT NOT NULL CHECK(as_of_kind IN ('instant','local-date','period','unknown')),
  as_of_value TEXT,
  temporal_json TEXT NOT NULL CHECK(json_valid(temporal_json)),
  freshness TEXT NOT NULL CHECK(freshness IN ('current','stale','unknown')),
  freshness_reason TEXT,
  sort_as_of TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_account TEXT NOT NULL,
  metric TEXT NOT NULL,
  instrument TEXT NOT NULL,
  parser TEXT NOT NULL,
  -- CORE identifiers, kept as the canonical reference of 04 §3. They address
  -- CORE rows; nothing in this database is a permanent reference of its own.
  observation_id INTEGER NOT NULL,
  parse_run_id INTEGER NOT NULL,
  fetch_artifact_id INTEGER NOT NULL,
  amount_minor TEXT,
  amount_text TEXT,
  as_of TEXT,
  observed_at TEXT,
  measure_view TEXT NOT NULL CHECK(measure_view IN ('balances','summaries')),
  latest_in_group INTEGER NOT NULL CHECK(latest_in_group IN (0,1)),
  row_digest TEXT NOT NULL CHECK(length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(snapshot_id,scope_key),
  CHECK((value_status='exact') = (quantity_coefficient IS NOT NULL AND quantity_scale IS NOT NULL)),
  CHECK(quantity_scale IS NULL OR (quantity_scale BETWEEN 0 AND 4096))
) STRICT;
CREATE UNIQUE INDEX current_balance_projection_order
  ON current_balance_projection(snapshot_id,row_seq);
CREATE INDEX current_balance_projection_scope
  ON current_balance_projection(snapshot_id,source_id,source_account,instrument,metric);
CREATE INDEX current_balance_projection_state
  ON current_balance_projection(snapshot_id,state,metric_id,unit_ref);

CREATE TRIGGER current_balance_projection_building_only BEFORE INSERT ON current_balance_projection
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'projection rows need a building snapshot'); END;
-- A re-sent chunk is a no-op only when its content is the same; different
-- content for a row already written is a conflict. RAISE(ABORT) overrides the
-- statement's OR IGNORE, so the re-send fails loudly instead of being hidden.
CREATE TRIGGER current_balance_projection_chunk_conflict BEFORE INSERT ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM current_balance_projection r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.scope_key=NEW.scope_key
    AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'projection chunk conflict'); END;
CREATE TRIGGER current_balance_projection_sealed_no_update BEFORE UPDATE ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed read snapshot is immutable'); END;
-- Deleting a retired build's rows is the rebuild path; deleting a published
-- one's is not.
CREATE TRIGGER current_balance_projection_sealed_no_delete BEFORE DELETE ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the snapshot before deleting its rows'); END;

-- The CORE references this build was made from, copied and digested from the
-- fixed input (04 §3). A decision id cannot be a foreign key across databases,
-- so it is verified here instead: a relation that claims a decision must name
-- one this snapshot recorded as its input.
CREATE TABLE snapshot_input_refs (
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN
    ('decision_revision','entity_relation','policy_release','restriction_revision',
     'published_high_water','identity_release','decimal_policy_release')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) BETWEEN 1 AND 256),
  ref_digest TEXT NOT NULL
    CHECK(length(ref_digest)=64 AND ref_digest NOT GLOB '*[^0-9a-f]*'),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,ref_kind,ref_id)
) STRICT;
CREATE INDEX snapshot_input_refs_kind ON snapshot_input_refs(ref_kind,ref_id);
CREATE TRIGGER snapshot_input_refs_building_only BEFORE INSERT ON snapshot_input_refs
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'input refs are recorded while the snapshot is building'); END;
CREATE TRIGGER snapshot_input_refs_no_update BEFORE UPDATE ON snapshot_input_refs
BEGIN SELECT RAISE(ABORT,'a snapshot never changes its own input refs'); END;
CREATE TRIGGER snapshot_input_refs_no_delete BEFORE DELETE ON snapshot_input_refs
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'retired')
BEGIN SELECT RAISE(ABORT,'retire the snapshot before deleting its input refs'); END;

-- Typed relations between measurement scopes, per snapshot. Unlike the CORE
-- table of migration 0030 these belong to one build: a relation derived from a
-- decision that was later revised does not change what an already published
-- snapshot says.
CREATE TABLE scope_relations (
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  from_scope_key TEXT NOT NULL CHECK(length(from_scope_key) BETWEEN 1 AND 1024),
  to_scope_key TEXT NOT NULL
    CHECK(length(to_scope_key) BETWEEN 1 AND 1024 AND to_scope_key<>from_scope_key),
  relation TEXT NOT NULL CHECK(relation IN ('same','disjoint','subset','overlaps','unknown')),
  source TEXT NOT NULL CHECK(source IN ('policy','decision','derived')),
  -- The CORE decision revision, as a copied reference: no cross-database FK.
  decision_revision_id TEXT,
  release TEXT NOT NULL CHECK(length(release) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,from_scope_key,to_scope_key),
  CHECK((source='decision') = (decision_revision_id IS NOT NULL))
) STRICT;
CREATE INDEX scope_relations_from ON scope_relations(snapshot_id,from_scope_key);
CREATE TRIGGER scope_relations_building_only BEFORE INSERT ON scope_relations
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'scope relations need a building snapshot'); END;
-- 04 §3: the decision a relation claims is one this snapshot fixed as input.
CREATE TRIGGER scope_relations_decision_ref BEFORE INSERT ON scope_relations
WHEN NEW.decision_revision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM snapshot_input_refs r WHERE r.snapshot_id=NEW.snapshot_id
    AND r.ref_kind='decision_revision' AND r.ref_id=NEW.decision_revision_id)
BEGIN SELECT RAISE(ABORT,'a decision relation needs its decision in the snapshot input refs'); END;
CREATE TRIGGER scope_relations_sealed_no_update BEFORE UPDATE ON scope_relations
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed read snapshot is immutable'); END;
CREATE TRIGGER scope_relations_sealed_no_delete BEFORE DELETE ON scope_relations
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the snapshot before deleting its relations'); END;

-- What the read model publishes. The seal and this switch are one D1 batch
-- (05 §5), so a reader never sees a snapshot that is complete but unpublished
-- as if it were current, and a build that finishes late is complete without
-- pulling the pointer back to an older context.
CREATE TABLE balance_snapshot_pointer (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 8 AND 64),
  output_digest TEXT NOT NULL
    CHECK(length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*'),
  switched_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER balance_snapshot_pointer_complete_only BEFORE INSERT ON balance_snapshot_pointer
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete'
    AND s.read_instance_id=NEW.read_instance_id)
BEGIN SELECT RAISE(ABORT,'the active snapshot must be complete and local'); END;
-- Forward only by source revision inside one epoch. A new epoch is the restore
-- case (05 §2): the counters may have rewound, so the comparison is void and
-- the operator's rebuild decides.
CREATE TRIGGER balance_snapshot_pointer_forward_only BEFORE UPDATE ON balance_snapshot_pointer
WHEN NEW.id<>OLD.id
 OR NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
   WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete'
     AND s.read_instance_id=NEW.read_instance_id)
 OR (NEW.core_epoch=OLD.core_epoch AND NEW.source_revision<OLD.source_revision)
BEGIN SELECT RAISE(ABORT,'the active snapshot never moves backwards'); END;
CREATE TRIGGER balance_snapshot_pointer_no_delete BEFORE DELETE ON balance_snapshot_pointer
BEGIN SELECT RAISE(ABORT,'the active pointer is switched, never removed'); END;

-- Where a bounded build got to. The chunk and its checkpoint are written in one
-- D1 batch, so a statement error rolls both back and a checkpoint can never
-- claim rows that are not there (05 §4, G2-08). `writer_lease` and
-- `writer_fence` are copied from the claim, so a displaced writer's checkpoint
-- is refused by the same fence that refuses its rows.
CREATE TABLE read_build_checkpoints (
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  stage TEXT NOT NULL CHECK(stage IN ('rows','relations')),
  position TEXT NOT NULL CHECK(length(position) BETWEEN 1 AND 128),
  rows_written INTEGER NOT NULL CHECK(rows_written>=0),
  writer_lease TEXT NOT NULL CHECK(length(writer_lease) BETWEEN 1 AND 128),
  writer_fence INTEGER NOT NULL CHECK(writer_fence>=0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,stage)
) STRICT;
CREATE TRIGGER read_build_checkpoints_building_only BEFORE INSERT ON read_build_checkpoints
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'a checkpoint needs a building snapshot'); END;
CREATE TRIGGER read_build_checkpoints_forward_only BEFORE UPDATE ON read_build_checkpoints
WHEN NEW.rows_written<OLD.rows_written OR NEW.writer_fence<OLD.writer_fence
BEGIN SELECT RAISE(ABORT,'a build checkpoint never goes backwards'); END;
