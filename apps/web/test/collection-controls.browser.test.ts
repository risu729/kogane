// Synthetic responses only: invented sources, accounts and dates.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { settledTest } from "./settle.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

let browser: Browser;
if (runnable) browser = await chromium.launch({ executablePath });
const test = settledTest();

describe.if(runnable)("server filter controls show the filter the URL applies", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  const listed: string[] = [];
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        // The options the store lists today: one source, one account, one unit, one kind.
        if (url.pathname === "/api/filter-options")
          return Response.json({
            sources: ["synthetic-bank"],
            accounts: [{ source_id: "synthetic-bank", source_account: "synthetic-account" }],
            instruments: ["JPY"],
            metrics: ["synthetic_balance"],
          });
        if (url.pathname === "/api/transactions") {
          listed.push(url.search);
          return Response.json({
            transactions: [],
            coverage: { limit: 500, truncated: false, nextOffset: null },
          });
        }
        if (url.pathname === "/api/balances") {
          listed.push(url.search);
          return Response.json({
            latest: [],
            history: [],
            coverage: { limit: 500, truncated: false, nextOffset: null, latestNextOffset: null },
          });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        return new Response(
          Bun.file(
            url.pathname.startsWith("/assets/")
              ? join(client, url.pathname)
              : join(client, "index.html"),
          ),
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function until(done: () => boolean): Promise<void> {
    for (let wait = 0; !done(); wait += 50) {
      if (wait > 10_000) throw new Error("the list was not requested");
      await Bun.sleep(50);
    }
  }

  /** A filter select; `name` is its accessible name or its label's first words. */
  function control(page: Page, name: string) {
    return page
      .getByLabel(name, { exact: true })
      .or(page.locator("label.filter-field", { hasText: name }).locator("select"));
  }

  /** The text of the option a select shows. */
  async function selected(page: Page, name: string): Promise<string> {
    const select = control(page, name);
    await select.waitFor({ timeout: 10_000 });
    return select.evaluate((element) => {
      const control = element as HTMLSelectElement;
      return control.selectedOptions[0]?.textContent ?? "";
    });
  }

  test("a source and account the options no longer list stay selected, marked as such", async () => {
    const page = await browser.newPage();
    try {
      listed.length = 0;
      await page.goto(`${origin}/transactions?source=retired-bank&account=retired-account`);
      await page.getByRole("heading", { name: "取引", exact: true }).waitFor();
      // The list is narrowed to the URL's source and account...
      await until(() => listed.includes("?source=retired-bank&account=retired-account"));
      // ...so the controls name them, not "every source" and "every account".
      expect(await selected(page, "全記録の取得元")).toBe("retired-bank（現在は一覧にありません）");
      expect(await selected(page, "全記録の口座")).toBe(
        "retired-account · retired-bank（現在は一覧にありません）",
      );
      // Choosing "every account" drops the unlisted account and keeps the source...
      await control(page, "全記録の口座").selectOption("");
      await page.waitForURL(`${origin}/transactions?source=retired-bank`);
      expect(await selected(page, "全記録の口座")).toBe("すべての口座");
      // ...and choosing a listed source drops the unlisted one and its marker.
      await control(page, "全記録の取得元").selectOption("synthetic-bank");
      await page.waitForURL(`${origin}/transactions?source=synthetic-bank`);
      expect(await selected(page, "全記録の取得元")).toBe("synthetic-bank");
      expect(
        await control(page, "全記録の取得元")
          .locator("option", { hasText: "retired-bank" })
          .count(),
      ).toBe(0);
      // A source and account that are listed read as before.
      await page.goto(`${origin}/transactions?source=synthetic-bank&account=synthetic-account`);
      await page.getByRole("heading", { name: "取引", exact: true }).waitFor();
      expect(await selected(page, "全記録の取得元")).toBe("synthetic-bank");
      expect(await selected(page, "全記録の口座")).toBe("synthetic-account · synthetic-bank");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a unit and kind the options do not list stay selected, marked as such", async () => {
    const page = await browser.newPage();
    try {
      listed.length = 0;
      await page.goto(`${origin}/balances?instrument=XXX&metric=retired_metric`);
      await page.getByRole("heading", { name: "残高", exact: true }).waitFor();
      await until(() => listed.some((search) => search.includes("instrument=XXX")));
      expect(await selected(page, "通貨・単位")).toBe("XXX（現在は一覧にありません）");
      expect(await selected(page, "残高の種類")).toBe("retired_metric（現在は一覧にありません）");
      // Choosing a listed kind replaces the unlisted one; "every" unit removes the unit.
      await control(page, "残高の種類").selectOption("synthetic_balance");
      await page.waitForURL(`${origin}/balances?instrument=XXX&metric=synthetic_balance`);
      await control(page, "通貨・単位").selectOption("");
      await page.waitForURL(`${origin}/balances?metric=synthetic_balance`);
      expect(await selected(page, "通貨・単位")).toBe("すべて");
      expect(await selected(page, "残高の種類")).toBe("synthetic_balance");
    } finally {
      await page.close();
    }
  }, 30_000);
});
