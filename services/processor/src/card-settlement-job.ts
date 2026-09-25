import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  exactQuantity,
  normalizeDecimal,
  type Quantity,
} from "../../../packages/domain/src/values.ts";
import {
  cardSettlementCandidate,
  CARD_SETTLEMENT_POLICY,
} from "../../../packages/domain/src/card-settlement.ts";
import { parseLocalDate } from "../../../packages/domain/src/time.ts";
import { cardSettlementOwnershipCtes } from "../../../packages/read-model/src/card-settlement-ownership.ts";

interface Row {
  id: number;
  parse_run_id: number;
  source_account: string;
  unit_ref: string;
  source_id: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  payment_date: string | null;
  as_of: string | null;
  period: string | null;
  statement_key: string;
  bank_key: string;
  account_id: string | null;
  owner_ref: string | null;
  evidence_refs_json: string | null;
}
const LIMIT = 1000;
/**
 * The next page of current provider statements after the cursor, with their
 * owners. The page is chosen first and only its statements are owned, through
 * the keyed form of `card_settlement_fact_ownership`
 * (packages/read-model/src/card-settlement-ownership.ts): joined whole, the view
 * read every published parse and every balance identity of the store on each
 * tick (docs/card-settlements.md, Cost). `?1` is the cursor, `?2` the page size.
 */
export const CARD_SETTLEMENT_STATEMENTS_SQL = `WITH page AS MATERIALIZED (
 SELECT * FROM card_statement_facts WHERE id>?1 ORDER BY id LIMIT ?2
), observed AS (SELECT id AS observation_id FROM page),
${cardSettlementOwnershipCtes("balance")}
SELECT page.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM page
 LEFT JOIN ownership ON ownership.observation_id=page.id ORDER BY page.id`;
/**
 * The bank debits within three days of one due date (`?1`, `?2`), at most `?3`
 * by id, with their owners, resolved for those debits only: joined whole, the
 * ownership view grouped every transaction identity of the store, once per
 * statement of the page.
 */
export const CARD_SETTLEMENT_BANK_DEBITS_SQL = `WITH debits AS MATERIALIZED (
 SELECT * FROM card_bank_debit_facts
 WHERE substr(as_of,1,10) BETWEEN date(?1,'-3 days') AND date(?2,'+3 days') ORDER BY id LIMIT ?3
), observed AS (SELECT id AS observation_id FROM debits),
${cardSettlementOwnershipCtes("transaction")}
SELECT debits.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM debits
 LEFT JOIN ownership ON ownership.observation_id=debits.id ORDER BY debits.id`;
function amount(row: Row, debit = false): Quantity | null {
  if (row.value_status !== "exact" || row.coefficient === null || row.scale === null) return null;
  const coefficient = debit ? row.coefficient.replace(/^-/, "") : row.coefficient;
  return exactQuantity(row.unit_ref, normalizeDecimal(BigInt(coefficient), row.scale));
}
function evidence(row: Row): string[] {
  const parsed: unknown = JSON.parse(row.evidence_refs_json ?? "[]");
  return Array.isArray(parsed)
    ? parsed.filter((ref): ref is string => typeof ref === "string")
    : [];
}
/** Published source facts only; heuristic candidates always remain unaccepted. */
export async function cardSettlementSweep(
  db: D1Database,
): Promise<{ scanned: number; proposed: number; written: number }> {
  const cursor = await db
    .prepare("SELECT last_statement_id FROM card_settlement_scan_cursor WHERE singleton=1")
    .first<{ last_statement_id: number }>();
  if (
    cursor?.last_statement_id &&
    !(await db
      .prepare("SELECT 1 FROM card_statement_facts WHERE id>? LIMIT 1")
      .bind(cursor.last_statement_id)
      .first())
  ) {
    await db
      .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0 WHERE singleton=1")
      .run();
    cursor.last_statement_id = 0;
  }
  const statements = await db
    .prepare(CARD_SETTLEMENT_STATEMENTS_SQL)
    .bind(cursor?.last_statement_id ?? 0, 100)
    .all<Row>();
  let proposed = 0,
    written = 0,
    scanned = statements.results.length;
  for (const statement of statements.results) {
    const total = amount(statement);
    if (
      !total ||
      !statement.payment_date ||
      !parseLocalDate(statement.payment_date) ||
      !statement.period
    ) {
      await db
        .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=? WHERE singleton=1")
        .bind(statement.id)
        .run();
      continue;
    }
    const banks = await db
      .prepare(CARD_SETTLEMENT_BANK_DEBITS_SQL)
      .bind(statement.payment_date, statement.payment_date, LIMIT)
      .all<Row>();
    scanned += banks.results.length;
    for (const bank of banks.results) {
      const debit = amount(bank, true);
      const bankDate =
        bank.as_of?.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})T00:00:00[+]09:00$/)?.[1] ?? null;
      if (!debit || !bankDate || !parseLocalDate(bankDate)) continue;
      const facts = cardSettlementCandidate(
        {
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
          paymentDate: {
            kind: "local-date",
            value: statement.payment_date,
            zone: "Asia/Tokyo",
            basis: "provider",
          },
          period: statement.period,
        },
        {
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
        },
        [...new Set([...evidence(statement), ...evidence(bank)])],
      );
      if (!facts) continue;
      proposed++;
      const digest = await canonicalDigest({
        policy: CARD_SETTLEMENT_POLICY,
        statementKey: statement.statement_key,
        bankKey: bank.bank_key,
        facts,
      });
      const result = await db
        .prepare(`INSERT INTO card_settlement_candidates
    (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM card_settlement_candidates WHERE proposal_digest=?)`)
        .bind(
          "cs_" + digest,
          statement.statement_key,
          bank.bank_key,
          statement.id,
          statement.parse_run_id,
          bank.id,
          bank.parse_run_id,
          CARD_SETTLEMENT_POLICY,
          JSON.stringify(facts),
          digest,
          new Date().toISOString(),
          digest,
        )
        .run();
      written += result.meta.changes;
      if (written >= 500) return { scanned, proposed, written };
    }
    await db
      .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=? WHERE singleton=1")
      .bind(statement.id)
      .run();
  }
  if (statements.results.length === 0)
    await db
      .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0 WHERE singleton=1")
      .run();
  return { scanned, proposed, written };
}
