import {
  CORE_REVISION_SQL,
  type CoreRevisionRow,
} from "../../../packages/read-model/src/source-revision.ts";
import { createSettlementBankReader } from "./card-settlement-bank-cache.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  cardSettlementCandidate,
  CARD_SETTLEMENT_POLICY,
} from "../../../packages/domain/src/card-settlement.ts";
import { parseLocalDate } from "../../../packages/domain/src/time.ts";
import {
  CARD_DEBIT_ACCOUNT_POLICY,
  candidateDebitAccountEvidence,
  type BankAccountReference,
  type CardDebitAccountStatement,
} from "../../../packages/domain/src/card-debit-account.ts";
import { debitAccountStatementForParse, knownBankAccounts } from "./card-debit-account-job.ts";
import { cardSettlementOwnershipCtes } from "../../../packages/read-model/src/card-settlement-ownership.ts";
import {
  bankDebitFactOf,
  CARD_SETTLEMENT_BANK_DEBITS_LIMIT,
  CARD_SETTLEMENT_BANK_DEBITS_SQL,
  statementFactOf,
  sweepRowAmount,
  sweepRowEvidence,
  type CardSettlementSweepRow,
} from "../../../packages/read-model/src/card-settlement-bank-debits.ts";
import {
  CARD_SETTLEMENT_UNMATCHED_CODES,
  unmatchedStatementCode,
  type CardSettlementUnmatchedCode,
} from "../../../packages/domain/src/card-settlement-unmatched.ts";

