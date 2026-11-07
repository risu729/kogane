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
  refs: { referenceId: string; source: string; producer: string; sourceAccount: string }[],
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
