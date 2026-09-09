-- Unit-scoped partial-run eligibility (design review D13, PR-14, policy
-- `unit-independent-v1`). Additive and inert on deploy: no policy row is
-- switched to the unit scope here, so every dataset keeps the run-scoped rule
-- `observation_fetch_runs.status = 'success' AND failure_count = 0`.
-- Enabling one dataset is an operator INSERT/UPDATE documented in
-- docs/parser-coverage.md, never a deploy.

-- The unit outcome that belongs to one artifact. A row exists only when the
-- artifact is attributed to a fetch unit (`fetch_unit_id`), that unit has its
-- own terminal report, and the run is sealed; artifacts without a unit (a
-- run-level manifest, a single-unit source, a collector that never catalogued
-- units) have no row and therefore stay on the run scope.
--
-- `unit_status` is 'success' only when the unit's own terminal report says
-- success with no safe failure code AND no collector_error artifact is
-- attributable to that unit or to the whole run. A run-level collector error
-- (`fetch_unit_id IS NULL`) is not attributable to any unit, so it disqualifies
-- every unit of the run: that is the conservative half of D13's "do not mix
-- page dependence with unit independence".
--
-- Sealing is required because Layer A's seal trigger is what proves the unit
-- is complete: a sealed run must carry a terminal report for every unit that
-- declared one required, and a unit whose terminal report declares
-- `declared_artifact_count` with scope 'direct' must own exactly that many
-- artifacts (migration 0001, `run_inventory_*` triggers). Without the seal a
-- unit's artifact set is still open.
CREATE VIEW IF NOT EXISTS observation_fetch_artifact_units AS
SELECT a.id AS fetch_artifact_id,
       u.fetch_run_id,
       u.id AS fetch_unit_id,
       u.unit_kind,
       u.unit_key,
       ur.normalized_outcome AS unit_outcome,
       ur.safe_failure_code AS unit_failure_code,
       CASE
         WHEN ur.normalized_outcome = 'success'
          AND ur.safe_failure_code IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM fetch_artifacts e
            WHERE e.fetch_run_id = u.fetch_run_id
              AND e.artifact_role = 'collector_error'
              AND (e.fetch_unit_id IS NULL OR e.fetch_unit_id = u.id)
          )
         THEN 'success' ELSE 'failed'
       END AS unit_status
FROM fetch_artifacts a
JOIN fetch_units u ON u.id = a.fetch_unit_id AND u.fetch_run_id = a.fetch_run_id
JOIN fetch_unit_reports ur ON ur.fetch_unit_id = u.id AND ur.report_kind = 'terminal'
WHERE EXISTS (SELECT 1 FROM fetch_run_seals s WHERE s.fetch_run_id = a.fetch_run_id);

-- A dataset can be independent at the unit level without being a container
-- snapshot dataset. MyJCB is exactly that case: its cards are independent
-- fetch units, but its current-statement selection lives in the per-source
-- multi-page contract in queries.ts, not in SNAPSHOT_DATASETS. A row with
-- `snapshot_selection = 0` carries only the eligibility policy (`unit_scope`)
-- and is skipped by the snapshot CTEs, so naming a dataset for unit-scoped
-- parsing never enrols it into container-snapshot selection.
ALTER TABLE dataset_snapshot_policies
  ADD COLUMN snapshot_selection INTEGER NOT NULL DEFAULT 1
    CHECK (snapshot_selection IN (0, 1));

-- What the parse knew about its own eligibility. `unit_scope = 'unit'` marks a
-- claim produced under `unit-independent-v1`; together with the existing
-- `parent_run_status` / `parent_run_failure_count` it records that the parent
-- run was partial and which unit report allowed the parse anyway.
ALTER TABLE parse_coverage_claims
  ADD COLUMN unit_scope TEXT NOT NULL DEFAULT 'run' CHECK (unit_scope IN ('run', 'unit'));
ALTER TABLE parse_coverage_claims
  ADD COLUMN unit_report_outcome TEXT CHECK (unit_report_outcome IS NULL OR unit_report_outcome IN (
    'success', 'partial', 'failed', 'human_required', 'cancelled', 'unknown'));
