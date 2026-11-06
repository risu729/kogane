// 口座・銘柄の整理 in the production client: the instrument counts per source
// (ADR 0073) come from the application service itself over the synthetic
// resolution world (packages/application/test/instrument-resolution-world.ts);
// the account coverage beside them is a fixed synthetic page. A refusal is
// shown as its reason, never as zeros, and no total across sources appears.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { readInstrumentCoverage } from "../../../packages/application/src/query/instrument-coverage.ts";
import {
  BROKER_B,
  world,
  type World,
} from "../../../packages/application/test/instrument-resolution-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const GRANT = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
} as const;
const PANEL = 'section[aria-labelledby="identity-instrument-coverage"]';
const PAGE = { limit: 100, truncated: false, nextOffset: null };

describe.if(runnable)("instrument counts on the identity page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let store: World;
  let refuse = false;
  const read: URL[] = [];

  beforeAll(async () => {
    store = await world();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        if (url.pathname === "/api/identity/instrument-coverage") {
          read.push(url);
          if (refuse)
            return Response.json(
              {
                schemaVersion: "financial-error-v1",
                code: "budget_exceeded",
                requestId: "instruments.coverage",
                refs: ["budget:identityObservations=500000"],
              },
              { status: 413 },
            );
          const outcome = await readInstrumentCoverage({
            grant: GRANT,
            sql: store.sql,
            source: url.searchParams.get("source"),
          });
          if (!outcome.ok) throw new Error(outcome.error.code);
          return Response.json(outcome.coverage);
        }
        if (url.pathname === "/api/identity/coverage")
          return Response.json({
            rows: [
              {
                source: "sbi-securities",
                eligible: 8,
                organized: 8,
                identified: 0,
                providerLocal: 8,
                aggregate: 0,
                unresolved: 0,
              },
            ],
            coverage: PAGE,
          });
        if (url.pathname === "/api/identity/connections") return Response.json({ connections: [] });
        if (url.pathname === "/api/identity/accounts")
          return Response.json({ rows: [], coverage: PAGE });
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "/index.html" : url.pathname));
        return (await file.exists())
          ? new Response(file)
          : new Response(Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function open(width: number) {
    const tab = await browser.newPage({ viewport: { width, height: 1000 } });
    await tab.goto(`${origin}/identities`);
    await tab.getByRole("heading", { name: "口座・銘柄の整理", exact: true }).waitFor();
    return tab;
  }

  for (const width of [1280, 390])
    test(`shows each source's identifiers by state at ${String(width)} px`, async () => {
      refuse = false;
      const tab = await open(width);
      const region = tab.getByRole("region", { name: "銘柄の整理状況" });
      await region.locator("tbody tr").first().waitFor();
      const headers = await region.locator("thead th").allInnerTexts();
      expect(headers).toEqual([
        "取得元",
        "識別子",
        "未判断の候補あり",
        "判断により同じ銘柄",
        "判断の記録なしで同じ銘柄（要確認）",
        "別の銘柄と判断済み",
        "候補なし",
      ]);
      const rows = await region
        .locator("tbody tr")
        .evaluateAll((trs) =>
          trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent)),
        );
      expect(rows).toEqual([
        ["sbi-securities", "8", "4", "0", "0", "0", "4"],
        [BROKER_B, "3", "1", "0", "0", "0", "2"],
      ]);
      // Counts only: no total across sources, no rate.
      const table = await region.locator("table").innerText();
      expect(table).not.toContain("合計");
      expect(table).not.toContain("%");
      expect(await tab.locator(PANEL).innerText()).toContain("取得元をまたいだ合計はありません");
      // The page itself never scrolls sideways; the table scrolls in its region.
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
        true,
      );
      await tab.close();
    });

  test("the source filter narrows the counts to that source", async () => {
    refuse = false;
    read.length = 0;
    const tab = await open(1280);
    await tab.getByLabel("取得元", { exact: true }).fill(BROKER_B);
    await tab.getByRole("button", { name: "絞り込む" }).click();
    const region = tab.getByRole("region", { name: "銘柄の整理状況" });
    await tab.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="銘柄の整理状況"] tbody tr').length === 1 &&
        document.querySelector('[aria-label="銘柄の整理状況"] tbody td')?.textContent !==
          "sbi-securities",
    );
    expect(await region.locator("tbody td").first().innerText()).toBe(BROKER_B);
    expect(read.some((url) => url.searchParams.get("source") === BROKER_B)).toBe(true);
    await tab.close();
  });

  test("a refused read shows its reason, never a row of zeros", async () => {
    refuse = true;
    const tab = await open(390);
    const panel = tab.locator(PANEL);
    await panel.getByText("表示上限を超えています", { exact: false }).waitFor();
    expect(await panel.locator("table").count()).toBe(0);
    // The account coverage above is its own read and still renders.
    await tab.getByRole("region", { name: "口座の整理状況" }).locator("tbody tr").waitFor();
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await tab.close();
  });
});
