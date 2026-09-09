-- Change lifecycle: plan → simulate → approve → commit (architecture addendum
-- A09; SC17, UC69/UC70). Additive only: no existing table, view, trigger or
-- row is altered, and a Worker build that predates this migration keeps
-- working because it never reads or writes the tables below. Layer A, Layer B
-- and the decision log of 0029 are untouched.
--
-- Nothing here holds an amount. A plan records what would change and how many
-- rows it touches; the money semantics stay in the observation tables.

-- An immutable plan. plan_id IS the plan digest
-- (canonicalDigest({kind,payload,expectedRevisions,baseContextId})), so any
-- change of target, payload, expected revision or context yields a different
-- plan and invalidates every approval bound to the old digest (SC17).
-- `status` is the only mutable column: operational state, not a fact.
CREATE TABLE change_plans (
 plan_id TEXT PRIMARY KEY CHECK(length(plan_id)=64 AND plan_id NOT GLOB '*[^0-9a-f]*'),
 kind TEXT NOT NULL CHECK(kind IN ('identity.assign','identity.release-override','relation.accept','relation.reject')),
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
CREATE INDEX change_plans_status ON change_plans(status,created_at);
CREATE TRIGGER change_plans_no_delete BEFORE DELETE ON change_plans BEGIN SELECT RAISE(ABORT,'change plans are append-only'); END;
CREATE TRIGGER change_plans_no_replace BEFORE INSERT ON change_plans
WHEN EXISTS(SELECT 1 FROM change_plans WHERE plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'change plan replacement is forbidden'); END;
-- Only `status` moves, and only away from a still-open plan.
CREATE TRIGGER change_plans_status_only BEFORE UPDATE ON change_plans
WHEN NEW.plan_id<>OLD.plan_id OR NEW.kind<>OLD.kind OR NEW.payload_json<>OLD.payload_json
 OR NEW.base_context_id<>OLD.base_context_id OR NEW.expected_revisions_json<>OLD.expected_revisions_json
 OR NEW.simulation_json<>OLD.simulation_json OR NEW.created_by<>OLD.created_by
 OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 OR OLD.status NOT IN ('planned','approved') OR NEW.status=OLD.status
BEGIN SELECT RAISE(ABORT,'change plan is immutable except its status'); END;

-- An approval receipt binds one human principal to one plan digest, a scope,
-- an expiry and a number of uses. An agent that sends `approved: true` never
-- creates a row here: the command boundary refuses it before this table.
CREATE TABLE approvals (
 approval_id TEXT PRIMARY KEY CHECK(length(approval_id) BETWEEN 1 AND 256),
 plan_id TEXT NOT NULL REFERENCES change_plans(plan_id),
 plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
 approver_actor TEXT NOT NULL CHECK(length(approver_actor) BETWEEN 1 AND 256),
 approver_verification TEXT NOT NULL CHECK(approver_verification='server'),
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json)='array'),
 expires_at TEXT NOT NULL,
 uses_remaining INTEGER NOT NULL CHECK(uses_remaining>=0),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX approvals_plan ON approvals(plan_id);
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
CREATE TRIGGER approvals_no_replace BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM approvals WHERE approval_id=NEW.approval_id)
 OR NEW.plan_digest<>NEW.plan_id
 OR NOT EXISTS(SELECT 1 FROM change_plans p WHERE p.plan_id=NEW.plan_id AND p.plan_id=NEW.plan_digest)
BEGIN SELECT RAISE(ABORT,'approval_plan_digest_invalid'); END;
-- The single permitted update: spending one use. Nothing else moves, and an
-- approval never gains uses back.
CREATE TRIGGER approvals_uses_only BEFORE UPDATE ON approvals
WHEN NEW.approval_id<>OLD.approval_id OR NEW.plan_id<>OLD.plan_id OR NEW.plan_digest<>OLD.plan_digest
 OR NEW.approver_actor<>OLD.approver_actor OR NEW.approver_verification<>OLD.approver_verification
 OR NEW.scope_json<>OLD.scope_json OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at
 OR NEW.uses_remaining<>OLD.uses_remaining-1
