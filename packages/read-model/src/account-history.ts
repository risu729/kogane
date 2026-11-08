// The correction history of one source account (ADR 0077, amendment
// 2026-11-08; docs/identity.md). One read and its count, neither of which
// writes:
//
// - `ACCOUNT_HISTORY_SQL`: every revision of the source account's mapping
//   (`account_mappings`, rule or manual), every decision about that mapping
//   (`decision_revisions` of subject `account_mapping`: assignments and
//   override releases), and every relation row of any kind whose `from_ref` or
//   `to_ref` is the source account (`connection_contains` acceptances and
//   withdrawals of an aggregator connection, `same_account` decisions), each
//   with the decision that wrote it, oldest first. Nothing is collapsed: a
//   correction is a later entry, never an edit.
// - `ACCOUNT_HISTORY_COUNT_SQL`: the same rows counted through the same keys,
//   so the service refuses a history over its budget before loading any text.
//
// Cost: each branch is keyed. Mappings by `UNIQUE(source_account_id,
// revision)`, mapping decisions by `decision_revisions_subject`, and relations
// by `entity_relations_from` and `entity_relations_to` with one probe per
// relation kind (the kind leads both indexes), each joined to its decision by
// primary key. The cost is linear in the account's own history and does not
// grow with the rest of the store.
import { RELATION_KINDS } from "../../domain/src/decisions.ts";
import type { DecisionOrigin } from "../../domain/src/decision-origin.ts";
import { decisionOriginSql, mappingDecisionOriginSql } from "./decision-origin.ts";
import type { SqlExecutor } from "./reader.ts";

const KINDS = RELATION_KINDS.map((kind) => `'${kind}'`).join(",");

/** ?1 the source account id. */
export const ACCOUNT_HISTORY_SQL = `SELECT 'mapping' AS entry,m.revision,m.created_at AS createdAt,
 m.method,NULL AS decisionKind,m.reason,m.account_id AS accountId,m.status,m.label,
 m.policy_version AS policyVersion,m.id AS recordId,NULL AS supersededBy,NULL AS relationKind,
 NULL AS relationStatus,NULL AS fromRef,NULL AS toRef,
 ${mappingDecisionOriginSql("account_mapping", "m.source_account_id", "m.revision", "m.method")} AS decisionOrigin
FROM account_mappings m WHERE m.source_account_id=?1
UNION ALL
SELECT 'decision',d.revision,d.created_at,d.method,d.decision_kind,d.reason,NULL,NULL,NULL,NULL,
 d.id,d.superseded_by,NULL,NULL,NULL,NULL,${decisionOriginSql("d")}
FROM decision_revisions d WHERE d.subject_kind='account_mapping' AND d.subject_ref=?1
UNION ALL
SELECT 'relation',d.revision,r.created_at,d.method,d.decision_kind,d.reason,NULL,NULL,NULL,NULL,
 r.id,NULL,r.kind,r.status,r.from_ref,r.to_ref,${decisionOriginSql("d")}
FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id
WHERE r.kind IN (${KINDS}) AND r.from_ref='source_account:'||?1
UNION ALL
SELECT 'relation',d.revision,r.created_at,d.method,d.decision_kind,d.reason,NULL,NULL,NULL,NULL,
 r.id,NULL,r.kind,r.status,r.from_ref,r.to_ref,${decisionOriginSql("d")}
FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id
WHERE r.kind IN (${KINDS}) AND r.to_ref='source_account:'||?1
ORDER BY createdAt,entry,revision,recordId`;

/**
 * Every branch of `ACCOUNT_HISTORY_SQL`, counted through the same keys before
 * any text is loaded. The decision join is kept, so the count is exactly the
 * rows the history read returns. A relation cannot name the account on both
 * sides (`to_ref<>from_ref`), so the two relation branches never overlap.
 */
export const ACCOUNT_HISTORY_COUNT_SQL = `SELECT
 (SELECT count(*) FROM account_mappings WHERE source_account_id=?1) +
 (SELECT count(*) FROM decision_revisions WHERE subject_kind='account_mapping' AND subject_ref=?1) +
 (SELECT count(*) FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id
  WHERE r.kind IN (${KINDS}) AND r.from_ref='source_account:'||?1) +
 (SELECT count(*) FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id
  WHERE r.kind IN (${KINDS}) AND r.to_ref='source_account:'||?1) AS n`;

export interface AccountHistoryRow {
  entry: "mapping" | "decision" | "relation";
  revision: number;
  createdAt: string;
  method: string;
  /** Who made it, as a closed class; a raw actor id never leaves the read. */
  decisionOrigin: DecisionOrigin;
  decisionKind: string | null;
  reason: string;
  /** A mapping revision's target account. */
  accountId: string | null;
  status: string | null;
  label: string | null;
  policyVersion: number | null;
  recordId: string;
  supersededBy: string | null;
  relationKind: string | null;
  relationStatus: string | null;
  fromRef: string | null;
  toRef: string | null;
}

export async function readAccountHistory(
  sql: SqlExecutor,
  sourceAccountId: string,
): Promise<AccountHistoryRow[]> {
  return sql.all<AccountHistoryRow>(ACCOUNT_HISTORY_SQL, [sourceAccountId]);
}
