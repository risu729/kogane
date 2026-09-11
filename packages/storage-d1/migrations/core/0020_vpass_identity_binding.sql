-- Trusted importer sidecars only; provider observation extra_json is not evidence.
CREATE VIEW trusted_vpass_card_bindings AS WITH candidates AS (
SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
       ba.id AS binding_artifact_id, bu.unit_key AS card_token,
       count(*) OVER(PARTITION BY fa.id) AS candidate_count
FROM fetch_artifacts fa
JOIN observation_fetch_artifacts visible ON visible.id=fa.id
JOIN fetch_runs financial ON financial.id=fa.fetch_run_id
JOIN acquisition_sessions session ON session.id=financial.acquisition_session_id
 AND session.producer_id=financial.producer_id AND session.external_id_namespace='vpass-worker-card-v1'
JOIN observation_fetch_runs financial_status ON financial_status.id=financial.id
JOIN fetch_units fu ON fu.id=fa.fetch_unit_id AND fu.fetch_run_id=financial.id
JOIN fetch_runs binding ON binding.acquisition_session_id=financial.acquisition_session_id
 AND binding.source_id=financial.source_id AND binding.producer_id=financial.producer_id
 AND binding.source_run_key=fu.unit_key||'-vpass-card-binding-v1'
JOIN observation_fetch_runs binding_status ON binding_status.id=binding.id
JOIN fetch_units bu ON bu.fetch_run_id=binding.id AND bu.unit_kind='card'
JOIN fetch_artifacts ba ON ba.fetch_run_id=binding.id AND ba.fetch_unit_id=bu.id
 AND ba.source_id=binding.source_id
WHERE fa.source_id='vpass' AND financial.source_id='vpass'
 AND financial.producer_id='collector-r2-importer'
 AND financial_status.status='success' AND financial_status.failure_count=0
 AND binding_status.status='success' AND binding_status.failure_count=0
 AND fu.unit_kind='card' AND fu.unit_key GLOB 'card-[0-9][0-9][0-9]'
 AND length(bu.unit_key)=78 AND substr(bu.unit_key,1,14)='vpass-card-v1-'
 AND substr(bu.unit_key,15) NOT GLOB '*[^0-9a-f]*'
 AND ba.dataset='card-identity-binding' AND ba.artifact_key='card-identity-binding.json'
 AND ba.artifact_role='collector_derived'
 AND ba.format_id='vpass-card-identity-binding-json' AND ba.format_version='1'
 AND EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND ur.report_kind='terminal' AND ur.normalized_outcome='success' AND ur.safe_failure_code IS NULL)
 AND NOT EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND (ur.normalized_outcome<>'success' OR ur.safe_failure_code IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM fetch_units other WHERE other.fetch_run_id=binding.id AND other.id<>bu.id)
 AND NOT EXISTS(SELECT 1 FROM fetch_artifacts other WHERE other.fetch_run_id=binding.id
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)
) SELECT financial_artifact_id,financial_unit_id,financial_unit_key,binding_artifact_id,card_token
 FROM candidates WHERE candidate_count=1;

CREATE TABLE identity_vpass_bindings (
 identity_run_id TEXT PRIMARY KEY REFERENCES identity_runs(id),
 financial_unit_id INTEGER NOT NULL REFERENCES fetch_units(id),
 binding_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
 card_token TEXT NOT NULL CHECK(length(card_token)=78 AND substr(card_token,1,14)='vpass-card-v1-'
   AND substr(card_token,15) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER identity_vpass_binding_provenance BEFORE INSERT ON identity_vpass_bindings
WHEN EXISTS(SELECT 1 FROM identity_run_seals WHERE identity_run_id=NEW.identity_run_id)
 OR NOT EXISTS(SELECT 1 FROM identity_runs r JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN trusted_vpass_card_bindings b ON b.financial_artifact_id=p.fetch_artifact_id
 WHERE r.id=NEW.identity_run_id AND r.policy_version>=2 AND p.status='ok'
 AND b.financial_unit_id=NEW.financial_unit_id AND b.binding_artifact_id=NEW.binding_artifact_id
 AND b.card_token=NEW.card_token)
BEGIN SELECT RAISE(ABORT,'identity_vpass_binding_provenance_invalid'); END;
CREATE TRIGGER identity_vpass_bindings_no_update BEFORE UPDATE ON identity_vpass_bindings
BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_vpass_bindings_no_delete BEFORE DELETE ON identity_vpass_bindings
BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_vpass_bindings_no_replace BEFORE INSERT ON identity_vpass_bindings
WHEN EXISTS(SELECT 1 FROM identity_vpass_bindings WHERE identity_run_id=NEW.identity_run_id)
BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;

CREATE TRIGGER identity_vpass_observation_binding BEFORE INSERT ON identity_observations
WHEN EXISTS(SELECT 1 FROM source_accounts a WHERE a.id=NEW.source_account_id
 AND a.source_id='vpass' AND json_extract(a.reference_json,'$[0]')='vpass:card'
 AND NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin WHERE pin.identity_run_id=NEW.identity_run_id
 AND pin.card_token=json_extract(a.reference_json,'$[1]')))
BEGIN SELECT RAISE(ABORT,'identity_vpass_account_evidence_invalid'); END;

CREATE TRIGGER identity_vpass_seal_provenance BEFORE INSERT ON identity_run_seals
WHEN EXISTS(SELECT 1 FROM identity_runs r JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE r.id=NEW.identity_run_id AND r.policy_version>=2 AND a.source_id='vpass'
 AND NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin JOIN trusted_vpass_card_bindings b
 ON b.financial_artifact_id=a.id AND b.binding_artifact_id=pin.binding_artifact_id
 AND b.financial_unit_id=pin.financial_unit_id AND b.card_token=pin.card_token
 WHERE pin.identity_run_id=r.id))
BEGIN SELECT RAISE(ABORT,'identity_vpass_seal_provenance_invalid'); END;

-- Later evidence exclusions also apply to C reads.
CREATE VIEW eligible_identity_runs AS SELECT r.* FROM identity_runs r
 WHERE NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin WHERE pin.identity_run_id=r.id
 AND NOT EXISTS(SELECT 1 FROM parse_runs p JOIN trusted_vpass_card_bindings b
 ON b.financial_artifact_id=p.fetch_artifact_id
 WHERE p.id=r.parse_run_id AND b.binding_artifact_id=pin.binding_artifact_id
 AND b.financial_unit_id=pin.financial_unit_id AND b.card_token=pin.card_token));
DROP VIEW current_identity_observations;
CREATE VIEW current_identity_observations AS SELECT o.*,r.policy_version,r.parse_run_id
 FROM identity_observations o JOIN eligible_identity_runs r ON r.id=o.identity_run_id
 JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0
 AND NOT EXISTS(SELECT 1 FROM eligible_identity_runs newer JOIN identity_run_seals ns ON ns.identity_run_id=newer.id
   WHERE newer.parse_run_id=r.parse_run_id AND newer.policy_version>r.policy_version);
