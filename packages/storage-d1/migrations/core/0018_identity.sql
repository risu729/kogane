-- Layer C: versioned and corrigible identities. Never modifies Layer A or B.
-- Duplicate INSERT guards below also reject SQLite REPLACE, independent of recursive_triggers.
CREATE TABLE source_accounts (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 producer_id TEXT NOT NULL REFERENCES producers(id), reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
 UNIQUE(source_id,producer_id,reference_json)
) STRICT;
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('identified','provider-local','aggregate','unresolved'))
) STRICT;
CREATE TABLE account_mappings (
 id TEXT PRIMARY KEY, source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
 revision INTEGER NOT NULL CHECK(revision>0), account_id TEXT NOT NULL REFERENCES accounts(id),
 method TEXT NOT NULL CHECK(method IN ('rule','manual')), reason TEXT NOT NULL CHECK(length(reason)>0),
 policy_version INTEGER NOT NULL CHECK(policy_version>0), created_at TEXT NOT NULL,
 label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('identified','provider-local','aggregate','unresolved')),
 UNIQUE(source_account_id,revision)
) STRICT;
CREATE TRIGGER account_mapping_revision BEFORE INSERT ON account_mappings
WHEN NEW.revision<>coalesce((SELECT max(revision) FROM account_mappings WHERE source_account_id=NEW.source_account_id),0)+1
BEGIN SELECT RAISE(ABORT,'account_mapping_revision_conflict'); END;
CREATE VIEW current_account_mappings AS SELECT m.* FROM account_mappings m
 WHERE NOT EXISTS(SELECT 1 FROM account_mappings n WHERE n.source_account_id=m.source_account_id AND n.revision>m.revision);

CREATE TABLE instruments (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('money','security','crypto','reward','product','unknown')),
 label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('identified','provider-local','aggregate','unresolved'))
) STRICT;
CREATE TABLE instrument_identifiers (
 id TEXT PRIMARY KEY, namespace TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL,
 details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 UNIQUE(namespace,scope,value)
) STRICT;
CREATE TABLE instrument_mappings (
 id TEXT PRIMARY KEY, identifier_id TEXT NOT NULL REFERENCES instrument_identifiers(id),
 revision INTEGER NOT NULL CHECK(revision>0), instrument_id TEXT NOT NULL REFERENCES instruments(id),
 method TEXT NOT NULL CHECK(method IN ('rule','manual')), reason TEXT NOT NULL CHECK(length(reason)>0),
 policy_version INTEGER NOT NULL CHECK(policy_version>0), created_at TEXT NOT NULL,
 label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('identified','provider-local','aggregate','unresolved')),
 UNIQUE(identifier_id,revision)
) STRICT;
CREATE TRIGGER instrument_mapping_revision BEFORE INSERT ON instrument_mappings
WHEN NEW.revision<>coalesce((SELECT max(revision) FROM instrument_mappings WHERE identifier_id=NEW.identifier_id),0)+1
BEGIN SELECT RAISE(ABORT,'instrument_mapping_revision_conflict'); END;
CREATE VIEW current_instrument_mappings AS SELECT m.* FROM instrument_mappings m
 WHERE NOT EXISTS(SELECT 1 FROM instrument_mappings n WHERE n.identifier_id=m.identifier_id AND n.revision>m.revision);

