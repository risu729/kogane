// The line view of the card purchase read (`queryCardPurchaseLines`, ADR 0125
// amendment) on every CORE migration: the page's events of one month as
// compact lines, by date or by amount, a keyset page at a time. The lines are
// checked against the page's own items for the same filter, the amount order
// against exact decimal comparison, the walk for duplicates and skips, each
// answer against its byte bound, and the reads against their query plans
// without table statistics. Purchases are written by the guarded recognition
// builder (card-purchase-world.ts). Synthetic values only.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  CARD_PURCHASE_LINE_COUNTERPARTY_MAX,
  CARD_PURCHASE_LINES_BYTES,
  CARD_PURCHASE_LINES_MAX,
  cardFigures,
  compactAmount,
  compareCardPurchaseLineKeys,
  lineCounterparty,
  type CardPurchaseLine,
  type CardPurchaseLineKey,
  type CardPurchaseLinesPage,
  type CardPurchaseView,
} from "../../domain/src/card-purchase-view.ts";
import { compareDecimals, decimalFromString, decimalLiteral } from "../../domain/src/values.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  CARD_PURCHASE_SUMMARY_LIMIT,
  CardPurchaseLimitError,
  type CardPurchaseLinesQuery,
  decodeLinesCursor,
  encodeLinesCursor,
  queryCardPurchaseCards,
  queryCardPurchaseLines,
  queryCardPurchases,
  readCardPurchaseLines,
} from "../src/query/card-purchases.ts";
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

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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

/** Every item of the page for one statement period (or every period), page after page. */
async function pageItems(sql: SqlExecutor, period?: string): Promise<CardPurchaseView[]> {
  const items: CardPurchaseView[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await queryCardPurchases(sql, {
      offset,
      ...(period === undefined ? {} : { period }),
    });
    items.push(...page.items);
    offset = page.nextOffset;
  }
  return items;
}

/** Every page of the line view for one request, each checked against the page bounds. */
async function walk(
  sql: SqlExecutor,
  query: CardPurchaseLinesQuery,
): Promise<{ lines: CardPurchaseLine[]; pages: CardPurchaseLinesPage[] }> {
  const pages: CardPurchaseLinesPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await queryCardPurchaseLines(sql, {
      ...query,
      ...(cursor === null ? {} : { cursor }),
    });
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines.length).toBeLessThanOrEqual(CARD_PURCHASE_LINES_MAX);
    expect(bytes(page)).toBeLessThanOrEqual(CARD_PURCHASE_LINES_BYTES);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 100);
  return { lines: pages.flatMap((page) => page.lines), pages };
}

/** The line the view prints for one of the page's items. */
function lineOf(item: CardPurchaseView, withAccount: boolean): CardPurchaseLine {
  const counterparty = lineCounterparty(
    item.sourceRows.find((row) => row.counterparty !== null)?.counterparty ?? null,
  );
  return {
    eventId: item.eventId,
    date: item.usageDate,
    kind: item.kind,
    state: item.state,
    amount:
      item.amount === null
        ? { unit: null, status: "missing", reason: item.unknownReason ?? "leg_absent" }
        : compactAmount(item.amount),
    ...(item.amount === null && item.lastKnownAmount !== null
      ? { lastKnown: compactAmount(item.lastKnownAmount) }
      : {}),
    counterparty: counterparty.text,
    ...(counterparty.cut ? { counterpartyCut: true as const } : {}),
    ...(withAccount ? { accountId: item.accountId } : {}),
  };
}

const LONG_COUNTERPARTY = `合成の長い加盟店名${"架空".repeat(40)}`;

/**
 * Three cards. The first Vpass card (`acct-card`) has 32 September-statement
 * purchases on 16 August days (two a day), amounts chosen so that text order
 * and number order differ (999, 1000, 10000, ...), two purchases of the same
 * amount on different days, a refund, one purchase whose row was retired
 * (state `unknown`, no amount), and one with a counterparty longer than a
 * line carries. The second Vpass card (`acct-card-3`) has three purchases,
 * one in the October statement. MyJCB (`acct-jcb`) has a confirmed charge and
 * a pending authorisation without a period.
 */
