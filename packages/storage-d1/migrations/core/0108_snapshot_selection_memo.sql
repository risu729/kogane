-- ADR 0129, slice 2 (issue #1491): the current snapshot set as data.
--
-- Every latest-state read used to recompute which capture is the current one
-- of each container from the whole stored history. This migration adds what
-- lets the Processor compute that set once per change of its inputs, by a
-- walk that starts at each container's newest capture, and lets its scheduled
-- reads start from the set's members:
--
--   core_snapshot_input_revision   a counter moved by every write of a table
--                                  that decides currentness (the ledger below)
--   snapshot_selection_containers  the containers a walk visits, one row per
--                                  (source, parser, dataset, unit, connection)
--                                  that ever had a published parse
--   snapshot_selection_keys        one row per computed set: (revision, core
--                                  epoch, digest of the walk's SQL text)
--   snapshot_selection_members     the set itself: ids only
--
-- None of them is evidence or a projection input. All four are outside the
-- source-revision ledger (packages/read-model/src/source-revision.ts,
-- REVISION_EXCLUDED_TABLES): the memo is written from what the ledger already
-- covers, and a memo write that moved the CORE revision would make every build
-- stale the moment it wrote. Additive only: no existing table, view, trigger
-- or row is altered, and a Worker build that predates this migration keeps
-- reading as before because it never names these tables.

-- THE SNAPSHOT-INPUT LEDGER. These tables decide which capture of a container
-- is current (packages/parsers/src/snapshot-query.ts and the V Point and MyJCB
-- selections in packages/read-model/src/current-captures.ts); every write of
-- one moves the counter in the same transaction. The list is mirrored by
-- SNAPSHOT_INPUT_REVISION_LEDGER in packages/read-model/src/source-revision.ts,
-- and a test asserts that the triggers are exactly the ledger.
--
--   parse_runs, published_parse_runs, publication_events   (what is adopted)
--   parse_coverage_claims, dataset_snapshot_policies       (coverage, policy)
--   fetch_run_seals                                        (evidence becomes visible)
--   fetch_run_annotations                                  (a run hidden from financial views)
--
-- Not in it: fetch_runs, fetch_artifacts, fetch_units, fetch_unit_reports,
-- fetch_run_reports and acquisition_sessions. A run's catalogue rows reach a
-- selection only through the sealed view, and each of those tables refuses an
-- insert into a sealed run and every update and delete (migration 0001), so
-- what the selection reads of them is fixed by the time the seal moves the
-- counter.
CREATE TABLE core_snapshot_input_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>=0)
) STRICT;
INSERT INTO core_snapshot_input_revision(id,revision) VALUES(1,1);
CREATE TRIGGER core_snapshot_input_revision_single_row BEFORE INSERT ON core_snapshot_input_revision
BEGIN SELECT RAISE(ABORT,'the snapshot input revision row is created once'); END;
CREATE TRIGGER core_snapshot_input_revision_no_delete BEFORE DELETE ON core_snapshot_input_revision
BEGIN SELECT RAISE(ABORT,'the snapshot input revision row is permanent'); END;

CREATE TRIGGER parse_runs_bump_snapshot_input_insert AFTER INSERT ON parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER parse_runs_bump_snapshot_input_update AFTER UPDATE ON parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER parse_runs_bump_snapshot_input_delete AFTER DELETE ON parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_snapshot_input_insert AFTER INSERT ON published_parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_snapshot_input_update AFTER UPDATE ON published_parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER published_parse_runs_bump_snapshot_input_delete AFTER DELETE ON published_parse_runs BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_snapshot_input_insert AFTER INSERT ON publication_events BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_snapshot_input_update AFTER UPDATE ON publication_events BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER publication_events_bump_snapshot_input_delete AFTER DELETE ON publication_events BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_snapshot_input_insert AFTER INSERT ON parse_coverage_claims BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_snapshot_input_update AFTER UPDATE ON parse_coverage_claims BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER parse_coverage_claims_bump_snapshot_input_delete AFTER DELETE ON parse_coverage_claims BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_snapshot_input_insert AFTER INSERT ON dataset_snapshot_policies BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_snapshot_input_update AFTER UPDATE ON dataset_snapshot_policies BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER dataset_snapshot_policies_bump_snapshot_input_delete AFTER DELETE ON dataset_snapshot_policies BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_snapshot_input_insert AFTER INSERT ON fetch_run_seals BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_snapshot_input_update AFTER UPDATE ON fetch_run_seals BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_seals_bump_snapshot_input_delete AFTER DELETE ON fetch_run_seals BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_snapshot_input_insert AFTER INSERT ON fetch_run_annotations BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_snapshot_input_update AFTER UPDATE ON fetch_run_annotations BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER fetch_run_annotations_bump_snapshot_input_delete AFTER DELETE ON fetch_run_annotations BEGIN UPDATE core_snapshot_input_revision SET revision=revision+1 WHERE id=1; END;

