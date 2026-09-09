-- Durable decision log (architecture addendum A06; review findings D06/D08).
-- Additive only: no existing table, view, trigger or row is altered. Layer A
-- and Layer B evidence and the existing identity mapping tables are untouched;
-- a Worker build that predates this migration keeps working because it never
-- reads or writes the tables below.

-- Idempotency ledger for identity commands. The same operation_id with the
-- same payload digest returns result_json again; a different digest is a
-- conflict. actor_id is the server-verified principal, never a body claim.
CREATE TABLE decision_operations (
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
 actor_verification TEXT NOT NULL CHECK(actor_verification IN ('server','legacy-unknown')),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
 created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER decision_operations_no_update BEFORE UPDATE ON decision_operations BEGIN SELECT RAISE(ABORT,'decision operations are append-only'); END;
CREATE TRIGGER decision_operations_no_delete BEFORE DELETE ON decision_operations BEGIN SELECT RAISE(ABORT,'decision operations are append-only'); END;
CREATE TRIGGER decision_operations_no_replace BEFORE INSERT ON decision_operations
WHEN EXISTS(SELECT 1 FROM decision_operations WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'decision operation replacement is forbidden'); END;

-- One row per judgement. For mapping subjects, subject_ref is the reference id
-- (source_account_id / identifier_id) and revision is the mapping revision the
-- judgement produced (assign) or releases (release-override). For relations,
-- subject_ref is the entity_relations row id. The only permitted update is
-- setting superseded_by once, to a later decision on the same subject.
CREATE TABLE decision_revisions (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 subject_kind TEXT NOT NULL CHECK(subject_kind IN ('account_mapping','instrument_mapping','relation')),
 subject_ref TEXT NOT NULL CHECK(length(subject_ref) BETWEEN 1 AND 512),
 revision INTEGER NOT NULL CHECK(revision>0),
 decision_kind TEXT NOT NULL CHECK(decision_kind IN ('assign','release-override','propose','accept','reject','supersede')),
 method TEXT NOT NULL CHECK(method IN ('manual','rule','ai','legacy-migration')),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
 operation_id TEXT REFERENCES decision_operations(operation_id),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND json_type(evidence_refs_json)='array'),
 previous_revision INTEGER CHECK(previous_revision IS NULL OR previous_revision>0),
 superseded_by TEXT REFERENCES decision_revisions(id),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX decision_revisions_subject ON decision_revisions(subject_kind,subject_ref,revision);
CREATE INDEX decision_revisions_operation ON decision_revisions(operation_id);

-- A manual assignment protects its subject from automatic policy until a
-- later release-override supersedes it. Protection is decided here, not by
-- "a manual row ever existed".
CREATE VIEW active_manual_overrides AS SELECT d.* FROM decision_revisions d
 WHERE d.subject_kind IN ('account_mapping','instrument_mapping')
 AND d.decision_kind='assign' AND d.method IN ('manual','legacy-migration') AND d.superseded_by IS NULL;

-- What automatic policy must not overwrite: an active override, or a manual
-- mapping row no decision describes (written by an older build or by hand),
-- which keeps its legacy protection until a release-override at or after its
-- revision rather than being silently released.
CREATE VIEW protected_mapping_subjects AS
 SELECT subject_kind,subject_ref FROM active_manual_overrides
 UNION
 SELECT 'account_mapping',m.source_account_id FROM account_mappings m WHERE m.method='manual'
  AND NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.subject_kind='account_mapping' AND d.subject_ref=m.source_account_id
   AND (d.revision=m.revision OR (d.decision_kind='release-override' AND d.revision>=m.revision)))
 UNION
 SELECT 'instrument_mapping',m.identifier_id FROM instrument_mappings m WHERE m.method='manual'
  AND NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.subject_kind='instrument_mapping' AND d.subject_ref=m.identifier_id
   AND (d.revision=m.revision OR (d.decision_kind='release-override' AND d.revision>=m.revision)));

CREATE TRIGGER decision_revisions_no_update BEFORE UPDATE ON decision_revisions
WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
 OR NEW.id<>OLD.id OR NEW.subject_kind<>OLD.subject_kind OR NEW.subject_ref<>OLD.subject_ref
 OR NEW.revision<>OLD.revision OR NEW.decision_kind<>OLD.decision_kind OR NEW.method<>OLD.method
 OR NEW.actor_id<>OLD.actor_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.reason<>OLD.reason
 OR NEW.evidence_refs_json<>OLD.evidence_refs_json OR NEW.previous_revision IS NOT OLD.previous_revision
 OR NEW.created_at<>OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM decision_revisions s WHERE s.id=NEW.superseded_by AND s.id<>OLD.id
  AND s.subject_kind=OLD.subject_kind AND s.subject_ref=OLD.subject_ref)
