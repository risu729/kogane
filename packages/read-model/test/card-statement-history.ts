// The statement history of the scaled card store (card-usage-scale-fixture.ts
// with `statements: true`): the provider bill totals, the bank captures and the
// settlement reviews that `card_statement_facts`, `card_bank_debit_facts`
// (both adapters, migration 0052), `card_settlement_fact_ownership` and
// `card_settlement_reviews` (migration 0044) read. Every payload is shaped for a deployed parser; every review is
// proposed as the processor sweep (services/processor/src/card-settlement-job.ts)
// proposes it, the same facts, keys and digest, and then accepted or rejected
// with the rows `card-settlement.accept` and `reject` write
// (packages/application/test/card-purchase-world.ts `settle`). Names, amounts
// and parties are invented; nothing here is a provider row.
import type { Database } from "bun:sqlite";
import {
  CARD_SETTLEMENT_POLICY,
  cardSettlementCandidate,
  type CardSettlementFacts,
} from "../../domain/src/card-settlement";
import { canonicalDigest } from "../../domain/src/context";
import { exactQuantity, normalizeDecimal } from "../../domain/src/values";
import type { VpassStatementHeader } from "./card-usage-fixture";

/** The one party every card and the bank belong to. */
const OWNER = "party:synthetic-self";
const ZONE = "Asia/Tokyo";
const WEEKDAYS = "日月火水木金土";

type Bind = string | number | null;

