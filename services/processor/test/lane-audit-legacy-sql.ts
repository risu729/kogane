// The two `reconciliation_proposals` reads of src/lane-audit.ts exactly as
// #925 shipped them (512118a4), before they wrote `+kind` so that the planner
// ranges on the rowid instead of walking or seeking the `(kind,stage)` index.
// Frozen as text so the tests can prove the current reads return the same
// rows in the same order and see the old plans fail the plan checks. Verbatim;
// never edit them by hand, and never import them outside tests.

/** The proposal ranges of one tick; binds (mark). */
export const LEGACY_LANE_RECONCILIATION_PROPOSALS_SQL = `SELECT kind,count(*) AS n,min(rowid) AS lo,max(rowid) AS hi FROM reconciliation_proposals
      WHERE rowid>?1 AND method='rule' GROUP BY kind`;

/** A `proposals:reconciliation-<kind>:<a>-<b>` reference read back; binds (from, to, kind). */
export const LEGACY_LANE_RECONCILIATION_REF_SQL = `SELECT id FROM reconciliation_proposals WHERE rowid>=?1 AND rowid<=?2 AND method='rule' AND kind=?3 ORDER BY rowid`;