BEGIN SELECT RAISE(ABORT,'decision revisions are append-only'); END;
CREATE TRIGGER decision_revisions_no_delete BEFORE DELETE ON decision_revisions BEGIN SELECT RAISE(ABORT,'decision revisions are append-only'); END;
CREATE TRIGGER decision_revisions_no_replace BEFORE INSERT ON decision_revisions
WHEN EXISTS(SELECT 1 FROM decision_revisions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'decision revision replacement is forbidden'); END;
-- A mapping judgement must name a mapping row that exists with the matching
-- method, and a release must have an active override to release. Inside one
-- D1 batch this aborts the whole command when its guard failed upstream.
CREATE TRIGGER decision_revisions_subject BEFORE INSERT ON decision_revisions
WHEN NEW.superseded_by IS NOT NULL
 OR (NEW.subject_kind='account_mapping' AND NOT EXISTS(SELECT 1 FROM account_mappings m
  WHERE m.source_account_id=NEW.subject_ref AND m.revision=NEW.revision
  AND (NEW.decision_kind<>'assign' OR m.method=CASE WHEN NEW.method='rule' THEN 'rule' ELSE 'manual' END)))
 OR (NEW.subject_kind='instrument_mapping' AND NOT EXISTS(SELECT 1 FROM instrument_mappings m
  WHERE m.identifier_id=NEW.subject_ref AND m.revision=NEW.revision
  AND (NEW.decision_kind<>'assign' OR m.method=CASE WHEN NEW.method='rule' THEN 'rule' ELSE 'manual' END)))
 OR (NEW.decision_kind='release-override' AND NEW.subject_kind<>'relation' AND NOT EXISTS(
  SELECT 1 FROM protected_mapping_subjects o WHERE o.subject_kind=NEW.subject_kind AND o.subject_ref=NEW.subject_ref))
BEGIN SELECT RAISE(ABORT,'decision_subject_invalid'); END;

-- Typed relations (addendum 05 section 2). Every row is one claim with its
-- kind, direction, validity, status, evidence and the decision that made it.
-- No transitive closure is stored or implied; same_account is never derived
-- from connection_contains (SC06).
CREATE TABLE entity_relations (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 kind TEXT NOT NULL CHECK(kind IN ('same_account','connection_contains','account_has_pocket','statement_covers','funded_by','liable_party','beneficial_owner','same_underlying','listed_as','replaces_identifier','provider_same','supersedes','supports','contradicts','pending_to_posted')),
 from_ref TEXT NOT NULL CHECK(length(from_ref) BETWEEN 1 AND 512),
 to_ref TEXT NOT NULL CHECK(length(to_ref) BETWEEN 1 AND 512 AND to_ref<>from_ref),
 valid_from TEXT,
 valid_to TEXT,
 status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','released')),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND json_type(evidence_refs_json)='array'),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX entity_relations_from ON entity_relations(kind,from_ref);
CREATE INDEX entity_relations_to ON entity_relations(kind,to_ref);
CREATE TRIGGER entity_relations_no_update BEFORE UPDATE ON entity_relations BEGIN SELECT RAISE(ABORT,'entity relations are append-only'); END;
CREATE TRIGGER entity_relations_no_delete BEFORE DELETE ON entity_relations BEGIN SELECT RAISE(ABORT,'entity relations are append-only'); END;
CREATE TRIGGER entity_relations_no_replace BEFORE INSERT ON entity_relations
WHEN EXISTS(SELECT 1 FROM entity_relations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'entity relation replacement is forbidden'); END;
CREATE TRIGGER entity_relations_provenance BEFORE INSERT ON entity_relations
WHEN NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
 AND d.subject_kind='relation' AND d.subject_ref=NEW.id)
BEGIN SELECT RAISE(ABORT,'relation_decision_missing'); END;

-- Which policy family/release produced an identity run and the exact evidence
-- set it depended on (review D08). A side table rather than new identity_runs
-- columns: the previous Worker build inserts identity_runs positionally, so
-- added columns would break its rollback; a side table it never reads cannot.
-- Runs written before this migration have no row; identity_run_contexts
-- derives their labels from the integer policy version they were written with.
CREATE TABLE identity_run_policies (
 identity_run_id TEXT PRIMARY KEY REFERENCES identity_runs(id),
 parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 policy_family TEXT NOT NULL CHECK(length(policy_family) BETWEEN 1 AND 64),
 policy_release TEXT NOT NULL CHECK(length(policy_release) BETWEEN 1 AND 128),
 dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64 AND dependency_digest NOT GLOB '*[^0-9a-f]*'),
 dependency_set_json TEXT NOT NULL CHECK(json_valid(dependency_set_json) AND json_type(dependency_set_json)='array'),
 UNIQUE(parse_run_id,policy_family,policy_release,dependency_digest)
) STRICT;
CREATE TRIGGER identity_run_policies_provenance BEFORE INSERT ON identity_run_policies
WHEN NOT EXISTS(SELECT 1 FROM identity_runs r WHERE r.id=NEW.identity_run_id AND r.parse_run_id=NEW.parse_run_id)
 OR EXISTS(SELECT 1 FROM identity_run_seals WHERE identity_run_id=NEW.identity_run_id)
