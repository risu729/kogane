// `reviewUpcomingCardBills` (src/query/card-upcoming-bills.ts, ADR 0114's
// 2026-11-19 amendment) over the synthetic dated store
// (packages/read-model/test/dated-state-fixture.ts) with the CORE migrations:
// each card's next bill from its newest current statement, its debit account
// from the ADR 0114 answer, the account's balance from the reported state for
// the date, and `covers`. Also: the answer passes the page's wire contract,
// stays under 8 KB for ten cards, writes nothing, is graded before it reads,
// and reaches account labels by key without table statistics. Every card,
// account, label, amount and date is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { CARD_DEBIT_ACCOUNTS_PATH } from "../../observation-shared/src/card-debit-accounts-contract.ts";
import { validUpcomingCardBills } from "../../observation-shared/src/card-upcoming-bills-contract.ts";
import {
  DATED_BALANCES_SQL,
  DATED_POSITIONS_SQL,
  DATED_SNAPSHOTS_SQL,
  DATED_STATEMENTS_BEFORE_WINDOW_SQL,
  DATED_STATEMENTS_SQL,
} from "../../read-model/src/dated-state.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore, type Capture } from "../../read-model/test/dated-state-fixture.ts";
import type { Grant } from "../src/grants.ts";
import {
  CARD_DEBIT_ACCOUNT_CANDIDATES_SQL,
  CARD_DEBIT_ACCOUNT_CARDS_SQL,
  CARD_DEBIT_ACCOUNT_READINGS_SQL,
} from "../src/query/card-debit-accounts.ts";
import { SETTLEMENT_SQL } from "../src/query/card-purchases.ts";
import {
  ACCOUNT_LABELS_SQL,
  reviewUpcomingCardBills,
  type UpcomingCardBillsReview,
} from "../src/query/card-upcoming-bills.ts";

const WHOLE: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const DATE = "2026-09-20";
const SMBC = { source: "smbc-bank", dataset: "balance-normalized", parser: "smbc-direct-balance" };
const BANK_A = "smbc-bank:synthetic-a";
const BANK_B = "smbc-bank:synthetic-b";

