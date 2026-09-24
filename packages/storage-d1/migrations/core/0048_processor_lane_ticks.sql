-- The last ticks of the Processor's scheduled lanes (operational, not
-- financial evidence). Additive only: no existing table, view, trigger or row
-- is altered, and a Worker build that predates this migration keeps working
-- because it never names the table below.
--
-- A lane that keeps no state of its own (purchase_recognition,
-- reconciliation_sweep, card_settlement_sweep, identity_sweep,
-- reward_claims_sweep, operation_dispatch, decision_outbox) used to leave
-- nothing but a Workers Logs line, so "did it run?" could only be answered
-- from the logs. One row here is one tick of one lane: when it started and
-- finished, whether it ran, was skipped because its flag is off, or failed
-- with a safe code, and its counts (docs/processor.md §6,
-- docs/operations.md §1).
--
-- counts_json holds counts, flags and closed reason codes only: every key is
-- an identifier, every value a non-negative integer, a boolean, or one level
-- of {code: count}. No text value can be stored, so no amount text, account
-- label, key or provider wording fits in it; the error code is a code, never
-- an exception message.
--
-- Bounded: the writer keeps the latest 288 rows per lane (one day of the
-- five-minute cron) and deletes the older ones in the same batch as each
-- insert. A row is never updated. The table is outside the source-revision
-- ledger (packages/read-model/src/source-revision.ts): recording that a lane
-- ran changes nothing a projection reads.
CREATE TABLE processor_lane_ticks (
 id INTEGER PRIMARY KEY,
 lane TEXT NOT NULL CHECK(length(lane) BETWEEN 1 AND 64 AND lane GLOB '[a-z]*' AND lane NOT GLOB '*[^a-z_]*'),
 started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
 finished_at_ms INTEGER NOT NULL CHECK(finished_at_ms>=started_at_ms),
 outcome TEXT NOT NULL CHECK(outcome IN ('ran','skipped-by-flag','failed')),
 error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64
  AND error_code GLOB '[A-Za-z]*' AND error_code NOT GLOB '*[^A-Za-z0-9_]*')),
 counts_json TEXT NOT NULL CHECK(length(counts_json)<=2048 AND json_valid(counts_json) AND json_type(counts_json)='object'),
 CHECK((outcome='failed')=(error_code IS NOT NULL)),
 CHECK(outcome='ran' OR counts_json='{}')
) STRICT;
-- The retention delete and the latest-per-lane read both walk one lane by id.
CREATE INDEX processor_lane_ticks_lane ON processor_lane_ticks(lane,id);
CREATE TRIGGER processor_lane_ticks_no_update BEFORE UPDATE ON processor_lane_ticks
BEGIN SELECT RAISE(ABORT,'processor lane ticks are written once'); END;
-- Keys are identifiers; top-level values are non-negative integers, booleans
-- or one object of {lower_snake_case code: non-negative integer}.
CREATE TRIGGER processor_lane_ticks_counts BEFORE INSERT ON processor_lane_ticks
WHEN EXISTS(SELECT 1 FROM json_each(NEW.counts_json) f
  WHERE length(f.key) NOT BETWEEN 1 AND 64 OR f.key NOT GLOB '[A-Za-z]*' OR f.key GLOB '*[^A-Za-z0-9_]*'
  OR f.type NOT IN ('integer','true','false','object') OR (f.type='integer' AND f.atom<0))
 OR EXISTS(SELECT 1 FROM json_each(NEW.counts_json) f JOIN json_each(NEW.counts_json,f.fullkey) g
  WHERE f.type='object' AND (length(g.key) NOT BETWEEN 1 AND 64 OR g.key NOT GLOB '[a-z]*'
  OR g.key GLOB '*[^a-z0-9_]*' OR g.type<>'integer' OR g.atom<0))
BEGIN SELECT RAISE(ABORT,'processor_lane_tick_counts_invalid'); END;
