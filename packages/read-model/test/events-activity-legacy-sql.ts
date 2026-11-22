// The activity list's SQL as it shipped before its filters (ADR 0081,
// amendment of 2026-11-20), frozen: `activityEventsSql` must stay this text
// byte for byte, and every filtered read is compared with this text's rows
// narrowed in memory (`events-filters.test.ts`). Do not edit it; a change to
// the unfiltered list is a new rewrite with its own proof.

/** `?1` basis, `?2` limit, `?3` offset. */
export const LEGACY_ACTIVITY_EVENTS_SQL = `SELECT e.event_id,e.revision,e.kind,e.state,e.unknown_reason,
 e.effective_time_json,e.basis,e.evidence_support_json,e.decision_revision_id
FROM economic_event_revisions e
WHERE e.superseded_by IS NULL AND EXISTS(SELECT 1 FROM economic_legs l
 WHERE l.event_id=e.event_id AND l.revision=e.revision AND l.basis=?1)
ORDER BY e.event_id,e.revision
LIMIT ?2 OFFSET ?3`;
