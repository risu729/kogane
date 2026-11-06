// The balance projection's relation read exactly as it shipped before ADR
// 0001's amendment of 2026-11-06 (`RELATION_SQL` in
// services/processor/src/balance-projection-job.ts at commit 893cb8af, with
// `RELATION_ROW_BOUND` = 5000), frozen as text so
// balance-projection-relations.test.ts can prove the current read returns the
// same rows wherever no later decision supersedes an earlier one. The digest
// below pins the text: never edit it by hand, and never import it outside
// tests.

/** SHA-256 of `LEGACY_PROJECTION_RELATIONS_SQL`. */
export const LEGACY_PROJECTION_RELATIONS_SQL_SHA256 =
  "88d587c59028f740db18801bbd8dae9e53faa007b9962fcf95ffc6b5d2359811";

/** The shipped text; one row over its 5,000-row bound. */
export const LEGACY_PROJECTION_RELATIONS_SQL = `SELECT id, kind, from_ref, to_ref, status, decision_revision_id
  FROM entity_relations
  WHERE kind IN ('same_account','connection_contains','account_has_pocket','statement_covers')
  ORDER BY id LIMIT 5001`;
