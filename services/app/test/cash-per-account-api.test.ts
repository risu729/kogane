// Cash per account (ADR 0123, amendment 2026-11-20): `GET /api/v2/balances/cash`
// and `kogane.balances.read` `collection: cash` on a synthetic store at the
// scale the owner's question meets (`cash-store.ts`): every page is the same
// answer on the route, the agent HTTP path and `/mcp`, stays under the 8 KB
// a client shows, and the pages together list every account once with the
// same subtotals; the subtotals are the latest page's known-assets subtotal
// unit by unit; a cursor continues at another page size and is refused with
// other filters; and an account reached through two provider references is
// never added twice. Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { decimalToString } from "../../../packages/domain/src/values";
import {
  CASH_REPORTED_TWICE,
  type CashPerAccountPage,
  type LatestBalanceSummaryPage,
} from "../../../packages/observation-shared/src/api-contract";
import { pageReadHarness } from "./page-read-harness";
import { seedRegistry } from "./fixtures";
import { buildSnapshot, cashSources, entityOf, seedCashSource, smbcCapture } from "./cash-store";

/** What the owner's client shows of a tool result (#1414). */
const CLIENT_BYTES = 8 * 1024;
const PATH = "/api/v2/balances/cash";
const TOOL = "kogane.balances.read";

const page = pageReadHarness("cash", { READ_PROJECTION_ENABLED: "true" });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

beforeAll(async () => {
  await seedRegistry();
  for (const capture of cashSources()) await seedCashSource(capture);
  await buildSnapshot();
}, 120_000);

/** Every page of one query, each checked against both agent transports and the 8 KB bound. */
async function allPages(
  query: Record<string, string> = {},
): Promise<{ pages: CashPerAccountPage[]; sizes: number[] }> {
  const pages: CashPerAccountPage[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const args: Record<string, string> = { ...query, ...(cursor === null ? {} : { cursor }) };
    const search = new URLSearchParams(args).toString();
    const answer = await page.expectSameAnswer(`${PATH}${search ? `?${search}` : ""}`, TOOL, {
      collection: "cash",
      ...args,
    });
    expect(answer.status).toBe(200);
    const body = answer.body as CashPerAccountPage;
    expect(validApiResponse(PATH, body)).toBe(true);
    // The bytes a client receives: the tool result's structured content.
    sizes.push(bytes({ schemaVersion: "kogane-page-read-v1", data: body }));
    pages.push(body);
    cursor = body.page.nextCursor;
  } while (cursor !== null);
  return { pages, sizes };
}

