-- Collector execution of an accepted operations-API request (issue #544,
-- ADR 0048). Additive only: no existing table, view, trigger or row is
-- altered, and a Worker that predates this migration keeps working because it
-- never reads or writes what is below.
--
-- `ops_requests` (0040) stays the immutable record of what was accepted. This
-- table is the operational state of *executing* one accepted `collection` or
-- unattended `session-refresh` request through the named collector RPC the
-- alarm already uses: whether it is waiting and why, when it started, which
-- runs the collector reported, and when publication was observed or which
-- closed reason ended it. One row per operation, so a re-sent request (the
-- same operation id) can never hold a second execution.
--
-- Nothing here holds an amount, a credential, provider text, a URL or a bucket
-- key: identifiers (operation, connection, collector source, run ids), closed
-- codes and timestamps only.
CREATE TABLE ops_collector_dispatches (
  operation_id TEXT PRIMARY KEY REFERENCES ops_requests(operation_id),
  -- The alarm job that binds the source to its collector (config/alarm-jobs.json),
  -- NULL only while no connection serves the request (`unsupported`).
  connection_id TEXT
    CHECK(connection_id IS NULL OR (length(connection_id) BETWEEN 1 AND 100
          AND connection_id NOT GLOB '*[^a-z0-9-]*')),
  action TEXT NOT NULL CHECK(action IN ('collect','refresh-session')),
  -- The `runs/<source>/…` id the collector's terminals carry: how a reported
  -- run is found in `collection_runs` without re-deriving it.
  terminal_source TEXT
    CHECK(terminal_source IS NULL OR (length(terminal_source) BETWEEN 1 AND 100
          AND terminal_source NOT GLOB '*[^a-z0-9-]*')),
  -- waiting: not started, nothing contacted; the reason is `reason_code`.
  -- started: the collector was called; the outcome is not recorded yet.
  -- collected / refreshed: the collector reported success (terminal persisted
  --   for a collection; session renewed for a refresh).
  -- published / unpublished: every reported run reached CORE publication, or
  --   ended with the closed reason in `reason_code`.
  -- failed / uncertain: the collector reported a failure, or the call's
  --   outcome cannot be known; neither is ever retried automatically.
  -- expired / unsupported: ended before any start.
  state TEXT NOT NULL
    CHECK(state IN ('waiting','started','collected','refreshed','published','unpublished',
                    'failed','uncertain','expired','unsupported')),
  reason_code TEXT
    CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 1 AND 64
          AND reason_code NOT GLOB '*[^a-z0-9_]*')),
  waits INTEGER NOT NULL DEFAULT 0 CHECK(waits>=0),
  -- At most one start per operation: a second provider session for the same
  -- acceptance is exactly what the idempotency key promises never happens.
  starts INTEGER NOT NULL DEFAULT 0 CHECK(starts IN (0,1)),
  run_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(run_ids_json) AND json_type(run_ids_json)='array'
          AND json_array_length(run_ids_json)<=100),
  accepted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  collected_at TEXT,
  published_at TEXT,
  finished_at TEXT,
  -- When the Processor next reads the trail of a collected operation.
  next_check_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_check_at_ms>=0),
  updated_at TEXT NOT NULL,
  CHECK(starts = (started_at IS NOT NULL)),
  CHECK((started_at IS NULL) = (state IN ('waiting','expired','unsupported'))),
  CHECK((collected_at IS NOT NULL) = (state IN ('collected','published','unpublished'))),
  CHECK((published_at IS NOT NULL) = (state = 'published')),
  CHECK(state NOT IN ('collected','published','unpublished') OR action = 'collect'),
  CHECK(state <> 'refreshed' OR action = 'refresh-session'),
  CHECK(state = 'unsupported' OR connection_id IS NOT NULL)
) STRICT;
CREATE INDEX ops_collector_dispatches_open
  ON ops_collector_dispatches(state, next_check_at_ms, operation_id);
CREATE TRIGGER ops_collector_dispatches_no_delete BEFORE DELETE ON ops_collector_dispatches
BEGIN SELECT RAISE(ABORT,'collector dispatches are never deleted'); END;
-- A row is born before any start: waiting, or already declined.
CREATE TRIGGER ops_collector_dispatches_no_replace BEFORE INSERT ON ops_collector_dispatches
WHEN NEW.state NOT IN ('waiting','expired','unsupported') OR NEW.starts<>0
 OR NEW.run_ids_json<>'[]'
BEGIN SELECT RAISE(ABORT,'a collector dispatch is recorded before it starts'); END;
-- Forward only: waiting → started → collected → published | unpublished, or
-- to a terminal state. A started execution never returns to waiting (that
-- would allow a second start), a terminal state is never reopened, and what a
-- collector reported is written once.
CREATE TRIGGER ops_collector_dispatches_forward_only BEFORE UPDATE ON ops_collector_dispatches
WHEN NEW.operation_id<>OLD.operation_id OR NEW.action<>OLD.action
 OR NEW.accepted_at<>OLD.accepted_at OR NEW.expires_at<>OLD.expires_at
 OR (OLD.connection_id IS NOT NULL AND NEW.connection_id IS NOT OLD.connection_id)
 OR (OLD.terminal_source IS NOT NULL AND NEW.terminal_source IS NOT OLD.terminal_source)
 OR NEW.starts<OLD.starts OR NEW.waits<OLD.waits
 OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
 OR (OLD.collected_at IS NOT NULL
     AND (NEW.collected_at IS NOT OLD.collected_at OR NEW.run_ids_json<>OLD.run_ids_json))
 OR NOT ((OLD.state='waiting' AND NEW.state IN ('waiting','started','expired','unsupported'))
      OR (OLD.state='started' AND NEW.state IN ('collected','refreshed','failed','uncertain'))
      OR (OLD.state='collected' AND NEW.state IN ('collected','published','unpublished')))
BEGIN SELECT RAISE(ABORT,'a collector dispatch only moves forward'); END;
