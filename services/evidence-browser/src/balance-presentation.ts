import type { BalanceRow } from "../../../poc/observation-pipeline/shared/api-contract";
import {
  classifyBalance,
  projectBalanceRows,
  type BalanceProjectionInput,
} from "../../../poc/observation-pipeline/shared/balance-semantics";

function input(row: BalanceRow): BalanceProjectionInput & { row: BalanceRow } {
  const organization = row.organization;
  const product =
    organization?.state === "organized" && organization.lineage === "current"
      ? (organization.product ?? null)
      : null;
  return {
    row,
    id: row.id,
    sourceId: row.source_id,
    parserName: row.parser.split("@")[0]!,
    metric: row.metric,
    sourceAccount: row.source_account,
    accountReference: organization?.account?.referenceId ?? null,
    accountTarget: organization?.account?.targetId ?? null,
    currency: row.instrument,
    amountMinor: row.amount_minor,
    amountText: row.amount_text,
    artifactId: product?.origin.artifactId ?? null,
    parseRunId: product?.origin.parseRunId ?? null,
    rawLocator: product?.origin.rawLocator ?? null,
    asOf: row.as_of,
    observedAt: row.observed_at,
    product,
  };
}

/** Called on the complete bounded candidate set, never a page fragment. */
export function presentLatestBalances(rows: readonly BalanceRow[], metric?: string): BalanceRow[] {
  if (rows.length > 5000) throw new Error("balance_presentation_budget");
  return projectBalanceRows(rows.map(input))
    .filter((group) => !metric || group.members.some((member) => member.metric === metric))
    .map((group) => ({
      ...group.representative.row,
      interpretation: {
        policyVersion: "balance-view-v1",
        semantic: classifyBalance(group.representative),
        evidence: group.members.map(({ id, metric }) => ({ id, metric })),
        duplicateCount: group.members.length - 1,
        conflict: group.conflict,
      },
    }));
}

/** Historical records remain individual observations, including superseded parses. */
export function describeBalanceRows<T extends BalanceRow>(rows: readonly T[]): T[] {
  return rows.map((row) => ({
    ...row,
    interpretation: {
      policyVersion: "balance-view-v1",
      semantic: classifyBalance(input(row)),
      evidence: [{ id: row.id, metric: row.metric }],
      duplicateCount: 0,
      conflict: false,
    },
  }));
}
