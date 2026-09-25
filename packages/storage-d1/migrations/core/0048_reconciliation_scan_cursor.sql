-- The reconciliation sweep's scan cursor, and an index for the pending-to-posted
-- candidate reads. Additive only: no existing table, view, trigger or row is
-- altered, and a Worker build that predates this migration keeps working
-- because it never reads or writes the table below and an index changes no
-- result.
--
-- Operational scan progress, not financial evidence (as 0044's and 0047's
-- cursors). The sweep pages through each slice's published pending and posted
-- rows by observation id and wraps to 0 after the last page, so a slice larger
-- than one page is still paired in full; before this cursor it re-read the
-- same first 1,000 rows every tick. One row per slice, keyed by the slice's
-- source (`RECONCILIATION_SLICES`, services/processor/src/reconciliation-job.ts),
-- created the first time that slice's cursor moves; an absent row reads as 0.
CREATE TABLE reconciliation_scan_cursor (
 source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 64),
 last_observation_id INTEGER NOT NULL CHECK(last_observation_id>=0)
) STRICT;

-- The candidate reads of card purchases and of a pending-to-posted review
-- (packages/application/src/query/card-purchase-candidates.ts) select every
-- `pending_to_posted` stage B proposal whatever its status, so 0032's
-- (status, kind, stage) index cannot serve them: without table statistics (D1
-- is never analyzed) they scanned every proposal, the stage A rows included.
CREATE INDEX reconciliation_proposals_kind_stage ON reconciliation_proposals(kind,stage);
