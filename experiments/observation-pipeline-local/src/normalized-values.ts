import type { Store } from "./store.ts";
import { validNormalizedDecimal } from "../shared/normalized-decimal.ts";
export function localDecimalRows<T extends { id: number }>(store: Store, kind: string, rows: T[]) {
  const query = store.db.query(
    "SELECT policy_version AS policyVersion,status,coefficient,scale,basis FROM observation_decimal_values WHERE kind=? AND observation_id=? AND policy_version='decimal-v1'",
  );
  return rows.map((row) => {
    const normalized = query.get(kind, row.id);
    if (!validNormalizedDecimal(normalized)) throw new Error("missing_or_invalid_db_decimal");
    return { ...row, normalized };
  });
}
