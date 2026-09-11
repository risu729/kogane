-- Publication event self-reference guard (design review follow-up to 0026).
--
-- publication_events records a pointer *change*: previous_parse_run_id is the
-- run that was adopted before, new_parse_run_id the run adopted now. A row
-- whose two ends are the same run records no change at all; it can only come
-- from a publish batch that was executed twice for an already published run,
-- and it corrupts the history the rollback runbook reads (the "previous" run
-- of the newest event would be the current one). The writer is fenced against
-- that (services/observation-pipeline/src/publication-gate.ts), and this
-- trigger makes the invariant a schema property so no future writer, repair
-- route or backfill can break it silently.
--
-- Additive: no table, index, view or existing trigger changes, and the 0026
-- backfill (previous_parse_run_id is the NULL literal), the pipeline writer
-- and POST /publication/repair (which only ever publishes a run the pointer
-- does not already name) all satisfy it. `IS` rather than `=` so the common
-- first-publication row (previous NULL, new not null) is not compared to NULL
-- and silently allowed for the wrong reason.

CREATE TRIGGER publication_events_no_self_reference BEFORE INSERT ON publication_events
WHEN NEW.previous_parse_run_id IS NEW.new_parse_run_id
BEGIN SELECT RAISE(ABORT,'publication_events cannot record a run replacing itself'); END;
