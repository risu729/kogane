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
  CASH_PAGE_BYTES,
  CASH_REPORTED_TWICE,
  cashAnswerBytes,
  type CashPerAccountPage,
  type LatestBalanceSummaryPage,
} from "../../../packages/observation-shared/src/api-contract";
import { projectionMeasureSql } from "../../../packages/read-model/src/balance-projection-sql";
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
      // The tool takes the page size as a number.
      ...(args["limit"] === undefined ? {} : { limit: Number(args["limit"]) }),
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
    // The rest at 25 measurements a page, each page ending at 8 KB first if it comes first.
    const rest: CashPerAccountPage[] = [];
    let next: string | null = cursor;
    while (next !== null) {
      const body = (await page.route(`${PATH}?limit=25&cursor=${encodeURIComponent(next)}`))
        .body as CashPerAccountPage;
      expect(body.page.limit).toBe(25);
      rest.push(body);
      next = body.page.nextCursor;
    }
    expect(rest[0]!.lines.length).toBeGreaterThan(first.lines.length);
    const seen = [...first.lines, ...rest.flatMap((entry) => entry.lines)].map(
      (line) => line.account,
    );
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(30);
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
    // account the store already has: the provider lists them apart, but the
    // projection sees one account entity and leaves both unresolved, so the
    // cash read shows both on one line and counts neither.
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
        [false, ["adoption:account_entity_shared"]],
      ]);
    const yen = pages[0]!.subtotals.byUnit[0]!;
    expect(yen).toMatchObject({ unit: "JPY", status: "partial", counted: 7, notCounted: 4 });
    expect(yen.reasons).toContain("adoption:account_entity_shared");
    expect(pages[0]!.dataCoverage.reasons).toContain("unresolved:account_entity_shared");
    // The latest page's subtotal adds neither reference either: both reads
    // agree on the 7 amounts they count.
    const latest = (await page.route("/api/v2/balances/latest?source=smbc-bank"))
      .body as LatestBalanceSummaryPage;
    expect(latest.subtotals.knownAssetsSubtotal![0]!.adoptedCount).toBe(7);
  });

  it("expires a cursor when an identity decision regroups lines anywhere in the scope", async () => {
    const first = (await page.route(PATH)).body as CashPerAccountPage;
    expect(first.page.hasMore).toBe(true);
    // A reference of a line the first page did not reach is mapped onto the
    // account of a line it did: the line at the cursor stays where it was,
    // but the rest of the walk and the subtotals now answer another grouping.
    const seen = first.lines[0]!;
    const unseen = (await page.route(`${PATH}?limit=500`)).body as CashPerAccountPage;
    const moved = unseen.lines.at(-1)!;
    expect(first.lines.map((line) => line.account)).not.toContain(moved.account);
    const observation = moved.references[0]!.amounts[0]!.observationId;
    const reference = (await env.DB.prepare(
      "SELECT source_account_id FROM identity_observations WHERE kind='balance' AND observation_id=?",
    )
      .bind(observation)
      .first<string>("source_account_id"))!;
    await env.DB.prepare(
      `INSERT INTO account_mappings
         SELECT ?1, ?2, max(revision)+1, ?3, 'manual', 'synthetic-merge', 1, '2026-11-19T00:00:00Z', ?4, 'provider-local'
         FROM account_mappings WHERE source_account_id=?2`,
    )
      .bind(`cash-regroup-${String(observation)}`, reference, seen.account, seen.label)
      .run();
    const next = await page.expectSameAnswer(
      `${PATH}?cursor=${encodeURIComponent(first.page.nextCursor!)}`,
      TOOL,
      { collection: "cash", cursor: first.page.nextCursor! },
    );
    expect(next.status).toBe(410);
    expect(next.body).toMatchObject({ error: "context_expired" });
    // A fresh walk reads the new grouping: one line fewer, the moved reference on the seen line.
    const fresh = (await page.route(`${PATH}?limit=500`)).body as CashPerAccountPage;
    expect(fresh.page.lines).toBe(unseen.page.lines - 1);
  });

  it("holds every page to 8 KB as /mcp writes it, and refuses one line that cannot fit", async () => {
    // The bytes the page is held to are the text `/mcp` answers.
    const answer = await page.mcpMessage({
      method: "tools/call",
      params: { name: TOOL, arguments: { collection: "cash", limit: 500 } },
    });
    const text = answer["result"].content[0].text as string;
    const body = answer["result"].structuredContent.data as CashPerAccountPage;
    expect(new TextEncoder().encode(text).length).toBe(cashAnswerBytes(body));
    expect(cashAnswerBytes(body)).toBeLessThanOrEqual(CASH_PAGE_BYTES);
    // `limit` 500 would take every line; the bytes end the page first, and the walk lists each once.
    expect(body.page.hasMore).toBe(true);
    const { pages, sizes } = await allPages({ limit: "500" });
    for (const size of sizes) expect(size).toBeLessThanOrEqual(CASH_PAGE_BYTES);
    expect(pages.flatMap((entry) => entry.lines)).toHaveLength(body.page.lines);
    // An account whose label alone passes the bytes: no page can hold its line.
    const line = pages.at(-1)!.lines.at(-1)!;
    const observation = line.references[0]!.amounts[0]!.observationId;
    const reference = (await env.DB.prepare(
      "SELECT source_account_id FROM identity_observations WHERE kind='balance' AND observation_id=?",
    )
      .bind(observation)
      .first<string>("source_account_id"))!;
    const entity = `acc_${"e".repeat(64)}`;
    const label = "合成".padEnd(3_000, "円");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts VALUES (?,?,'cash','provider-local')").bind(
        entity,
        label,
      ),
      env.DB.prepare(
        `INSERT INTO account_mappings
           SELECT ?1, ?2, max(revision)+1, ?3, 'manual', 'synthetic-long-label', 1, '2026-11-19T00:00:00Z', ?4, 'provider-local'
           FROM account_mappings WHERE source_account_id=?2`,
      ).bind(`cash-long-${String(observation)}`, reference, entity, label),
    ]);
    const source = line.references[0]!.source;
    const refused = await page.expectSameAnswer(`${PATH}?source=${source}`, TOOL, {
      collection: "cash",
      source,
    });
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({ error: "result_limit_exceeded" });
  });
});

describe("the measure read on D1", () => {
  it("searches one snapshot by key under every filter the route takes, without table statistics", async () => {
    // No ANALYZE has run on the READ database: the planner has no statistics.
    const stats = await env.READ.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'",
    ).first<number>("n");
    expect(stats).toBe(0);
    for (const scope of [
      {},
      { source: "smbc-bank" },
      { account: "smbc-bank:synthetic-ordinary-0012" },
      { instrument: "JPY" },
      { source: "smbc-bank", account: "smbc-bank:synthetic-ordinary-0012", instrument: "JPY" },
    ]) {
      const query = projectionMeasureSql("a".repeat(64), scope);
      const plan = await env.READ.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.args)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(" | ");
      expect(detail, JSON.stringify(scope)).toMatch(
        /SEARCH current_balance_projection USING INDEX current_balance_projection_order \(snapshot_id=\?/u,
      );
      expect(detail, JSON.stringify(scope)).not.toContain("SCAN current_balance_projection");
      expect(detail, JSON.stringify(scope)).not.toMatch(/USE TEMP B-TREE/u);
    }
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
