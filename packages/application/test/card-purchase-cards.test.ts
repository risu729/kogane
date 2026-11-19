// The per-card view of the card purchase read (`queryCardPurchaseCards`,
// ADR 0125) on every CORE migration: the page's whole-filter figures grouped
// by card, each card's statements with their settlement review, the events
// without a statement figure by closed reason, the usage-month frame, the
// summary bound, the answer's size and the query plans without table
// statistics. Purchases are written by the guarded recognition builder and
// statements and settlement reviews as their own writers store them
// (card-purchase-world.ts). Synthetic values only.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cardFigures } from "../../domain/src/card-purchase-view.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  ACCOUNT_LABELS_SQL,
  CardPurchaseLimitError,
  queryCardPurchaseCards,
  queryCardPurchases,
  SELECTION_SQL,
  USAGE_MONTH_SELECTION_SQL,
} from "../src/query/card-purchases.ts";
import { cardsAddedUp } from "./card-purchase-cards-sum.ts";
import { PurchaseWorld } from "./card-purchase-world.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const worlds: { close(): void }[] = [];
function world(): PurchaseWorld {
  const created = new PurchaseWorld();
  worlds.push(created);
  return created;
}
afterEach(() => {
  for (const created of worlds.splice(0)) created.close();
});

/** Every table's row count and the connection's change counter: a read moves neither. */
function tables(db: Database): Record<string, unknown> {
  const names = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return {
    counts: Object.fromEntries(
      names.map((name) => [
        name,
        (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    ),
    changes: (db.query("SELECT total_changes() AS n").get() as { n: number }).n,
  };
}

/** The world's executor with every statement and its query plan recorded. */
function planned(w: PurchaseWorld): { sql: SqlExecutor; plans: Map<string, string[]> } {
  const plans = new Map<string, string[]>();
  return {
    plans,
    sql: {
      all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
        const steps = w.db.query(`EXPLAIN QUERY PLAN ${query}`).all(...(args as never[])) as {
          detail: string;
        }[];
        plans.set(query, [...(plans.get(query) ?? []), ...steps.map((step) => step.detail)]);
        return w.sql.all<T>(query, args);
      },
      first: (query, args) => w.sql.first(query, args),
    },
  };
}

/**
 * Three cards: two Vpass cards and a MyJCB connection. The first Vpass card
 * has two September-statement purchases, a refund and an October-statement
 * purchase; its September statement is collected and settled. The second
 * Vpass card's September statement is not collected. The MyJCB connection
 * has a September-statement charge and a pending authorisation without a
 * period.
 */
async function threeCards() {
  const w = world();
  w.run(
    "INSERT INTO accounts(id,label,role,status) VALUES('acct-card-3','Synthetic second card','liability','identified')",
  );
  const vpass = (
    externalId: string,
    rest: Omit<Parameters<PurchaseWorld["usage"]>[0], "externalId">,
  ) => w.recognise(w.usage({ ...rest, externalId }));
  await vpass("vpass:card-001:202609:web:row-a:0", {
    amount: -1200,
    usageDate: "2026-08-10",
  });
  await vpass("vpass:card-001:202609:web:row-b:0", {
    amount: -534,
    usageDate: "2026-08-20",
  });
  await vpass("vpass:card-001:202609:web:row-c:0", {
    amount: 300,
    usageDate: "2026-08-25",
  });
  await vpass("vpass:card-001:202610:web:row-d:0", {
    amount: -2000,
    usageDate: "2026-09-05",
    statementPeriod: "202610",
  });
  await w.recognise(
    w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:unconfirmed:row-e:0",
      status: "unconfirmed",
      amount: -800,
      usageDate: "2026-09-28",
      statementPeriod: null,
      accountId: "acct-jcb",
    }),
  );
  await vpass("vpass:card-002:202609:web:row-f:0", {
    amount: -4321,
    usageDate: "2026-08-12",
    sourceAccount: "vpass:card-002",
    accountId: "acct-card-3",
  });
  await w.recognise(
    w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:confirmed:row-g:0",
      amount: -999,
      usageDate: "2026-08-15",
      accountId: "acct-jcb",
    }),
  );
  const statement = w.statement({
    source: "vpass",
    sourceAccount: "vpass:card-001",
    accountId: "acct-card",
    period: "2026-09",
    total: 1434,
    paymentDate: "2026-10-10",
  });
  w.settle({
    statement,
    bank: w.bankDebit(1434),
    source: "vpass",
    accountId: "acct-card",
    period: "2026-09",
    total: 1434,
    status: "accepted",
  });
  return w;
}

