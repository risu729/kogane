// The account connection reviews (migration 0023, docs/account-connections.md):
// the inventory the identity page lists, and the connection each account row
// of the identity and organization reads shows. Moved here from
// `services/app/src/account-connections.ts` (ADR 0081 point 2), so the screens
// and `kogane.identity.read` read the reviews through one function and no
// adapter holds this SQL.
import type { AccountConnection } from "../../../observation-shared/src/account-connection-contract.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
export type { AccountConnection };
const REVIEWS_SQL =
  "SELECT * FROM current_account_connection_reviews ORDER BY producer_id,connection_key LIMIT 65";
interface ReviewRow {
  producer_id: string;
  connection_key: string;
  label: string;
  status: "confirmed" | "unresolved";
  related_source_id: string | null;
  direct_producer_id: string | null;
  reason: string;
  detail_artifact_id: number;
  direct_artifact_id: number | null;
  branch_artifact_id: number | null;
  direct_reference_ids_json: string;
  evidence_eligible: number;
  revision: number;
}
export function connectionReferenceSet(json: string): Set<string> {
  if (json.length > 26001) throw new Error("connection_direct_reference_limit");
  let values: unknown;
  try {
    values = JSON.parse(json);
  } catch {
    throw new Error("connection_direct_reference_invalid");
  }
  if (
    !Array.isArray(values) ||
    values.length > 100 ||
    values.some((v) => typeof v !== "string" || v.length < 1 || v.length > 256) ||
    new Set(values).size !== values.length
  )
    throw new Error("connection_direct_reference_invalid");
  return new Set(values as string[]);
}
function presentation(row: ReviewRow): AccountConnection {
  return {
    label: row.label,
    status: row.evidence_eligible ? row.status : "evidence-ineligible",
    relation: row.status === "confirmed" ? "same-provider-connection" : "candidate",
    relatedSource: row.related_source_id,
    reason: row.evidence_eligible
      ? row.reason
      : "対応根拠の原本が現在の集計対象外です。過去の確認記録のみを表示しています。",
    leafBinding: "unresolved",
    evidenceArtifactIds: [
      row.detail_artifact_id,
      row.direct_artifact_id,
      row.branch_artifact_id,
    ].filter((id): id is number => id !== null),
    revision: row.revision,
  };
}
/** Every current review; more than the inventory bound is refused, not cut. */
async function reviews(sql: SqlExecutor): Promise<ReviewRow[]> {
  const rows = await sql.all<ReviewRow>(REVIEWS_SQL, []);
  if (rows.length > 64) throw new Error("connection_inventory_limit");
  return rows;
}
/** Invoke only behind the existing Access gate. No raw identifiers are returned. */
export async function listAccountConnections(sql: SqlExecutor): Promise<AccountConnection[]> {
  const rows = await reviews(sql);
  return rows.map((row) => {
    connectionReferenceSet(row.direct_reference_ids_json);
    return presentation(row);
  });
}
/** Exact reference IDs determine which direct accounts a retained proof covers. */
export async function readAccountConnections(
  sql: SqlExecutor,
  refs: readonly { referenceId: string; source: string; producer: string; sourceAccount: string }[],
): Promise<Map<string, AccountConnection>> {
  if (refs.length > 5501) throw new Error("connection_reference_limit");
  const parsed = (await reviews(sql)).map((row) => ({
    ...row,
    directReferences: connectionReferenceSet(row.direct_reference_ids_json),
  }));
  const result = new Map<string, AccountConnection>();
  for (const ref of refs) {
    const matches = parsed.filter(
      (row) =>
        (ref.source === "moneyforward-me" &&
          ref.producer === row.producer_id &&
          ref.sourceAccount === `moneyforward-me:${row.connection_key}`) ||
        (row.status === "confirmed" &&
          ref.source === row.related_source_id &&
          ref.producer === row.direct_producer_id &&
          row.directReferences.has(ref.referenceId)),
    );
    if (matches.length === 1) result.set(ref.referenceId, presentation(matches[0]!));
    if (matches.length > 1)
      result.set(ref.referenceId, {
        label: "取得経路間の対応を要確認",
        status: "unresolved",
        relation: "candidate",
        relatedSource: null,
        reason: "複数の連携が同じ取得元の参照に対応しています。個別口座の対応は確定していません。",
        leafBinding: "unresolved",
        evidenceArtifactIds: [
          ...new Set(matches.flatMap((row) => presentation(row).evidenceArtifactIds)),
        ],
        revision: Math.max(...matches.map((row) => row.revision)),
      });
  }
  return result;
}

/** A reviewed provider name describes an MF connection, never a leaf account. */
export function connectionAccountLabel(
  currentLabel: string,
  method: "rule" | "manual",
  source: string,
  connection: AccountConnection | undefined,
): string {
  return source === "moneyforward-me" &&
    method !== "manual" &&
    connection &&
    connection.status !== "evidence-ineligible"
    ? `${connection.label}（個別口座未確定）`
    : currentLabel;
}

/** The source whose references a connection review can label (`connectionAccountLabel`). */
const AGGREGATOR_SOURCE = "moneyforward-me";
/** Aggregator source accounts one entity-label read may return (the candidate read's bound). */
const ENTITY_REFERENCE_BOUND = 1_000;
/**
 * Every aggregator source account with its current mapping: one keyed range of
 * `UNIQUE(source_id,producer_id,reference_json)` and, per row, the mapping by
 * `UNIQUE(source_account_id,revision)`. One row past the bound is read, so a
 * larger store is refused, never cut (ADR 0077 amendment 2026-11-19).
 */