async function threeCards() {
  const w = world();
  w.run(
    "INSERT INTO accounts(id,label,role,status) VALUES('acct-card-3','Synthetic second card','liability','identified')",
  );
  const amounts = [999, 1000, 10000, 2500, 1000, 87, 4321, 120, 15000, 640];
  const events: string[] = [];
  for (let row = 0; row < 32; row += 1) {
    const day = String(1 + Math.floor(row / 2)).padStart(2, "0");
    events.push(
      await w.recognise(
        w.usage({
          externalId: `vpass:card-001:202609:web:row-${row}:0`,
          amount: -(amounts[row % amounts.length]! + (row >= 10 ? row * 7 : 0)),
          usageDate: `2026-08-${day}`,
          ...(row === 5 ? { counterparty: LONG_COUNTERPARTY } : {}),
        }),
      ),
    );
  }
  await w.recognise(
    w.usage({
      externalId: "vpass:card-001:202609:web:refund-a:0",
      amount: 300,
      usageDate: "2026-08-25",
    }),
  );
  // The provider stopped displaying it: `unknown`, no leg, its last amount kept.
  const retired = events[3]!;
  await w.retire(retired);
  for (const [row, period, day] of [
    ["a", "202609", "12"],
    ["b", "202609", "12"],
    ["c", "202610", "30"],
  ] as const)
    await w.recognise(
      w.usage({
        externalId: `vpass:card-002:${period}:web:row-${row}:0`,
        amount: -(5000 + row.charCodeAt(0)),
        usageDate: `2026-08-${day}`,
        statementPeriod: period,
        sourceAccount: "vpass:card-002",
        accountId: "acct-card-3",
      }),
    );
  await w.recognise(
    w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:confirmed:row-g:0",
      amount: -999,
      usageDate: "2026-08-15",
      accountId: "acct-jcb",
    }),
  );
  await w.recognise(
    w.usage({
      source: "myjcb",
      externalId: "myjcb-credit-ledger:unconfirmed:row-e:0",
      status: "unconfirmed",
      amount: -800,
      usageDate: "2026-08-28",
      statementPeriod: null,
      accountId: "acct-jcb",
    }),
  );
  return { w, retired };
}