function hash(text: string): number {
  let value = 2_166_136_261;
  for (const character of text)
    value = Math.imul(value ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return value;
}

const yen = (amount: number): string => amount.toLocaleString("en-US");

/**
 * The provider total of one statement (`YYYYMM`): stable, and at least 10,000
 * yen, above every ordinary bank row, so a debit matches only its own bill.
 */
export function statementTotal(source: string, month: string): number {
  return 10_000 + (hash(`${source}:${month}`) % 190_000);
}

/** The due date, `YYYY-MM-DD`: the 26th for Vpass, the 10th for MyJCB. */
export function paymentDate(source: "vpass" | "myjcb", month: string): string {
  return `${month.slice(0, 4)}-${month.slice(4)}-${source === "vpass" ? "26" : "10"}`;
}

const japaneseDate = (date: string): string =>
  `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;

/** The finalized bill header of Vpass card `source`'s statement `month`. */
export function vpassHeader(source: string, month: string): VpassStatementHeader {
  return {
    payTotal: yen(statementTotal(source, month)),
    seikyuYm: month,
    shiharaiDate: japaneseDate(paymentDate("vpass", month)),
  };
}

/** A sanitized MyJCB confirmed statement page (`credit-detail`) of `month`. */
export function myjcbStatementHtml(month: string): Uint8Array {
  const due = paymentDate("myjcb", month);
  const weekday = WEEKDAYS[new Date(`${due}T00:00:00Z`).getUTCDay()]!;
  const heading = `${Number(month.slice(0, 4))}年${Number(month.slice(4))}月`;
  return new TextEncoder().encode(
    `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1>` +
      `<h2>${heading}お支払い分のカードご利用明細</h2><div class="detail-list-01"></div>` +
      `<dl class="list"><dt>${japaneseDate(due)}(${weekday})お支払い金額合計</dt>` +
      `<dd><span>${yen(statementTotal("myjcb", month))}</span>円</dd></dl></body></html>`,
  );
}

/**
 * The MyJCB past-month summary (`credit-past-months`) of the twelve statement
 * months up to `months[0]`: bill amounts without a due date, which the
 * statement reads must skip.
 */
export function myjcbPastMonthsPayload(months: readonly string[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "030100601",
      result: {
        errId: null,
        errMessage: "",
        detailPastJsonInfo: months.map((month, index) => ({
          detailAvailableFlag: true,
          detailMonth: String(index),
          payAmount: `${yen(statementTotal("myjcb", month))}円`,
          payAmountDispFlag: true,
          settlementYM: `${Number(month.slice(0, 4))}年${Number(month.slice(4))}月`,
        })),
      },
    }),
  );
}

/** One SMBC `balance-normalized` capture. */
export function smbcBalancePayload(observedAt: string, amount: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ amount, currency: "JPY", observedAt }));
}

export interface BankRow {
  id: string;
  amount: number;
  direction: "credit" | "debit";
  description: string;
}

/** One SMBC `transactions-normalized` capture of the rows booked on `day`. */
export function smbcTransactionsPayload(
  day: string,
  rows: readonly BankRow[],
  closing: number,
): Uint8Array {
  let balance = closing;
  const transactions = rows.map((row) => {
    const entry = { ...row, balanceAfter: balance, date: `${day}T00:00:00+09:00` };
    balance += row.direction === "credit" ? -row.amount : row.amount;
    return entry;
  });
  const total = (direction: BankRow["direction"]): number =>
    rows.filter((row) => row.direction === direction).reduce((sum, row) => sum + row.amount, 0);
  return new TextEncoder().encode(
    JSON.stringify({
      depositsTotal: total("credit"),
      range: { start: day, end: day },
      transactions,
      withdrawalsTotal: total("debit"),
    }),
  );
}

/** The one SBI Shinsei account of the store: `sbi-shinsei:<accountNo>`. */
export const SBI_SHINSEI_ACCOUNT_NO = "SYNTHETIC-SCALE-001";

/** One SBI Shinsei activity row: the provider's own id, side and posting date. */
export interface SbiShinseiRow {
  txnReferenceNo: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
  side: "debit" | "credit";
}

/**
 * One SBI Shinsei `top-accounts-balance-and-activity` capture, in the shape of
 * tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries (without
 * the optional yen equivalent, a valuation the store does not need): the JPY
 * account's overview and its activity window `from`..`to` (the rows of those
 * days, oldest first, so a row is re-stated by every capture whose window
 * covers its day).
 */
export function sbiShinseiActivityPayload(
  observedAt: string,
  from: string,
  to: string,
  rows: readonly SbiShinseiRow[],
  closing: number,
): Uint8Array {
  const compact = (date: string): string => date.replaceAll("-", "");
  let balance = closing;
  for (const row of rows) balance += row.side === "debit" ? row.amount : -row.amount;
  const activityDetails = rows.map((row) => {
    balance += row.side === "debit" ? -row.amount : row.amount;
    return {
      txnReferenceNo: row.txnReferenceNo,
      description: "synthetic",
      [row.side]: String(row.amount),
      postingDate: compact(row.date),
      balance: String(balance),
      tradeTypeCode: "SYNTHETIC",
    };
  });
  const time = observedAt.slice(0, 19).replace(/[-T:]/gu, "");
  return new TextEncoder().encode(
    JSON.stringify({
      responseParam: {
        overview: {
          responseParam: {
            savingsDetails: [
              {
                accountNo: SBI_SHINSEI_ACCOUNT_NO,
                balance: String(closing),
                currency: "JPY",
                productCode: "601",
              },
            ],
          },
        },
        activity: {
          responseParam: {
            fromDate: compact(from),
            toDate: compact(to),
            currentBalance: String(closing),
            accountNo: SBI_SHINSEI_ACCOUNT_NO,
            currency: "JPY",
            activityDetails,
          },
        },
        systemResponseTime: time,
        sbiHyperYokinFlg: "0",
      },
      header: { adapterResultCode: "0" },
    }),
  );
}

/** The one St.George account of the store: `st-george:<accountKey>`. */
export const ST_GEORGE_ACCOUNT_KEY = "b".repeat(64);

/** One St.George `account-snapshot` capture: the account's current and available balance. */
export function stGeorgeSnapshotPayload(observedAt: string, day: string): Uint8Array {
  const cents = 100_000 + (hash(`st-george:${day}`) % 5_000_000);
  const text = (value: number): string =>
    `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
  return new TextEncoder().encode(
    JSON.stringify({
      schema: "st-george-browser-v1",
      observedAt,
      currency: "AUD",
      currencyEvidence: "source-configured",
      accounts: [
        {
          accountKey: ST_GEORGE_ACCOUNT_KEY,
          label: "Synthetic account",
          currentBalanceText: text(cents),
          availableBalanceText: text(cents - 5_000),
          openingBalanceText: null,
          closingBalanceText: null,
          historyState: "unknown",
          pendingState: "unknown",
          transactions: [],
        },
      ],
    }),
  );
}

/** A provider statement total as `card_statement_facts` returns it, with its ownership. */
export interface StatementFact {
  id: number;
  parseRunId: number;
  source: "vpass" | "myjcb";
  sourceAccount: string;
  accountId: string;
  /** `json_array(source, producer, namespace, source_account, period)`. */
  statementKey: string;
  /** `YYYY-MM`. */
  period: string;
  paymentDate: string;
  total: number;
  /** `card_settlement_fact_ownership.evidence_refs_json`. */
  evidence: readonly string[];
}

