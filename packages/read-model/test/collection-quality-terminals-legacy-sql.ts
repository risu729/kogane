// Frozen from 1151e090, before migration 0086. Do not derive from current SQL.
export const LEGACY_UNREGISTERED_QUALITY_SQL = `SELECT r.source, r.blocked_code, COUNT(*) AS runs,
       MAX(r.first_seen_at) AS newest_seen_at
  FROM json_each(?1) wanted
  CROSS JOIN collection_runs r ON r.source = wanted.value
 WHERE r.registered_at IS NULL
   AND r.id = (SELECT MAX(newest.id) FROM collection_runs newest
                WHERE newest.source = r.source AND newest.run_id = r.run_id)
   AND NOT EXISTS (SELECT 1 FROM collection_runs done
                    WHERE done.source = r.source AND done.run_id = r.run_id
                      AND done.registered_at IS NOT NULL)
 GROUP BY r.source, r.blocked_code
 ORDER BY r.source, r.blocked_code`;

export const LEGACY_TERMINAL_QUALITY_SQL = `WITH wanted(source, run_id) AS (
  SELECT json_extract(pair.value, '$[0]'), json_extract(pair.value, '$[1]')
    FROM json_each(?1) pair
)
SELECT r.id, r.source, r.run_id, r.provider_outcome, r.coverage_status, r.blocked_code,
       r.registered_at,
       CASE WHEN EXISTS (SELECT 1 FROM observation_fetch_runs f WHERE f.id = r.fetch_run_id)
            THEN r.fetch_run_id END AS visible_fetch_run_id,
       (SELECT stage.state FROM collection_run_stages stage
         WHERE stage.collection_run_id = r.id AND stage.stage = 'registered'
         ORDER BY stage.id DESC LIMIT 1) AS registered_stage_state,
       (SELECT stage.failure_code FROM collection_run_stages stage
         WHERE stage.collection_run_id = r.id AND stage.stage = 'registered'
         ORDER BY stage.id DESC LIMIT 1) AS registered_stage_failure_code
  FROM wanted
  CROSS JOIN collection_runs r ON r.source = wanted.source AND r.run_id = wanted.run_id
 ORDER BY r.id`;
