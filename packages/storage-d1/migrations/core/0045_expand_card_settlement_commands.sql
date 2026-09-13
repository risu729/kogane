-- Expand the operation vocabulary without rewriting any recorded judgement.
-- D1 applies each migration atomically. Build a second, complete FK graph,
-- copy history before installing insertion guards, then replace the old graph
-- leaf-first. Foreign-key enforcement stays ON throughout: there are no
-- dangling references, cascaded deletes, or writable_schema changes.
-- approvals and decision_outbox are copied solely because they reference the
-- rebuilt parents; their schema and all four tables' indexes/triggers remain
-- identical to 0031 and 0038. Explicit column lists preserve every historical value.
-- https://developers.cloudflare.com/d1/reference/migrations/

CREATE TABLE change_plans_expanded (
 plan_id TEXT PRIMARY KEY CHECK(length(plan_id)=64 AND plan_id NOT GLOB '*[^0-9a-f]*'),
 kind TEXT NOT NULL CHECK(kind IN ('identity.assign','identity.release-override','relation.accept','relation.reject','card-settlement.accept','card-settlement.reject','card-settlement.withdraw')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
 base_context_id TEXT NOT NULL CHECK(length(base_context_id) BETWEEN 1 AND 256),
 -- {subjectRef: revision}. Verified again inside the commit transaction.
 expected_revisions_json TEXT NOT NULL CHECK(json_valid(expected_revisions_json) AND json_type(expected_revisions_json)='object'),
 -- Server-computed before/after counts, invalidations and affected scopes.
 -- Counts and identifiers only; never amounts.
 simulation_json TEXT NOT NULL CHECK(json_valid(simulation_json) AND json_type(simulation_json)='object'),
 created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('planned','approved','committed','stale','rejected'))
) STRICT;

CREATE TABLE approvals_expanded (
 approval_id TEXT PRIMARY KEY CHECK(length(approval_id) BETWEEN 1 AND 256),
 plan_id TEXT NOT NULL REFERENCES change_plans_expanded(plan_id),
 plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
 approver_actor TEXT NOT NULL CHECK(length(approver_actor) BETWEEN 1 AND 256),
 approver_verification TEXT NOT NULL CHECK(approver_verification='server'),
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json)='array'),
 expires_at TEXT NOT NULL,
 uses_remaining INTEGER NOT NULL CHECK(uses_remaining>=0),
 created_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_receipts_expanded (
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('identity.assign','identity.release-override','relation.accept','relation.reject','card-settlement.accept','card-settlement.reject','card-settlement.withdraw')),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 plan_id TEXT NOT NULL REFERENCES change_plans_expanded(plan_id),
 status TEXT NOT NULL CHECK(status IN ('accepted','published','failed')),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
 created_at TEXT NOT NULL,
 published_at TEXT,
 UNIQUE(principal,operation_id)
) STRICT;

CREATE TABLE decision_outbox_expanded (
 id INTEGER PRIMARY KEY,
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256),
 operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
 target TEXT NOT NULL CHECK(target IN ('identity-projection','balance-projection','agent-notify')),
 enqueued_at TEXT NOT NULL,
 processed_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64),
 outcome TEXT CHECK(outcome IS NULL OR length(outcome) BETWEEN 1 AND 64),
 -- Operational lease so two dispatchers cannot run one row at once, and
 -- backoff so a failing target does not spin.
 available_at_ms INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until_ms INTEGER NOT NULL DEFAULT 0,
 progress_code TEXT CHECK(progress_code IS NULL OR length(progress_code) BETWEEN 1 AND 64),
 pending_polls INTEGER NOT NULL DEFAULT 0,
 blocked_code TEXT CHECK(blocked_code IS NULL OR length(blocked_code) BETWEEN 1 AND 64),
 required_source_revision INTEGER,
 evidence_ref TEXT,
 applied_source_revision INTEGER,
 UNIQUE(decision_revision_id,target),
 FOREIGN KEY(principal,operation_id) REFERENCES operation_receipts_expanded(principal,operation_id)
) STRICT;