export const ENTITY_AGGREGATOR_REFERENCES_SQL = `SELECT s.id AS referenceId,s.producer_id AS producer,
 json_extract(s.reference_json,'$[0]') AS sourceAccount,m.account_id AS targetId,m.method
FROM source_accounts s
JOIN account_mappings m ON m.source_account_id=s.id
 AND m.revision=(SELECT max(n.revision) FROM account_mappings n WHERE n.source_account_id=s.id)
WHERE s.source_id='${AGGREGATOR_SOURCE}' ORDER BY s.id LIMIT ${String(ENTITY_REFERENCE_BOUND + 1)}`;

/** The connection label one entity shows, with the connection that names it. */
export interface EntityConnectionLabel {
  label: string;
  connection: AccountConnection;
}

/**
 * The entity label rule (ADR 0077 amendment 2026-11-19): an account entity
 * any of whose automatic aggregator references carries an eligible
 * connection label shows that label, with its `（個別口座未確定）` suffix,
 * whichever of its references a row was read through. A collector-era
 * reference of a MoneyForward identity shares its entity with the
 * importer-era reference the connection review was recorded under (reviews
 * are keyed by producer), so both read the reviewed label. Two different
 * labels on one entity name no label (`null`): each reference keeps its own.
 * A manual mapping is never relabelled.
 */
export async function readEntityConnectionLabels(
  sql: SqlExecutor,
  targetIds: ReadonlySet<string>,
): Promise<Map<string, EntityConnectionLabel | null>> {
  const result = new Map<string, EntityConnectionLabel | null>();
  if (targetIds.size === 0) return result;
  const rows = await sql.all<{
    referenceId: string;
    producer: string;
    sourceAccount: string;
    targetId: string;
    method: "rule" | "manual";
  }>(ENTITY_AGGREGATOR_REFERENCES_SQL, []);
  if (rows.length > ENTITY_REFERENCE_BOUND) throw new Error("connection_reference_limit");
  const refs = rows.filter((row) => row.method !== "manual" && targetIds.has(row.targetId));
  if (refs.length === 0) return result;
  const connections = await readAccountConnections(
    sql,
    refs.map((row) => ({
      referenceId: row.referenceId,
      source: AGGREGATOR_SOURCE,
      producer: row.producer,
      sourceAccount: row.sourceAccount,
    })),
  );
  const labels = new Map<string, Map<string, AccountConnection>>();
  for (const row of refs) {
    const connection = connections.get(row.referenceId);
    if (!connection || connection.status === "evidence-ineligible") continue;
    const label = connectionAccountLabel("", "rule", AGGREGATOR_SOURCE, connection);
    const entity = labels.get(row.targetId) ?? new Map<string, AccountConnection>();
    if (!entity.has(label)) entity.set(label, connection);
    labels.set(row.targetId, entity);
  }
  for (const [targetId, entity] of labels) {
    const [only] = [...entity];
    result.set(targetId, entity.size === 1 ? { label: only![0], connection: only![1] } : null);
  }
  return result;
}

/** One organized reference whose display label is decided here. */
export interface LabelledReference {
  referenceId: string;
  targetId: string;
  source: string;
  producer: string;
  sourceAccount: string;
  method: "rule" | "manual";
}

/** What may decorate a reference's label: its own reviewed connection, and its entity's label. */
export interface AccountLabelDecoration {
  own?: AccountConnection;
  entity?: EntityConnectionLabel;
}

/** A reference's display label and the connection it shows, if any. */
export interface OrganizedAccountLabel {
  label: string;
  connection?: AccountConnection;
}

/**
 * The decorations of each reference, the one read the organization of
 * observation rows, the identity pages and the filter options share: the
 * reference's own reviewed connection, and the entity label of every entity
 * one of the given automatic aggregator references names. Display only: no
 * mapping, row or total moves.
 */
export async function readAccountLabelDecorations(
  sql: SqlExecutor,
  refs: readonly LabelledReference[],
): Promise<Map<string, AccountLabelDecoration>> {
  const own = await readAccountConnections(sql, refs);
  const targets = new Set(
    refs
      .filter((ref) => ref.method !== "manual" && ref.source === AGGREGATOR_SOURCE)
      .map((ref) => ref.targetId),
  );
  const entities = await readEntityConnectionLabels(sql, targets);
  const result = new Map<string, AccountLabelDecoration>();
  for (const ref of refs) {
    const connection = own.get(ref.referenceId);
    const entity = entities.get(ref.targetId) ?? undefined;
    if (connection || entity)
      result.set(ref.referenceId, {
        ...(connection ? { own: connection } : {}),
        ...(entity ? { entity } : {}),
      });
  }
  return result;
}

/**
 * The label one row of a reference shows: a manual mapping's own label; else
 * its entity's connection label (the entity label rule); else its own
 * connection's (`connectionAccountLabel`); else its mapping label. The
 * connection shown is the one that named the label, or the reference's own.
 */
export function decoratedAccountLabel(
  label: string,
  method: "rule" | "manual",
  source: string,
  decoration: AccountLabelDecoration | undefined,
): OrganizedAccountLabel {
  if (method !== "manual" && decoration?.entity)
    return { label: decoration.entity.label, connection: decoration.entity.connection };
  const own = decoration?.own;
  return {
    label: connectionAccountLabel(label, method, source, own),
    ...(own ? { connection: own } : {}),
  };
}
