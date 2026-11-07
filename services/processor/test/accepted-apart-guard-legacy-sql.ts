// The purchase lane's merge guard for a pair the reconciliation lane accepted
// by rule, exactly as it shipped before ADR 0017's amendment of 2026-11-06
// (the `proposalState` text of `mergeLinked` in src/card-purchase-job.ts at
// commit 893cb8af), frozen as text so card-purchase-link-current.test.ts can
// prove the current guard holds on the same stores wherever no proposal was
// recorded after a decision of the triple. The digest below pins the text:
// never edit it by hand, and never import it outside tests.

/** SHA-256 of `LEGACY_ACCEPTED_APART_GUARD_SQL`. */
export const LEGACY_ACCEPTED_APART_GUARD_SQL_SHA256 =
  "d1452ef41a810bfb9685e8a25dcfac051d33c79ae42559b4e247fdc59d24cdfc";

/** ?1 the proposal, ?2 the relation kind, ?3 and ?4 its ends. */
export const LEGACY_ACCEPTED_APART_GUARD_SQL = `EXISTS(SELECT 1 FROM reconciliation_proposals p JOIN decision_revisions d ON d.id=p.decision_revision_id
  WHERE p.id=? AND p.status='accepted' AND d.method='rule')
 AND (SELECT r.status FROM entity_relations r WHERE r.kind=? AND r.from_ref=? AND r.to_ref=?
  ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)='accepted'`;
