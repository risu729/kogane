// The account candidates' relation read exactly as it shipped before ADR
// 0077's amendment of 2026-11-08 (`ACCOUNT_RELATIONS_SQL` in
// packages/read-model/src/account-candidates.ts at commit 9697a011, with
// `ACCOUNT_RELATION_ROW_BOUND` = 10000), frozen as text so
// account-relations-current.test.ts can prove the current read returns the
// same rows wherever no proposal was recorded after a decision of the pair.
// The digest below pins the text: never edit it by hand, and never import it
// outside tests.

/** SHA-256 of `LEGACY_ACCOUNT_RELATIONS_SQL`. */
export const LEGACY_ACCOUNT_RELATIONS_SQL_SHA256 =
  "cfa1c4d55525386e7220dd1703d9b246e27eeb74b97ce799b500e27a92b848b6";

export const LEGACY_ACCOUNT_RELATIONS_SQL = `SELECT kind,fromRef,toRef,status,createdAt,id FROM (
 SELECT r.kind,r.from_ref AS fromRef,r.to_ref AS toRef,r.status,r.created_at AS createdAt,r.id,
  row_number() OVER (PARTITION BY r.kind,r.from_ref,r.to_ref ORDER BY r.created_at DESC,r.id DESC) AS rank
 FROM entity_relations r
 WHERE (r.kind='connection_contains' AND r.from_ref>='connection:' AND r.from_ref<'connection;'
   AND r.to_ref>='source_account:' AND r.to_ref<'source_account;')
  OR (r.kind='same_account' AND r.from_ref>='source_account:' AND r.from_ref<'source_account;'
   AND r.to_ref>='source_account:' AND r.to_ref<'source_account;')
) WHERE rank=1 ORDER BY kind,fromRef,toRef LIMIT 10001`;
