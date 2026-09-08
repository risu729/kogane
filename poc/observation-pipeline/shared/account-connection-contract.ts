/** A connection groups provider views. It never establishes leaf-account equivalence. */
export interface AccountConnection {
  label: string;
  status: "confirmed" | "unresolved" | "evidence-ineligible";
  relation: "same-provider-connection" | "candidate";
  relatedSource: string | null;
  reason: string;
  leafBinding: "unresolved";
  evidenceArtifactIds: number[];
  revision: number;
}

export function validAccountConnection(value: unknown): value is AccountConnection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.label === "string" &&
    typeof row.reason === "string" &&
    typeof row.status === "string" &&
    ["confirmed", "unresolved", "evidence-ineligible"].includes(row.status) &&
    typeof row.relation === "string" &&
    ["same-provider-connection", "candidate"].includes(row.relation) &&
    (row.status !== "confirmed" || row.relation === "same-provider-connection") &&
    (row.status !== "unresolved" || row.relation === "candidate") &&
    (row.relatedSource === null || typeof row.relatedSource === "string") &&
    row.leafBinding === "unresolved" &&
    Number.isSafeInteger(row.revision) &&
    Number(row.revision) > 0 &&
    Array.isArray(row.evidenceArtifactIds) &&
    row.evidenceArtifactIds.length > 0 &&
    row.evidenceArtifactIds.length <= 192 &&
    row.evidenceArtifactIds.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}