describe("cash per account", () => {
  it("lists every account once over pages under 8 KB, the route, agent HTTP and MCP alike", async () => {
    const { pages, sizes } = await allPages();
    console.log(`cash pages (MCP structured content bytes): ${sizes.join(", ")}`);
    for (const size of sizes) expect(size).toBeLessThan(CLIENT_BYTES);
    expect(pages.length).toBeGreaterThan(1);
    const lines = pages.flatMap((entry) => entry.lines);
    // 26 deposits, two that did not parse, the exchange's and the broker's.
    expect(lines).toHaveLength(30);
    expect(pages[0]!.page.lines).toBe(30);
    expect(new Set(lines.map((line) => line.account)).size).toBe(30);
    for (const line of lines) {
      expect(line.account).toMatch(/^acc_[0-9a-f]{64}$/u);
      expect(line.label).toMatch(/^合成/u);
    }
    // The subtotals, the left-out counts and the coverage are the scope's, on every page.
    for (const entry of pages) {
      expect(entry.subtotals).toEqual(pages[0]!.subtotals);
      expect(entry.leftOut).toEqual(pages[0]!.leftOut);
      expect(entry.liabilitiesCoverage).toBe("unknown");
    }
    const { byUnit, bySource } = pages[0]!.subtotals;
    expect(
      byUnit.map((entry) => [entry.unit, entry.status, entry.counted, entry.notCounted]),
    ).toEqual([
      ["AUD", "complete", 1, 0],
      ["EUR", "complete", 1, 0],
      // The two yen deposits that did not parse are reasons, never zeros.
      ["JPY", "partial", 27, 2],
      ["USD", "complete", 1, 0],
    ]);
    expect(byUnit.find((entry) => entry.unit === "USD")!.value).toBe("1234.56");
    expect(byUnit.find((entry) => entry.unit === "JPY")!.reasons).toEqual([
      "adoption:value_not_exact",
    ]);
    expect(bySource.map((entry) => [entry.source, entry.unit, entry.counted])).toEqual([
      ["mizuho-bank", "JPY", 6],
      ["sbi-securities", "AUD", 1],
      ["sbi-securities", "EUR", 1],
      ["sbi-securities", "USD", 1],
      ["sbi-shinsei-bank", "JPY", 12],
      ["sbi-vc-trade", "JPY", 1],
      ["smbc-bank", "JPY", 8],
    ]);
    expect(pages[0]!.leftOut).toEqual([
      { reason: "metric_unknown", rows: 1, metrics: ["unknown"], moreMetrics: 0 },
      {
        reason: "not_a_stock",
        rows: 7,
        metrics: ["deposit.available-balance", "broker.buying-power"],
        moreMetrics: 0,
      },
      {
        reason: "restates_a_balance",
        rows: 2,
        metrics: ["deposit.balance-after-transaction"],
        moreMetrics: 0,
      },
    ]);
  });

  it("adds what the latest page's known-assets subtotal adds, unit by unit", async () => {
    const cash = (await page.route(PATH)).body as CashPerAccountPage;
    const latest = (await page.route("/api/v2/balances/latest")).body as LatestBalanceSummaryPage;
    const known = latest.subtotals.knownAssetsSubtotal!;
    expect(cash.subtotals.byUnit.map((entry) => [entry.unit, entry.counted])).toEqual(
      known.map((entry) => [entry.unitRef, entry.adoptedCount]),
    );
    for (const entry of known) {
      const counted = cash.subtotals.byUnit.find((unit) => unit.unit === entry.unitRef)!;
      expect(counted.scale).toBe(entry.scale);
      expect(counted.value).toBe(
        decimalToString({ coefficient: entry.coefficient, scale: entry.scale }),
      );
    }
  });

  it("filters by source and unit, and refuses a metric, a view and a detail", async () => {
    const broker = await page.expectSameAnswer(`${PATH}?source=sbi-securities`, TOOL, {
      collection: "cash",
      source: "sbi-securities",
    });
    const body = broker.body as CashPerAccountPage;
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.references[0]!.amounts.map((amount) => amount.unit)).toEqual([
      "AUD",
      "EUR",
      "USD",
    ]);
    expect(body.subtotals.bySource.every((entry) => entry.source === "sbi-securities")).toBe(true);
    const usd = (await page.route(`${PATH}?instrument=USD`)).body as CashPerAccountPage;
    expect(usd.subtotals.byUnit.map((entry) => entry.unit)).toEqual(["USD"]);
    for (const [query, args] of [
      ["metric=deposit.balance", { metric: "deposit.balance" }],
      ["view=balances", { view: "balances" }],
      ["detail=summary", { detail: "summary" }],
    ] as const) {
      const refused = await page.expectSameAnswer(`${PATH}?${query}`, TOOL, {
        collection: "cash",
        ...args,
      });
      expect(refused.status).toBe(400);
      expect((refused.body as { error: string }).error).toBe("invalid_query");
    }
  });

  it("continues a cursor at another page size, and refuses it with other filters", async () => {
    const first = (await page.route(PATH)).body as CashPerAccountPage;
    const cursor = first.page.nextCursor!;
    const next = (await page.route(`${PATH}?limit=25&cursor=${encodeURIComponent(cursor)}`))
      .body as CashPerAccountPage;
    const seen = [...first.lines, ...next.lines].map((line) => line.account);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(30);
    expect(next.page.nextCursor).toBeNull();
    const mismatch = await page.expectSameAnswer(
      `${PATH}?source=smbc-bank&cursor=${encodeURIComponent(cursor)}`,
      TOOL,
      { collection: "cash", source: "smbc-bank", cursor },
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ error: "cursor_mismatch" });
    expect((mismatch.body as { mustMatch: string[] }).mustMatch).toContain("source");
    // A latest page's cursor belongs to another route.
    const latest = (await page.route("/api/v2/balances/latest")).body as LatestBalanceSummaryPage;
    const crossed = await page.route(
      `${PATH}?cursor=${encodeURIComponent(latest.page.nextCursor!)}`,
    );
    expect(crossed.status).toBe(400);
    expect(crossed.body).toMatchObject({ error: "cursor_mismatch" });
  });

  it("never adds two adopted amounts of one account reached through two references (INV06)", async () => {
    // A second provider reference of the bank whose identity maps it onto an
    // account the store already has: the projection adopts both (the
    // provider lists them apart), so the cash read is where the account
    // entity shows they are one account.
    // The bank's next capture lists it beside the accounts it listed before.
    const account = smbcCapture().accounts[0]!;
    await seedCashSource(
      smbcCapture([
        {
          rawAccount: "smbc-bank:synthetic-second-reference",
          label: account.label,
          entityOf: account.rawAccount,
          measurements: [{ metric: "account_balance", unit: "JPY", text: "1", minor: "1" }],
        },
      ]),
    );
    await buildSnapshot();
    const entity = await entityOf(account.rawAccount);
    const { pages } = await allPages({ source: "smbc-bank" });
    const lines = pages.flatMap((entry) => entry.lines);
    // Still one line per account: the account's two references are one line.
    expect(lines).toHaveLength(10);
    const twice = lines.find((line) => line.account === entity)!;
    expect(twice.references).toHaveLength(2);
    for (const reference of twice.references)
      expect(reference.amounts.map((amount) => [amount.counted, amount.reasons])).toEqual([
        [false, [CASH_REPORTED_TWICE]],
      ]);
    const yen = pages[0]!.subtotals.byUnit[0]!;
    expect(yen).toMatchObject({ unit: "JPY", status: "partial", counted: 7, notCounted: 4 });
    expect(yen.reasons).toContain(CASH_REPORTED_TWICE);
    expect(pages[0]!.dataCoverage.reasons).toContain(CASH_REPORTED_TWICE);
    // The latest page's subtotal keys on the provider reference, so it adds
    // both: the difference the ADR records as an open limit of that subtotal.
    const latest = (await page.route("/api/v2/balances/latest?source=smbc-bank"))
      .body as LatestBalanceSummaryPage;
    expect(latest.subtotals.knownAssetsSubtotal![0]!.adoptedCount).toBe(9);
  });
});

describe("the published tool", () => {
  it("names the cash collection within the description bound a client accepts", async () => {
    const listed = await page.mcpMessage({ method: "tools/list" });
    const tool = (
      listed["result"].tools as { name: string; description: string; inputSchema: any }[]
    ).find((entry) => entry.name === TOOL)!;
    expect(tool.description.length).toBeLessThanOrEqual(2048);
    expect(tool.inputSchema.properties.collection.enum).toEqual(["latest", "history", "cash"]);
    for (const term of [
      "`cash`",
      "deposit.balance",
      "broker.foreign-cash-deposit",
      "exchange.cash-balance",
      "byUnit",
      "bySource",
      "`leftOut`",
      CASH_REPORTED_TWICE,
      "liabilitiesCoverage unknown",
      "result_limit_exceeded",
    ])
      expect(tool.description, term).toContain(term);
    expect(env.READ).toBeDefined();
  });
});
