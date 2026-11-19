// Each card's next bill and whether its debit account covers it (ADR 0114,
// 2026-11-19 amendment). Every card, account, amount and date is made up.
import { describe, expect, test } from "bun:test";
import {
  compactQuantity,
  COVERS_UNKNOWN_REASONS,
  upcomingCardBills,
  type UpcomingAccountInput,
  type UpcomingCardInput,
  type UpcomingDebitAccount,
} from "../src/card-upcoming-bills.ts";
import { absentQuantity, exactQuantity, integerDecimal, type Quantity } from "../src/values.ts";

const DATE = "2098-03-20";
const yen = (value: number): Quantity => exactQuantity("JPY", integerDecimal(value), "decimal-v1");

function account(key: string | null): UpcomingDebitAccount {
  return key === null
    ? {
        answer: "unknown",
        key: null,
        account: null,
        sourceAccount: null,
        label: null,
        since: null,
        codes: ["no_debit_account_evidence"],
      }
    : {
        answer: "accepted-settlement",
        key: "entity:" + key,
        account: key,
        sourceAccount: "smbc-bank:" + key,
        label: "Synthetic " + key,
        since: "2098-02-26",
        codes: [],
      };
}

function card(
  name: string,
  statement: UpcomingCardInput["statement"],
  key: string | null,
  settledPeriods: string[] = [],
): UpcomingCardInput {
  return {
    card: { source: "vpass", sourceAccount: "vpass:" + name, label: null },
    statement,
    settledPeriods,
    debitAccount: account(key),
  };
}
const bill = (paymentDate: string | null, amount: Quantity, period = "2098-03") => ({
  period,
  paymentDate,
  amount,
});
const balance = (
  value: Quantity,
  capturedAt: string | null = "2098-03-19T01:00:00.000Z",
  previousDebit: string | null = "2098-02-26",
): UpcomingAccountInput => ({ balance: value, capturedAt, previousDebit });

describe("which statements are bills", () => {
  test("a statement due today or later is a bill; every other card says why, never a zero", () => {
    const answer = upcomingCardBills({
      date: DATE,
      cards: [
        card("due-today", bill(DATE, yen(100)), "a"),
        card("due-later", bill("2098-03-27", yen(200)), "a"),
        card("past", bill("2098-02-27", yen(300), "2098-02"), "a"),
        card("undated", bill(null, yen(400)), "a"),
        card("none", null, null),
        card("settled", bill("2098-03-27", yen(500)), "a", ["2098-03"]),
      ],
      accounts: new Map([["entity:a", balance(yen(1000))]]),
    });
    expect(answer.bills.map((item) => [item.card.sourceAccount, item.debitDate])).toEqual([
      ["vpass:due-today", DATE],
      ["vpass:due-later", "2098-03-27"],
    ]);
    expect(answer.notListed).toEqual([
      { card: "vpass:none", source: "vpass", reason: "no_statement", last: null },
      {
        card: "vpass:past",
        source: "vpass",
        reason: "no_statement_due",
        last: { period: "2098-02", debitDate: "2098-02-27" },
      },
      {
        card: "vpass:settled",
        source: "vpass",
        reason: "statement_settled",
        last: { period: "2098-03", debitDate: "2098-03-27" },
      },
      {
        card: "vpass:undated",
        source: "vpass",
        reason: "payment_date_not_published",
        last: { period: "2098-03", debitDate: null },
      },
    ]);
    // A bill carries the debit account answer, without the grouping key.
    expect(answer.bills[0]!.debitAccount).toEqual({
      answer: "accepted-settlement",
      account: "a",
      sourceAccount: "smbc-bank:a",
      label: "Synthetic a",
      since: "2098-02-26",
      codes: [],
    });
    expect(answer.bills[0]!.amount).toEqual({ value: "100", unit: "JPY", status: "exact" });
  });
});

