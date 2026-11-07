// The bank debits the card settlement sweep compares with one statement
// (services/processor/src/card-settlement-job.ts), shared with the review
// read of statements without a candidate
// (packages/application/src/query/card-statements-unmatched.ts), so the two
// read the same rows for the same due date.
import type { CardBankDebitFact, CardStatementFact } from "../../domain/src/card-settlement.ts";
import { exactQuantity, normalizeDecimal, type Quantity } from "../../domain/src/values.ts";
import { parseLocalDate } from "../../domain/src/time.ts";
import { cardSettlementOwnershipCtes } from "./card-settlement-ownership.ts";

/**
 * A row of `card_statement_facts` or `card_bank_debit_facts` with its owner, as
 * the sweep's statement page and `CARD_SETTLEMENT_BANK_DEBITS_SQL` return it.
 */
export interface CardSettlementSweepRow {
  id: number;
  parse_run_id: number;
  source_account: string;
  unit_ref: string;
  source_id: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  payment_date?: string | null;
  as_of: string | null;
  /** The bank adapter's civil debit date (`card_bank_debit_facts`, 0052). */
  debit_date?: string | null;
  period?: string | null;
  statement_key?: string;
  bank_key?: string;
  account_id: string | null;
  owner_ref: string | null;
  evidence_refs_json: string | null;
}

/** The row's exact amount, a debit as its positive magnitude; null when not exact. */
export function sweepRowAmount(row: CardSettlementSweepRow, debit = false): Quantity | null {
  if (row.value_status !== "exact" || row.coefficient === null || row.scale === null) return null;
  const coefficient = debit ? row.coefficient.replace(/^-/, "") : row.coefficient;
  return exactQuantity(row.unit_ref, normalizeDecimal(BigInt(coefficient), row.scale));
}

/** The ownership evidence refs the row's owner carries. */
export function sweepRowEvidence(row: CardSettlementSweepRow): string[] {
  const parsed: unknown = JSON.parse(row.evidence_refs_json ?? "[]");
  return Array.isArray(parsed)
    ? parsed.filter((ref): ref is string => typeof ref === "string")
    : [];
}

/** The statement fact the sweep compares, for a row whose total and due date it read. */
export function statementFactOf(
  statement: CardSettlementSweepRow,
  total: Quantity,
  paymentDate: string,
): CardStatementFact {
  return {
    ref: {
      kind: "balance",
      id: "balance:" + statement.id,
      revision: "parse_run:" + statement.parse_run_id,
    },
    sourceId: statement.source_id as "vpass" | "myjcb",
    sourceAccount: statement.source_account,
    accountId: statement.account_id ?? null,
    ownerRef: statement.owner_ref ?? null,
    amount: total,
    paymentDate: { kind: "local-date", value: paymentDate, zone: "Asia/Tokyo", basis: "provider" },
    period: statement.period ?? null,
  };
}

/** The bank debit fact the sweep compares, or null for a row without an exact amount or a valid date. */
export function bankDebitFactOf(bank: CardSettlementSweepRow): CardBankDebitFact | null {
  const debit = sweepRowAmount(bank, true);
  const bankDate = bank.debit_date ?? null;
  if (!debit || !bankDate || !parseLocalDate(bankDate)) return null;
  return {
    ref: {
      kind: "transaction",
      id: "transaction:" + bank.id,
      revision: "parse_run:" + bank.parse_run_id,
    },
    sourceId: bank.source_id,
    sourceAccount: bank.source_account,
    accountId: bank.account_id ?? null,
    ownerRef: bank.owner_ref ?? null,
    amount: debit,
    occurred: { kind: "local-date", value: bankDate, zone: "Asia/Tokyo", basis: "provider" },
  };
}

/** The most rows one window read returns. */
export const CARD_SETTLEMENT_BANK_DEBITS_LIMIT = 1000;

/**
 * The bank debits within three days of one due date (`?1`, `?2`), at most `?3`
 * by id, with their owners, resolved for those debits only: joined whole, the
 * ownership view grouped every transaction identity of the store, once per
 * statement of the page. The window is on each adapter's own `debit_date`
 * (migration 0052): SMBC's is the date of its midnight-JST `as_of`, the only
 * shape the sweep ever matched, and SBI Shinsei's is its posting date.
 */
export const CARD_SETTLEMENT_BANK_DEBITS_SQL = `WITH debits AS MATERIALIZED (
 SELECT * FROM card_bank_debit_facts
 WHERE debit_date BETWEEN date(?1,'-3 days') AND date(?2,'+3 days') ORDER BY id LIMIT ?3
), observed AS (SELECT id AS observation_id FROM debits),
${cardSettlementOwnershipCtes("transaction", { ownerDefault: true })}
SELECT debits.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM debits
 LEFT JOIN ownership ON ownership.observation_id=debits.id ORDER BY debits.id`;
