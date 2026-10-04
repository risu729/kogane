-- ADR 0037: indexed admitted stage-A evidence and a latched retirement proof.
-- Additive operational state only; no current-selection or matching rule changes.
-- Any dependency mutation dirties the proof. While already dirty, subsequent
-- mutations do not write the singleton until a reader arms a fresh check.
CREATE TABLE card_purchase_retirement_check (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL CHECK(revision>=0),
 checking_revision INTEGER,
 clean_revision INTEGER,
 clean_policy TEXT CHECK(clean_policy IS NULL OR length(clean_policy) BETWEEN 1 AND 128),
 CHECK(checking_revision IS NULL OR checking_revision<=revision),
 CHECK(clean_revision IS NULL OR clean_revision<=revision)
) STRICT;
INSERT INTO card_purchase_retirement_check VALUES(1,0,NULL,NULL,NULL);

CREATE TRIGGER purchase_retirement_acquisition_sessions_insert AFTER INSERT ON acquisition_sessions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_acquisition_sessions_update AFTER UPDATE ON acquisition_sessions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_acquisition_sessions_delete AFTER DELETE ON acquisition_sessions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognition_keys_insert AFTER INSERT ON card_purchase_recognition_keys
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognition_keys_update AFTER UPDATE ON card_purchase_recognition_keys
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognition_keys_delete AFTER DELETE ON card_purchase_recognition_keys
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognitions_insert AFTER INSERT ON card_purchase_recognitions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognitions_update AFTER UPDATE ON card_purchase_recognitions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_card_purchase_recognitions_delete AFTER DELETE ON card_purchase_recognitions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_economic_event_revisions_insert AFTER INSERT ON economic_event_revisions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_economic_event_revisions_update AFTER UPDATE ON economic_event_revisions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_economic_event_revisions_delete AFTER DELETE ON economic_event_revisions
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_artifacts_insert AFTER INSERT ON fetch_artifacts
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_artifacts_update AFTER UPDATE ON fetch_artifacts
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_artifacts_delete AFTER DELETE ON fetch_artifacts
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_run_reports_insert AFTER INSERT ON fetch_run_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_run_reports_update AFTER UPDATE ON fetch_run_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_run_reports_delete AFTER DELETE ON fetch_run_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_runs_insert AFTER INSERT ON fetch_runs
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_runs_update AFTER UPDATE ON fetch_runs
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_runs_delete AFTER DELETE ON fetch_runs
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_unit_reports_insert AFTER INSERT ON fetch_unit_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_unit_reports_update AFTER UPDATE ON fetch_unit_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_unit_reports_delete AFTER DELETE ON fetch_unit_reports
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_units_insert AFTER INSERT ON fetch_units
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_units_update AFTER UPDATE ON fetch_units
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_fetch_units_delete AFTER DELETE ON fetch_units
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_run_policies_insert AFTER INSERT ON identity_run_policies
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_run_policies_update AFTER UPDATE ON identity_run_policies
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_run_policies_delete AFTER DELETE ON identity_run_policies
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_vpass_bindings_insert AFTER INSERT ON identity_vpass_bindings
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_vpass_bindings_update AFTER UPDATE ON identity_vpass_bindings
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_identity_vpass_bindings_delete AFTER DELETE ON identity_vpass_bindings
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_observation_artifact_metadata_insert AFTER INSERT ON observation_artifact_metadata
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_observation_artifact_metadata_update AFTER UPDATE ON observation_artifact_metadata
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_observation_artifact_metadata_delete AFTER DELETE ON observation_artifact_metadata
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_transaction_observations_insert AFTER INSERT ON transaction_observations
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_transaction_observations_update AFTER UPDATE ON transaction_observations
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;
CREATE TRIGGER purchase_retirement_transaction_observations_delete AFTER DELETE ON transaction_observations
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;

-- Reuse the existing source/visibility ledger for publication, mappings,
-- identities, decimal values, decisions and restrictions, and core restores.
-- The direct triggers above cover read dependencies absent from that ledger
-- (including the recognition writer's own output), without broadening the
-- balance projection's revision contract.
CREATE TRIGGER purchase_retirement_core_revision_update AFTER UPDATE ON core_source_revision
BEGIN
 UPDATE card_purchase_retirement_check SET revision=revision+1
 WHERE singleton=1 AND (clean_revision=revision OR checking_revision=revision);
END;

-- Exact provider-origin predicate of reconciliation-job.ts. A-only pages use
-- this index; their complete group count still includes every shipped row.
CREATE INDEX reconciliation_provider_ids ON transaction_observations(id)
WHERE external_id IS NOT NULL
 AND (CASE WHEN json_valid(extra_json) AND json_type(extra_json,'$._kogane.identityOrigin')='text'
     AND length(json_extract(extra_json,'$._kogane.identityOrigin')) BETWEEN 1 AND 256
   THEN json_extract(extra_json,'$._kogane.identityOrigin') END) IS NOT NULL
 AND instr((CASE WHEN json_valid(extra_json) AND json_type(extra_json,'$._kogane.identityOrigin')='text'
     AND length(json_extract(extra_json,'$._kogane.identityOrigin')) BETWEEN 1 AND 256
   THEN json_extract(extra_json,'$._kogane.identityOrigin') END), 'fingerprint')=0
 AND instr((CASE WHEN json_valid(extra_json) AND json_type(extra_json,'$._kogane.identityOrigin')='text'
     AND length(json_extract(extra_json,'$._kogane.identityOrigin')) BETWEEN 1 AND 256
   THEN json_extract(extra_json,'$._kogane.identityOrigin') END), 'occurrence')=0;
