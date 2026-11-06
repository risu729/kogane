// The reads behind the account correspondence candidates (ADR 0077,
// docs/identity.md). Four bounded reads, none of which writes:
//
// - `ACCOUNT_CONNECTION_REVIEWS_SQL`: the current connection reviews with the
//   view's own evidence recheck (`current_account_connection_reviews`, CORE
//   0023), in the order and with the 64-row bound the browser's connection
//   reader already uses; one row past the bound is read so a larger table is
//   refused, never cut.
// - `AGGREGATOR_SOURCE_ACCOUNTS_SQL`: every `moneyforward-me` source account
//   of any producer, through the `UNIQUE(source_id,producer_id,
//   reference_json)` index.
// - `ACCOUNT_RELATIONS_SQL`: the newest `connection_contains` relation from a
//   `connection:` reference to a `source_account:` reference, and the newest
//   `same_account` relation between two `source_account:` references, per
//   pair of references, ordered as the change lifecycle orders a relation's
//   history (`created_at` then `id`, newest first). Each kind is one keyed
//   range of a `(kind, ref)` index (`entity_relations_from` or `_to`).
// - `ACCOUNT_SOURCE_FACTS_SQL`: the named source accounts and each one's
//   current mapping, by primary key and the `UNIQUE(source_account_id,
//   revision)` index.
import type { SqlExecutor } from "./reader.ts";

/** One row past the domain bound (64), so a larger table is refused. */
export const ACCOUNT_CONNECTION_REVIEWS_SQL = `SELECT producer_id AS producerId,
 connection_key AS connectionKey,revision,label,status,related_source_id AS relatedSourceId,
 direct_producer_id AS directProducerId,detail_artifact_id AS detailArtifactId,
 direct_artifact_id AS directArtifactId,branch_artifact_id AS branchArtifactId,
 direct_reference_ids_json AS directReferenceIdsJson,evidence_eligible AS evidenceEligible
FROM current_account_connection_reviews ORDER BY producer_id,connection_key LIMIT 65`;

export interface AccountConnectionReviewRow {
  producerId: string;
  connectionKey: string;
  revision: number;
  label: string;
  status: "confirmed" | "unresolved";
  relatedSourceId: string | null;
  directProducerId: string | null;
  detailArtifactId: number;
  directArtifactId: number | null;
  branchArtifactId: number | null;
  directReferenceIdsJson: string;
  evidenceEligible: number;
}

/** Aggregator source accounts one read may return before it is refused (domain bound 1,000). */
const AGGREGATOR_SOURCE_ACCOUNT_ROW_BOUND = 1_000;
export const AGGREGATOR_SOURCE_ACCOUNTS_SQL = `SELECT id AS sourceAccountId,producer_id AS producerId,
 reference_json AS referenceJson
FROM source_accounts WHERE source_id='moneyforward-me'
ORDER BY id LIMIT ${String(AGGREGATOR_SOURCE_ACCOUNT_ROW_BOUND + 1)}`;

export interface AggregatorSourceAccountRow {
  sourceAccountId: string;
  producerId: string;
  referenceJson: string;
}

/** Newest relation rows one read may return before it is refused (domain bound 10,000). */
const ACCOUNT_RELATION_ROW_BOUND = 10_000;
export const ACCOUNT_RELATIONS_SQL = `SELECT kind,fromRef,toRef,status FROM (
 SELECT r.kind,r.from_ref AS fromRef,r.to_ref AS toRef,r.status,
  row_number() OVER (PARTITION BY r.kind,r.from_ref,r.to_ref ORDER BY r.created_at DESC,r.id DESC) AS rank
 FROM entity_relations r
 WHERE (r.kind='connection_contains' AND r.from_ref>='connection:' AND r.from_ref<'connection;'
   AND r.to_ref>='source_account:' AND r.to_ref<'source_account;')
  OR (r.kind='same_account' AND r.from_ref>='source_account:' AND r.from_ref<'source_account;'
   AND r.to_ref>='source_account:' AND r.to_ref<'source_account;')
) WHERE rank=1 ORDER BY kind,fromRef,toRef LIMIT ${String(ACCOUNT_RELATION_ROW_BOUND + 1)}`;

export interface AccountRelationRow {
  kind: "connection_contains" | "same_account";
  fromRef: string;
  toRef: string;
  status: "proposed" | "accepted" | "rejected" | "released";
}

/** ?1 a JSON array of source account ids; one row per id that exists. */
export const ACCOUNT_SOURCE_FACTS_SQL = `SELECT s.id AS sourceAccountId,s.source_id AS sourceId,
 s.producer_id AS producerId,m.account_id AS accountId,m.label,m.status,m.method,
 m.revision AS mappingRevision
FROM json_each(?1) j
JOIN source_accounts s ON s.id=j.value
LEFT JOIN account_mappings m ON m.source_account_id=s.id
 AND m.revision=(SELECT max(n.revision) FROM account_mappings n WHERE n.source_account_id=s.id)
ORDER BY s.id`;

export interface AccountSourceFactsRow {
  sourceAccountId: string;
  sourceId: string;
  producerId: string;
  /** The current mapping's target, or null when the reference has no mapping. */
  accountId: string | null;
  label: string | null;
  status: string | null;
  method: string | null;
  mappingRevision: number | null;
}

export async function readAccountConnectionReviews(
  sql: SqlExecutor,
): Promise<AccountConnectionReviewRow[]> {
  return sql.all<AccountConnectionReviewRow>(ACCOUNT_CONNECTION_REVIEWS_SQL, []);
}

export async function readAggregatorSourceAccounts(
  sql: SqlExecutor,
): Promise<AggregatorSourceAccountRow[]> {
  return sql.all<AggregatorSourceAccountRow>(AGGREGATOR_SOURCE_ACCOUNTS_SQL, []);
}

export async function readAccountRelations(sql: SqlExecutor): Promise<AccountRelationRow[]> {
  return sql.all<AccountRelationRow>(ACCOUNT_RELATIONS_SQL, []);
}

export async function readAccountSourceFacts(
  sql: SqlExecutor,
  sourceAccountIds: readonly string[],
): Promise<AccountSourceFactsRow[]> {
  if (sourceAccountIds.length === 0) return [];
  return sql.all<AccountSourceFactsRow>(ACCOUNT_SOURCE_FACTS_SQL, [
    JSON.stringify(sourceAccountIds),
  ]);
}
