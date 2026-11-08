// The change lifecycle's relation target read exactly as it shipped before
// ADR 0017's amendment of 2026-11-06 (`RELATION_SQL` in
// src/operations/targets.ts at commit 893cb8af), frozen as text so
// relation-target-current.test.ts can prove the current read returns the same
// pin and status wherever no proposal was recorded after a decision of the
// triple. The digest below pins the text: never edit it by hand, and never
// import it outside tests.

/** SHA-256 of `LEGACY_RELATION_TARGET_SQL`. */
export const LEGACY_RELATION_TARGET_SQL_SHA256 =
  "60a4fb30553487d86998a227f65dcd5da0854a93e6d0cb3d6d69579f4480fa62";

/** ?1 kind, ?2 from_ref, ?3 to_ref. */
export const LEGACY_RELATION_TARGET_SQL = `SELECT count(*) AS revision,
 (SELECT r.status FROM entity_relations r WHERE r.kind=?1 AND r.from_ref=?2 AND r.to_ref=?3
   ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS current_status
 FROM entity_relations WHERE kind=?1 AND from_ref=?2 AND to_ref=?3`;