describe("the per-card view", () => {
  test("groups the page's figures by card, beside each card's statements, and writes nothing", async () => {
    const w = await threeCards();
    const before = tables(w.db);
    const answer = await queryCardPurchaseCards(w.sql, { period: "2026-09" });
    expect(tables(w.db)).toEqual(before);
    const page = await queryCardPurchases(w.sql, { period: "2026-09" });

    // The same selection and figures as the page's summary, in compact form.
    expect(answer.frame).toBe("statement-period");
    expect(answer.events).toBe(page.summary.events);
    expect(answer.unresolved).toBe(page.summary.unresolved);
    expect(answer.totals).toEqual(page.summary.units.map(cardFigures));
    expect(answer.coverage).toEqual({
      scope: page.coverage.scope,
      completeTransactionHistory: false,
      unsupportedShapes: page.coverage.unsupportedShapes,
      unrecognizedCurrentRows: page.coverage.unrecognizedCurrentRows,
      unrecognizedReasons: page.coverage.unrecognizedReasons,
      refundsAllocated: false,
    });
    expect(answer.cardsTruncated).toBe(false);
    expect(answer.settlementAddsPurchaseExpense).toBe(false);
    // The cards, added back together in the domain, are the page's figures.
    expect(cardsAddedUp(answer)).toEqual({
      totals: answer.totals,
      events: answer.events,
      unresolved: answer.unresolved,
    });

    expect(answer.cards).toEqual([
      {
        accountId: "acct-card",
        sourceId: "vpass",
        label: "Synthetic card",
        events: 3,
        unresolved: 0,
        figures: [
          {
            unit: "JPY",
            captured: "1734",
            authorized: "0",
            capturedRefunds: "300",
            authorizedRefunds: "0",
          },
        ],
        withoutStatement: [],
        statements: [
          {
            period: "2026-09",
            total: { unit: "JPY", value: "1434" },
            paymentDate: "2026-10-10",
            settlement: "accepted",
            debit: { sourceId: "smbc-bank", date: "2026-10-10" },
          },
        ],
      },
      {
        accountId: "acct-card-3",
        sourceId: "vpass",
        label: "Synthetic second card",
        events: 1,
        unresolved: 0,
        figures: [
          {
            unit: "JPY",
            captured: "4321",
            authorized: "0",
            capturedRefunds: "0",
            authorizedRefunds: "0",
          },
        ],
        withoutStatement: [{ reasonCode: "statement_not_collected", events: 1 }],
        statements: [],
      },
      {
        accountId: "acct-jcb",
        sourceId: "myjcb",
        label: "Synthetic card",
        events: 1,
        unresolved: 0,
        figures: [
          {
            unit: "JPY",
            captured: "999",
            authorized: "0",
            capturedRefunds: "0",
            authorizedRefunds: "0",
          },
        ],
        withoutStatement: [{ reasonCode: "statement_not_collected", events: 1 }],
        statements: [],
      },
    ]);
  });

  test("a usage month selects by the provider usage date, across statement periods", async () => {
    const w = await threeCards();
    const september = await queryCardPurchaseCards(w.sql, { usageMonth: "2026-09" });
    expect(september.frame).toBe("usage-month");
    // Card 1's October-statement purchase and MyJCB's pending authorisation.
    expect(september.cards).toHaveLength(2);
    expect(september.cards[0]).toMatchObject({
      accountId: "acct-card",
      events: 1,
      figures: [
        {
          unit: "JPY",
          captured: "2000",
          authorized: "0",
          capturedRefunds: "0",
          authorizedRefunds: "0",
        },
      ],
      // The October statement is not collected.
      withoutStatement: [{ reasonCode: "statement_not_collected", events: 1 }],
      statements: [],
    });
    expect(september.cards[1]).toMatchObject({
      accountId: "acct-jcb",
      events: 1,
      figures: [
        {
          unit: "JPY",
          captured: "0",
          authorized: "800",
          capturedRefunds: "0",
          authorizedRefunds: "0",
        },
      ],
      withoutStatement: [{ reasonCode: "not_posted", events: 1 }],
    });
    expect(september.totals).toEqual([
      {
        unit: "JPY",
        captured: "2000",
        authorized: "800",
        capturedRefunds: "0",
        authorizedRefunds: "0",
      },
    ]);
    const august = await queryCardPurchaseCards(w.sql, { usageMonth: "2026-08" });
    expect(august.cards.map((card) => [card.accountId, card.events])).toEqual([
      ["acct-card", 3],
      ["acct-card-3", 1],
      ["acct-jcb", 1],
    ]);
    // A month without usage is an empty answer, not a zero figure.
    expect(await queryCardPurchaseCards(w.sql, { usageMonth: "2026-07" })).toMatchObject({
      cards: [],
      totals: [],
      events: 0,
    });
  });

  test("the usage-month selection is the page's selection narrowed by usage date", async () => {
    const w = await threeCards();
    // Built from the shipped text: only the event-id predicate differs.
    expect(
      USAGE_MONTH_SELECTION_SQL.replace(
        "substr(json_extract(c.facts_json,'$.usageDate'),1,7)=?2",
        "(?2 IS NULL OR c.event_id=?2)",
      ),
    ).toBe(SELECTION_SQL);
    const everything = (
      await w.sql.all<{ event_id: string; usage_date: string }>(SELECTION_SQL, [null, null, 10_001])
    ).map((row) => JSON.stringify(row));
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const narrowed = (
        await w.sql.all<{ event_id: string }>(USAGE_MONTH_SELECTION_SQL, [null, month, 10_001])
      ).map((row) => JSON.stringify(row));
      expect(narrowed.sort()).toEqual(
        everything.filter((row) => JSON.parse(row).usage_date.startsWith(`${month}-`)).sort(),
      );
    }
  });

  test("refuses a filter past the summary bound and malformed input", async () => {
    const w = world();
    const overfull: SqlExecutor = {
      all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
        query.includes("FROM current_card_purchase_recognitions c")
          ? Array.from({ length: Number(args.at(-1)) }, () => ({}) as T)
          : w.sql.all<T>(query, args),
      first: (query, args) => w.sql.first(query, args),
    };
    for (const input of [{ period: "2026-09" }, { usageMonth: "2026-09" }])
      await expect(queryCardPurchaseCards(overfull, input)).rejects.toBeInstanceOf(
        CardPurchaseLimitError,
      );
    // Exactly one month: neither or both is refused before anything is read.
    for (const input of [{}, { period: "2026-09", usageMonth: "2026-09" }])
      await expect(queryCardPurchaseCards(overfull, input)).rejects.toThrow("invalid_query");
    await expect(queryCardPurchaseCards(w.sql, { period: "202609" })).rejects.toThrow(
      "invalid_period",
    );
    await expect(queryCardPurchaseCards(w.sql, { usageMonth: "2026-13" })).rejects.toThrow(
      "invalid_usage_month",
    );
  });

  test("ten cards, each with two settled statements in one usage month, answer in under 8 KB", async () => {
    const w = world();
    // Account ids as long as the identity store's (`account_` and a SHA-256),
    // a label as long as a card name with its ordinal, two statements per
    // card (a usage month can reach two) and an accepted settlement on each:
    // the largest per-card shape the view has.
    for (let card = 1; card <= 10; card += 1) {
      const id = String(card).padStart(3, "0");
      const accountId = `account_${id.repeat(22).slice(0, 64)}`;
      w.run(
        "INSERT INTO accounts(id,label,role,status) VALUES(?,?,'liability','identified')",
        accountId,
        `Synthetic card label ${id}（card-${id}）`,
      );
      for (const [period, day] of [
        ["202609", "0"],
        ["202610", "2"],
      ] as const) {
        for (let row = 0; row < 3; row += 1)
          await w.recognise(
            w.usage({
              externalId: `vpass:card-${id}:${period}:web:row-${row}:0`,
              amount: -(100_000 + card * 1000 + row),
              usageDate: `2026-09-${day}${row + 1}`,
              statementPeriod: period,
              sourceAccount: `vpass:card-${id}`,
              accountId,
            }),
          );
        const statement = w.statement({
          source: "vpass",
          sourceAccount: `vpass:card-${id}`,
          accountId,
          period: `2026-${period.slice(4)}`,
          total: 1_300_000 + card,
          paymentDate: `2026-${period.slice(4)}-27`,
        });
        w.settle({
          statement,
          bank: w.bankDebit(1_300_000 + card),
          source: "vpass",
          accountId,
          period: `2026-${period.slice(4)}`,
          total: 1_300_000 + card,
          status: "accepted",
        });
      }
    }
    const answer = await queryCardPurchaseCards(w.sql, { usageMonth: "2026-09" });
    expect(answer.cards).toHaveLength(10);
    expect(
      answer.cards.every(
        (card) =>
          card.statements.length === 2 &&
          card.statements.every((statement) => statement.debit !== null),
      ),
    ).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).length;
    expect(bytes).toBeLessThan(8 * 1024);
    // The first page of events, which a client pages through for this question today, is far larger.
    const page = await queryCardPurchases(w.sql);
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeGreaterThan(bytes * 5);
  });

  test("lists at most 100 cards, says more exist, and totals every card", async () => {
    const w = world();
    // 101 cards with one purchase each; account ids sort as the card numbers.
    for (let card = 1; card <= 101; card += 1) {
      const id = String(card).padStart(3, "0");
      const accountId = `acct-many-${id}`;
      w.run(
        "INSERT INTO accounts(id,label,role,status) VALUES(?,?,'liability','identified')",
        accountId,
        `Synthetic card ${id}`,
      );
      await w.recognise(
        w.usage({
          externalId: `vpass:card-${id}:202609:web:row-a:0`,
          amount: -(1000 + card),
          usageDate: "2026-08-10",
          sourceAccount: `vpass:card-${id}`,
          accountId,
        }),
      );
    }
    const answer = await queryCardPurchaseCards(w.sql, { period: "2026-09" });
    expect(answer.cards).toHaveLength(100);
    expect(answer.cardsTruncated).toBe(true);
    expect(answer.cards.at(-1)!.accountId).toBe("acct-many-100");
    // The totals still cover the card that is not listed; the listed cards
    // add up to everything but it.
    expect(answer.events).toBe(101);
    expect(answer.totals).toEqual([
      {
        unit: "JPY",
        captured: String(101 * 1000 + (101 * 102) / 2),
        authorized: "0",
        capturedRefunds: "0",
        authorizedRefunds: "0",
      },
    ]);
    expect(cardsAddedUp(answer)).toEqual({
      totals: [{ ...answer.totals[0]!, captured: String(100 * 1000 + (100 * 101) / 2) }],
      events: 100,
      unresolved: 0,
    });
  }, 60_000);

  test("reads the page's statements, labels by primary key and walks no leg or key table", async () => {
    const w = await threeCards();
    expect(
      w.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    const { sql, plans } = planned(w);
    await queryCardPurchaseCards(sql, { usageMonth: "2026-08" });
    await queryCardPurchaseCards(sql, { period: "2026-09" });
    // No leg or key table is walked (the page's own rule); the artifact scans
    // of the shared current-usage snapshot CTEs are the page's, documented in
    // docs/read-model.md (Cost).
    const all = [...plans.values()].flat();
    expect(
      all.filter(
        (detail) =>
          /\bSCAN (?:l|economic_legs|k|card_purchase_recognition_keys|accounts)\b/u.test(detail) ||
          detail.includes("economic_legs_basis"),
      ),
    ).toEqual([]);
    // The usage-month selection reaches the same tables the same way as the page's.
    const selection = (query: string, args: unknown[]) =>
      (
        w.db.query(`EXPLAIN QUERY PLAN ${query}`).all(...(args as never[])) as { detail: string }[]
      ).map((step) => step.detail);
    expect(selection(USAGE_MONTH_SELECTION_SQL, [null, "2026-08", 10_001])).toEqual(
      selection(SELECTION_SQL, [null, null, 10_001]),
    );
    // Labels: one primary-key lookup per listed account, never a scan of `accounts`.
    const labels = plans.get(ACCOUNT_LABELS_SQL)!;
    expect(labels.some((detail) => /^SEARCH a USING .*\(id=\?\)/u.test(detail))).toBe(true);
    expect(labels.filter((detail) => detail.startsWith("SCAN a"))).toEqual([]);
    // No per-event explanation is read.
    expect([...plans.keys()].filter((query) => query.includes("evidence_support_json"))).toEqual(
      [],
    );
  });
});