/** A bank debit as `card_bank_debit_facts` returns it, with its ownership. */
export interface BankDebit {
  id: number;
  /** The adapter's source: `smbc-bank` or `sbi-shinsei-bank`. */
  sourceId: string;
  parseRunId: number;
  /** `json_array(source, producer, namespace, source_account, external_id)`. */
  bankKey: string;
  sourceAccount: string;
  accountId: string;
  /** `YYYY-MM-DD`, the provider's civil date. */
  date: string;
  amount: number;
  evidence: readonly string[];
}

interface Candidate {
  id: string;
  facts: CardSettlementFacts;
  createdAt: string;
}

/** What a build proposed and decided, for the measurement report. */
export interface SettlementCounts {
  candidates: number;
  accepted: number;
  rejected: number;
  /** (source, account, period) keys with candidates but no decision. */
  undecided: number;
}

const DAY_MS = 86_400_000;
const dayGap = (left: string, right: string): number =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / DAY_MS;

const quantity = (amount: number) => exactQuantity("JPY", normalizeDecimal(BigInt(amount), 0));

/**
 * The statements and debits a build has captured, and the reviews the sweep
 * proposed from them. A statement's newest capture replaces the older one, as
 * `card_statement_facts` keeps only the newest representation, and so does a
 * bank row's (an SMBC row is captured once; an SBI Shinsei row is re-stated by
 * every capture whose activity window covers it, under the same provider id).
 */
export class SettlementLedger {
  private readonly current = new Map<string, StatementFact>();
  /** The current debit of each bank key, by amount. */
  private readonly debits = new Map<number, Map<string, BankDebit>>();
  /** The amount each bank key's current debit is filed under. */
  private readonly amounts = new Map<string, number>();
  private readonly examined = new Set<string>();
  private readonly digests = new Set<string>();
  private readonly groups = new Map<string, Candidate[]>();
  private sequence = 0;
  private decided = { accepted: 0, rejected: 0 };

  constructor(private readonly db: Database) {}

  private run(sql: string, ...binds: Bind[]): void {
    this.db.query(sql).run(...binds);
  }

  statement(fact: StatementFact): void {
    this.current.set(fact.statementKey, fact);
  }

  debit(fact: BankDebit): void {
    const previous = this.amounts.get(fact.bankKey);
    if (previous !== undefined) this.debits.get(previous)?.delete(fact.bankKey);
    this.amounts.set(fact.bankKey, fact.amount);
    const same = this.debits.get(fact.amount) ?? new Map<string, BankDebit>();
    same.set(fact.bankKey, fact);
    this.debits.set(fact.amount, same);
  }

