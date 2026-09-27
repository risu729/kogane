-- ADR 0029: the Vpass card token is an unkeyed, domain-separated SHA-256 of
-- the provider's card tuple, `vpass-card-v2-<64 lowercase hex>`, beside the
-- retired importer's HMAC tokens `vpass-card-v1-<64 lowercase hex>`, which
-- stay valid historical evidence. The trusted binding view and the identity
-- pin accepted v1 only; both now accept exactly v1 and v2, and nothing else
-- about either changes.
--
-- 1. `identity_vpass_bindings` (migration 0020) states the token shape in a
--    CHECK, which SQLite cannot alter. The table is rebuilt under the same
--    name with the CHECK widened, copying every row with explicit columns
--    before the insertion guards exist again, as migrations 0045 and 0051
--    rebuilt the command tables: no row is changed, dropped or added, and
--    its triggers are recreated verbatim from 0020 after the copy. Nothing
--    references the table by foreign key; the views and triggers that read it
--    (`eligible_identity_runs`, `identity_vpass_observation_binding`,
--    `identity_vpass_seal_provenance`) name it and read the rebuilt table.
--    D1 applies a migration atomically.
-- 2. `trusted_vpass_card_bindings` is migration 0055's view verbatim with the
--    one prefix condition widened.
--    services/processor/test/vpass-binding-view.test.ts proves on random and
--    scaled stores that its v1 rows are exactly 0055's, and that its v2 rows
--    are exactly the rows 0055 returns once each v2 token is read as a v1
--    token; services/processor/test/binding-query-plan.test.ts that every
--    read of it keeps 0055's plan step for step.
-- A v1 and a v2 token of the same card are different values here and
-- everywhere else; joining them is a separate, reviewed decision.

CREATE TABLE identity_vpass_bindings_0057_copy (
 identity_run_id TEXT NOT NULL,
 financial_unit_id INTEGER NOT NULL,
 binding_artifact_id INTEGER NOT NULL,
 card_token TEXT NOT NULL
) STRICT;
INSERT INTO identity_vpass_bindings_0057_copy(identity_run_id,financial_unit_id,binding_artifact_id,card_token)
 SELECT identity_run_id,financial_unit_id,binding_artifact_id,card_token
 FROM identity_vpass_bindings ORDER BY rowid;
DROP TABLE identity_vpass_bindings;
CREATE TABLE identity_vpass_bindings (
 identity_run_id TEXT PRIMARY KEY REFERENCES identity_runs(id),
 financial_unit_id INTEGER NOT NULL REFERENCES fetch_units(id),
 binding_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
 card_token TEXT NOT NULL CHECK(length(card_token)=78
   AND substr(card_token,1,14) IN ('vpass-card-v1-','vpass-card-v2-')
   AND substr(card_token,15) NOT GLOB '*[^0-9a-f]*')
) STRICT;
INSERT INTO identity_vpass_bindings(identity_run_id,financial_unit_id,binding_artifact_id,card_token)
 SELECT identity_run_id,financial_unit_id,binding_artifact_id,card_token
 FROM identity_vpass_bindings_0057_copy ORDER BY rowid;
DROP TABLE identity_vpass_bindings_0057_copy;

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

DROP VIEW trusted_vpass_card_bindings;
CREATE VIEW trusted_vpass_card_bindings AS
SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
       ba.id AS binding_artifact_id, bu.unit_key AS card_token
FROM fetch_artifacts fa
JOIN observation_fetch_artifacts visible ON visible.id=fa.id
JOIN fetch_runs financial ON financial.id=fa.fetch_run_id
JOIN acquisition_sessions session ON session.id=financial.acquisition_session_id
 AND session.producer_id=financial.producer_id
 AND session.external_id_namespace=CASE financial.producer_id
   WHEN 'collector-r2-importer' THEN 'vpass-worker-card-v1' WHEN 'collector-vpass' THEN 'shared-r2' END
JOIN observation_fetch_runs financial_status ON financial_status.id=financial.id
JOIN fetch_units fu ON fu.id=fa.fetch_unit_id AND fu.fetch_run_id=financial.id
JOIN fetch_runs binding ON binding.acquisition_session_id=financial.acquisition_session_id
 AND binding.source_id=financial.source_id AND binding.producer_id=financial.producer_id
 AND binding.source_run_key=CASE financial.producer_id
   WHEN 'collector-r2-importer' THEN fu.unit_key||'-vpass-card-binding-v1'
   WHEN 'collector-vpass' THEN financial.source_run_key END
JOIN observation_fetch_runs binding_status ON binding_status.id=binding.id
JOIN fetch_units bu ON bu.fetch_run_id=binding.id AND bu.unit_kind='card'
JOIN fetch_artifacts ba ON ba.fetch_run_id=binding.id AND ba.fetch_unit_id=bu.id
 AND ba.source_id=binding.source_id
WHERE fa.source_id='vpass' AND financial.source_id='vpass'
 AND financial.producer_id IN ('collector-r2-importer','collector-vpass')
 AND financial_status.status='success' AND financial_status.failure_count=0
 AND binding_status.status='success' AND binding_status.failure_count=0
 AND (financial.producer_id='collector-r2-importer' OR (binding.id=financial.id
   AND financial.source_run_key GLOB '*-'||fu.unit_key||':terminal-registration-v[0-9]*'))
 AND NOT EXISTS(SELECT 1 FROM fetch_runs other_binding
   WHERE other_binding.acquisition_session_id=binding.acquisition_session_id
    AND other_binding.source_id=binding.source_id AND other_binding.source_run_key=binding.source_run_key
    AND other_binding.id<>binding.id)
 AND fu.unit_kind='card' AND fu.unit_key GLOB 'card-[0-9][0-9][0-9]'
 AND length(bu.unit_key)=78 AND substr(bu.unit_key,1,14) IN ('vpass-card-v1-','vpass-card-v2-')
 AND substr(bu.unit_key,15) NOT GLOB '*[^0-9a-f]*'
 AND ba.dataset='card-identity-binding' AND ba.artifact_key='card-identity-binding.json'
 AND ba.artifact_role='collector_derived'
 AND ba.format_id='vpass-card-identity-binding-json' AND ba.format_version='1'
 AND EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND ur.report_kind='terminal' AND ur.normalized_outcome='success' AND ur.safe_failure_code IS NULL)
 AND NOT EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND (ur.normalized_outcome<>'success' OR ur.safe_failure_code IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM fetch_units other WHERE other.fetch_run_id=binding.id AND other.id<>bu.id
   AND (financial.producer_id='collector-r2-importer' OR other.id<>fu.id))
 AND NOT EXISTS(SELECT 1 FROM fetch_artifacts other WHERE other.fetch_run_id=binding.id
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)
;
