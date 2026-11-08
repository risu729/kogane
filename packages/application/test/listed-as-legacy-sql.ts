// The instrument candidates' `listed_as` read exactly as it shipped before
// ADR 0017's amendment of 2026-11-06 (`LISTED_AS_SQL` in
// packages/read-model/src/instrument-resolution.ts at commit 893cb8af, with
// `LISTED_AS_ROW_BOUND` = 10000), frozen as text so listed-as-current.test.ts
// can prove the current read returns the same rows wherever no proposal was
// recorded after a decision of the pair. The digest below pins the text:
// never edit it by hand, and never import it outside tests.

/** SHA-256 of `LEGACY_LISTED_AS_SQL`. */
export const LEGACY_LISTED_AS_SQL_SHA256 =
  "f5d0e0ce9e8050bfb8cc57e6567d7fd224af9e929604f716dae0d434e72e24f3";

export const LEGACY_LISTED_AS_SQL = `SELECT fromRef,toRef,status FROM (
 SELECT r.from_ref AS fromRef,r.to_ref AS toRef,r.status,
  row_number() OVER (PARTITION BY r.from_ref,r.to_ref ORDER BY r.created_at DESC,r.id DESC) AS rank
 FROM entity_relations r
 WHERE r.kind='listed_as' AND r.to_ref>='identifier:' AND r.to_ref<'identifier;'
  AND r.from_ref>='instrument:' AND r.from_ref<'instrument;'
) WHERE rank=1 ORDER BY fromRef,toRef LIMIT 10001`;
