// The existing append-only instrument history, graded by the reader's grant.
// One identifier per request; all entries or a refusal, never truncation.
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";
import { INSTRUMENT_IDENTIFIER_ID } from "./instrument-candidates-review.ts";
import { queryInstrumentHistory, type HistoryEntry } from "./instrument-resolution.ts";

export interface InstrumentHistoryRead {
  schemaVersion: "kogane-instrument-history-v1";
  identifierId: string;
  total: number;
  entries: HistoryEntry[];
}
export type InstrumentHistoryOutcome =
  | { ok: true; history: InstrumentHistoryRead }
  | { ok: false; error: FinancialError };

// Every branch of INSTRUMENT_HISTORY_SQL, counted through the same indexed
// keys before loading text. The relation join is retained, so the count is
// exactly the rows that the shipped history read returns.
export const INSTRUMENT_HISTORY_COUNT_SQL = `SELECT
 (SELECT count(*) FROM instrument_mappings WHERE identifier_id=?1) +
 (SELECT count(*) FROM decision_revisions WHERE subject_kind='instrument_mapping' AND subject_ref=?1) +
 (SELECT count(*) FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id
  WHERE r.kind='listed_as' AND r.to_ref='identifier:'||?1) AS n`;

export async function readInstrumentHistoryForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  identifierId: unknown;
}): Promise<InstrumentHistoryOutcome> {
  const { grant, sql, identifierId } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): InstrumentHistoryOutcome => ({
    ok: false,
    error: financialError(code, "instruments.history", refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  if (typeof identifierId !== "string" || !INSTRUMENT_IDENTIFIER_ID.test(identifierId))
    return fail("invalid_query", ["identifierId"]);
  if (
    !(await sql.first<{ found: number }>(
      "SELECT 1 AS found FROM instrument_identifiers WHERE id=?1",
      [identifierId],
    ))
  )
    return fail("evidence_restricted", ["identifierId"]);
  const total = (await sql.first<{ n: number }>(INSTRUMENT_HISTORY_COUNT_SQL, [identifierId]))!.n;
  if (total > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);
  const [history] = await queryInstrumentHistory(sql, [identifierId]);
  // A concurrent append between count and read is not returned over budget.
  if (history!.entries.length > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);
  return {
    ok: true,
    history: {
      schemaVersion: "kogane-instrument-history-v1",
      identifierId,
      total: history!.entries.length,
      entries: history!.entries,
    },
  };
}
