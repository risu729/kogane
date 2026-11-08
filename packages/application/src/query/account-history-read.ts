// The append-only correction history of one source account, graded by the
// reader's grant (ADR 0077, amendment 2026-11-08). One source account per
// request; all entries or a refusal, never truncation. The page
// (`口座の対応候補`), `GET /api/identity/account-history` and
// `kogane.accounts.history` all call this function.
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import {
  ACCOUNT_HISTORY_COUNT_SQL,
  readAccountHistory,
  type AccountHistoryRow,
} from "../../../read-model/src/account-history.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";
import { ACCOUNT_SOURCE_ACCOUNT_ID } from "./account-candidates.ts";

export type AccountHistoryEntry = AccountHistoryRow;

export interface AccountHistoryRead {
  schemaVersion: "kogane-account-history-v1";
  sourceAccountId: string;
  total: number;
  /** Oldest first. Nothing in it is ever rewritten: a correction is a later entry. */
  entries: AccountHistoryEntry[];
}
export type AccountHistoryOutcome =
  | { ok: true; history: AccountHistoryRead }
  | { ok: false; error: FinancialError };

const REQUEST_ID = "accounts.history";

export async function readAccountHistoryForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  sourceAccountId: unknown;
}): Promise<AccountHistoryOutcome> {
  const { grant, sql, sourceAccountId } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): AccountHistoryOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (typeof sourceAccountId !== "string" || !ACCOUNT_SOURCE_ACCOUNT_ID.test(sourceAccountId))
    return fail("invalid_query", ["sourceAccountId"]);
  if (
    !(await sql.first<{ found: number }>("SELECT 1 AS found FROM source_accounts WHERE id=?1", [
      sourceAccountId,
    ]))
  )
    return fail("evidence_restricted", ["sourceAccountId"]);
  const budget = [`budget:maxRows=${String(grant.budget.maxRows)}`];
  const total = (await sql.first<{ n: number }>(ACCOUNT_HISTORY_COUNT_SQL, [sourceAccountId]))!.n;
  if (total > grant.budget.maxRows) return fail("budget_exceeded", budget);
  const entries = await readAccountHistory(sql, sourceAccountId);
  // A concurrent append between count and read is not returned over budget.
  if (entries.length > grant.budget.maxRows) return fail("budget_exceeded", budget);
  return {
    ok: true,
    history: {
      schemaVersion: "kogane-account-history-v1",
      sourceAccountId,
      total: entries.length,
      entries,
    },
  };
}
