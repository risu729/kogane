// The pending-to-posted candidates' relation read exactly as it shipped before
// ADR 0017's amendment of 2026-11-06 (`CANDIDATE_RELATIONS_SQL` in
// src/query/card-purchase-candidates.ts at commit 893cb8af, with
// `PENDING_POSTED_RELATION_KIND` = `pending_to_posted`), frozen as text so
// pending-posted-relations-current.test.ts can prove the current read returns
// the same pin and status wherever no proposal was recorded after a decision
// of the triple. The digest below pins the text: never edit it by hand, and
// never import it outside tests.

/** SHA-256 of `LEGACY_CANDIDATE_RELATIONS_SQL`. */
export const LEGACY_CANDIDATE_RELATIONS_SQL_SHA256 =
  "2a335a715b2a853984dc4c1b4d3e3eed41066040c55c173d0a87479322789fea";

/** ?1 a JSON array of `[from, to]` pairs. */
export const LEGACY_CANDIDATE_RELATIONS_SQL = `SELECT json_extract(w.value,'$[0]') AS from_ref,json_extract(w.value,'$[1]') AS to_ref,
 (SELECT count(*) FROM entity_relations r WHERE r.kind='pending_to_posted'
   AND r.from_ref=json_extract(w.value,'$[0]') AND r.to_ref=json_extract(w.value,'$[1]')) AS revision,
 (SELECT r.status FROM entity_relations r WHERE r.kind='pending_to_posted'
   AND r.from_ref=json_extract(w.value,'$[0]') AND r.to_ref=json_extract(w.value,'$[1]')
   ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS status
FROM json_each(?1) w`;