describe("covers", () => {
  test("yes when the exact balance is at least the exact bills; a later line counts the earlier ones", () => {
    const answer = upcomingCardBills({
      date: DATE,
      cards: [
        card("one", bill("2098-03-26", yen(600)), "a"),
        card("two", bill("2098-03-27", yen(500)), "a"),
      ],
      accounts: new Map([["entity:a", balance(yen(1000))]]),
    });
    expect(answer.byDebitAccount).toEqual([
      {
        account: "a",
        sourceAccount: "smbc-bank:a",
        label: "Synthetic a",
        debitDate: "2098-03-26",
        bills: 1,
        cardBills: { value: "600", unit: "JPY", status: "exact" },
        balance: {
          value: "1000",
          unit: "JPY",
          status: "exact",
          capturedAt: "2098-03-19T01:00:00.000Z",
        },
        covers: "yes",
        reasons: [],
        notes: ["other_debits_not_modelled"],
      },
      {
        account: "a",
        sourceAccount: "smbc-bank:a",
        label: "Synthetic a",
        debitDate: "2098-03-27",
        bills: 2,
        cardBills: { value: "1100", unit: "JPY", status: "exact" },
        balance: {
          value: "1000",
          unit: "JPY",
          status: "exact",
          capturedAt: "2098-03-19T01:00:00.000Z",
        },
        covers: "no",
        reasons: [],
        notes: ["other_debits_not_modelled"],
      },
    ]);
  });

  test("an equal balance covers; a smaller one does not", () => {
    const run = (value: number) =>
      upcomingCardBills({
        date: DATE,
        cards: [card("one", bill("2098-03-26", yen(600)), "a")],
        accounts: new Map([["entity:a", balance(yen(value))]]),
      }).byDebitAccount[0]!.covers;
    expect(run(600)).toBe("yes");
    expect(run(599)).toBe("no");
  });

  test("a bill that is not exact makes the line's sum not exact and covers unknown", () => {
    const answer = upcomingCardBills({
      date: DATE,
      cards: [
        card("exact", bill("2098-03-26", yen(100)), "a"),
        card(
          "unread",
          bill("2098-03-26", absentQuantity("JPY", "unparsed", "stored:unparsed")),
          "a",
        ),
      ],
      accounts: new Map([["entity:a", balance(yen(1_000_000))]]),
    });
    expect(answer.bills.map((item) => item.amount)).toEqual([
      { value: "100", unit: "JPY", status: "exact" },
      { unit: "JPY", status: "unparsed", reason: "stored:unparsed" },
    ]);
    expect(answer.byDebitAccount[0]).toMatchObject({
      bills: 2,
      cardBills: { unit: "JPY", status: "missing", reason: "bill_not_exact" },
      covers: "unknown",
      reasons: ["bill_not_exact"],
    });
  });

  test("a balance that is not exact, or none reported, is unknown", () => {
    for (const value of [
      absentQuantity("JPY", "missing", "balance_not_reported"),
      absentQuantity("JPY", "conflict", "balances_disagree"),
    ]) {
      const line = upcomingCardBills({
        date: DATE,
        cards: [card("one", bill("2098-03-26", yen(100)), "a")],
        accounts: new Map([["entity:a", balance(value, null)]]),
      }).byDebitAccount[0]!;
      expect(line.covers).toBe("unknown");
      expect(line.reasons).toEqual(["balance_not_exact"]);
      expect(line.balance).toEqual({ ...compactQuantity(value), capturedAt: null });
    }
  });

  test("a balance captured on or before the previous debit from the account is unknown", () => {
    const run = (capturedAt: string) =>
      upcomingCardBills({
        date: DATE,
        cards: [card("one", bill("2098-03-26", yen(100)), "a")],
        accounts: new Map([["entity:a", balance(yen(1000), capturedAt, "2098-03-10")]]),
      }).byDebitAccount[0]!;
    // 2098-03-10 in Tokyo, the debit's own day: the debit may come after it.
    expect(run("2098-03-10T01:00:00.000Z")).toMatchObject({
      covers: "unknown",
      reasons: ["balance_before_previous_debit"],
    });
    // 00:30 on 3/11 in Tokyo is still 3/10 in UTC: the next day, after the debit.
    expect(run("2098-03-10T15:30:00.000Z")).toMatchObject({ covers: "yes", reasons: [] });
  });

  test("bills with no known debit account have their own line and make earlier-or-equal lines unknown", () => {
    const answer = upcomingCardBills({
      date: DATE,
      cards: [
        card("known-early", bill("2098-03-25", yen(100)), "a"),
        card("known-late", bill("2098-03-28", yen(100)), "b"),
        card("unknown", bill("2098-03-27", yen(300)), null),
      ],
      accounts: new Map([
        ["entity:a", balance(yen(1000))],
        ["entity:b", balance(yen(1000))],
      ]),
    });
    expect(
      answer.byDebitAccount.map((line) => [
        line.account,
        line.debitDate,
        line.covers,
        line.reasons,
      ]),
    ).toEqual([
      ["a", "2098-03-25", "yes", []],
      [null, "2098-03-27", "unknown", ["debit_account_unknown"]],
      // The unknown card's bill is due before this one and might come from it.
      ["b", "2098-03-28", "unknown", ["cards_with_unknown_account"]],
    ]);
    const unknown = answer.byDebitAccount[1]!;
    expect(unknown.balance).toBeNull();
    expect(unknown.cardBills).toEqual({ value: "300", unit: "JPY", status: "exact" });
  });

  test("reasons follow the closed list's order", () => {
    const line = upcomingCardBills({
      date: DATE,
      cards: [
        card("unknown", bill("2098-03-25", yen(1)), null),
        card("one", bill("2098-03-26", absentQuantity("JPY", "missing", "stored:missing")), "a"),
      ],
      accounts: new Map([
        [
          "entity:a",
          balance(absentQuantity("JPY", "missing", "x"), "2098-03-01T00:00:00.000Z", "2098-03-05"),
        ],
      ]),
    }).byDebitAccount[1]!;
    expect(line.reasons).toEqual([
      "bill_not_exact",
      "balance_not_exact",
      "balance_before_previous_debit",
      "cards_with_unknown_account",
    ]);
    expect(COVERS_UNKNOWN_REASONS.filter((reason) => line.reasons.includes(reason))).toEqual(
      line.reasons,
    );
  });
});
