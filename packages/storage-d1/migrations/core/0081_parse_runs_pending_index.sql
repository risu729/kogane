-- ADR 0079: the sweep's interrupted-attempt repair reads pending parse runs
-- only. `maintenance` (services/processor/src/worker.ts) runs on every sweep:
-- UPDATE parse_runs ... WHERE status='pending' AND EXISTS(<its failed job>).
-- Without an index whose rows are the pending runs, D1's unanalyzed planner
-- read every parse run ever written on every tick to find the few still
-- pending. A partial index holds exactly those rows; the planner reads it
-- whole and probes the job per row as before. Additive: no row, view or
-- trigger changes, and the statement text is unchanged.
CREATE INDEX parse_runs_pending ON parse_runs(fetch_artifact_id, parser_name, parser_version)
 WHERE status='pending';
