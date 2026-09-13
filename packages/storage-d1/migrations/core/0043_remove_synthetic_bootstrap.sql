-- Remove production bootstrap verification metadata, never shared raw objects.
-- The dedicated source and the explicitly annotated pre-source bootstrap runs
-- contain no parsed observations. Unexpected dependent rows fail the migration
-- through the existing restrictive foreign keys; they are not cascaded away.
-- Wrangler applies each migration atomically. Restore every append-only guard
-- before completion; no production write path receives a deletion exception.
CREATE TABLE _synthetic_cleanup_runs (
  id INTEGER PRIMARY KEY,
  acquisition_session_id INTEGER NOT NULL
);
INSERT INTO _synthetic_cleanup_runs
SELECT r.id, r.acquisition_session_id
FROM fetch_runs AS r
JOIN acquisition_sessions AS s ON s.id = r.acquisition_session_id
WHERE r.source_id = 'kogane-synthetic'
   OR (s.external_id_namespace = 'synthetic' AND EXISTS (
     SELECT 1 FROM fetch_run_annotations AS a
     WHERE a.fetch_run_id = r.id
       AND a.annotation_kind = 'exclude_from_financial_views'
       AND a.reason_code = 'legacy-synthetic-bootstrap'
   ));

DROP TRIGGER ingestion_attempts_no_delete;
DROP TRIGGER fetch_run_seals_no_delete;
DROP TRIGGER run_inventory_items_no_delete;
DROP TRIGGER run_inventories_no_delete;
DROP TRIGGER fetch_artifacts_no_delete;
DROP TRIGGER fetch_run_reports_no_delete;
DROP TRIGGER fetch_run_annotations_no_delete;
DROP TRIGGER fetch_runs_no_delete;
DROP TRIGGER acquisition_sessions_no_delete;

DELETE FROM ingestion_attempts WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM fetch_run_seals WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM run_inventory_items WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM run_inventories WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM fetch_artifacts WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM fetch_run_reports WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM fetch_run_annotations WHERE fetch_run_id IN (SELECT id FROM _synthetic_cleanup_runs);
DELETE FROM fetch_runs WHERE id IN (SELECT id FROM _synthetic_cleanup_runs);
-- A session can contain real runs too. Only remove one that is now empty.
DELETE FROM acquisition_sessions
WHERE id IN (SELECT acquisition_session_id FROM _synthetic_cleanup_runs)
  AND NOT EXISTS (SELECT 1 FROM fetch_runs WHERE acquisition_session_id = acquisition_sessions.id)
  AND NOT EXISTS (SELECT 1 FROM collection_runs WHERE acquisition_session_id = acquisition_sessions.id);

-- Remove the production source and its ingress routes so it cannot reappear
-- in source selectors or accept another bootstrap run. Local fixtures can
-- still insert their own invented source registries after migrating.
DELETE FROM ingest_client_routes WHERE source_id = 'kogane-synthetic';
DELETE FROM producer_sources WHERE source_id = 'kogane-synthetic';
DELETE FROM http_scope_rules WHERE source_id = 'kogane-synthetic';
DELETE FROM origin_template_policies WHERE source_id = 'kogane-synthetic';
DELETE FROM source_external_ids WHERE source_id = 'kogane-synthetic';
DELETE FROM sources WHERE id = 'kogane-synthetic';
DROP TABLE _synthetic_cleanup_runs;

CREATE TRIGGER ingestion_attempts_no_delete BEFORE DELETE ON ingestion_attempts
BEGIN SELECT RAISE(ABORT, 'ingestion_attempts is append-only'); END;
CREATE TRIGGER fetch_run_seals_no_delete BEFORE DELETE ON fetch_run_seals
BEGIN SELECT RAISE(ABORT, 'fetch_run_seals is append-only'); END;
CREATE TRIGGER run_inventory_items_no_delete BEFORE DELETE ON run_inventory_items
BEGIN SELECT RAISE(ABORT, 'run_inventory_items is append-only'); END;
CREATE TRIGGER run_inventories_no_delete BEFORE DELETE ON run_inventories
BEGIN SELECT RAISE(ABORT, 'run_inventories is append-only'); END;
CREATE TRIGGER fetch_artifacts_no_delete BEFORE DELETE ON fetch_artifacts
BEGIN SELECT RAISE(ABORT, 'fetch_artifacts is append-only'); END;
CREATE TRIGGER fetch_run_reports_no_delete BEFORE DELETE ON fetch_run_reports
BEGIN SELECT RAISE(ABORT, 'fetch_run_reports is append-only'); END;
CREATE TRIGGER fetch_run_annotations_no_delete
BEFORE DELETE ON fetch_run_annotations
BEGIN SELECT RAISE(ABORT, 'fetch_run_annotations is append-only'); END;
CREATE TRIGGER fetch_runs_no_delete BEFORE DELETE ON fetch_runs
BEGIN SELECT RAISE(ABORT, 'fetch_runs is append-only'); END;
CREATE TRIGGER acquisition_sessions_no_delete BEFORE DELETE ON acquisition_sessions
BEGIN SELECT RAISE(ABORT, 'acquisition_sessions is append-only'); END;
