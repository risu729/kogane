-- Validate provenance and select the latest sealed policy once per parse,
-- before expanding its observations. Keep eligible_identity_runs flattenable
-- for the writer's keyed lookups. CROSS JOIN fixes the candidate driver at B
-- parses, preventing the planner from multiplying A reports by all parses.
DROP VIEW current_identity_observations;
CREATE VIEW current_identity_observations AS
WITH candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM parse_runs p
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL
   AND f.status='success' AND f.failure_count=0
), latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM candidates GROUP BY parse_run_id
)
SELECT o.*,r.policy_version,r.parse_run_id
FROM latest l
JOIN candidates r ON r.parse_run_id=l.parse_run_id AND r.policy_version=l.policy_version
JOIN identity_observations o ON o.identity_run_id=r.id;
