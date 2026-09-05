// End-to-end smoke tests through a real browser.
//
// These exist for the one thing the API tests cannot check: that the client
// actually renders, and that the invariants survive the round trip through
// JSON and React. They are deliberately few — the API tests cover the query
// logic far more cheaply, and duplicating them here would be pure cost.
//
// What is worth a browser is the provenance walk: holding an observation and
// the bytes it came from at the same time is the whole point of this tool.
//
// Skipped unless a Chromium binary is available. The environment provides one
// at PLAYWRIGHT_BROWSERS_PATH; CHROMIUM_PATH overrides it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import {
  insertObservation,
  insertParseRun,
  supersedeOlderParseRuns,
} from "../src/store.ts";
import { buildFixture, RETIRED_DESCRIPTION } from "./fixture.ts";

const CLIENT_DIR = join(import.meta.dir, "..", "web", "dist");

function chromiumPath(): string | undefined {
  const explicit = process.env["CHROMIUM_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  const installed = chromium.executablePath();
  if (existsSync(installed)) return installed;
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root || !existsSync(root)) return undefined;
  // The installed build number varies; take whichever full chromium is present.
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium-")) continue;
    for (const relative of [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
      "chrome-win64/chrome.exe",
    ]) {
      const candidate = join(root, entry, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const executablePath = chromiumPath();
const clientBuilt = existsSync(join(CLIENT_DIR, "index.html"));
const runnable = executablePath !== undefined && clientBuilt;

if (!runnable) {
  const reason = !clientBuilt
    ? "the client is not built (run `bun run build`)"
    : "no Chromium binary was found";
  console.log(`browser tests skipped: ${reason}`);
  // A missing Chromium is an environment fact and skipping is right. A missing
  // build is a step the developer forgot, and reporting it as a green run
  // would let a broken client pass unnoticed, so it fails the suite instead.
  if (!clientBuilt || process.env["CI"] === "true") {
    process.exitCode = 1;
    console.log(
      "  -> failing the suite: `bun test` cannot vouch for a client that was never built",
    );
  }
}

describe.if(runnable)("evidence browser in a real browser", () => {
  const fixture = buildFixture();
  let browser: Browser;
  let baseUrl: string;
  let server: ReturnType<typeof Bun.serve>;
  const consoleErrors: string[] = [];

  const TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    // A second parse run whose output must never reach a current view, but
    // must stay reachable through the artifact that produced it.
    const staleRunId = insertParseRun(fixture.store, {
      artifactId: fixture.artifactId,
      parserName: "browser-probe",
      parserVersion: "0.1.0",
      parsedAt: "2026-08-28T00:00:00Z",
      status: "ok",
      warnings: [],
    });
    insertObservation(fixture.store, staleRunId, {
      kind: "transaction",
      sourceAccount: "probe:account",
      description: RETIRED_DESCRIPTION,
      amountMinor: 7,
      currency: "JPY",
      rawLocator: "json:$",
      extra: {},
    });
    const freshRunId = insertParseRun(fixture.store, {
      artifactId: fixture.artifactId,
      parserName: "browser-probe",
      parserVersion: "0.2.0",
      parsedAt: "2026-08-28T00:00:01Z",
      status: "ok",
      warnings: [],
    });
    insertObservation(fixture.store, freshRunId, {
      kind: "transaction",
      sourceAccount: "probe:account",
      // Provider text shaped like markup must reach the screen as text.
      description: "BROWSER_FRESH <script>window.__xss = true</script>",
      amountMinor: -1180,
      currency: "JPY",
      rawLocator: "json:$",
      extra: {},
    });
    supersedeOlderParseRuns(
      fixture.store,
      fixture.artifactId,
      "browser-probe",
      freshRunId,
    );

    const app = createApi(fixture.store, {
      serveClient: async (request) => {
        const pathname = new URL(request.url).pathname;
        const candidate = join(CLIENT_DIR, pathname);
        if (candidate.startsWith(CLIENT_DIR) && pathname !== "/") {
          const file = Bun.file(candidate);
          if (await file.exists()) return new Response(file);
        }
        return new Response(Bun.file(join(CLIENT_DIR, "index.html")));
      },
    });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: executablePath! });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function open(path: string): Promise<{ text: string; xss: boolean }> {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push(`${path}: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      consoleErrors.push(`${path}: ${error.message}`),
    );
    await page.goto(baseUrl + path, { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    const xss = await page.evaluate(
      () => (globalThis as { __xss?: boolean }).__xss === true,
    );
    await page.close();
    return { text, xss };
  }

  test(
    "every view renders without a console error",
    async () => {
      for (const path of [
        "/",
        "/transactions",
        "/balances",
        "/positions",
        "/artifacts",
        `/artifacts/${fixture.artifactId}`,
        "/observations/transaction/1",
        "/no-such-view",
      ]) {
        const { text } = await open(path);
        expect(text.length).toBeGreaterThan(100);
      }
      expect(consoleErrors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a superseded observation is hidden here and reachable there",
    async () => {
      const current = await open("/transactions");
      expect(current.text).toContain("BROWSER_FRESH");
      expect(current.text).not.toContain(RETIRED_DESCRIPTION);

      const artifact = await open(`/artifacts/${fixture.artifactId}`);
      expect(artifact.text).toContain(RETIRED_DESCRIPTION);
      expect(artifact.text).toContain("旧");
    },
    TIMEOUT_MS,
  );

  test(
    "provider text shaped like markup renders as text, not as an element",
    async () => {
      const { text, xss } = await open("/transactions");
      expect(xss).toBe(false);
      expect(text).toContain("<script>window.__xss = true</script>");
    },
    TIMEOUT_MS,
  );

  test(
    "amounts are formatted from minor units, never through a float",
    async () => {
      const { text } = await open("/transactions");
      expect(text).toContain("-1,180 JPY");
      expect(text).toContain("1,024.53 USD");
    },
    TIMEOUT_MS,
  );

  test(
    "the provenance walk reaches the bytes",
    async () => {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/observations/transaction/1`, {
        waitUntil: "networkidle",
      });
      const text = await page.locator("body").innerText();
      for (const step of ["解析", "原本", "取得"]) {
        expect(text).toContain(step);
      }
      const href = await page
        .locator('a[href^="/api/raw/"]')
        .first()
        .getAttribute("href");
      expect(href).toMatch(/^\/api\/raw\/[0-9a-f]{64}$/u);

      // The link is not decoration: it returns the exact stored bytes.
      const response = await page.request.get(baseUrl + href!);
      expect(response.status()).toBe(200);
      const digest = new Bun.CryptoHasher("sha256")
        .update(new Uint8Array(await response.body()))
        .digest("hex");
      expect(href).toBe(`/api/raw/${digest}`);
      await page.close();
    },
    TIMEOUT_MS,
  );

  test(
    "source and date filters narrow observations without treating missing dates as matches",
    async () => {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/transactions`, { waitUntil: "networkidle" });
      await page
        .getByLabel("取得元", { exact: true })
        .selectOption("demo-bank");
      await page.getByLabel("開始日", { exact: true }).fill("2026-08-20");
      await page.getByLabel("終了日", { exact: true }).fill("2026-08-20");
      const rows = page.locator("tbody");
      expect(await rows.innerText()).toContain("Inbound transfer");
      expect(await rows.innerText()).not.toContain("BROWSER_FRESH");
      expect(await rows.innerText()).not.toContain("Coffee");
      await page
        .getByRole("button", { name: "条件をクリア", exact: true })
        .click();
      expect(await rows.innerText()).toContain("BROWSER_FRESH");
      await page.close();
    },
    TIMEOUT_MS,
  );

  test(
    "request failures are visible and retry recovers instead of claiming an empty store",
    async () => {
      const page = await browser.newPage();
      let fail = true;
      await page.route("**/api/transactions", async (route) => {
        if (!fail) return route.continue();
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "private-upstream-diagnostic-must-not-render",
          }),
        });
      });
      await page.goto(`${baseUrl}/transactions`);
      await page.locator("main").getByRole("alert").waitFor();
      expect(await page.locator("body").innerText()).not.toContain(
        "private-upstream-diagnostic",
      );
      expect(await page.locator("tbody").count()).toBe(0);
      fail = false;
      await page
        .locator("main")
        .getByRole("button", { name: "再試行", exact: true })
        .click();
      await page.getByText("BROWSER_FRESH", { exact: false }).waitFor();
      await page.close();
    },
    TIMEOUT_MS,
  );

  test(
    "mobile views keep navigation and tables within the viewport",
    async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      for (const path of [
        "/",
        "/transactions",
        "/balances",
        "/positions",
        "/artifacts",
      ]) {
        await page.goto(baseUrl + path, { waitUntil: "networkidle" });
        const dimensions = await page.evaluate(() => ({
          width: window.innerWidth,
          document: document.documentElement.scrollWidth,
        }));
        expect(dimensions.document).toBeLessThanOrEqual(dimensions.width + 1);
        expect(await page.getByRole("navigation").count()).toBeGreaterThan(0);
      }
      await page.close();
    },
    TIMEOUT_MS,
  );

  test(
    "large responses render 50 rows at a time and filtering resets the page",
    async () => {
      const page = await browser.newPage();
      await page.route("**/api/transactions", async (route) => {
        const original = await route.fetch();
        const data = await original.json();
        const transactions = Array.from({ length: 125 }, (_, index) => ({
          ...data.transactions[0],
          id: index + 1000,
          description: `Pagination item ${index + 1}`,
        }));
        await route.fulfill({ response: original, json: { transactions } });
      });
      await page.goto(`${baseUrl}/transactions`, { waitUntil: "networkidle" });
      expect(await page.locator("tbody tr").count()).toBe(50);
      await page.getByRole("button", { name: "次へ", exact: true }).click();
      expect(await page.locator("tbody").innerText()).toContain(
        "Pagination item 51",
      );
      await page
        .getByLabel("内容を検索", { exact: true })
        .fill("Pagination item 125");
      expect(await page.locator("tbody tr").count()).toBe(1);
      expect(await page.locator("tbody").innerText()).toContain(
        "Pagination item 125",
      );
      expect(
        await page
          .getByRole("button", { name: "前へ", exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.close();
    },
    TIMEOUT_MS,
  );

  test(
    "a failed refresh preserves the previous records with a warning",
    async () => {
      const page = await browser.newPage();
      let fail = false;
      await page.route("**/api/transactions", async (route) => {
        if (!fail) return route.continue();
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: "{}",
        });
      });
      await page.goto(`${baseUrl}/transactions`, { waitUntil: "networkidle" });
      fail = true;
      await page
        .getByRole("button", { name: "表示を更新", exact: true })
        .click();
      await page.locator("main").getByRole("alert").waitFor();
      expect(
        await page.locator("main").getByRole("alert").innerText(),
      ).toContain("前回");
      expect(await page.locator("tbody").innerText()).toContain(
        "BROWSER_FRESH",
      );
      fail = false;
      await page
        .locator("main")
        .getByRole("button", { name: "再試行", exact: true })
        .click();
      await page
        .locator("main")
        .getByRole("alert")
        .waitFor({ state: "detached" });
      await page.close();
    },
    TIMEOUT_MS,
  );
});
