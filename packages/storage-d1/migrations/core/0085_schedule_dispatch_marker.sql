-- Only new protocol claims prove that an absent marker means no RPC.
-- Historical rows and older deployed builds retain dispatch_protocol=0.
CREATE TABLE collection_schedule_occurrences_v2 (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES collection_schedules(id),
 nominal_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 status TEXT NOT NULL CHECK(status IN('started','completed','failed','uncertain','not_dispatched')),
 run_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(run_ids_json)), failure_code TEXT,
 dispatch_protocol INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_protocol IN(0,1)),
 dispatched_at TEXT, attempt_ref TEXT, retry_claimed_at TEXT,
 UNIQUE(schedule_id,nominal_at),
 CHECK(dispatch_protocol=1 OR (dispatched_at IS NULL AND attempt_ref IS NULL AND retry_claimed_at IS NULL)),
 CHECK(status<>'not_dispatched' OR (dispatch_protocol=1 AND dispatched_at IS NULL))
) STRICT;
INSERT INTO collection_schedule_occurrences_v2(id,schedule_id,nominal_at,started_at,finished_at,status,run_ids_json,failure_code)
 SELECT id,schedule_id,nominal_at,started_at,finished_at,status,run_ids_json,failure_code FROM collection_schedule_occurrences;
DROP TABLE collection_schedule_occurrences;
ALTER TABLE collection_schedule_occurrences_v2 RENAME TO collection_schedule_occurrences;
CREATE INDEX schedule_occurrences_recent ON collection_schedule_occurrences(started_at DESC);
CREATE INDEX schedule_occurrences_pending ON collection_schedule_occurrences(started_at) WHERE status='started';
CREATE INDEX schedule_occurrences_retry ON collection_schedule_occurrences(schedule_id,nominal_at) WHERE status='not_dispatched' AND retry_claimed_at IS NULL;
CREATE TRIGGER schedule_occurrence_identity_immutable BEFORE UPDATE ON collection_schedule_occurrences
WHEN NEW.id IS NOT OLD.id OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.nominal_at IS NOT OLD.nominal_at OR NEW.started_at IS NOT OLD.started_at OR NEW.dispatch_protocol IS NOT OLD.dispatch_protocol
BEGIN SELECT RAISE(ABORT,'immutable_occurrence_identity'); END;
CREATE TRIGGER schedule_occurrence_dispatch_immutable BEFORE UPDATE ON collection_schedule_occurrences
WHEN (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at) OR (OLD.retry_claimed_at IS NOT NULL AND NEW.retry_claimed_at IS NOT OLD.retry_claimed_at)
BEGIN SELECT RAISE(ABORT,'immutable_dispatch_marker'); END;