CREATE TABLE identity_runs (
 id TEXT PRIMARY KEY, parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 policy_version INTEGER NOT NULL CHECK(policy_version>0), created_at TEXT NOT NULL,
 UNIQUE(parse_run_id,policy_version)
) STRICT;
CREATE TABLE identity_observations (
 id TEXT PRIMARY KEY, identity_run_id TEXT NOT NULL REFERENCES identity_runs(id),
 kind TEXT NOT NULL CHECK(kind IN ('transaction','balance','position','valuation')),
 observation_id INTEGER NOT NULL, source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
 account_mapping_id TEXT NOT NULL REFERENCES account_mappings(id),
 issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
 UNIQUE(identity_run_id,kind,observation_id)
) STRICT;
CREATE TABLE identity_instrument_uses (
 identity_observation_id TEXT NOT NULL REFERENCES identity_observations(id),
 role TEXT NOT NULL CHECK(role IN ('unit','security','trade-unit','usage-unit')),
 identifier_id TEXT NOT NULL REFERENCES instrument_identifiers(id),
 instrument_mapping_id TEXT NOT NULL REFERENCES instrument_mappings(id),
 PRIMARY KEY(identity_observation_id,role)
) STRICT;
-- A seal publishes the entire run at once. A crashed run is idempotently resumed.
CREATE TABLE identity_run_seals (
 identity_run_id TEXT PRIMARY KEY REFERENCES identity_runs(id),
 observation_count INTEGER NOT NULL CHECK(observation_count>=0), completed_at TEXT NOT NULL
) STRICT;
CREATE INDEX identity_observation_lookup ON identity_observations(kind,observation_id);
CREATE INDEX identity_observation_account ON identity_observations(source_account_id);
CREATE TRIGGER identity_observation_provenance BEFORE INSERT ON identity_observations
WHEN EXISTS(SELECT 1 FROM identity_run_seals WHERE identity_run_id=NEW.identity_run_id)
 OR NOT EXISTS(SELECT 1 FROM account_mappings WHERE id=NEW.account_mapping_id AND source_account_id=NEW.source_account_id)
 OR NOT EXISTS(
 SELECT 1 FROM identity_runs r JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN fetch_artifacts artifact ON artifact.id=p.fetch_artifact_id JOIN fetch_runs f ON f.id=artifact.fetch_run_id
 JOIN source_accounts sa ON sa.id=NEW.source_account_id AND sa.source_id=artifact.source_id AND sa.producer_id=f.producer_id
 WHERE r.id=NEW.identity_run_id AND p.status='ok' AND (
  (NEW.kind='transaction' AND EXISTS(SELECT 1 FROM transaction_observations o WHERE o.id=NEW.observation_id AND o.parse_run_id=p.id)) OR
  (NEW.kind='balance' AND EXISTS(SELECT 1 FROM balance_observations o WHERE o.id=NEW.observation_id AND o.parse_run_id=p.id)) OR
  (NEW.kind='position' AND EXISTS(SELECT 1 FROM position_observations o WHERE o.id=NEW.observation_id AND o.parse_run_id=p.id)) OR
  (NEW.kind='valuation' AND EXISTS(SELECT 1 FROM valuation_observations o WHERE o.id=NEW.observation_id AND o.parse_run_id=p.id))))
BEGIN SELECT RAISE(ABORT,'identity_observation_provenance_invalid'); END;
CREATE TRIGGER identity_use_provenance BEFORE INSERT ON identity_instrument_uses
WHEN NOT EXISTS(SELECT 1 FROM instrument_mappings WHERE id=NEW.instrument_mapping_id AND identifier_id=NEW.identifier_id)
 OR EXISTS(SELECT 1 FROM identity_observations o JOIN identity_run_seals s ON s.identity_run_id=o.identity_run_id WHERE o.id=NEW.identity_observation_id)
BEGIN SELECT RAISE(ABORT,'identity_instrument_provenance_invalid'); END;
CREATE TRIGGER identity_seal_complete BEFORE INSERT ON identity_run_seals
WHEN NEW.observation_count<>(SELECT count(*) FROM identity_observations WHERE identity_run_id=NEW.identity_run_id)
 OR NEW.observation_count<>(SELECT
 (SELECT count(*) FROM transaction_observations WHERE parse_run_id=r.parse_run_id)+
 (SELECT count(*) FROM balance_observations WHERE parse_run_id=r.parse_run_id)+
 (SELECT count(*) FROM position_observations WHERE parse_run_id=r.parse_run_id)+
 (SELECT count(*) FROM valuation_observations WHERE parse_run_id=r.parse_run_id)
 FROM identity_runs r WHERE r.id=NEW.identity_run_id)
BEGIN SELECT RAISE(ABORT,'identity_run_incomplete'); END;
CREATE VIEW current_identity_observations AS SELECT o.*,r.policy_version,r.parse_run_id
 FROM identity_observations o JOIN identity_runs r ON r.id=o.identity_run_id
 JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 JOIN parse_runs p ON p.id=r.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0
 AND NOT EXISTS(SELECT 1 FROM identity_runs newer JOIN identity_run_seals ns ON ns.identity_run_id=newer.id
   WHERE newer.parse_run_id=r.parse_run_id AND newer.policy_version>r.policy_version);