INSERT INTO change_plans_expanded (plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
 SELECT plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status FROM change_plans;
INSERT INTO approvals_expanded (approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at)
 SELECT approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at FROM approvals;
INSERT INTO operation_receipts_expanded (operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at)
 SELECT operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at FROM operation_receipts;
INSERT INTO decision_outbox_expanded (id,decision_revision_id,principal,operation_id,target,enqueued_at,processed_at,attempts,last_error_code,outcome,available_at_ms,lease_token,lease_until_ms,progress_code,pending_polls,blocked_code,required_source_revision,evidence_ref,applied_source_revision)
 SELECT id,decision_revision_id,principal,operation_id,target,enqueued_at,processed_at,attempts,last_error_code,outcome,available_at_ms,lease_token,lease_until_ms,progress_code,pending_polls,blocked_code,required_source_revision,evidence_ref,applied_source_revision FROM decision_outbox;

-- Retire the old graph from children to parents, without changing references.
DROP TABLE decision_outbox;
DROP TABLE approvals;
DROP TABLE operation_receipts;
DROP TABLE change_plans;

-- SQLite carries replacement-graph FK references forward during each rename.
ALTER TABLE change_plans_expanded RENAME TO change_plans;
ALTER TABLE operation_receipts_expanded RENAME TO operation_receipts;
ALTER TABLE approvals_expanded RENAME TO approvals;
ALTER TABLE decision_outbox_expanded RENAME TO decision_outbox;

-- Restore the unchanged append-only and forward-only operational guards.
CREATE INDEX change_plans_status ON change_plans(status,created_at);
CREATE TRIGGER change_plans_no_delete BEFORE DELETE ON change_plans BEGIN SELECT RAISE(ABORT,'change plans are append-only'); END;
CREATE TRIGGER change_plans_no_replace BEFORE INSERT ON change_plans
WHEN EXISTS(SELECT 1 FROM change_plans WHERE plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'change plan replacement is forbidden'); END;
CREATE TRIGGER change_plans_status_only BEFORE UPDATE ON change_plans
WHEN NEW.plan_id<>OLD.plan_id OR NEW.kind<>OLD.kind OR NEW.payload_json<>OLD.payload_json
 OR NEW.base_context_id<>OLD.base_context_id OR NEW.expected_revisions_json<>OLD.expected_revisions_json
 OR NEW.simulation_json<>OLD.simulation_json OR NEW.created_by<>OLD.created_by
 OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 OR OLD.status NOT IN ('planned','approved') OR NEW.status=OLD.status
BEGIN SELECT RAISE(ABORT,'change plan is immutable except its status'); END;
CREATE INDEX approvals_plan ON approvals(plan_id);
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
CREATE TRIGGER approvals_no_replace BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM approvals WHERE approval_id=NEW.approval_id)
 OR NEW.plan_digest<>NEW.plan_id
 OR NOT EXISTS(SELECT 1 FROM change_plans p WHERE p.plan_id=NEW.plan_id AND p.plan_id=NEW.plan_digest)
BEGIN SELECT RAISE(ABORT,'approval_plan_digest_invalid'); END;
CREATE TRIGGER approvals_uses_only BEFORE UPDATE ON approvals
WHEN NEW.approval_id<>OLD.approval_id OR NEW.plan_id<>OLD.plan_id OR NEW.plan_digest<>OLD.plan_digest
 OR NEW.approver_actor<>OLD.approver_actor OR NEW.approver_verification<>OLD.approver_verification
 OR NEW.scope_json<>OLD.scope_json OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at
 OR NEW.uses_remaining<>OLD.uses_remaining-1
BEGIN SELECT RAISE(ABORT,'approval is immutable except spending one use'); END;
CREATE INDEX operation_receipts_plan ON operation_receipts(plan_id);
CREATE TRIGGER operation_receipts_no_delete BEFORE DELETE ON operation_receipts BEGIN SELECT RAISE(ABORT,'operation receipts are append-only'); END;
CREATE TRIGGER operation_receipts_no_replace BEFORE INSERT ON operation_receipts
WHEN EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=NEW.operation_id)
 OR NEW.status<>'accepted' OR NEW.published_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'operation receipt replacement is forbidden'); END;
CREATE TRIGGER operation_receipts_status_only BEFORE UPDATE ON operation_receipts
WHEN NEW.operation_id<>OLD.operation_id OR NEW.principal<>OLD.principal
 OR NEW.operation_kind<>OLD.operation_kind OR NEW.payload_digest<>OLD.payload_digest
 OR NEW.plan_id<>OLD.plan_id OR NEW.result_json<>OLD.result_json OR NEW.created_at<>OLD.created_at
 OR OLD.status<>'accepted' OR NEW.status NOT IN ('published','failed')
 OR (NEW.status='published' AND NEW.published_at IS NULL)
BEGIN SELECT RAISE(ABORT,'operation receipt is immutable except its publication state'); END;
CREATE INDEX decision_outbox_pending ON decision_outbox(processed_at,available_at_ms,id);
CREATE INDEX decision_outbox_operation ON decision_outbox(principal,operation_id);
CREATE TRIGGER decision_outbox_no_delete BEFORE DELETE ON decision_outbox BEGIN SELECT RAISE(ABORT,'decision outbox rows are append-only'); END;
CREATE TRIGGER decision_outbox_no_replace BEFORE INSERT ON decision_outbox
WHEN NEW.processed_at IS NOT NULL OR NEW.attempts<>0
 OR EXISTS(SELECT 1 FROM decision_outbox WHERE decision_revision_id=NEW.decision_revision_id AND target=NEW.target)
BEGIN SELECT RAISE(ABORT,'decision outbox replacement is forbidden'); END;
CREATE TRIGGER decision_outbox_progress_only BEFORE UPDATE ON decision_outbox
WHEN NEW.id<>OLD.id OR NEW.decision_revision_id<>OLD.decision_revision_id
 OR NEW.principal<>OLD.principal OR NEW.operation_id<>OLD.operation_id
 OR NEW.target<>OLD.target OR NEW.enqueued_at<>OLD.enqueued_at
 OR NEW.attempts<OLD.attempts OR OLD.processed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'decision outbox row is immutable except its processing state'); END;

-- The outbox completion guard added by 0038 is unchanged as well.
CREATE TRIGGER decision_outbox_completion_guard BEFORE UPDATE ON decision_outbox
WHEN NEW.pending_polls<OLD.pending_polls
 OR (OLD.required_source_revision IS NOT NULL
     AND NEW.required_source_revision IS NOT OLD.required_source_revision)
 OR (NEW.processed_at IS NOT NULL AND NEW.evidence_ref IS NULL)
BEGIN SELECT RAISE(ABORT,'an outbox row is processed only with its completion evidence'); END;
