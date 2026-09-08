-- Connection correspondence is not account equivalence. No account mapping is changed.
CREATE TABLE account_connection_reviews (
 id INTEGER PRIMARY KEY,
 producer_id TEXT NOT NULL REFERENCES producers(id),
 connection_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 status TEXT NOT NULL CHECK(status IN ('confirmed','unresolved')),
 related_source_id TEXT REFERENCES sources(id),
 direct_producer_id TEXT REFERENCES producers(id),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 verifier_version TEXT NOT NULL,
 detail_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
 direct_artifact_id INTEGER REFERENCES fetch_artifacts(id),
 branch_artifact_id INTEGER REFERENCES fetch_artifacts(id),
 direct_reference_ids_json TEXT NOT NULL CHECK(json_valid(direct_reference_ids_json) AND json_type(direct_reference_ids_json)='array'),
 created_at TEXT NOT NULL,
 UNIQUE(producer_id,connection_key,revision),
 CHECK((status='confirmed' AND related_source_id IS NOT NULL AND related_source_id='sbi-shinsei-bank' AND direct_producer_id IS NOT NULL AND direct_artifact_id IS NOT NULL AND branch_artifact_id IS NOT NULL AND json_array_length(direct_reference_ids_json)>0)
 OR (status='unresolved' AND direct_producer_id IS NULL AND direct_artifact_id IS NULL AND branch_artifact_id IS NULL AND direct_reference_ids_json='[]'))
) STRICT;
CREATE TRIGGER account_connection_revision BEFORE INSERT ON account_connection_reviews
WHEN NEW.revision<>coalesce((SELECT max(revision) FROM account_connection_reviews WHERE producer_id=NEW.producer_id AND connection_key=NEW.connection_key),0)+1
BEGIN SELECT RAISE(ABORT,'connection_revision_conflict'); END;
CREATE TRIGGER account_connection_evidence BEFORE INSERT ON account_connection_reviews
WHEN NOT EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.id=NEW.detail_artifact_id AND a.source_id='moneyforward-me' AND a.dataset='account-detail' AND a.fetch_unit_key=NEW.connection_key AND r.tool=NEW.producer_id AND r.status='success' AND r.failure_count=0)
 OR (NEW.status='confirmed' AND (
 NOT EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.id=NEW.direct_artifact_id AND a.source_id=NEW.related_source_id AND a.dataset='top-accounts-balance-and-activity' AND r.tool=NEW.direct_producer_id AND r.status='success' AND r.failure_count=0)
 OR NOT EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id JOIN fetch_artifacts d ON d.id=NEW.direct_artifact_id WHERE a.id=NEW.branch_artifact_id AND a.source_id=NEW.related_source_id AND a.dataset='balance-summary-and-stage' AND a.fetch_run_id=d.fetch_run_id AND r.tool=NEW.direct_producer_id AND r.status='success' AND r.failure_count=0)
 OR EXISTS(SELECT 1 FROM json_each(NEW.direct_reference_ids_json) j LEFT JOIN source_accounts s ON s.id=j.value WHERE j.type<>'text' OR s.id IS NULL OR s.source_id<>NEW.related_source_id OR s.producer_id<>NEW.direct_producer_id)))
BEGIN SELECT RAISE(ABORT,'connection_evidence_invalid'); END;
CREATE TRIGGER account_connection_no_update BEFORE UPDATE ON account_connection_reviews BEGIN SELECT RAISE(ABORT,'connection reviews are append-only'); END;
CREATE TRIGGER account_connection_no_delete BEFORE DELETE ON account_connection_reviews BEGIN SELECT RAISE(ABORT,'connection reviews are append-only'); END;
CREATE TRIGGER account_connection_no_replace BEFORE INSERT ON account_connection_reviews
WHEN EXISTS(SELECT 1 FROM account_connection_reviews WHERE id=NEW.id OR (producer_id=NEW.producer_id AND connection_key=NEW.connection_key AND revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'connection replacement forbidden'); END;
CREATE VIEW current_account_connection_reviews AS SELECT c.*,
 CASE WHEN EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.id=c.detail_artifact_id AND r.status='success' AND r.failure_count=0)
 AND (c.status='unresolved' OR (
 EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.id=c.direct_artifact_id AND r.status='success' AND r.failure_count=0)
 AND EXISTS(SELECT 1 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id WHERE a.id=c.branch_artifact_id AND r.status='success' AND r.failure_count=0))) THEN 1 ELSE 0 END AS evidence_eligible
 FROM account_connection_reviews c WHERE NOT EXISTS(SELECT 1 FROM account_connection_reviews n WHERE n.producer_id=c.producer_id AND n.connection_key=c.connection_key AND n.revision>c.revision);
