// Column geometry needs a real layout engine: API tests cannot catch clipped money.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import type { TransactionRow } from "../shared/api-contract.ts";
import { buildFixture } from "./fixture.ts";

const clients = {
  local: join(import.meta.dir, "../web/dist"),
  central: join(import.meta.dir, "../web/dist-production"),
};
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const built = Object.values(clients).every((path) => existsSync(join(path, "index.html")));
const runnable = built && existsSync(executablePath);
if (!runnable) {
  console.log("table layout browser: build, build:production and Chromium required");
  if (!built || process.env["CI"] === "true") process.exitCode = 1;
}

const source = `synthetic-bank-${"long-source-".repeat(10)}`;
const account = `synthetic-account-${"0123456789abcdef".repeat(12)}`;
const description =
  "海外送金の精算・長い取引内容が金額や取得元を押し潰さずに読めることを確認するための合成記録";
const minor = "900719925474099312345";
const fallback = `unparsed-provider-amount-${"1234567890".repeat(8)}`;

describe.if(runnable)("transaction columns at desktop and phone widths", () => {
  const fixture = buildFixture();
  let browser: Browser;
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const origins: Record<string, string> = {};

  beforeAll(async () => {
    const api = createApi(fixture.store);
    for (const [mode, client] of Object.entries(clients)) {
      const central = mode === "central";
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/meta") {
            return Response.json({
              apiVersion: 1,
              source: {
                kind: central ? "central-store" : "local-store",
                classification: "synthetic",
              },
              capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
            });
          }
          if (url.pathname === "/api/filter-options") {
            return Response.json({
              sources: [source],
              accounts: [{ source_id: source, source_account: account }],
              instruments: ["JPY"],
              metrics: [],
            });
          }
          if (url.pathname === "/api/transactions") {
            const response = await api.fetch(
              new Request(new URL("/api/transactions", request.url)),
            );
            const value = (await response.json()) as { transactions: TransactionRow[] };
            const seed = value.transactions[0]!;
            return Response.json({
              transactions: [
                {
                  ...seed,
                  id: 1,
                  source_id: source,
                  source_account: account,
                  description,
                  amount_minor: minor,
                  amount_text: null,
                  currency: "JPY",
                  as_of: "2026-09-08",
                  status: "posted",
                },
                {
                  ...seed,
                  id: 2,
                  source_id: "another-synthetic-bank",
                  source_account: "everyday",
                  description: "別の合成記録",
                  amount_minor: "-1200",
                  currency: "JPY",
                  as_of: "2026-09-07",
                },
                {
                  ...seed,
                  id: 3,
                  source_id: "synthetic-fallback",
                  source_account: "unparsed",
                  description: "未解析金額の合成記録",
                  amount_minor: null,
                  amount_text: fallback,
                  currency: "UNKNOWN",
                  as_of: "2026-09-06",
                },
              ],
              ...(central ? { coverage: { limit: 500, truncated: false, nextOffset: null } } : {}),
            });
          }
          if (url.pathname.startsWith("/api/")) return api.fetch(request);
          return new Response(
            Bun.file(
              url.pathname.startsWith("/assets/")
                ? join(client, url.pathname)
                : join(client, "index.html"),
            ),
          );
        },
      });
      servers.push(server);
      origins[mode] = `http://127.0.0.1:${server.port}`;
    }
    browser = await chromium.launch({ executablePath });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) server.stop(true);
    fixture.store.db.close();
  });

  for (const mode of ["local", "central"] as const) {
    for (const width of [390, 1280]) {
      test(`${mode} at ${width}px preserves identifiers, amounts and keyboard access`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.goto(`${origins[mode]}/transactions`, { waitUntil: "networkidle" });
          const table = page.locator(".transaction-table");
          await table.waitFor();
          const row = table.locator("tbody tr").filter({ hasText: description });
          expect(await table.locator("thead th").count()).toBe(6);
          expect(await row.locator(".col-source").innerText()).toBe(`${source}\n${account}`);
          expect(await row.locator(".col-description").innerText()).toContain(description);
          expect(await row.locator(".amount").innerText()).toContain("900,719,925,474,099,312,345");
          const geometry = await row.evaluate((element) => {
            const amount = element.querySelector<HTMLElement>(".amount")!;
            const cell = element.querySelector<HTMLElement>(".col-amount")!;
            const text = amount.getBoundingClientRect();
            const bounds = cell.getBoundingClientRect();
            return {
              amountLeft: text.left,
              amountRight: text.right,
              cellLeft: bounds.left,
              cellRight: bounds.right,
              descriptionWidth: element.querySelector(".col-description")!.getBoundingClientRect()
                .width,
              pageWidth: document.documentElement.clientWidth,
              pageScrollWidth: document.documentElement.scrollWidth,
              sourceClipped:
                element.querySelector<HTMLElement>(".col-source")!.scrollWidth >
                element.querySelector<HTMLElement>(".col-source")!.clientWidth + 1,
            };
          });
          expect(geometry.descriptionWidth).toBeGreaterThanOrEqual(180);
          expect(geometry.amountLeft).toBeGreaterThanOrEqual(geometry.cellLeft);
          expect(geometry.amountRight).toBeLessThanOrEqual(geometry.cellRight);
          expect(geometry.sourceClipped).toBe(false);
          expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageWidth + 1);
          const fallbackRow = table.locator("tbody tr").filter({ hasText: "未解析金額の合成記録" });
          expect(await fallbackRow.locator(".amount").innerText()).toContain(fallback);
          const fallbackBounds = await fallbackRow.evaluate((element) => {
            const text = element.querySelector(".amount")!.getBoundingClientRect();
            const cell = element.querySelector(".col-amount")!.getBoundingClientRect();
            return {
              textLeft: text.left,
              textRight: text.right,
              cellLeft: cell.left,
              cellRight: cell.right,
            };
          });
          expect(fallbackBounds.textLeft).toBeGreaterThanOrEqual(fallbackBounds.cellLeft);
          expect(fallbackBounds.textRight).toBeLessThanOrEqual(fallbackBounds.cellRight);
          const region = page
            .getByRole("region", { name: "取引の記録", exact: true })
            .and(page.locator("[tabindex]"));
          await region.focus();
          expect(await region.evaluate((element) => document.activeElement === element)).toBe(true);
          if (width === 390) {
            const before = await region.evaluate((element) => element.scrollLeft);
            await page.keyboard.press("ArrowRight");
            await page.waitForFunction(
              () => (document.querySelector(".table-scroll")?.scrollLeft ?? 0) > 0,
            );
            expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
          }
          if (mode === "central") {
            expect(await table.locator("thead button").count()).toBe(0);
            expect(await table.locator("th[aria-sort]").count()).toBe(0);
          } else {
            await table.getByRole("button", { name: "内容", exact: true }).focus();
            await page.keyboard.press("Enter");
            expect(await table.locator("th[aria-sort]").count()).toBe(1);
            await table.getByRole("button", { name: "取引の基準日", exact: true }).focus();
            await page.keyboard.press("Enter");
            expect(await table.locator("th[aria-sort]").count()).toBe(1);
            expect(await table.locator("th.col-date").getAttribute("aria-sort")).toBe("ascending");
            expect(await table.locator("tbody .col-date").allTextContents()).toEqual([
              "2026-09-06",
              "2026-09-07",
              "2026-09-08",
            ]);
            await page.keyboard.press("Enter");
            expect(await table.locator("tbody .col-date").allTextContents()).toEqual([
              "2026-09-08",
              "2026-09-07",
              "2026-09-06",
            ]);
          }
          const screenshots = process.env["UI_REVIEW_SCREENSHOTS"];
          if (screenshots) {
            mkdirSync(screenshots, { recursive: true });
            await region.evaluate((element) => {
              element.scrollLeft = 0;
            });
            await page.screenshot({
              path: join(screenshots, `transactions-${mode}-${width}.png`),
              fullPage: true,
            });
          }
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
