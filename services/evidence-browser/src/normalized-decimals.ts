import {
  validNormalizedDecimal,
  type NormalizedDecimal,
} from "../../../poc/observation-pipeline/shared/normalized-decimal";
import { DEFAULT_DECIMAL_POLICY } from "./decimal-policy";
type Kind = "balance" | "transaction" | "position" | "valuation";
/**
 * Read only the already-authorized page's persisted normalization, never
 * reparsing in the UI/API. `policyVersion` selects the projection; callers
 * resolve it through `decimalPolicySelection`, which refuses a name with no
 * projection instead of quietly serving another policy's rows.
 */
export async function decimalRows<T extends { id: number }>(
  db: D1Database,
  kind: Kind,
  rows: readonly T[],
  policyVersion: string = DEFAULT_DECIMAL_POLICY,
): Promise<Array<T & { normalized: NormalizedDecimal }>> {
  if (rows.length > 5000) throw new Error("decimal_row_budget");
  const found = new Map<number, NormalizedDecimal>();
  for (let offset = 0; offset < rows.length; offset += 80) {
    const ids = rows.slice(offset, offset + 80).map((row) => row.id);
    const result = await db
      .prepare(
        `SELECT observation_id,policy_version AS policyVersion,status,coefficient,scale,basis FROM observation_decimal_values WHERE kind=? AND policy_version=? AND observation_id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(kind, policyVersion, ...ids)
      .all<NormalizedDecimal & { observation_id: number }>();
    for (const row of result.results) {
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