  /**
   * One pass of the sweep over everything captured so far: every current
   * statement against every debit of the same amount within three days of its
   * due date, one candidate per digest the store does not hold yet.
   */
  async propose(createdAt: string): Promise<number> {
    let written = 0;
    for (const statement of this.current.values())
      for (const bank of this.debits.get(statement.total)?.values() ?? []) {
        const pair = `${statement.id}:${bank.id}`;
        if (this.examined.has(pair)) continue;
        this.examined.add(pair);
        if (dayGap(statement.paymentDate, bank.date) > 3) continue;
        const facts = cardSettlementCandidate(
          {
            ref: {
              kind: "balance",
              id: `balance:${statement.id}`,
              revision: `parse_run:${statement.parseRunId}`,
            },
            sourceId: statement.source,
            sourceAccount: statement.sourceAccount,
            accountId: statement.accountId,
            ownerRef: OWNER,
            amount: quantity(statement.total),
            paymentDate: {
              kind: "local-date",
              value: statement.paymentDate,
              zone: ZONE,
              basis: "provider",
            },
            period: statement.period,
          },
          {
            ref: {
              kind: "transaction",
              id: `transaction:${bank.id}`,
              revision: `parse_run:${bank.parseRunId}`,
            },
            sourceId: bank.sourceId,
            sourceAccount: bank.sourceAccount,
            accountId: bank.accountId,
            ownerRef: OWNER,
            amount: quantity(bank.amount),
            occurred: { kind: "local-date", value: bank.date, zone: ZONE, basis: "provider" },
          },
          [...new Set([...statement.evidence, ...bank.evidence])],
        );
        if (facts === null) continue;
        const digest = await canonicalDigest({
          policy: CARD_SETTLEMENT_POLICY,
          statementKey: statement.statementKey,
          bankKey: bank.bankKey,
          facts,
        });
        if (this.digests.has(digest)) continue;
        this.digests.add(digest);
        const id = `cs_${digest}`;
        this.run(
          `INSERT INTO card_settlement_candidates
            (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          id,
          statement.statementKey,
          bank.bankKey,
          statement.id,
          statement.parseRunId,
          bank.id,
          bank.parseRunId,
          CARD_SETTLEMENT_POLICY,
          JSON.stringify(facts),
          digest,
          createdAt,
        );
        const group = JSON.stringify([statement.source, statement.accountId, statement.period]);
        const candidates = this.groups.get(group) ?? [];
        candidates.push({ id, facts, createdAt });
        this.groups.set(group, candidates);
        written += 1;
      }
    return written;
  }

  private decision(id: string, subject: string, kind: string, createdAt: string): void {
    this.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,?,'manual','synthetic-operator',NULL,'synthetic review','[]',NULL,NULL,?)`,
      id,
      subject,
      kind,
      createdAt,
    );
  }

  /**
   * The operator's reviews: of every (source, account, period), the first
   * candidate is accepted, except that one key in ten is rejected and one in
   * ten left undecided. Later candidates of a key stay proposed, as the
   * acceptance reservation leaves them.
   */
  decide(): SettlementCounts {
    const keys = [...this.groups.keys()].sort();
    let undecided = 0;
    keys.forEach((key, index) => {
      const first = this.groups.get(key)![0]!;
      if (index % 10 === 3) {
        undecided += 1;
        return;
      }
      const status = index % 10 === 7 ? "rejected" : "accepted";
      const n = (this.sequence += 1);
      const createdAt = new Date(Date.parse(first.createdAt) + DAY_MS).toISOString();
      const decisionId = `dr_settlement_${n}`;
      this.decision(
        decisionId,
        `card-settlement:${first.id}`,
        status === "accepted" ? "accept" : "reject",
        createdAt,
      );
      if (status === "rejected") {
        this.run(
          `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
           VALUES(?,1,'rejected',?,NULL,NULL,NULL,?)`,
          first.id,
          decisionId,
          createdAt,
        );
        this.decided.rejected += 1;
        return;
      }
      const { facts } = first;
      const total =
        facts.statement.amount.value.status === "exact"
          ? facts.statement.amount.value.value.coefficient
          : "0";
      const eventId = `event_settlement_${n}`;
      const allocationId = `allocation_settlement_${n}`;
      this.decision(`dr_event_${n}`, `event:${eventId}`, "accept", createdAt);
      this.decision(`dr_allocation_${n}`, `allocation:${allocationId}`, "accept", createdAt);
      this.run(
        `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
         VALUES(?,1,'card_settlement','debited',NULL,?,'cash-movement',?,?,NULL,?)`,
        eventId,
        JSON.stringify(facts.bankDebit.occurred),
        JSON.stringify([facts.statement.ref.id, facts.bankDebit.ref.id]),
        `dr_event_${n}`,
        createdAt,
      );
      this.run(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
         VALUES(?,1,0,?,'JPY','exact',?,0,NULL,'decrease','cash-movement')`,
        eventId,
        facts.bankDebit.accountId,
        total,
      );
      this.run(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
         VALUES(?,1,1,?,'JPY','missing',NULL,NULL,'statement_principal_and_fees_unknown','unresolved','obligation-change')`,
        eventId,
        facts.statement.accountId,
      );
      this.run(
        `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
         VALUES(?,?,?,'settlement','JPY',?,0,?,NULL,?)`,
        allocationId,
        facts.bankDebit.ref.id,
        `event:${eventId}`,
        total,
        `dr_allocation_${n}`,
        createdAt,
      );
      this.run(
        `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
         VALUES(?,1,'accepted',?,?,NULL,?,?)`,
        first.id,
        decisionId,
        eventId,
        allocationId,
        createdAt,
      );
      this.decided.accepted += 1;
    });
    return {
      candidates: this.digests.size,
      accepted: this.decided.accepted,
      rejected: this.decided.rejected,
      undecided,
    };
  }
}

/** An accepted timeless ownership claim, as the ownership review records it. */
export function ownershipRelation(
  db: Database,
  kind: "liable_party" | "beneficial_owner",
  accountId: string,
): string {
  const id = `rel-${kind}-${accountId}`;
  db.query(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?,'relation',?,1,'accept','manual','synthetic-operator',NULL,'synthetic ownership','[]',NULL,NULL,'2024-01-01T00:00:00Z')`,
  ).run(`dr-${id}`, id);
  db.query(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
     VALUES(?,?,?,?,NULL,NULL,'accepted',?,'[]','2024-01-01T00:00:00Z')`,
  ).run(id, kind, accountId, OWNER, `dr-${id}`);
  return id;
}