type Row = CardSettlementSweepRow & {
  payment_date: string | null;
  period: string | null;
  statement_key: string;
  bank_key: string;
};
const LIMIT = CARD_SETTLEMENT_BANK_DEBITS_LIMIT;
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
${cardSettlementOwnershipCtes("balance", { ownerDefault: true })}
SELECT page.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM page
 LEFT JOIN ownership ON ownership.observation_id=page.id ORDER BY page.id`;
const amount = sweepRowAmount;
const evidence = sweepRowEvidence;
/**
 * Appends what the card's own debit-account statement says about one
 * candidate (ADR 0032, `card_settlement_debit_account_evidence`, migration
 * 0060) when it differs from the candidate's latest row for that statement
 * and policy. Evidence only: the candidate's facts and digest were fixed
 * before this runs, and nothing here reads or writes ownership.
 */
const DEBIT_ACCOUNT_EVIDENCE_SQL = `INSERT INTO card_settlement_debit_account_evidence
 (candidate_id,statement_id,policy,outcome,reason,proposal_json,evidence_digest,created_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8
 WHERE coalesce((SELECT evidence_digest FROM card_settlement_debit_account_evidence
  WHERE candidate_id=?1 AND statement_id=?2 AND policy=?3 ORDER BY id DESC LIMIT 1),'')<>?7`;
async function recordDebitAccountEvidence(
  db: D1Database,
  candidateId: string,
  statement: CardDebitAccountStatement,
  bankAccounts: readonly BankAccountReference[],
  facts: NonNullable<ReturnType<typeof cardSettlementCandidate>>,
): Promise<number> {
  const evidence = candidateDebitAccountEvidence(statement, bankAccounts, facts);
  const digest = await canonicalDigest({ policy: CARD_DEBIT_ACCOUNT_POLICY, evidence });
  const result = await db
    .prepare(DEBIT_ACCOUNT_EVIDENCE_SQL)
    .bind(
      candidateId,
      Number(statement.ref.id.slice(statement.ref.id.indexOf(":") + 1)),
      CARD_DEBIT_ACCOUNT_POLICY,
      evidence.outcome,
      evidence.reason,
      evidence.proposal === null ? null : JSON.stringify(evidence.proposal),
      digest,
      new Date().toISOString(),
    )
    .run();
  return result.meta.changes;
}

/**
 * Why a statement the sweep examined this tick yielded no candidate, as a
 * closed code (docs/card-settlements.md, Unmatched statements; ADR 0009):
 * `unmatchedStatementCode` (packages/domain/src/card-settlement-unmatched.ts),
 * the same function the review read of statements without a candidate uses.
 * Only the rows the sweep already read decide the code. A statement paid by
 * two debits, partly paid, or paid by a debit outside the window or the
 * adapters is one of the last two; the codes never say which.
 */
export { CARD_SETTLEMENT_UNMATCHED_CODES };
export { CARD_SETTLEMENT_BANK_DEBITS_SQL };

export interface CardSettlementSweepResult {
  scanned: number;
  proposed: number;
  written: number;
  /** Debit-account evidence rows this tick newly appended. */
  debitAccountEvidence: number;
  /** Statements examined this tick that yielded no candidate, per closed code. */
  unmatched: Record<CardSettlementUnmatchedCode, number>;
}

/** Published source facts only; heuristic candidates always remain unaccepted. */
export async function cardSettlementSweep(db: D1Database): Promise<CardSettlementSweepResult> {
  // Cache only numberless baseline references. Observed context stays debit-local.
  const bankAccountsBySource = new Map<string, BankAccountReference[] | null>();
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
    debitAccountEvidence = 0,
    scanned = statements.results.length;
  const unmatched: Record<CardSettlementUnmatchedCode, number> = {
    statement_total_refund_or_zero: 0,
    statement_not_comparable: 0,
    no_debit_in_window: 0,
    no_equal_amount_debit: 0,
  };
  const readBanks = createSettlementBankReader<Row>(
    () => db.prepare(CORE_REVISION_SQL).first<CoreRevisionRow>(),
    async (date) =>
      (await db.prepare(CARD_SETTLEMENT_BANK_DEBITS_SQL).bind(date, date, LIMIT).all<Row>())
        .results,
  );
  // Account context is pinned to each debit; never reuse it across captures.
  for (const statement of statements.results) {
    // Read once per statement, and only for a MyJCB statement: no Vpass
    // statement API carries a debit account (observed absent).
    let debitStatement: CardDebitAccountStatement | null | undefined;
    const total = amount(statement);
    if (
      !total ||
      !statement.payment_date ||
      !parseLocalDate(statement.payment_date) ||
      !statement.period
    ) {
      unmatched[unmatchedStatementCode(total, false, null)]++;
      await db
        .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=? WHERE singleton=1")
        .bind(statement.id)
        .run();
      continue;
    }
    const banks = await readBanks(statement.payment_date);
    // Preserve the existing logical scan count, including shared rows.
    scanned += banks.length;
    let matched = false;
    for (const bank of banks) {
      const bankDebit = bankDebitFactOf(bank);
      if (!bankDebit) continue;
      const facts = cardSettlementCandidate(
        statementFactOf(statement, total, statement.payment_date),
        bankDebit,
        [...new Set([...evidence(statement), ...evidence(bank)])],
      );
      if (!facts) continue;
      matched = true;
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
      if (statement.source_id === "myjcb") {
        if (debitStatement === undefined)
          debitStatement = await debitAccountStatementForParse(
            db,
            statement.parse_run_id,
            statement.source_account,
          );
        if (debitStatement) {
          const bankSourceId = debitStatement.bankSourceId;
          let bankAccounts: BankAccountReference[] | null = [];
          if (bankSourceId !== null) {
            if (!bankAccountsBySource.has(bankSourceId))
              bankAccountsBySource.set(bankSourceId, await knownBankAccounts(db, bankSourceId));
            bankAccounts = await knownBankAccounts(
              db,
              bankSourceId,
              {
                sourceId: facts.bankDebit.sourceId,
                sourceAccount: facts.bankDebit.sourceAccount,
                ref: facts.bankDebit.ref,
              },
              bankAccountsBySource.get(bankSourceId),
            );
          }
          // More known accounts than the rule is given: uniqueness is not
          // judged and nothing is recorded.
          if (bankAccounts !== null)
            debitAccountEvidence += await recordDebitAccountEvidence(
              db,
              "cs_" + digest,
              debitStatement,
              bankAccounts,
              facts,
            );
        }
      }
      if (written >= 500) return { scanned, proposed, written, debitAccountEvidence, unmatched };
    }
    // Classified from the rows read above only: no further read. A total that
    // is not a valid positive quantity never matches (`cardSettlementCandidate`),
    // whatever the window holds.
    if (!matched) unmatched[unmatchedStatementCode(total, true, banks.length)]++;
    await db
      .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=? WHERE singleton=1")
      .bind(statement.id)
      .run();
  }
  if (statements.results.length === 0)
    await db
      .prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0 WHERE singleton=1")
      .run();
  return { scanned, proposed, written, debitAccountEvidence, unmatched };
}
