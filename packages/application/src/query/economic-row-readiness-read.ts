// Grant boundary for the existing coherent S0 diagnostic. No SQL or writer here.
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import { validEconomicRowReadinessRequest } from "../../../domain/src/economic-row-readiness.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";
import { queryEconomicRowReadiness } from "./economic-row-readiness.ts";

type Diagnostic = Awaited<ReturnType<typeof queryEconomicRowReadiness>>;
export type EconomicRowReadinessReadOutcome =
  | Exclude<Diagnostic, { status: "refused" }>
  | { status: "refused"; error: FinancialError };

export async function readEconomicRowReadinessForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<EconomicRowReadinessReadOutcome> {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): EconomicRowReadinessReadOutcome => ({
    status: "refused",
    error: financialError(code, "economic-readiness.read", refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  // Ownership and live holders can cross the requested row's source/account.
  // Reject narrower grants before any read, even a schema/existence probe.
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length) return fail("evidence_restricted", narrowed);
  if (!validEconomicRowReadinessRequest(request)) return fail("invalid_query", ["request"]);
  if (request.rows.length > Math.min(64, grant.budget.maxRows))
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);
  try {
    const result = await queryEconomicRowReadiness(sql, request);
    return result.status === "refused" ? fail("invalid_query", ["request"]) : result;
  } catch {
    // Includes malformed stored pins; neither data nor exception text escapes.
    return { status: "unavailable", reason: "readiness_store_unavailable" };
  }
}
