// A provider statement total from `card_statement_facts` (migration 0044) as
// a reader shows it: always a quantity, with the reasons `queryCardPurchases`
// gives the same view's total (`providerTotal`). Shared by each card's debit
// account (card-debit-accounts.ts) and the statements without a candidate
// (card-statements-unmatched.ts), so the two answer one total alike (INV05).
import { absentQuantity, type Quantity } from "../../../domain/src/values.ts";
import {
  sweepRowAmount,
  type CardSettlementSweepRow,
} from "../../../read-model/src/card-settlement-bank-debits.ts";

/**
 * A statement row. `value_status` is null when `card_statement_facts` found
 * no decimal-v1 value for the observation (its join is a LEFT JOIN).
 */
export type StatementTotalRow = Omit<CardSettlementSweepRow, "value_status"> & {
  value_status: string | null;
};

/**
 * The statement's total as the provider stated it: exact, else its stored
 * status with `stored:<status>`, else `missing` with `decimal_not_projected`
 * when no decimal-v1 value was recorded. Null only for a row CORE 0024's
 * CHECK never stores (an `exact` status without its two columns, or a status
 * outside decimal-v1): the caller fails the read with its own code rather
 * than answer it.
 */
export function statementTotal(row: StatementTotalRow): Quantity | null {
  const status = row.value_status;
  if (status === "exact") return sweepRowAmount({ ...row, value_status: status });
  if (status === "missing" || status === "unparsed" || status === "conflict")
    return absentQuantity(row.unit_ref, status, `stored:${status}`);
  if (status === null) return absentQuantity(row.unit_ref, "missing", "decimal_not_projected");
  return null;
}
