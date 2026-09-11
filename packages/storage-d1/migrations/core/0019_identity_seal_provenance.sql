-- An empty failed parse must not be publishable through direct SQL either.
CREATE TRIGGER identity_seal_success BEFORE INSERT ON identity_run_seals
WHEN NOT EXISTS(SELECT 1 FROM identity_runs r JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE r.id=NEW.identity_run_id AND p.status='ok')
BEGIN SELECT RAISE(ABORT,'identity_seal_parse_provenance_invalid'); END;
