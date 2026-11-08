// The card ownership review's claims read exactly as it shipped before ADR
// 0017's amendment of 2026-11-06 (the inline text of `queryCardOwnership` in
// src/query/card-ownership.ts at commit 893cb8af), frozen as text so
// card-ownership-claims-current.test.ts can prove the current read returns the
// same claims wherever no proposal follows a decision of the same owner. The
// digest below pins the text: never edit it by hand, and never import it
// outside tests.

/** SHA-256 of `LEGACY_CARD_OWNERSHIP_CLAIMS_SQL`. */
export const LEGACY_CARD_OWNERSHIP_CLAIMS_SQL_SHA256 =
  "09a806a37787caae8453c3041a7da51fe1198b28cb36061c4737662bb9414a27";

/** ?1 the role, ?2 the account, ?3 the last relation rowid the pin counted. */
export const LEGACY_CARD_OWNERSHIP_CLAIMS_SQL = `SELECT r.id,r.to_ref,r.status,r.valid_from,r.valid_to,r.evidence_refs_json,r.decision_revision_id
      FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
      WHERE r.kind=?1 AND r.from_ref IN(?2,'account:'||?2) AND r.rowid<=?3
       AND NOT EXISTS(SELECT 1 FROM entity_relations n WHERE n.kind=r.kind AND n.from_ref IN(?2,'account:'||?2)
        AND n.to_ref=r.to_ref AND n.rowid>r.rowid AND n.rowid<=?3)
      ORDER BY r.rowid DESC LIMIT 51`;