BEGIN SELECT RAISE(ABORT,'identity_run_policy_provenance_invalid'); END;
CREATE TRIGGER identity_run_policies_no_update BEFORE UPDATE ON identity_run_policies BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_run_policies_no_delete BEFORE DELETE ON identity_run_policies BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER identity_run_policies_no_replace BEFORE INSERT ON identity_run_policies
WHEN EXISTS(SELECT 1 FROM identity_run_policies WHERE identity_run_id=NEW.identity_run_id)
BEGIN SELECT RAISE(ABORT,'identity replacement is forbidden'); END;
CREATE VIEW identity_run_contexts AS SELECT r.id AS identity_run_id,r.parse_run_id,r.policy_version,r.created_at,
 coalesce(p.policy_family,CASE WHEN r.policy_version=2 THEN 'vpass-card-binding' ELSE 'identity-default' END) AS policy_family,
 coalesce(p.policy_release,CASE WHEN r.policy_version=2 THEN 'vpass-card-binding-v2' ELSE 'identity-default-v'||r.policy_version END) AS policy_release,
 coalesce(p.dependency_digest,'legacy') AS dependency_digest,
 p.identity_run_id IS NOT NULL AS policy_recorded
 FROM identity_runs r LEFT JOIN identity_run_policies p ON p.identity_run_id=r.id;

-- Migration of existing manual decisions (addendum 13, A06/A09): every manual
-- mapping revision becomes an active override recorded exactly once, with its
-- original reason and timestamp. The actor is unknown from the old rows and is
-- kept as legacy-unknown; no approver is invented. Mapping rows are not changed.
INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
SELECT 'dr_legacy_account_'||m.id,'account_mapping',m.source_account_id,m.revision,'assign','legacy-migration','legacy-unknown',NULL,
 substr(m.reason,1,2000),json_array('account_mapping:'||m.id),
 (SELECT max(p.revision) FROM account_mappings p WHERE p.source_account_id=m.source_account_id AND p.revision<m.revision),
 NULL,m.created_at
FROM account_mappings m WHERE m.method='manual' ORDER BY m.source_account_id,m.revision;
INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
SELECT 'dr_legacy_instrument_'||m.id,'instrument_mapping',m.identifier_id,m.revision,'assign','legacy-migration','legacy-unknown',NULL,
 substr(m.reason,1,2000),json_array('instrument_mapping:'||m.id),
 (SELECT max(p.revision) FROM instrument_mappings p WHERE p.identifier_id=m.identifier_id AND p.revision<m.revision),
 NULL,m.created_at
FROM instrument_mappings m WHERE m.method='manual' ORDER BY m.identifier_id,m.revision;

-- Evidenced MoneyForward connection correspondences (migration 0023) become
-- connection_contains relations: the connection covers each exact direct leaf
-- reference the review pinned. Only connection-level evidence exists, so no
-- same_account relation is written (SC06). Bounded by the review table
-- (at most 64 current connections, at most 100 references each).
INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
SELECT 'dr_legacy_connection_'||c.id||'_'||j.key,'relation','rel_legacy_connection_'||c.id||'_'||j.key,c.revision,'accept','legacy-migration','legacy-unknown',NULL,
 substr(c.reason,1,2000),json_array('fetch_artifact:'||c.detail_artifact_id,'fetch_artifact:'||c.direct_artifact_id,'fetch_artifact:'||c.branch_artifact_id),
 NULL,NULL,c.created_at
FROM account_connection_reviews c JOIN json_each(c.direct_reference_ids_json) j
WHERE c.status='confirmed' AND j.type='text'
 AND NOT EXISTS(SELECT 1 FROM account_connection_reviews n WHERE n.producer_id=c.producer_id AND n.connection_key=c.connection_key AND n.revision>c.revision)
ORDER BY c.id,j.key;
INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
SELECT 'rel_legacy_connection_'||c.id||'_'||j.key,'connection_contains','connection:'||c.producer_id||'/'||c.connection_key,'source_account:'||j.value,NULL,NULL,'accepted',
 'dr_legacy_connection_'||c.id||'_'||j.key,
 json_array('fetch_artifact:'||c.detail_artifact_id,'fetch_artifact:'||c.direct_artifact_id,'fetch_artifact:'||c.branch_artifact_id),c.created_at
FROM account_connection_reviews c JOIN json_each(c.direct_reference_ids_json) j
WHERE c.status='confirmed' AND j.type='text'
 AND NOT EXISTS(SELECT 1 FROM account_connection_reviews n WHERE n.producer_id=c.producer_id AND n.connection_key=c.connection_key AND n.revision>c.revision)
ORDER BY c.id,j.key;