describe("the line view", () => {
  test("lists the page's events for the same filter, in the page's order, and writes nothing", async () => {
    const { w } = await threeCards();
    const before = tables(w.db);
    const items = await pageItems(w.sql, "2026-09");
    expect(items.length).toBeGreaterThan(CARD_PURCHASE_LINES_MAX);
    const { lines, pages } = await walk(w.sql, { period: "2026-09" });
    // Every card's lines carry their account; the order is the page's.
    expect(lines).toEqual(items.map((item) => lineOf(item, true)));
    expect(pages.length).toBeGreaterThan(1);
    const page = await queryCardPurchases(w.sql, { period: "2026-09" });
    for (const answer of pages)
      expect(answer).toMatchObject({
        view: "lines",
        frame: "statement-period",
        sort: "date",
        accountId: null,
        events: page.summary.events,
        unresolved: page.summary.unresolved,
        figures: page.summary.units.map(cardFigures),
        coverage: {
          scope: "card-purchase-recognition",
          completeTransactionHistory: false,
          unrecognizedCurrentRows: page.coverage.unrecognizedCurrentRows,
          refundsAllocated: false,
        },
      });

    // One account: its own events of the page, without the account on each line,
    // and the per-card view's figures for that card.
    const cards = await queryCardPurchaseCards(w.sql, { period: "2026-09" });
    for (const card of cards.cards) {
      const own = await walk(w.sql, { period: "2026-09", account: card.accountId });
      expect(own.lines).toEqual(
        items
          .filter((item) => item.accountId === card.accountId)
          .map((item) => lineOf(item, false)),
      );
      expect(own.pages[0]).toMatchObject({
        accountId: card.accountId,
        events: card.events,
        unresolved: card.unresolved,
        figures: card.figures,
      });
    }

    // A usage month: the page's events whose usage date is in it, across statements.
    const everything = await pageItems(w.sql);
    const august = await walk(w.sql, { usageMonth: "2026-08", account: "acct-card-3" });
    expect(august.pages[0]!.frame).toBe("usage-month");
    expect(august.lines).toEqual(
      everything
        .filter((item) => item.accountId === "acct-card-3" && item.usageDate.startsWith("2026-08-"))
        .map((item) => lineOf(item, false)),
    );
    expect(august.lines).toHaveLength(3);
    // An account or a month without events is an empty answer, not a zero figure.
    for (const query of [
      { period: "2026-09", account: "acct-none" },
      { usageMonth: "2026-07" },
    ] as const)
      expect(await queryCardPurchaseLines(w.sql, query)).toMatchObject({
        lines: [],
        nextCursor: null,
        events: 0,
        unresolved: 0,
        figures: [],
      });
    expect(tables(w.db)).toEqual(before);
  });

  test("sorts by exact amount, largest first, with lines without an amount last and their reason kept", async () => {
    const { w, retired } = await threeCards();
    const items = await pageItems(w.sql, "2026-09");
    const { lines } = await walk(w.sql, {
      period: "2026-09",
      account: "acct-card",
      sort: "amount",
    });
    const own = items.filter((item) => item.accountId === "acct-card");
    // The same lines as the date order, reordered.
    expect([...lines].sort((a, b) => (a.eventId < b.eventId ? -1 : 1))).toEqual(
      own.map((item) => lineOf(item, false)).sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
    );
    const exact = lines.filter((line) => "value" in line.amount);
    const absent = lines.slice(exact.length);
    // Every exact amount comes first, then every line without one.
    expect(absent.every((line) => !("value" in line.amount))).toBe(true);
    expect(absent.map((line) => line.eventId)).toEqual([retired]);
    expect(absent[0]).toEqual({
      eventId: retired,
      date: "2026-08-02",
      kind: "purchase",
      state: "unknown",
      amount: { unit: null, status: "missing", reason: "provider_status_absent" },
      // Its last amount is shown beside it, never as its amount or a zero.
      lastKnown: { unit: "JPY", value: "2500" },
      counterparty: "synthetic merchant",
    });
    // Numerically descending (10000 before 999, which text order would invert);
    // equal amounts newest first, then by event id.
    const decimal = (line: CardPurchaseLine) => {
      const parsed = decimalFromString((line.amount as { value: string }).value);
      if (!parsed.ok) throw new Error("not a decimal");
      return parsed.value;
    };
    for (let index = 1; index < exact.length; index += 1) {
      const [a, b] = [exact[index - 1]!, exact[index]!];
      const order = compareDecimals(decimal(a), decimal(b));
      expect(order).toBeGreaterThanOrEqual(0);
      if (order === 0) expect(a.date >= b.date).toBe(true);
    }
    const values = exact.map((line) => (line.amount as { value: string }).value);
    expect(values.indexOf("10000")).toBeLessThan(values.indexOf("999"));
    expect(values.filter((value) => value === "1000")).toHaveLength(2);
    // The refund is a line of its kind, ranked by its own amount.
    expect(lines.find((line) => line.kind === "refund")).toMatchObject({
      state: "captured",
      amount: { unit: "JPY", value: "300" },
    });
    // In the date order the retired line keeps its date position.
    const byDate = await walk(w.sql, { period: "2026-09", account: "acct-card" });
    expect(byDate.lines.findIndex((line) => line.eventId === retired)).toBe(
      own.findIndex((item) => item.eventId === retired),
    );
  });

  test("the amount order compares exact decimals across scales and keeps units apart", () => {
    const key = (
      eventId: string,
      date: string,
      amount: [string, string] | null,
    ): CardPurchaseLineKey => ({
      eventId,
      date,
      amount: amount === null ? null : { unit: amount[0], value: decimalLiteral(amount[1]) },
    });
    const keys = [
      key("purchase_a", "2026-08-01", ["JPY", "999"]),
      key("purchase_b", "2026-08-02", ["USD", "12.5"]),
      key("purchase_c", "2026-08-03", null),
      key("purchase_d", "2026-08-04", ["JPY", "1000.5"]),
      key("purchase_e", "2026-08-05", ["JPY", "1000.50"]),
      key("purchase_f", "2026-08-06", ["USD", "100.25"]),
      key("purchase_g", "2026-08-07", null),
      key("purchase_h", "2026-08-01", ["JPY", "999"]),
    ];
    const ids = (sort: "date" | "amount") =>
      [...keys].sort((a, b) => compareCardPurchaseLineKeys(sort, a, b)).map((k) => k.eventId);
    expect(ids("amount")).toEqual([
      // JPY, largest first; equal values (1000.5 at two scales) newest first.
      "purchase_e",
      "purchase_d",
      "purchase_h",
      "purchase_a",
      // USD apart from JPY, never compared with it.
      "purchase_f",
      "purchase_b",
      // No exact amount: last, newest first.
      "purchase_g",
      "purchase_c",
    ]);
    expect(ids("date")).toEqual([
      "purchase_g",
      "purchase_f",
      "purchase_e",
      "purchase_d",
      "purchase_c",
      "purchase_b",
      "purchase_h",
      "purchase_a",
    ]);
  });

  test("pages by keyset without a duplicate or a skip, also while events arrive", async () => {
    const { w } = await threeCards();
    for (const query of [
      { period: "2026-09" },
      { period: "2026-09", sort: "amount" },
      { usageMonth: "2026-08", sort: "amount" },
      { usageMonth: "2026-08", account: "acct-card" },
    ] as const) {
      const { lines, pages } = await walk(w.sql, query);
      expect(pages.length, JSON.stringify(query)).toBeGreaterThan(1);
      const ids = lines.map((line) => line.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(pages[0]!.events);
      // The cursor counts the lines listed before the next page.
      let listed = 0;
      for (const page of pages) {
        listed += page.lines.length;
        if (page.nextCursor !== null)
          expect(decodeLinesCursor(page.nextCursor)!.listed).toBe(listed);
      }
    }

    // Events recognised between two pages: one that sorts before the cursor is
    // not listed later, one after it is; nothing listed repeats or goes missing.
    const first = await queryCardPurchaseLines(w.sql, { period: "2026-09" });
    const early = await w.recognise(
      w.usage({
        externalId: "vpass:card-001:202609:web:late-new:0",
        amount: -77,
        usageDate: "2026-08-31",
      }),
    );
    const late = await w.recognise(
      w.usage({
        externalId: "vpass:card-001:202609:web:late-old:0",
        amount: -78,
        usageDate: "2026-07-31",
      }),
    );
    const rest: CardPurchaseLine[] = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await queryCardPurchaseLines(w.sql, { period: "2026-09", cursor });
      rest.push(...page.lines);
      cursor = page.nextCursor;
    }
    const ids = [...first.lines, ...rest].map((line) => line.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(early);
    expect(ids.at(-1)).toBe(late);
    const now = (await walk(w.sql, { period: "2026-09" })).lines.map((line) => line.eventId);
    expect(ids).toEqual(now.filter((id) => id !== early));
  });

  test("refuses a cursor of another request and malformed input before reading", async () => {
    const { w } = await threeCards();
    const first = await queryCardPurchaseLines(w.sql, { period: "2026-09" });
    const cursor = first.nextCursor!;
    expect(decodeLinesCursor(cursor)).toMatchObject({
      query: { account: null, period: "2026-09", usageMonth: null, sort: "date" },
      listed: first.lines.length,
    });
    const reads: string[] = [];
    const counted: SqlExecutor = {
      all: (query, args) => {
        reads.push(query);
        return w.sql.all(query, args);
      },
      first: (query, args) => w.sql.first(query, args),
    };
    for (const query of [
      { period: "2026-09", sort: "amount", cursor },
      { period: "2026-09", account: "acct-card", cursor },
      { period: "2026-10", cursor },
      { usageMonth: "2026-09", cursor },
      { period: "2026-09", cursor: `${cursor}x` },
      { period: "2026-09", cursor: "not-a-cursor" },
    ] as const)
      await expect(queryCardPurchaseLines(counted, query)).rejects.toThrow("invalid_cursor");
    for (const [query, code] of [
      [{}, "invalid_query"],
      [{ period: "2026-09", usageMonth: "2026-08" }, "invalid_query"],
      [{ period: "202609" }, "invalid_period"],
      [{ usageMonth: "2026-13" }, "invalid_usage_month"],
      [{ period: "2026-09", account: "-bad" }, "invalid_account"],
      [{ period: "2026-09", account: "a".repeat(129) }, "invalid_account"],
      [{ period: "2026-09", sort: "merchant" }, "invalid_sort"],
    ] as const)
      await expect(
        queryCardPurchaseLines(counted, query as CardPurchaseLinesQuery),
      ).rejects.toThrow(code);
    expect(reads).toEqual([]);
    // A cursor is canonical: a re-encoded one with another amount text is not this read's.
    const decoded = decodeLinesCursor(cursor)!;
    expect(encodeLinesCursor(decoded)).toBe(cursor);
    const amountSorted = (
      await queryCardPurchaseLines(w.sql, { period: "2026-09", sort: "amount" })
    ).nextCursor!;
    const tampered = Buffer.from(
      Buffer.from(amountSorted, "base64url")
        .toString()
        .replace(/"value":"(\d+)"/u, '"value":"$1.0"'),
    ).toString("base64url");
    expect(decodeLinesCursor(tampered)).toBeNull();
    // The summary bound refuses the month, never a part of it.
    const overfull: SqlExecutor = {
      all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
        query.includes("FROM current_card_purchase_recognitions c")
          ? Array.from({ length: Number(args.at(-1)) }, () => ({}) as T)
          : w.sql.all<T>(query, args),
      first: (query, args) => w.sql.first(query, args),
    };
    await expect(
      queryCardPurchaseLines(overfull, { usageMonth: "2026-08", account: "acct-card" }),
    ).rejects.toBeInstanceOf(CardPurchaseLimitError);
  });

  test("counts a cursor's depth from its key, whatever count the cursor claims", async () => {
    const { w } = await threeCards();
    // Enough lines for three pages.
    for (let row = 0; row < 20; row += 1)
      await w.recognise(
        w.usage({
          externalId: `vpass:card-001:202609:web:deep-${row}:0`,
          amount: -(200 + row),
          usageDate: "2026-08-20",
        }),
      );
    const query = { usageMonth: "2026-08", sort: "amount" } as const;
    const { pages } = await walk(w.sql, query);
    expect(pages.length).toBeGreaterThan(2);
    const [first, second] = pages as [CardPurchaseLinesPage, CardPurchaseLinesPage];
    const issued = decodeLinesCursor(first.nextCursor!)!;
    const depth = first.lines.length;
    expect(issued.listed).toBe(depth);
    expect(second.nextCursor).not.toBeNull();
    for (const [claimed, before, next] of [
      // A count rewritten lower is raised to the key's depth, and the next cursor counts from it.
      [1, depth, depth + second.lines.length],
      // A count claimed deeper than the key is kept; past the summary bound it is held there.
      [depth + 3, depth + 3, depth + 3 + second.lines.length],
      [CARD_PURCHASE_SUMMARY_LIMIT, CARD_PURCHASE_SUMMARY_LIMIT, CARD_PURCHASE_SUMMARY_LIMIT],
    ] as const) {
      const read = await readCardPurchaseLines(w.sql, {
        ...query,
        cursor: encodeLinesCursor({ ...issued, listed: claimed }),
      });
      expect(read.before, String(claimed)).toBe(before);
      expect(read.page.lines).toEqual(second.lines);
      expect(decodeLinesCursor(read.page.nextCursor!)!.listed).toBe(next);
    }
    // A key no line has is placed where it sorts: past every line, the whole month is before it.
    const past = await readCardPurchaseLines(w.sql, {
      ...query,
      cursor: encodeLinesCursor({
        ...issued,
        after: { date: "1900-01-01", eventId: `purchase_${"0".repeat(64)}`, amount: null },
        listed: 1,
      }),
    });
    expect(past).toMatchObject({ before: first.events, page: { lines: [], nextCursor: null } });
  });

  test("cuts a counterparty by code point, never inside a surrogate pair", () => {
    const max = CARD_PURCHASE_LINE_COUNTERPARTY_MAX;
    expect(lineCounterparty(null)).toEqual({ text: null, cut: false });
    expect(lineCounterparty("a".repeat(max))).toEqual({ text: "a".repeat(max), cut: false });
    // An astral character straddling the bound in UTF-16 is kept whole or dropped whole.
    const straddle = `${"a".repeat(max - 1)}🛒🛒`;
    expect(lineCounterparty(straddle)).toEqual({ text: `${"a".repeat(max - 1)}🛒`, cut: true });
    const cut = lineCounterparty(`${"a".repeat(max - 1)}🛒`.repeat(2)).text!;
    expect(cut.at(-1)).toBe("\udED2");
    expect(cut.at(-2)).toBe("\ud83d");
    // A lone surrogate in stored text is one code point, kept as it is.
    expect(lineCounterparty(`${"\ud800".repeat(max)}b`)).toEqual({
      text: "\ud800".repeat(max),
      cut: true,
    });
  });

  test("keeps every answer within its byte bound, with counterparties cut and flagged", async () => {
    const w = world();
    // The largest line shape: an identity-store account id on every line (no
    // account named), a counterparty of control characters JSON escapes to six
    // bytes each and of astral characters, longer than a line carries.
    const accountId = `account_${"f".repeat(64)}`;
    w.run(
      "INSERT INTO accounts(id,label,role,status) VALUES(?,'Synthetic card','liability','identified')",
      accountId,
    );
    const escaped = "\u0001".repeat(CARD_PURCHASE_LINE_COUNTERPARTY_MAX + 10);
    const astral = "🛒".repeat(CARD_PURCHASE_LINE_COUNTERPARTY_MAX + 1);
    for (let row = 0; row < 40; row += 1)
      await w.recognise(
        w.usage({
          externalId: `vpass:card-009:202609:web:row-${row}:0`,
          amount: -(1_000_000_000 + row),
          usageDate: `2026-08-${String(1 + (row % 28)).padStart(2, "0")}`,
          sourceAccount: "vpass:card-009",
          accountId,
          counterparty: row % 2 === 0 ? escaped : astral,
        }),
      );
    for (const sort of ["date", "amount"] as const) {
      const { lines, pages } = await walk(w.sql, { period: "2026-09", sort });
      expect(lines).toHaveLength(40);
      // Fewer than the line maximum fit, so the byte bound decided each page.
      expect(pages[0]!.lines.length).toBeLessThan(CARD_PURCHASE_LINES_MAX);
      for (const line of lines) {
        expect(line.counterpartyCut).toBe(true);
        expect(Array.from(line.counterparty!)).toHaveLength(CARD_PURCHASE_LINE_COUNTERPARTY_MAX);
        expect(line.accountId).toBe(accountId);
      }
      expect(lines.some((line) => line.counterparty === "🛒".repeat(64))).toBe(true);
      // The agent's whole answer around the largest page stays under 8 KB.
      for (const page of pages)
        expect(
          bytes({
            schemaVersion: "kogane-card-purchases-lines-v1",
            query: {
              view: "lines",
              account: "a".repeat(128),
              period: "2026-09",
              usageMonth: null,
              sort,
            },
            decisions: "operator-only",
            nextPage: "budget_exceeded",
            data: page,
          }),
        ).toBeLessThan(8 * 1024);
    }
    // An everyday month: 25 lines of a short counterparty fit one answer.
    const plain = await threeCards();
    const page = await queryCardPurchaseLines(plain.w.sql, { period: "2026-09" });
    expect(page.lines).toHaveLength(CARD_PURCHASE_LINES_MAX);
    expect(bytes(page)).toBeLessThan(CARD_PURCHASE_LINES_BYTES);
  });

  test("reads the listed lines' rows by key and walks no leg, key or observation table", async () => {
    const { w } = await threeCards();
    expect(
      w.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    const { sql, plans } = planned(w);
    for (const query of [
      { period: "2026-09", sort: "amount" },
      { usageMonth: "2026-08", account: "acct-card" },
    ] as const)
      await walk(sql, query);
    const all = [...plans.values()].flat();
    expect(
      all.filter(
        (detail) =>
          /\bSCAN (?:l|economic_legs|k|card_purchase_recognition_keys|t|transaction_observations|accounts)\b/u.test(
            detail,
          ) || detail.includes("economic_legs_basis"),
      ),
    ).toEqual([]);
    // The provider rows of the listed lines only: keys by event, rows by primary key.
    const keys = [...plans.entries()].find(([query]) =>
      query.includes("FROM card_purchase_recognition_keys k"),
    )![1];
    expect(keys.some((detail) => /^SEARCH k USING /u.test(detail))).toBe(true);
    expect(keys.some((detail) => /^SEARCH t USING INTEGER PRIMARY KEY/u.test(detail))).toBe(true);
    // No evidence, history, statement, settlement or candidate is read.
    for (const marker of [
      "evidence_support_json",
      "ROW_NUMBER() OVER (PARTITION BY c.event_id",
      "card_statement_facts",
      "card_settlement_reviews",
      "reconciliation_proposals",
    ])
      expect(
        [...plans.keys()].filter((query) => query.includes(marker)),
        marker,
      ).toEqual([]);
  });
});
