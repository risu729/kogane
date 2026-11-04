// Synthetic persisted provenance only. No authentication/configuration or production data.
export const ORIGIN_CASES = [
  { actor: "mcp-client:synthetic-origin", verification: "server", origin: "delegated" },
  { actor: "synthetic-operator", verification: "server", origin: "operator" },
  { actor: "mcp-client:synthetic-legacy", verification: "legacy-unknown", origin: "legacy" },
  { actor: "mcp-client:synthetic-unrecorded", verification: null, origin: "unknown" },
  { actor: "mcp-client:", verification: "server", origin: "unknown" },
  {
    actor: "mcp-client:synthetic-mismatch",
    verification: "server",
    origin: "unknown",
    mismatch: true,
  },
  { actor: "synthetic-old", verification: null, origin: "legacy", method: "legacy-migration" },
] as const;
export function originDecisionFixture(
  kind: "instrument_mapping" | "account_mapping",
  referenceId: string,
  revision: number,
  index: number,
  key: string,
) {
  const scenario = ORIGIN_CASES[index % ORIGIN_CASES.length]!;
  const operationId = `origin-operation-${key}`;
  const decisionId = `origin-decision-${key}`;
  const writes: { sql: string; args: (string | number | null)[] }[] = [];
  if (scenario.verification !== null)
    writes.push({
      sql: "INSERT INTO decision_operations VALUES (?,?,?,'assign',?,'{}','2099-01-01')",
      args: [
        operationId,
        "mismatch" in scenario ? "synthetic-other" : scenario.actor,
        scenario.verification,
        "0".repeat(64),
      ],
    });
  writes.push({
    sql: `INSERT INTO decision_revisions
      (id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,
       reason,evidence_refs_json,previous_revision,superseded_by,created_at)
      VALUES (?,?,?,?,'assign',?,?,?,'synthetic origin fixture','[]',NULL,NULL,'2099-01-01')`,
    args: [
      decisionId,
      kind,
      referenceId,
      revision,
      "method" in scenario ? scenario.method : "manual",
      scenario.actor,
      scenario.verification === null ? null : operationId,
    ],
  });
  return { writes, origin: scenario.origin, decisionId, operationId, actor: scenario.actor };
}
