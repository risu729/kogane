-- The two operational records of ADR 0129's first slice (issue #1491): what
-- the Processor's invocations read from D1 per hour, and the input key under
-- which the report job last stored its report. Neither is evidence or a
-- projection input: both are outside the source-revision ledger
-- (packages/read-model/src/source-revision.ts, REVISION_EXCLUDED_TABLES), so
-- writing them moves nothing a projection reads. Additive only: no existing
-- table, view, trigger or row is altered, and a Worker build that predates
-- this migration keeps working because it never names either table.

-- Rows read per hour, summed over every metered Processor invocation (the
-- `invocation_budget` log line's `d1RowsRead`, scheduled ticks and queue
-- batches alike). The scheduled tick sums the last 24 rows before its lanes
-- run; above the daily budget it logs an error and runs the derived lanes only
-- on the first scheduled tick of each hour (docs/processor.md). Bounded: the
-- writer deletes rows older than 48 hours in the same batch as each upsert.
CREATE TABLE processor_read_budget_hours (
 hour_start_ms INTEGER PRIMARY KEY CHECK(hour_start_ms>=0 AND hour_start_ms%3600000=0),
 rows_read INTEGER NOT NULL CHECK(rows_read>=0),
 -- Scheduled invocations recorded in this hour; the throttle reads whether
 -- one already ran, so queue batches are counted apart.
 scheduled_ticks INTEGER NOT NULL CHECK(scheduled_ticks>=0),
 queue_invocations INTEGER NOT NULL CHECK(queue_invocations>=0)
) STRICT;

-- The report job's skip gate: one row per option set (`gate_id`, the digest
-- of the caller's options and the build releases). `input_key` is the digest
-- of the CORE revision row and the newest price claim read before the stored
-- report was built; while both are unchanged and the knowledge cutoff stays in
-- [built_cutoff_ms, valid_until_ms), the stored report is the answer and the
-- job reads nothing else. `valid_until_ms` is when the earliest price claimed
-- for a held position becomes admissible by the clock alone (NULL: none is
-- pending). Only the report job writes it, after the report is stored.
CREATE TABLE report_job_gates (
 gate_id TEXT PRIMARY KEY CHECK(length(gate_id)=64 AND gate_id NOT GLOB '*[^0-9a-f]*'),
 input_key TEXT NOT NULL CHECK(length(input_key)=64 AND input_key NOT GLOB '*[^0-9a-f]*'),
 report_id TEXT NOT NULL REFERENCES report_artifacts(report_id),
 context_id TEXT NOT NULL CHECK(length(context_id) BETWEEN 1 AND 256),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
 run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
 built_cutoff_ms INTEGER NOT NULL CHECK(built_cutoff_ms>=0),
 valid_until_ms INTEGER CHECK(valid_until_ms IS NULL OR valid_until_ms>built_cutoff_ms),
 updated_at TEXT NOT NULL CHECK(length(updated_at) BETWEEN 1 AND 64)
) STRICT;
