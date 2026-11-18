// The purchase lane's reviewed-pair guard exactly as it was first written
// (`REVIEWED_PAIR_SQL` in src/card-purchase-job.ts at commit f0a4fa0f, its
// `${PENDING_POSTED_RELATION_KIND}` written out), frozen as text so
// card-purchase-reviewed-pair.test.ts can prove the keyed rewrite reaches the
// same verdict on the same stores wherever a review wrote its triple. The
// digest below pins the text: never edit it by hand, and never import it
// outside tests.

/** SHA-256 of `LEGACY_REVIEWED_PAIR_SQL`. */
export const LEGACY_REVIEWED_PAIR_SQL_SHA256 =
  "a74fb98a04abd76d21d119612734443b2add13baa18c71d0cb0ddc68e59ac663";

/** Bound as the pending event's id, then the posted event's. */
export const LEGACY_REVIEWED_PAIR_SQL = `SELECT d.id FROM decision_revisions d
 CROSS JOIN reconciliation_proposals p ON p.id=substr(d.subject_ref,10)
 WHERE d.subject_kind='relation' AND d.subject_ref>'proposal:' AND d.subject_ref<'proposal;'
  AND d.method<>'rule' AND p.kind='pending_to_posted'
  AND json_extract(p.target_refs_json,'$[0].id') IN
   (SELECT 'transaction:'||k.observation_id FROM card_purchase_recognition_keys k WHERE k.event_id=?)
  AND json_extract(p.target_refs_json,'$[1].id') IN
   (SELECT 'transaction:'||k.observation_id FROM card_purchase_recognition_keys k WHERE k.event_id=?)
 LIMIT 1`;