-- The containers a walk visits. A capture can be current for a parser only
-- through a published parse by that parser, so a container is registered when
-- its first parse is published, and never removed: a container whose captures
-- all stopped being eligible is still walked, and finds nothing. `dataset_key`
-- and `unit_key` are the artifact's dataset and fetch unit key ('' for none:
-- neither may be empty in fetch_artifacts or fetch_units). `connection_key` is
-- the MyJCB past-months connection (the artifact key before its first '/',
-- MYJCB_PAST_MONTHS_CONNECTION in current-captures.ts) for that parser and ''
-- for every other. Keyed by publication rather than by every artifact insert,
-- so a dataset that two sources share (`realised-gains`) is walked only for
-- the parser that ever published one of its captures.
CREATE TABLE snapshot_selection_containers (
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  parser_name TEXT NOT NULL CHECK(length(parser_name) BETWEEN 1 AND 200),
  dataset_key TEXT NOT NULL CHECK(length(dataset_key) BETWEEN 0 AND 200),
  unit_key TEXT NOT NULL CHECK(length(unit_key) BETWEEN 0 AND 500),
  connection_key TEXT NOT NULL CHECK(length(connection_key) BETWEEN 0 AND 500),
  PRIMARY KEY(source_id,parser_name,dataset_key,unit_key,connection_key)
) STRICT, WITHOUT ROWID;

-- A container already registered is skipped by NOT EXISTS, not by INSERT OR
-- IGNORE: a trigger's conflict clause gives way to the firing statement's, so
-- an upsert or INSERT OR REPLACE of the publication would fail on it.
CREATE TRIGGER published_parse_runs_register_snapshot_container_insert AFTER INSERT ON published_parse_runs
BEGIN
  INSERT INTO snapshot_selection_containers(source_id,parser_name,dataset_key,unit_key,connection_key)
  SELECT container.* FROM (
    SELECT a.source_id, NEW.parser_name AS parser_name, coalesce(a.dataset,'') AS dataset_key,
           coalesce(u.unit_key,'') AS unit_key,
           CASE WHEN NEW.parser_name='myjcb-credit-past-month-balances'
                THEN substr(a.artifact_key, 1, instr(a.artifact_key, '/') - 1) ELSE '' END AS connection_key
    FROM fetch_artifacts a LEFT JOIN fetch_units u ON u.id=a.fetch_unit_id
    WHERE a.id=NEW.fetch_artifact_id
  ) container
  WHERE NOT EXISTS (SELECT 1 FROM snapshot_selection_containers registered
                    WHERE registered.source_id=container.source_id
                      AND registered.parser_name=container.parser_name
                      AND registered.dataset_key=container.dataset_key
                      AND registered.unit_key=container.unit_key
                      AND registered.connection_key=container.connection_key);
END;
CREATE TRIGGER published_parse_runs_register_snapshot_container_update AFTER UPDATE ON published_parse_runs
BEGIN
  INSERT INTO snapshot_selection_containers(source_id,parser_name,dataset_key,unit_key,connection_key)
  SELECT container.* FROM (
    SELECT a.source_id, NEW.parser_name AS parser_name, coalesce(a.dataset,'') AS dataset_key,
           coalesce(u.unit_key,'') AS unit_key,
           CASE WHEN NEW.parser_name='myjcb-credit-past-month-balances'
                THEN substr(a.artifact_key, 1, instr(a.artifact_key, '/') - 1) ELSE '' END AS connection_key
    FROM fetch_artifacts a LEFT JOIN fetch_units u ON u.id=a.fetch_unit_id
    WHERE a.id=NEW.fetch_artifact_id
  ) container
  WHERE NOT EXISTS (SELECT 1 FROM snapshot_selection_containers registered
                    WHERE registered.source_id=container.source_id
                      AND registered.parser_name=container.parser_name
                      AND registered.dataset_key=container.dataset_key
                      AND registered.unit_key=container.unit_key
                      AND registered.connection_key=container.connection_key);
END;

-- Every container that already had a published parse.
INSERT OR IGNORE INTO snapshot_selection_containers(source_id,parser_name,dataset_key,unit_key,connection_key)
SELECT DISTINCT a.source_id, published.parser_name, coalesce(a.dataset,''), coalesce(u.unit_key,''),
       CASE WHEN published.parser_name='myjcb-credit-past-month-balances'
            THEN substr(a.artifact_key, 1, instr(a.artifact_key, '/') - 1) ELSE '' END