BEGIN SELECT RAISE(ABORT,'approval is immutable except spending one use'); END;

-- Idempotency receipts, scoped to the principal and the operation id. The row
-- is the atomic reservation of the commit: it is written by the first
-- statement of the commit batch under every precondition, and every later
-- statement of that batch is joined to it, so a failed guard writes nothing.
-- `accepted` means the judgement is durable; `published` means every outbox
-- target of that judgement has been processed. They are never the same thing.
CREATE TABLE operation_receipts (
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('identity.assign','identity.release-override','relation.accept','relation.reject')),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 plan_id TEXT NOT NULL REFERENCES change_plans(plan_id),
 status TEXT NOT NULL CHECK(status IN ('accepted','published','failed')),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
 created_at TEXT NOT NULL,
 published_at TEXT,
 UNIQUE(principal,operation_id)
) STRICT;
CREATE INDEX operation_receipts_plan ON operation_receipts(plan_id);
CREATE TRIGGER operation_receipts_no_delete BEFORE DELETE ON operation_receipts BEGIN SELECT RAISE(ABORT,'operation receipts are append-only'); END;
CREATE TRIGGER operation_receipts_no_replace BEFORE INSERT ON operation_receipts
WHEN EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=NEW.operation_id)
 OR NEW.status<>'accepted' OR NEW.published_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'operation receipt replacement is forbidden'); END;
-- Only the publication columns move, and only forwards from `accepted`.
CREATE TRIGGER operation_receipts_status_only BEFORE UPDATE ON operation_receipts
WHEN NEW.operation_id<>OLD.operation_id OR NEW.principal<>OLD.principal
 OR NEW.operation_kind<>OLD.operation_kind OR NEW.payload_digest<>OLD.payload_digest
 OR NEW.plan_id<>OLD.plan_id OR NEW.result_json<>OLD.result_json OR NEW.created_at<>OLD.created_at
 OR OLD.status<>'accepted' OR NEW.status NOT IN ('published','failed')
 OR (NEW.status='published' AND NEW.published_at IS NULL)
BEGIN SELECT RAISE(ABORT,'operation receipt is immutable except its publication state'); END;

-- The decision outbox (addendum 12 section 3). Distinct from the collector R2
-- import outbox: this one carries accepted internal judgements to the read
-- models. Delivery is assumed duplicated and out of order; every target
-- processor is idempotent, and the receipt turns `published` only when every
-- row of its operation is processed.
CREATE TABLE decision_outbox (
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
 UNIQUE(decision_revision_id,target),
 FOREIGN KEY(principal,operation_id) REFERENCES operation_receipts(principal,operation_id)
) STRICT;
CREATE INDEX decision_outbox_pending ON decision_outbox(processed_at,available_at_ms,id);
CREATE INDEX decision_outbox_operation ON decision_outbox(principal,operation_id);
CREATE TRIGGER decision_outbox_no_delete BEFORE DELETE ON decision_outbox BEGIN SELECT RAISE(ABORT,'decision outbox rows are append-only'); END;
CREATE TRIGGER decision_outbox_no_replace BEFORE INSERT ON decision_outbox
WHEN NEW.processed_at IS NOT NULL OR NEW.attempts<>0
 OR EXISTS(SELECT 1 FROM decision_outbox WHERE decision_revision_id=NEW.decision_revision_id AND target=NEW.target)
BEGIN SELECT RAISE(ABORT,'decision outbox replacement is forbidden'); END;
-- Only the processing columns move; what was enqueued never changes, and a
-- processed row is never reopened (duplicate delivery is a no-op, not a
-- rewrite).
CREATE TRIGGER decision_outbox_progress_only BEFORE UPDATE ON decision_outbox
WHEN NEW.id<>OLD.id OR NEW.decision_revision_id<>OLD.decision_revision_id
 OR NEW.principal<>OLD.principal OR NEW.operation_id<>OLD.operation_id
 OR NEW.target<>OLD.target OR NEW.enqueued_at<>OLD.enqueued_at
 OR NEW.attempts<OLD.attempts OR OLD.processed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'decision outbox row is immutable except its processing state'); END;