function executor(store: DatedStore, seen?: string[]): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) => {
      seen?.push(sql);
      return store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(sql: string, args: readonly unknown[]) => {
      seen?.push(sql);
      return (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

/**
 * A Vpass statement total of `card` as the statement parser stores it; a
 * `null` amount is one the decimal-v1 projection cannot read.
 */
function statement(
  store: DatedStore,
  input: { card: string; period: string; paymentDate: string | null; minor: number | null },
): Capture {
  const month = input.period.replace("-", "");
  const captured = store.capture({
    source: "vpass",
    dataset: "statement-page",
    parser: "vpass-statement-page",
    fetchedAt: `${input.period}-12T01:00:00Z`,
    artifactKey: `cards/${input.card}/months/${month}/top-000.json`,
  });
  const id = Number(
    store.db.run(
      `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,'credit_statement_payment_amount',?,?,0,'JPY',NULL,NULL,'$.total',?)`,
      [
        captured.parse,
        input.card,
        input.minor,
        input.minor === null ? "unreadable" : String(input.minor),
        JSON.stringify({
          _kogane: {
            statementMonth: month,
            snapshotSemantics: "provider-reported-monthly-payment-amount",
            ...(input.paymentDate === null ? {} : { paymentDate: input.paymentDate }),
          },
        }),
      ],
    ).lastInsertRowid,
  );
  return { ...captured, balances: [id] };
}

let decisions = 0;
/**
 * An accepted settlement of `statement` (period `period` of `card`) against a
 * debit from `bank` on `debitDate`: the ADR 0114 `accepted-settlement` answer.
 */
function accept(
  store: DatedStore,
  statementCapture: Capture,
  input: { card: string; period: string; bank: string; debitDate: string },
): void {
  const bank = store.capture({
    source: "smbc-bank",
    dataset: "synthetic-history",
    parser: "synthetic-bank-history",
    fetchedAt: `${input.debitDate}T03:00:00Z`,
  });
  const debit = Number(
    store.db.run(
      `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,'posted',-1,'-1',0,'JPY',NULL,NULL,?,NULL,'$.rows[0]','{}')`,
      [bank.parse, input.bank, `debit-${bank.parse}`, `${input.debitDate}T00:00:00+09:00`],
    ).lastInsertRowid,
  );
  const id = `cs_${statementCapture.parse}_${debit}`;
  const facts = {
    statement: { sourceId: "vpass", sourceAccount: input.card, period: input.period },
    bankDebit: {
      sourceId: "smbc-bank",
      sourceAccount: input.bank,
      occurred: {
        kind: "local-date",
        value: input.debitDate,
        zone: "Asia/Tokyo",
        basis: "provider",
      },
    },
  };
  store.db.run(
    `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
     VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,'2026-09-01T00:00:00Z')`,
    [
      id,
      JSON.stringify(["vpass", input.card, input.period]),
      JSON.stringify(["smbc-bank", debit]),
      statementCapture.balances[0]!,
      statementCapture.parse,
      debit,
      bank.parse,
      JSON.stringify(facts),
      String(++decisions).padStart(64, "d"),
    ],
  );
  const decision = `dr-${id}`;
  store.db.run(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?,'relation',?,1,'accept','manual','synthetic-operator',NULL,'synthetic review','[]',NULL,NULL,'2026-09-02T00:00:00Z')`,
    [decision, `card-settlement:${id}`],
  );
  store.db.run(
    `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
     VALUES(?,1,'accepted',?,?,NULL,?,'2026-09-02T00:00:00Z')`,
    [id, decision, `event-${id}`, `allocation-${id}`],
  );
}

/** An account entity with `label`, before an identity run maps to it (entities are append-only). */
function entity(store: DatedStore, id: string, label: string, status: string): void {
  store.db.run("INSERT INTO accounts VALUES(?,?,'synthetic',?)", [id, label, status]);
}

/** The bank's balance capture of `accounts` on `fetchedAt`, each mapped to its entity. */
function balances(
  store: DatedStore,
  fetchedAt: string,
  accounts: readonly [string, number | null, string][],
): void {
  for (const [account, minor, id] of accounts) {
    if (store.db.query("SELECT 1 FROM accounts WHERE id=?").get(id) === null)
      entity(store, id, `Synthetic bank ${id}`, "identified");
    const capture = store.capture({
      ...SMBC,
      fetchedAt,
      unitKey: account,
      balances: [{ account, metric: "account_balance", instrument: "JPY", minor }],
    });
    store.identify(capture, "smbc-bank", id, "identified");
  }
}

/**
 * The scenario store, on 2026-09-20:
 *
 * - card-001: 30,000 due 09-27, debited from bank A (accepted, 08-27);
 * - card-002: 20,000 due 09-26, debited from bank B (accepted, 08-26);
 * - card-003: 5,000 due 10-05, no debit-account evidence;
 * - card-004: an unreadable total due 09-28, debited from bank A (accepted);
 * - card-005: a statement the provider gave no due date, which an accepted
 *   settlement from bank A (09-10) pays (bank A: bank B's previous debit
 *   stays card-002's 08-26);
 * - card-006: its newest statement was due 08-27, debited from bank A;
 * - bank A reports 50,000 and bank B 10,000, captured 09-19.
 */
function scenario(
  bank: (store: DatedStore) => void = (store) =>
    balances(store, "2026-09-19T01:00:00Z", [
      [BANK_A, 50_000, "acct-bank-a"],
      [BANK_B, 10_000, "acct-bank-b"],
    ]),
): DatedStore {
  const store = new DatedStore();
  const card = (
    name: string,
    bill: { minor: number | null; paymentDate: string | null } | null,
    settled: { bank: string; debitDate: string } | null,
  ) => {
    const sourceAccount = `vpass:${name}`;
    const august = statement(store, {
      card: sourceAccount,
      period: "2026-08",
      paymentDate: settled?.debitDate ?? "2026-08-27",
      minor: 1000,
    });
    store.identify(august, "vpass", `acct-${name}`, "provider-local");
    if (settled !== null)
      accept(store, august, { card: sourceAccount, period: "2026-08", ...settled });
    if (bill !== null) {
      const september = statement(store, { card: sourceAccount, period: "2026-09", ...bill });
      store.identify(september, "vpass", `acct-${name}`, "provider-local");
    }
  };
  card(
    "card-001",
    { minor: 30_000, paymentDate: "2026-09-27" },
    { bank: BANK_A, debitDate: "2026-08-27" },
  );
  card(
    "card-002",
    { minor: 20_000, paymentDate: "2026-09-26" },
    { bank: BANK_B, debitDate: "2026-08-26" },
  );
  card("card-003", { minor: 5_000, paymentDate: "2026-10-05" }, null);
  card(
    "card-004",
    { minor: null, paymentDate: "2026-09-28" },
    { bank: BANK_A, debitDate: "2026-08-27" },
  );
  const undated = statement(store, {
    card: "vpass:card-005",
    period: "2026-09",
    paymentDate: null,
    minor: 4_000,
  });
  store.identify(undated, "vpass", "acct-card-005", "provider-local");
  accept(store, undated, {
    card: "vpass:card-005",
    period: "2026-09",
    bank: BANK_A,
    debitDate: "2026-09-10",
  });
  card("card-006", null, { bank: BANK_A, debitDate: "2026-08-27" });
  bank(store);
  return store;
}

async function review(
  store: DatedStore,
  seen?: string[],
  date: string = DATE,
): Promise<UpcomingCardBillsReview> {
  const outcome = await reviewUpcomingCardBills({
    grant: WHOLE,
    sql: executor(store, seen),
    date,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.review;
}

describe("each card's next bill", () => {
  test("bills due on or after the date, by debit date, with the debit account each answer names", async () => {
    const answer = await review(scenario());
    expect(answer).toMatchObject({
      schemaVersion: "kogane-card-upcoming-bills-v1",
      view: "upcoming",
      date: DATE,
      zone: "Asia/Tokyo",
      rules: ["card-upcoming-bills-v1", "card-debit-account-answer-v1"],
      cardsMax: 100,
      cardsTruncated: false,
    });
    expect(
      answer.bills.map((bill) => [
        bill.card.sourceAccount,
        bill.statementPeriod,
        bill.debitDate,
        bill.amount,
        bill.debitAccount.answer,
        bill.debitAccount.account,
      ]),
    ).toEqual([
      [
        "vpass:card-002",
        "2026-09",
        "2026-09-26",
        { value: "20000", unit: "JPY", status: "exact" },
        "accepted-settlement",
        "acct-bank-b",
      ],
      [
        "vpass:card-001",
        "2026-09",
        "2026-09-27",
        { value: "30000", unit: "JPY", status: "exact" },
        "accepted-settlement",
        "acct-bank-a",
      ],
      // Not exact: its status and reason, never a zero (INV05).
      [
        "vpass:card-004",
        "2026-09",
        "2026-09-28",
        { unit: "JPY", status: "unparsed", reason: "stored:unparsed" },
        "accepted-settlement",
        "acct-bank-a",
      ],
      [
        "vpass:card-003",
        "2026-09",
        "2026-10-05",
        { value: "5000", unit: "JPY", status: "exact" },
        "unknown",
        null,
      ],
    ]);
    expect(answer.bills[1]!.debitAccount).toEqual({
      answer: "accepted-settlement",
      account: "acct-bank-a",
      sourceAccount: BANK_A,
      label: "Synthetic bank acct-bank-a",
      since: "2026-08-27",
      codes: [],
    });
    expect(answer.bills[3]!.debitAccount).toMatchObject({
      answer: "unknown",
      codes: ["no_debit_account_evidence"],
    });
    expect(answer.bills[0]!.card.label).toBe("Synthetic");
  });

  test("a provider that published no due date, and a card with nothing due, are listed with their reason", async () => {
    const answer = await review(scenario());
    expect(answer.notListed).toEqual([
      {
        card: "vpass:card-005",
        source: "vpass",
        reason: "payment_date_not_published",
        last: { period: "2026-09", debitDate: null },
      },
      {
        card: "vpass:card-006",
        source: "vpass",
        reason: "no_statement_due",
        last: { period: "2026-08", debitDate: "2026-08-27" },
      },
    ]);
  });
});

describe("covers", () => {
  test("bank A covers card-001 exactly; card-004's total makes the next line unknown", async () => {
    const lines = (await review(scenario())).byDebitAccount;
    const a = lines.filter((line) => line.account === "acct-bank-a");
    expect(
      a.map((line) => [line.debitDate, line.bills, line.cardBills, line.covers, line.reasons]),
    ).toEqual([
      ["2026-09-27", 1, { value: "30000", unit: "JPY", status: "exact" }, "yes", []],
      [
        "2026-09-28",
        2,
        { unit: "JPY", status: "missing", reason: "bill_not_exact" },
        "unknown",
        ["bill_not_exact"],
      ],
    ]);
    expect(a[0]!.balance).toEqual({
      value: "50000",
      unit: "JPY",
      status: "exact",
      capturedAt: "2026-09-19T01:00:00.000Z",
    });
    expect(a[0]!.notes).toEqual(["other_debits_not_modelled"]);
  });

  test("bank B does not cover card-002", async () => {
    const [b] = (await review(scenario())).byDebitAccount.filter(
      (line) => line.account === "acct-bank-b",
    );
    expect(b).toMatchObject({
      debitDate: "2026-09-26",
      bills: 1,
      cardBills: { value: "20000", status: "exact" },
      balance: { value: "10000", status: "exact" },
      covers: "no",
      reasons: [],
    });
  });

  test("on a bill's own due date, a balance captured that day may already show the debit", async () => {
    // Asked on card-002's due date (09-26): bank B's capture of that day may
    // come after the bank took the 20,000, so comparing it with the bill would
    // count the debit twice. Captured the day before, it is compared.
    const today = "2026-09-26";
    const sameDay = scenario((store) =>
      balances(store, "2026-09-26T03:00:00Z", [[BANK_B, 10_000, "acct-bank-b"]]),
    );
    const [b] = (await review(sameDay, undefined, today)).byDebitAccount.filter(
      (line) => line.account === "acct-bank-b",
    );
    expect(b).toMatchObject({
      debitDate: today,
      bills: 1,
      cardBills: { value: "20000", status: "exact" },
      balance: { value: "10000", status: "exact", capturedAt: "2026-09-26T03:00:00.000Z" },
      covers: "unknown",
      reasons: ["balance_before_previous_debit"],
    });
    const dayBefore = scenario((store) =>
      balances(store, "2026-09-25T03:00:00Z", [[BANK_B, 10_000, "acct-bank-b"]]),
    );
    const [earlier] = (await review(dayBefore, undefined, today)).byDebitAccount.filter(
      (line) => line.account === "acct-bank-b",
    );
    expect(earlier).toMatchObject({ debitDate: today, covers: "no", reasons: [] });
  });

  test("a refund statement to bank B never offsets card-002's bill", async () => {
    // card-007, debited from bank B (accepted 08-26), has a September refund
    // of 15,000 due 09-26: netted in, card-002's 20,000 would read 5,000 and
    // fit bank B's 10,000.
    const store = scenario((store) => {
      const august = statement(store, {
        card: "vpass:card-007",
        period: "2026-08",
        paymentDate: "2026-08-26",
        minor: 1000,
      });
      store.identify(august, "vpass", "acct-card-007", "provider-local");
      accept(store, august, {
        card: "vpass:card-007",
        period: "2026-08",
        bank: BANK_B,
        debitDate: "2026-08-26",
      });
      const refund = statement(store, {
        card: "vpass:card-007",
        period: "2026-09",
        paymentDate: "2026-09-26",
        minor: -15_000,
      });
      store.identify(refund, "vpass", "acct-card-007", "provider-local");
      balances(store, "2026-09-19T01:00:00Z", [
        [BANK_A, 50_000, "acct-bank-a"],
        [BANK_B, 10_000, "acct-bank-b"],
      ]);
    });
    const answer = await review(store);
    expect(answer.bills.map((bill) => bill.card.sourceAccount)).not.toContain("vpass:card-007");
    expect(answer.byDebitAccount.filter((line) => line.account === "acct-bank-b")).toEqual([
      expect.objectContaining({
        debitDate: "2026-09-26",
        bills: 1,
        cardBills: { value: "20000", unit: "JPY", status: "exact" },
        covers: "no",
        reasons: [],
      }),
    ]);
    expect(answer.notListed.find((card) => card.card === "vpass:card-007")).toEqual({
      card: "vpass:card-007",
      source: "vpass",
      reason: "statement_total_refund_or_zero",
      last: { period: "2026-09", debitDate: "2026-09-26" },
    });
  });

  test("the bill with no known debit account has its own line, unknown", async () => {
    const unknown = (await review(scenario())).byDebitAccount.filter(
      (line) => line.account === null,
    );
    expect(unknown).toEqual([
      {
        account: null,
        sourceAccount: null,
        label: null,
        debitDate: "2026-10-05",
        bills: 1,
        cardBills: { value: "5000", unit: "JPY", status: "exact" },
        balance: null,
        covers: "unknown",
        reasons: ["debit_account_unknown"],
        notes: ["other_debits_not_modelled"],
      },
    ]);
  });

  test("a statement with no due date that no settlement pays makes its account's lines unknown", async () => {
    // card-007's newest statement states no due date and is debited from bank A.
    const store = scenario();
    const august = statement(store, {
      card: "vpass:card-007",
      period: "2026-08",
      paymentDate: "2026-08-27",
      minor: 1000,
    });
    store.identify(august, "vpass", "acct-card-007", "provider-local");
    accept(store, august, {
      card: "vpass:card-007",
      period: "2026-08",
      bank: BANK_A,
      debitDate: "2026-08-27",
    });
    const september = statement(store, {
      card: "vpass:card-007",
      period: "2026-09",
      paymentDate: null,
      minor: 7_000,
    });
    store.identify(september, "vpass", "acct-card-007", "provider-local");
    const answer = await review(store);
    expect(answer.notListed.find((card) => card.card === "vpass:card-007")).toEqual({
      card: "vpass:card-007",
      source: "vpass",
      reason: "payment_date_not_published",
      last: { period: "2026-09", debitDate: null },
    });
    expect(
      answer.byDebitAccount
        .filter((line) => line.account !== null)
        .map((line) => [line.account, line.debitDate, line.covers, line.reasons]),
    ).toEqual([
      ["acct-bank-b", "2026-09-26", "no", []],
      ["acct-bank-a", "2026-09-27", "unknown", ["cards_with_unknown_due_date"]],
      ["acct-bank-a", "2026-09-28", "unknown", ["bill_not_exact", "cards_with_unknown_due_date"]],
    ]);
  });

  test("an account entity's balance is its newest reference's, never a sum (INV06)", async () => {
    // A second source account of bank A's entity, captured on its own.
    const alias = "smbc-bank:synthetic-a-second";
    const line = async (aliasAt: string) =>
      (
        await review(
          scenario((store) => {
            balances(store, aliasAt, [[alias, 70_000, "acct-bank-a"]]);
            balances(store, "2026-09-19T01:00:00Z", [
              [BANK_A, 50_000, "acct-bank-a"],
              [BANK_B, 10_000, "acct-bank-b"],
            ]);
          }),
        )
      ).byDebitAccount.find(
        (entry) => entry.account === "acct-bank-a" && entry.debitDate === "2026-09-27",
      );
    // The older reference is neither taken nor added.
    expect(await line("2026-09-18T01:00:00Z")).toMatchObject({
      balance: { value: "50000", status: "exact", capturedAt: "2026-09-19T01:00:00.000Z" },
      covers: "yes",
    });
    // Two references captured together that disagree are a conflict, not a choice.
    expect(await line("2026-09-19T01:00:00Z")).toMatchObject({
      balance: {
        unit: "JPY",
        status: "conflict",
        reason: "balances_disagree",
        capturedAt: "2026-09-19T01:00:00.000Z",
      },
      covers: "unknown",
      reasons: ["balance_not_exact"],
    });
  });

  test("a balance captured before the previous debit, or not reported, is never compared", async () => {
    // Bank B's balance is older than card-002's accepted 08-26 debit; bank A has none at all.
    const store = scenario((store) =>
      balances(store, "2026-08-25T01:00:00Z", [[BANK_B, 90_000, "acct-bank-b"]]),
    );
    const lines = (await review(store)).byDebitAccount;
    expect(lines.find((line) => line.account === "acct-bank-b")).toMatchObject({
      balance: { value: "90000", status: "exact", capturedAt: "2026-08-25T01:00:00.000Z" },
      covers: "unknown",
      reasons: ["balance_before_previous_debit"],
    });
    // Bank A's source account maps to no entity in the reported state any more.
    expect(
      lines.find((line) => line.sourceAccount === BANK_A && line.debitDate === "2026-09-27"),
    ).toMatchObject({
      account: null,
      balance: { status: "missing", reason: "balance_not_reported", capturedAt: null },
      covers: "unknown",
      reasons: ["balance_not_exact"],
    });
  });
});

describe("the answer as served", () => {
  test("passes the page's wire contract, through the route's own dispatch", async () => {
    const answer = JSON.parse(JSON.stringify({ apiVersion: 2, ...(await review(scenario())) }));
    expect(validUpcomingCardBills(answer)).toBe(true);
    expect(validApiResponse(CARD_DEBIT_ACCOUNTS_PATH, answer)).toBe(true);
    // A yes its figures do not carry, or an unknown without a reason, is refused.
    const lying = structuredClone(answer);
    lying.byDebitAccount.find((line: { covers: string }) => line.covers === "no").covers = "yes";
    expect(validUpcomingCardBills(lying)).toBe(false);
    const silent = structuredClone(answer);
    silent.byDebitAccount.find((line: { covers: string }) => line.covers === "unknown").reasons =
      [];
    expect(validUpcomingCardBills(silent)).toBe(false);
    const zero = structuredClone(answer);
    zero.bills[2].amount = { value: "0", unit: "JPY", status: "unparsed" };
    expect(validUpcomingCardBills(zero)).toBe(false);
    // A refund served as a bill, where it would offset other bills, is refused.
    const refund = structuredClone(answer);
    refund.bills[0].amount = { value: "-5000", unit: "JPY", status: "exact" };
    expect(validUpcomingCardBills(refund)).toBe(false);
    refund.bills[0].amount = { value: "0", unit: "JPY", status: "exact" };
    expect(validUpcomingCardBills(refund)).toBe(false);
  });

  test("ten cards with bills and labels stay under 8 KB", async () => {
    const store = new DatedStore();
    for (let n = 1; n <= 10; n++) {
      const card = `vpass:card-${String(n).padStart(3, "0")}`;
      entity(
        store,
        `acct-card-${n}`,
        `合成カード名${n}（card-${String(n).padStart(3, "0")}）`,
        "provider-local",
      );
      const august = statement(store, {
        card,
        period: "2026-08",
        paymentDate: "2026-08-27",
        minor: 1000,
      });
      store.identify(august, "vpass", `acct-card-${n}`, "provider-local");
      accept(store, august, {
        card,
        period: "2026-08",
        bank: n % 2 === 0 ? BANK_A : BANK_B,
        debitDate: "2026-08-27",
      });
      const september = statement(store, {
        card,
        period: "2026-09",
        paymentDate: n % 3 === 0 ? "2026-10-05" : "2026-09-27",
        minor: 123_456 + n,
      });
      store.identify(september, "vpass", `acct-card-${n}`, "provider-local");
    }
    balances(store, "2026-09-19T01:00:00Z", [
      [BANK_A, 1_000_000, "acct-bank-a"],
      [BANK_B, 1_000_000, "acct-bank-b"],
    ]);
    const answer = await review(store);
    expect(answer.bills).toHaveLength(10);
    const bytes = new TextEncoder().encode(JSON.stringify({ apiVersion: 2, ...answer })).length;
    expect(bytes).toBeLessThan(8 * 1024);
  });
});

describe("cost and authority", () => {
  test("it writes nothing and issues only the reads it composes", async () => {
    const store = scenario();
    const before = (store.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const seen: string[] = [];
    await review(store, seen);
    expect((store.db.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before);
    expect(new Set(seen)).toEqual(
      new Set([
        CARD_DEBIT_ACCOUNT_CARDS_SQL,
        CARD_DEBIT_ACCOUNT_READINGS_SQL,
        CARD_DEBIT_ACCOUNT_CANDIDATES_SQL,
        DATED_POSITIONS_SQL,
        DATED_BALANCES_SQL,
        DATED_SNAPSHOTS_SQL,
        DATED_STATEMENTS_SQL,
        DATED_STATEMENTS_BEFORE_WINDOW_SQL,
        SETTLEMENT_SQL,
        ACCOUNT_LABELS_SQL,
      ]),
    );
  });

  test("a narrowed grant is refused before anything is read", async () => {
    const seen: string[] = [];
    const outcome = await reviewUpcomingCardBills({
      grant: { ...WHOLE, scopes: { sources: ["vpass"], accounts: "*" } },
      sql: executor(scenario(), seen),
      date: DATE,
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "evidence_restricted" } });
    expect(seen).toEqual([]);
  });

  test("without table statistics, account labels are reached by key", () => {
    const store = scenario();
    store.db.run("DROP TABLE IF EXISTS sqlite_stat1");
    const plan = (
      store.db.query(`EXPLAIN QUERY PLAN ${ACCOUNT_LABELS_SQL}`).all('["a","b"]') as {
        detail: string;
      }[]
    ).map((row) => row.detail);
    expect(
      plan.some((line) =>
        /^SEARCH a USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)/u.test(line),
      ),
    ).toBe(true);
    expect(plan.filter((line) => /^SCAN a\b/u.test(line))).toEqual([]);
  });
});
