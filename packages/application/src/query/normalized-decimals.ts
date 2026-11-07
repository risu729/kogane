// The persisted decimal normalization of an already-authorized page. Moved
// here from `services/app/src/normalized-decimals.ts` (ADR 0081 point 2) so
// the observation and balance routes and their MCP page reads share it.
import {
  validNormalizedDecimal,
  type NormalizedDecimal,
} from "../../../observation-shared/src/normalized-decimal";
import { DECIMAL_POLICY_RELEASE } from "../../../read-model/src/index";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
type Kind = "balance" | "transaction" | "position" | "valuation";
/**
 * Read only the already-authorized page's persisted normalization, never
 * reparsing in the UI/API. `policyVersion` selects the projection; callers
 * resolve it through `decimalPolicySelection`, which refuses a name with no
 * projection instead of quietly serving another policy's rows.
 */
export async function decimalRows<T extends { id: number }>(
  reads: SqlExecutor,
  kind: Kind,
  rows: readonly T[],
  policyVersion: string = DECIMAL_POLICY_RELEASE,
): Promise<Array<T & { normalized: NormalizedDecimal }>> {
  if (rows.length > 5000) throw new Error("decimal_row_budget");
  const found = new Map<number, NormalizedDecimal>();
  for (let offset = 0; offset < rows.length; offset += 80) {
    const ids = rows.slice(offset, offset + 80).map((row) => row.id);
    const result = await reads.all<NormalizedDecimal & { observation_id: number }>(
      `SELECT observation_id,policy_version AS policyVersion,status,coefficient,scale,basis FROM observation_decimal_values WHERE kind=? AND policy_version=? AND observation_id IN (${ids.map(() => "?").join(",")})`,
      [kind, policyVersion, ...ids],
    );
    for (const row of result) {
      const { observation_id, ...value } = row;
      if (!validNormalizedDecimal(value)) throw new Error("invalid_db_decimal");
      found.set(observation_id, value);
    }
  }
  return rows.map((row) => {
    const normalized = found.get(row.id);
    if (!normalized) throw new Error("missing_db_decimal");
    return { ...row, normalized };
  });
}
