import type { AccountConnection } from "../../../packages/observation-shared/src/account-connection-contract";
export type { AccountConnection };
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
/** Invoke only behind the existing Access gate. No raw identifiers are returned. */
export async function listAccountConnections(db: D1Database): Promise<AccountConnection[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM current_account_connection_reviews ORDER BY producer_id,connection_key LIMIT 65",
    )
    .all<ReviewRow>();
  if (rows.results.length > 64) throw new Error("connection_inventory_limit");
  return rows.results.map((row) => {
    connectionReferenceSet(row.direct_reference_ids_json);
    return presentation(row);
  });
}
/** Exact reference IDs determine which direct accounts a retained proof covers. */
export async function readAccountConnections(
  db: D1Database,
  refs: { referenceId: string; source: string; producer: string; sourceAccount: string }[],
): Promise<Map<string, AccountConnection>> {
  if (refs.length > 5501) throw new Error("connection_reference_limit");
  const rows = await db
    .prepare(
      "SELECT * FROM current_account_connection_reviews ORDER BY producer_id,connection_key LIMIT 65",
    )
    .all<ReviewRow>();
  if (rows.results.length > 64) throw new Error("connection_inventory_limit");
  const parsed = rows.results.map((row) => ({
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
