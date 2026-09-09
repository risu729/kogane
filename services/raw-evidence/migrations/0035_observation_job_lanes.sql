-- Observation job lanes (D09). Additive and rollback-safe: every new column
-- has a constant default, so a Worker that predates this migration keeps
-- inserting and selecting jobs unchanged; new tables are read only by the
-- lane-aware Worker. Layer A and Layer B evidence tables are not touched.

-- lane: which budget executes the job. Existing rows become 'incremental'.
-- target_release/replay_plan_id: reserved for targeted replay and a later
-- adoption PR; NULL for ordinary jobs. priority orders jobs within a lane.
-- created_at_ms is 0 for rows that predate this migration (age unknown).
ALTER TABLE observation_parse_jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'incremental'
  CHECK(lane IN ('incremental','replay','repair'));
ALTER TABLE observation_parse_jobs ADD COLUMN target_release TEXT;
ALTER TABLE observation_parse_jobs ADD COLUMN replay_plan_id INTEGER;
ALTER TABLE observation_parse_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE observation_parse_jobs ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX observation_jobs_lane_ready
  ON observation_parse_jobs(lane,status,available_at_ms);

-- Durable outbox written atomically with the raw seal. The trigger runs in
-- the same D1 transaction as the seal insert, so a seal that commits always
-- has its notification and raw-evidence code is unchanged. Items are
-- operational state: losing or mis-processing one is recovered by the repair
-- lane's cyclic scan, never by re-sealing.
CREATE TABLE observation_work_items (
  id INTEGER PRIMARY KEY,
  fetch_run_id INTEGER NOT NULL REFERENCES fetch_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('sealed_run')),
  enqueued_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  -- Bounded progress inside one run (staged runs may hold thousands of
  -- artifacts): the highest artifact id already examined for this item.
  cursor_artifact_id INTEGER NOT NULL DEFAULT 0,
  jobs_created INTEGER NOT NULL DEFAULT 0,
  outcome TEXT CHECK(outcome IN ('jobs_created','no_new_jobs','not_eligible')),
  UNIQUE(fetch_run_id,kind)
) STRICT;
CREATE INDEX observation_work_items_pending
  ON observation_work_items(processed_at_ms,id);
CREATE TRIGGER observation_work_items_on_seal AFTER INSERT ON fetch_run_seals
BEGIN
  INSERT OR IGNORE INTO observation_work_items(fetch_run_id,kind,enqueued_at_ms)
  VALUES(NEW.fetch_run_id,'sealed_run',NEW.sealed_at_ms);
END;

-- Targeted replay plans. The artifact id high-water is fixed when the plan is
-- created so later evidence never grows the plan. Status is mutable
-- operational state; plans never delete raw evidence or parse results.
CREATE TABLE observation_replay_plans (
  id INTEGER PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  dataset TEXT,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  target_release TEXT,
  artifact_id_from INTEGER NOT NULL DEFAULT 0,
  artifact_id_high_water INTEGER NOT NULL,
  fetched_from TEXT,
  fetched_to TEXT,
  status TEXT NOT NULL CHECK(status IN ('planned','running','paused','completed','cancelled')),
  estimated_artifacts INTEGER NOT NULL DEFAULT 0,
  already_parsed INTEGER NOT NULL DEFAULT 0,
  jobs_created INTEGER NOT NULL DEFAULT 0,
  creation_cursor INTEGER NOT NULL DEFAULT 0,
  creation_complete INTEGER NOT NULL DEFAULT 0 CHECK(creation_complete IN (0,1)),
  reason TEXT NOT NULL
) STRICT;
CREATE INDEX observation_replay_plans_status ON observation_replay_plans(status,id);

-- Per-lane scheduling state. observation_scan_state row 1 keeps its existing
-- meaning as the repair lane's cyclic artifact cursor; this table records
-- each lane's last sweep and, for incremental, the highest processed item.
CREATE TABLE observation_lane_state (
  lane TEXT PRIMARY KEY CHECK(lane IN ('incremental','replay','repair')),
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sweep_at_ms INTEGER NOT NULL DEFAULT 0,
  last_created INTEGER NOT NULL DEFAULT 0,
  last_executed INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO observation_lane_state(lane) VALUES('incremental'),('repair'),('replay');
