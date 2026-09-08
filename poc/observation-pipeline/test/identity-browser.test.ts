// Local synthetic fixtures only. No connection to a user browser or real account.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import { buildFixture } from "./fixture.ts";
import type { IdentityAccountRow, IdentityInstrumentRow } from "../shared/identity-contract.ts";

const client = join(import.meta.dir, "../web/dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("identity browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}
const source = "synthetic-source-" + "long-reference-".repeat(9);
const reference = "synthetic-account-" + "0123456789abcdef".repeat(15);
const freshLabel = "IDENTITY_PRIVATE_SYNTHETIC";
const pageTwo = "IDENTITY_SECOND_PAGE";

describe.if(runnable)("protected identity client on local synthetic server", () => {
  const fixture = buildFixture();
  const observation = fixture.store.db
    .query("SELECT id FROM transaction_observations LIMIT 1")
    .get() as { id: number };
  const requests: string[] = [];
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
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
            source: { kind: "central-store", classification: "synthetic" },
            capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
          });
        if (url.pathname.startsWith("/api/identity/")) {
          const filtered = url.searchParams.get("source");
          const second = Number(url.searchParams.get("offset") ?? "0") > 0;
          const envelope = { limit: 100, truncated: !second, nextOffset: second ? null : 100 };
          if (url.pathname.endsWith("/coverage"))
            return Response.json({
              rows: [
                {
                  source: filtered || source,
                  eligible: 6,
                  organized: 4,
                  identified: 1,
                  providerLocal: 1,
                  aggregate: 1,
                  unresolved: 1,
                },
              ],
              coverage: { limit: 100, truncated: false, nextOffset: null },
            });
          if (url.pathname.endsWith("/accounts")) {
            const rows: IdentityAccountRow[] = (
              second ? ["identified"] : ["identified", "provider-local", "aggregate", "unresolved"]
            ).map((status, index) => ({
              referenceId: `ref-${index}`,
              targetId: `target-${index}`,
              label: second ? pageTwo : `${freshLabel}-${index}`,
              role: "cash",
              status: status as IdentityAccountRow["status"],
              source: filtered || source,
              reference,
              reason: "synthetic-verified-rule",
              revision: 2,
              observedCount: 1,
              origin: { kind: "transaction", id: observation.id },
            }));
            return Response.json({ rows, coverage: envelope });
          }
          const rows: IdentityInstrumentRow[] = [
            {
              referenceId: "synthetic-ric",
              targetId: "synthetic-security",
              label: second ? pageTwo : "Synthetic foreign security",
              kind: "security",
              status: "provider-local",
              source: filtered || source,
              namespace: "ric",
              scope: "global",
              value: "SYN.O",
              reason: "provider-reported-ric",
              revision: 2,
              observedCount: 1,
              origin: { kind: "transaction", id: observation.id },
            },
          ];
          return Response.json({ rows, coverage: envelope });
        }
        if (url.pathname === "/api/filter-options")
          return Response.json({
            sources: ["sbi-securities"],
            accounts: [],
            instruments: [],
            metrics: [],
          });
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
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    fixture.store.db.close();
  });

  for (const width of [390, 1280])
    test(`identity status, disclosure, keyboard scrolling and layout at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}/identities`, { waitUntil: "networkidle" });
        const first = page.locator("article").filter({ hasText: `${freshLabel}-0` });
        await first.waitFor();
        for (const label of ["識別済み", "取得元内で識別", "集計表示", "要確認"])
          expect(
            await page.locator("article .badge").getByText(label, { exact: true }).count(),
          ).toBe(1);
        expect(await page.locator("main").innerText()).toContain(
          "重複除去や資産額の合算を行いません",
        );
        const region = page.getByRole("region", { name: "口座の整理状況", exact: true });
        await region.focus();
        expect(await region.evaluate((el) => document.activeElement === el)).toBe(true);
        if (width === 390) {
          await region.evaluate((el) => {
            el.scrollLeft = 0;
          });
          await page.keyboard.press("ArrowRight");
          await page.waitForFunction(
            () =>
              (document.querySelector('[role="region"][aria-label="口座の整理状況"]')?.scrollLeft ??
                0) > 0,
          );
        }
        const summary = first.getByText("対応の根拠・取得元の識別情報", { exact: true });
        await summary.focus();
        await summary.press("Enter");
        const full = first.getByText(reference, { exact: true });
        expect(await full.isVisible()).toBe(true);
        expect(
          await full.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            const text = selection.toString();
            selection.removeAllRanges();
            return text;
          }),
        ).toBe(reference);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);
        const screenshotDir = process.env["UI_REVIEW_SCREENSHOTS"];
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({
            path: join(screenshotDir, `identity-${width}.png`),
            fullPage: true,
          });
        }
      } finally {
        await page.close();
      }
    }, 60_000);

  test("source filtering, two page lists, origin/back and shared shell preserve private state", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/transactions`, { waitUntil: "networkidle" });
      const shell = await page.locator(".app-shell").elementHandle();
      await page
        .getByRole("navigation", { name: "メインナビゲーション" })
        .getByRole("link", { name: "口座・銘柄", exact: true })
        .click();
      await page.getByRole("heading", { name: "口座・銘柄の整理", exact: true }).waitFor();
      expect(await shell!.evaluate((el) => el === document.querySelector(".app-shell"))).toBe(true);
      expect(await page.locator("main").count()).toBe(1);
      await page.getByLabel("取得元", { exact: true }).fill("sbi-securities");
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/api/identity/accounts?") &&
            response.url().includes("source=sbi-securities"),
        ),
        page.getByRole("button", { name: "絞り込む", exact: true }).click(),
      ]);
      expect(new URL(page.url()).search).toBe("");
      await page.getByRole("button", { name: "次の100件", exact: true }).last().click();
      await page.getByRole("heading", { name: new RegExp(pageTwo) }).waitFor();
      await page.getByRole("button", { name: "前の100件", exact: true }).last().click();
      await page
        .getByRole("heading", { name: new RegExp(freshLabel) })
        .first()
        .waitFor();
      await page.getByRole("button", { name: "通貨・銘柄", exact: true }).click();
      await page.getByRole("heading", { name: /Synthetic foreign security/ }).waitFor();
      await page.getByRole("button", { name: "次の100件", exact: true }).last().click();
      await page.getByRole("heading", { name: new RegExp(pageTwo) }).waitFor();
      await page.getByRole("link", { name: "代表記録・原本を確認", exact: true }).click();
      await page.waitForURL(`**/observations/transaction/${observation.id}`);
      await page.goBack({ waitUntil: "networkidle" });
      await page.getByRole("heading", { name: new RegExp(pageTwo) }).waitFor();
      expect(await page.getByLabel("取得元", { exact: true }).inputValue()).toBe("sbi-securities");
      expect(
        await page
          .getByRole("button", { name: "通貨・銘柄", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([
        0, 0,
      ]);
      expect(
        requests.some(
          (path) =>
            path.includes("/api/identity/instruments?") &&
            path.includes("offset=100") &&
            path.includes("source=sbi-securities"),
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const status of [401, 403])
    test(`authorization ${status} removes cached identity data across retry and remount`, async () => {
      const page = await browser.newPage();
      let failure = 0;
      await page.route("**/api/identity/accounts**", (route) =>
        failure
          ? route.fulfill({ status: failure, contentType: "application/json", body: "{}" })
          : route.continue(),
      );
      try {
        await page.goto(`${origin}/identities`, { waitUntil: "networkidle" });
        await page
          .getByRole("heading", { name: new RegExp(freshLabel) })
          .first()
          .waitFor();
        failure = status;
        await page.getByRole("button", { name: "表示を更新", exact: true }).click();
        await page.locator("main").getByRole("alert").waitFor();
        expect(await page.locator("main").innerText()).not.toContain(freshLabel);
        failure = 503;
        await page.locator("main").getByRole("button", { name: "再試行", exact: true }).click();
        await page
          .locator("main")
          .getByText(/HTTP 503/)
          .waitFor();
        await page.getByRole("button", { name: "通貨・銘柄", exact: true }).click();
        await page.getByRole("heading", { name: /Synthetic foreign security/ }).waitFor();
        await page.getByRole("button", { name: "口座", exact: true }).click();
        await page.locator("main").getByRole("alert").waitFor();
        expect(await page.locator("main").innerText()).not.toContain(freshLabel);
        failure = 0;
        await page.locator("main").getByRole("button", { name: "再試行", exact: true }).click();
        await page
          .getByRole("heading", { name: new RegExp(freshLabel) })
          .first()
          .waitFor();
      } finally {
        await page.close();
      }
    }, 60_000);
});
