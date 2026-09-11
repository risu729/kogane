-- Operations API records (unified plan 02 §4-5, U06). Additive only: no
-- existing table, view, trigger or row is altered, and a Worker that predates
-- this migration keeps working because it never reads or writes what is below.
-- The one change to an existing table is `ALTER TABLE ... ADD COLUMN` with an
-- implicit NULL default, which the 0035 writer and reader ignore.
--
-- Why a new table rather than `operation_receipts` (0031): that table's
-- `operation_kind` CHECK is the closed list of change-lifecycle kinds, and an
-- existing migration is immutable. A collection request is also a different
-- fact from a judgement receipt — it records that a *request* was accepted,
-- not that a decision is durable — so the two stay separate and the 0031
-- tables keep their meaning unchanged.
--
-- Nothing here holds an amount, a credential, a bucket key, a URL or provider
-- text. A request row holds a declared source id, a bounded run identifier,
-- date-only window bounds and safe codes.

-- One accepted operations-API request. `operation_id` is
-- 'op_' || sha256(kind, principal, idempotency key), so re-sending the same
-- request under the same key addresses the same row instead of creating a
-- second one (G3-06, G3-14). `payload_digest` is the canonical digest of the
-- validated request: the same key with a different payload is a conflict, not
-- an overwrite.
--
-- `status` and the dispatch columns are operational state; everything else is
-- the immutable record of what was accepted.
CREATE TABLE ops_requests (
  operation_id TEXT PRIMARY KEY
    CHECK(length(operation_id)=67 AND substr(operation_id,1,3)='op_'
          AND substr(operation_id,4) NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL
    CHECK(kind IN ('collection','import','replay','projection','session-refresh')),
  -- The server-verified subject. Never read from a request body or a header.
  principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL
    CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  -- A declared source, enforced by the registry rather than by free text.
  -- NULL only for a kind that names no single source (projection rebuild).
  source_id TEXT REFERENCES sources(id),
  request_json TEXT NOT NULL
    CHECK(json_valid(request_json) AND json_type(request_json)='object'),
  -- 'accepted' means the request is durable, never that the work is done.
  -- 'waiting_for_human' is the answer when the source policy requires a
  -- person (12 §3): the request is kept, and nothing retries a login.
  status TEXT NOT NULL
    CHECK(status IN ('accepted','waiting_for_human','running','completed','failed','blocked')),
  -- Notification is separate from acceptance. A failed dispatch never deletes
  -- the request; the Processor cron re-dispatches 'dispatch_pending' rows.
  dispatch_state TEXT NOT NULL
    CHECK(dispatch_state IN ('not_required','dispatch_pending','dispatched','dispatch_failed')),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0),
  available_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(available_at_ms>=0),
  -- What the executor bound this request to, written once: the collection run,
  -- the replay plan, the registration. Identifiers only, never a URL or key.
  -- A second dispatch of the same operation finds it already set and must
  -- reuse that work rather than start a second provider session (G3-14).
  target_ref TEXT CHECK(target_ref IS NULL OR length(target_ref) BETWEEN 1 AND 256),
  -- A safe code, never a message, a value or an exception string (G3-08).
  failure_code TEXT
    CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 64
          AND failure_code NOT GLOB '*[^a-z0-9_]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(principal,kind,idempotency_key)
) STRICT;
CREATE INDEX ops_requests_dispatch ON ops_requests(dispatch_state,available_at_ms,operation_id);
CREATE INDEX ops_requests_principal ON ops_requests(principal,created_at);
CREATE INDEX ops_requests_open ON ops_requests(status,kind,created_at);
CREATE TRIGGER ops_requests_no_delete BEFORE DELETE ON ops_requests
BEGIN SELECT RAISE(ABORT,'operations requests are append-only'); END;
-- A request is accepted once. It is never re-accepted into a fresh state, and
-- it is never inserted as already done, already dispatched or already failed.
CREATE TRIGGER ops_requests_no_replace BEFORE INSERT ON ops_requests
WHEN EXISTS(SELECT 1 FROM ops_requests WHERE operation_id=NEW.operation_id)
 OR NEW.status NOT IN ('accepted','waiting_for_human')
 OR NEW.dispatch_attempts<>0 OR NEW.failure_code IS NOT NULL OR NEW.target_ref IS NOT NULL
BEGIN SELECT RAISE(ABORT,'operations request replacement is forbidden'); END;
-- Only progress moves: what was accepted never changes, a terminal request is
-- never reopened, and a bound target is never re-pointed at other work.
CREATE TRIGGER ops_requests_progress_only BEFORE UPDATE ON ops_requests
WHEN NEW.operation_id<>OLD.operation_id OR NEW.kind<>OLD.kind OR NEW.principal<>OLD.principal
 OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload_digest<>OLD.payload_digest
 OR NEW.request_json<>OLD.request_json OR NEW.created_at<>OLD.created_at
 OR NEW.source_id IS NOT OLD.source_id
 OR NEW.dispatch_attempts<OLD.dispatch_attempts
 OR (OLD.target_ref IS NOT NULL AND NEW.target_ref IS NOT OLD.target_ref)
 OR OLD.status IN ('completed','failed','blocked')
BEGIN SELECT RAISE(ABORT,'operations request is immutable except its progress'); END;

-- Stage progress of one request, in the vocabulary of contracts/stages.json:
-- persisted -> registered -> parsed -> adopted -> projected. A stage with no
-- row is `pending`; a row is written by the executor that reached the stage.
-- `queued`, `building`, a flag being off and "no processor" are never
-- completion, so they never produce a 'completed' row here.
CREATE TABLE ops_request_stages (
  operation_id TEXT NOT NULL REFERENCES ops_requests(operation_id),
  stage TEXT NOT NULL
    CHECK(stage IN ('persisted','registered','parsed','adopted','projected')),
  state TEXT NOT NULL CHECK(state IN ('pending','completed','retryable','blocked')),
  -- The identifier of what proves the stage (run, parse run, snapshot). Never
  -- a URL, a bucket key or provider text.
  evidence_ref TEXT CHECK(evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 256),
  failure_code TEXT
    CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 64
          AND failure_code NOT GLOB '*[^a-z0-9_]*')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,stage)
) STRICT;
CREATE INDEX ops_request_stages_state ON ops_request_stages(state,updated_at);
CREATE TRIGGER ops_request_stages_no_delete BEFORE DELETE ON ops_request_stages
BEGIN SELECT RAISE(ABORT,'operations stages are append-only'); END;
-- A completed stage is evidence that something happened; a later sweep never
-- turns it back into pending, retryable or blocked.
CREATE TRIGGER ops_request_stages_no_reopen BEFORE UPDATE ON ops_request_stages
WHEN NEW.operation_id<>OLD.operation_id OR NEW.stage<>OLD.stage
 OR NEW.attempts<OLD.attempts
 OR (OLD.state='completed' AND NEW.state<>'completed')
BEGIN SELECT RAISE(ABORT,'a completed stage is never reopened'); END;

-- Which accepted request a replay plan belongs to. The plan tables of 0035
-- stay the only place a replay plan lives: the operations API creates a
-- `planned` row there and records the operation on it, rather than keeping a
-- second copy of the plan.
ALTER TABLE observation_replay_plans ADD COLUMN operation_id TEXT;
CREATE UNIQUE INDEX observation_replay_plans_operation
  ON observation_replay_plans(operation_id) WHERE operation_id IS NOT NULL;