CREATE VIEW effective_identity_observations AS SELECT o.*,m.account_id,m.id AS effective_account_mapping_id
 FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id;
CREATE VIEW effective_identity_instruments AS SELECT u.*,m.instrument_id,m.id AS effective_instrument_mapping_id
 FROM identity_instrument_uses u JOIN current_identity_observations o ON o.id=u.identity_observation_id
 JOIN current_instrument_mappings m ON m.identifier_id=u.identifier_id;

CREATE TRIGGER source_accounts_no_update BEFORE UPDATE ON source_accounts BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER source_accounts_no_delete BEFORE DELETE ON source_accounts BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER accounts_no_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER account_mappings_no_update BEFORE UPDATE ON account_mappings BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER account_mappings_no_delete BEFORE DELETE ON account_mappings BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instruments_no_update BEFORE UPDATE ON instruments BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instruments_no_delete BEFORE DELETE ON instruments BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instrument_identifiers_no_update BEFORE UPDATE ON instrument_identifiers BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instrument_identifiers_no_delete BEFORE DELETE ON instrument_identifiers BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instrument_mappings_no_update BEFORE UPDATE ON instrument_mappings BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER instrument_mappings_no_delete BEFORE DELETE ON instrument_mappings BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_runs_no_update BEFORE UPDATE ON identity_runs BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_runs_no_delete BEFORE DELETE ON identity_runs BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_observations_no_update BEFORE UPDATE ON identity_observations BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_observations_no_delete BEFORE DELETE ON identity_observations BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_instrument_uses_no_update BEFORE UPDATE ON identity_instrument_uses BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_instrument_uses_no_delete BEFORE DELETE ON identity_instrument_uses BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_run_seals_no_update BEFORE UPDATE ON identity_run_seals BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_run_seals_no_delete BEFORE DELETE ON identity_run_seals BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER source_accounts_no_replace BEFORE INSERT ON source_accounts WHEN EXISTS(SELECT 1 FROM source_accounts WHERE id=NEW.id OR (source_id=NEW.source_id AND producer_id=NEW.producer_id AND reference_json=NEW.reference_json)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER accounts_no_replace BEFORE INSERT ON accounts WHEN EXISTS(SELECT 1 FROM accounts WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER account_mappings_no_replace BEFORE INSERT ON account_mappings WHEN EXISTS(SELECT 1 FROM account_mappings WHERE id=NEW.id OR (source_account_id=NEW.source_account_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER instruments_no_replace BEFORE INSERT ON instruments WHEN EXISTS(SELECT 1 FROM instruments WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER instrument_identifiers_no_replace BEFORE INSERT ON instrument_identifiers WHEN EXISTS(SELECT 1 FROM instrument_identifiers WHERE id=NEW.id OR (namespace=NEW.namespace AND scope=NEW.scope AND value=NEW.value)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER instrument_mappings_no_replace BEFORE INSERT ON instrument_mappings WHEN EXISTS(SELECT 1 FROM instrument_mappings WHERE id=NEW.id OR (identifier_id=NEW.identifier_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER identity_runs_no_replace BEFORE INSERT ON identity_runs WHEN EXISTS(SELECT 1 FROM identity_runs WHERE id=NEW.id OR (parse_run_id=NEW.parse_run_id AND policy_version=NEW.policy_version)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER identity_observations_no_replace BEFORE INSERT ON identity_observations WHEN EXISTS(SELECT 1 FROM identity_observations WHERE id=NEW.id OR (identity_run_id=NEW.identity_run_id AND kind=NEW.kind AND observation_id=NEW.observation_id)) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER identity_instrument_uses_no_replace BEFORE INSERT ON identity_instrument_uses WHEN EXISTS(SELECT 1 FROM identity_instrument_uses WHERE identity_observation_id=NEW.identity_observation_id AND role=NEW.role) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE TRIGGER identity_run_seals_no_replace BEFORE INSERT ON identity_run_seals WHEN EXISTS(SELECT 1 FROM identity_run_seals WHERE identity_run_id=NEW.identity_run_id) BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
