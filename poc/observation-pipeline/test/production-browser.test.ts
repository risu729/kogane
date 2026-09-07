// Local, synthetic integration only: the production bundle and both API families.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import { buildFixture, HOSTILE_DESCRIPTION } from "./fixture.ts";

const client = join(import.meta.dir, "../web/dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("production browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}

describe.if(runnable)("combined production client", () => {
  const fixture = buildFixture();
  const observation = fixture.store.db
    .query("SELECT id FROM transaction_observations WHERE description = ?")
    .get(HOSTILE_DESCRIPTION) as { id: number };
  const requests: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    const api = createApi(fixture.store);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
            parsingHealth: { pending: 0, running: 0, failed: 1 },
          });
        if (url.pathname === "/api/filter-options")
          return Response.json({
            sources: ["demo-bank", "opaque-source-" + "a".repeat(64)],
            accounts: [{ source_id: "demo-bank", source_account: "demo-bank:main" }],
            instruments: ["JPY"],
            metrics: ["ledger"],
          });
        if (url.pathname === "/api/evidence/v1/meta")
          return Response.json({
            apiVersion: "evidence-v1",
            source: { kind: "central-raw-store", classification: "financial" },
            capabilities: {
              readOnly: true,
              rawEvidence: true,
              parsedObservations: false,
              liveCollectors: false,
            },
            sources: [{ id: "sony-bank", label: "テスト銀行" }],
          });
        if (url.pathname === "/api/evidence/v1/sources/sony-bank/runs")
          return Response.json({
            apiVersion: "evidence-v1",
            sourceId: "sony-bank",
            coverage: "sealed-only",
            items: [],
            nextCursor: null,
          });
        if (url.pathname.startsWith("/api/")) {
          // Use the real observation DTOs, adding the production pagination envelope.
          const clean = new URL(url);
          clean.search = "";
          const response = await api.fetch(new Request(clean));
          if (["/api/artifacts", "/api/transactions"].includes(url.pathname)) {
            const value = (await response.json()) as Record<string, unknown>;
            if (url.pathname === "/api/transactions") {
              value["transactions"] = (value["transactions"] as Record<string, unknown>[]).map(
                (row) => ({ ...row, source_account: `account-hmac-${"a".repeat(128)}` }),
              );
            }
            if (url.pathname === "/api/artifacts" && url.searchParams.has("cursor"))
              value["artifacts"] = (value["artifacts"] as Record<string, unknown>[]).map((row) => ({
                ...row,
                dataset: "SECOND_PAGE_SENTINEL",
              }));
            return Response.json({
              ...value,
              coverage: {
                limit: 500,
                truncated: !url.searchParams.has("cursor") && !url.searchParams.has("offset"),
                ...(url.pathname === "/api/artifacts"
                  ? { nextCursor: url.searchParams.has("cursor") ? null : "1" }
                  : { nextOffset: url.searchParams.has("offset") ? null : 500 }),
              },
            });
          }
          return response;
        }
        const file = Bun.file(
          url.pathname.startsWith("/assets/")
            ? join(client, url.pathname)
            : join(client, "index.html"),
        );
        return new Response(file, {
          headers: {
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          },
        });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("all observation routes render under production CSP at desktop and mobile widths", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const [path, expected] of [
        ["/", "Demo Bank"],
        ["/transactions", HOSTILE_DESCRIPTION],
        ["/balances", "248,820"],
        ["/positions", "EXAMPLE <FUND>"],
        ["/artifacts", "statement"],
        [`/artifacts/${fixture.artifactId}`, "現行の解析"],
        [`/observations/transaction/${observation.id}`, "json:$.rows[0]"],
        ["/evidence", "テスト銀行"],
      ]) {
        await page.goto(origin + path, { waitUntil: "networkidle" });
        expect(await page.locator("h1").count()).toBe(1);
        const text = await page.locator("body").innerText();
        expect(text).toContain(expected!);
        for (const error of [
          "データの形式が対応していません",
          "データを取得できませんでした",
          "指定されたデータが見つかりません",
          "ページが見つかりません",
        ])
          expect(text).not.toContain(error);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);

  test("evidence navigation preserves observation routes and does not deny available parsing", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/evidence", { waitUntil: "networkidle" });
    expect(await page.locator("body").innerText()).not.toContain("解析結果はまだ提供していません");
    for (const name of ["取引", "残高", "保有資産", "原本・証跡", "ホーム"])
      expect(
        await page
          .getByRole("navigation", { name: "メインナビゲーション" })
          .getByRole("link", { name, exact: true })
          .count(),
      ).toBe(1);
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "取引", exact: true })
      .click();
    await page.waitForLoadState("networkidle");
    expect(await page.locator("h1").innerText()).toBe("取引");
    await page.goBack();
    expect(await page.locator("h1").innerText()).toBe("取得履歴と原本");
    await page.close();
  });

  test("query-only paging, filtering, reset and back refetch correct production pages", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/artifacts?source=demo-bank", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "次の500件" }).click();
    await page.locator("td").filter({ hasText: "SECOND_PAGE_SENTINEL" }).first().waitFor();
    expect(requests).toContain("/api/artifacts?source=demo-bank&cursor=1");
    expect(await page.locator("body").innerText()).toContain("SECOND_PAGE_SENTINEL");
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "原本・証跡", exact: true })
      .click();
    await page.locator("td").filter({ hasText: "statement" }).first().waitFor();
    expect(new URL(page.url()).search).toBe("");
    expect(await page.locator("body").innerText()).not.toContain("SECOND_PAGE_SENTINEL");
    await page.getByLabel("全記録の取得元", { exact: true }).selectOption("demo-bank");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).search).toBe("?source=demo-bank");
    await page.goBack();
    await page.waitForLoadState("networkidle");
    expect(await page.getByLabel("全記録の取得元", { exact: true }).inputValue()).toBe("");
    await page.close();
  });

  test("observation provenance links to its artifact and protected original without auto-fetch", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/observations/transaction/${observation.id}`, {
      waitUntil: "networkidle",
    });
    expect(await page.locator("body").innerText()).toContain("json:$.rows[0]");
    const raw = page.locator(`a[href='/api/raw/${fixture.sha256}']`).first();
    expect(await raw.count()).toBe(1);
    expect(requests.some((path) => path.startsWith("/api/raw/"))).toBe(false);
    await page.locator(`a[href='/artifacts/${fixture.artifactId}']`).first().click();
    await page.getByText("現行の解析", { exact: true }).waitFor();
    expect(await page.locator("body").textContent()).toContain("demo-statement");
    await page.goBack();
    await page.getByText("json:$.rows[0]", { exact: true }).first().waitFor();
    expect(await page.locator("body").innerText()).toContain("json:$.rows[0]");
    await page.close();
  });

  test("search drafts do not navigate per keystroke and invalid date ranges do not submit", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/transactions", { waitUntil: "networkidle" });
    await page.getByLabel("内容を検索", { exact: true }).fill("日本語の検索");
    expect(new URL(page.url()).search).toBe("");
    await page.getByLabel("開始日", { exact: true }).fill("2026-09-02");
    await page.getByLabel("終了日", { exact: true }).fill("2026-09-01");
    expect(await page.getByRole("button", { name: "検索条件を適用" }).isDisabled()).toBe(true);
    await page.getByLabel("終了日", { exact: true }).fill("2026-09-03");
    await page.getByRole("button", { name: "検索条件を適用" }).click();
    expect(new URL(page.url()).searchParams.get("q")).toBe("日本語の検索");
    expect(new URL(page.url()).searchParams.get("from")).toBe("2026-09-02");
    await page.goBack();
    expect(new URL(page.url()).search).toBe("");
    await page.close();
  });
});