FROM published_parse_runs published
JOIN fetch_artifacts a ON a.id=published.fetch_artifact_id
LEFT JOIN fetch_units u ON u.id=a.fetch_unit_id;

-- The walks order captures by their raw time in ms, the shipped selections by
-- the sealed view's text of that time, which is NULL from year 10000 on (and a
-- NULL sorts last). Both orders agree only below that bound, so no capture or
-- terminal report may carry a time at or past it. Updates of either table are
-- already refused (migration 0001); production held none past it when this
-- was added (2026-11-23).
CREATE TRIGGER fetch_artifacts_capture_time_before_10000 BEFORE INSERT ON fetch_artifacts
WHEN coalesce(NEW.fetched_at_ms, NEW.recorded_at_ms) >= 253402300800000
BEGIN SELECT RAISE(ABORT,'fetch_artifacts capture time is past year 9999'); END;
CREATE TRIGGER fetch_run_reports_completion_before_10000 BEFORE INSERT ON fetch_run_reports
WHEN NEW.completed_at_ms >= 253402300800000
BEGIN SELECT RAISE(ABORT,'fetch_run_reports completion time is past year 9999'); END;

-- The walks' order. A container's captures newest first, by the time the
-- sealed view shows (`observation_fetch_artifacts.fetched_at`), and the
-- terminal reports newest first for the V Point run selection, which ranks
-- runs by completion. Each index of this migration is partial on a condition
-- that always holds (its columns are NOT NULL) and that only the memo's
-- statements state, so that no other statement's plan moves to it: without
-- table statistics a new (source_id, dataset) index replaced the plans of reads
-- that filter by source, and a terminal-report index those of the views.
CREATE INDEX idx_fetch_artifacts_source_dataset_capture
  ON fetch_artifacts (source_id, dataset, coalesce(fetched_at_ms, recorded_at_ms) DESC, id DESC)
  WHERE coalesce(fetched_at_ms, recorded_at_ms) IS NOT NULL;
CREATE INDEX idx_fetch_run_reports_terminal_completion
  ON fetch_run_reports (completed_at_ms DESC, fetch_run_id DESC)
  WHERE report_kind='terminal' AND coalesce(completed_at_ms, fetch_run_id) IS NOT NULL;
-- Whether a walked capture's dataset is unit-scoped (`unitScopePolicySql`) is
-- asked per capture; without this the policy table is scanned each time.
CREATE INDEX idx_dataset_snapshot_policies_source_dataset
  ON dataset_snapshot_policies (source_id, dataset);
-- A memo-backed read reaches the published parses of a parser that no
-- snapshot rule governs (whose every published row is current) by parser.
CREATE INDEX idx_published_parse_runs_parser
  ON published_parse_runs (parser_name, fetch_artifact_id, parse_run_id)
  WHERE coalesce(parser_name, parse_run_id) IS NOT NULL;

-- One computed set. Only the Processor writes it, in one batch with its
-- members, and only for the current revision and core epoch; `selection_digest`
-- is the SHA-256 of the walk's SQL text, which carries every code-owned
-- constant the selection uses, so a deploy that changes one computes again.
CREATE TABLE snapshot_selection_keys (
  id INTEGER PRIMARY KEY,
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
  computed_at_ms INTEGER NOT NULL CHECK(computed_at_ms>=0),
  UNIQUE(snapshot_revision,core_epoch,selection_digest)
) STRICT;

-- The members of one set, ids only. `container` and `artifact-container`
-- rows are every sealed artifact of a current snapshot, with the parser (and
-- the parser version the dataset's policy requires) it is current for;
-- `myjcb-past-months` rows are the current MyJCB past-months captures; a
-- `vpoint-run` row is the current V Point run of a source, with no parser and
-- artifact 0. Deleted with their key when the key is no longer current.
CREATE TABLE snapshot_selection_members (
  key_id INTEGER NOT NULL REFERENCES snapshot_selection_keys(id),
  selection TEXT NOT NULL CHECK(selection IN ('container','artifact-container','myjcb-past-months','vpoint-run')),
  parser_name TEXT NOT NULL CHECK(length(parser_name) BETWEEN 0 AND 200),
  fetch_artifact_id INTEGER NOT NULL CHECK(fetch_artifact_id>=0),
  fetch_run_id INTEGER NOT NULL CHECK(fetch_run_id>=0),
  required_version TEXT CHECK(required_version IS NULL OR length(required_version) BETWEEN 1 AND 100),
  PRIMARY KEY(key_id,selection,parser_name,fetch_artifact_id,fetch_run_id)
) STRICT, WITHOUT ROWID;
