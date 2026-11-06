// 監査ログ in the production client against a server whose pages the
// application's own `readAuditPage` produces from the synthetic audit store
// (audit-fixture.ts), on a desktop and a phone viewport. The page sends only
// the server's closed filters, pages by the server's cursor without a total,
// refuses a malformed page, and tells a non-operator plainly that the log is
// the operator's. Every value is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { auditFixture, FILLER_READS, type AuditFixture } from "./audit-fixture.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

describe.if(runnable)("the operator's audit log page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let fixture: AuditFixture;
  let operator = true;
  let malformed = false;
  let staleCursor = false;
  const reads: URLSearchParams[] = [];

  beforeEach(() => {
    operator = true;
    malformed = false;
    staleCursor = false;
    reads.length = 0;
  });
  beforeAll(async () => {
    fixture = await auditFixture();
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
        if (url.pathname === "/api/v2/audit") {
          reads.push(url.searchParams);
          if (request.method !== "GET")
            return Response.json({ error: "method_not_allowed" }, { status: 405 });
          if (!operator) return Response.json({ error: "operator_required" }, { status: 403 });
          if (staleCursor && url.searchParams.has("cursor"))
            return Response.json({ error: "stale_context" }, { status: 409 });
          const { status, body } = await fixture.answer(url.searchParams);
          if (malformed && status === 200) {
            const page = body as { records: { result: string }[] };
            page.records[0]!.result = "approved";
          }
          return Response.json(body, { status });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "index.html" : url.pathname));
        return new Response((await file.exists()) ? file : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const rows = (page: Page) => page.locator(".audit-table tbody tr");
  const noPageOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  for (const viewport of VIEWPORTS)
    test(`${viewport.name}: navigation, labels and cursor paging without a total`, async () => {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        await page.goto(`${origin}/`);
        await page.locator("h1").first().waitFor();
        // The navigation entry is always listed, like the schedule settings'.
        const link = page.getByRole("link", { name: "監査ログ", exact: true });
        await link.click();
        await page.getByRole("heading", { level: 1, name: "監査ログ" }).waitFor();
        expect(page.url()).toBe(`${origin}/audit`);
        await page.waitForFunction(() => document.title === "監査ログ | kogane");
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
        expect(await link.getAttribute("aria-current")).toBe("page");

        await rows(page).first().waitFor();
        expect(await rows(page).count()).toBe(50);
        expect(reads).toHaveLength(1);
        expect([...reads[0]!.keys()]).toEqual([]);
        await page.getByText("1ページ目 · このページ50件", { exact: true }).waitFor();
        await page.getByText("続きがあります", { exact: true }).waitFor();
        // Closed codes appear with their Japanese names; no total is ever shown.
        const text = (await page.locator("main").innerText()).replace(/\s+/gu, " ");
        for (const expected of [
          "確認待ちとして準備",
          "委任されたエージェント",
          "拒否",
          "actor_not_supported",
          "失敗",
          "upstream_unavailable",
          "改訂 1 → 2",
          "変更した項目: 有効・無効、実行パターン",
          "判断の改訂 2件",
          "依頼の状態: 受付済み",
          "停止した実行を解除",
          "1日の上限（2000件）を超えた読み取り37件を集計",
          "記録の照会",
        ])
          expect(text).toContain(expected);
        expect(text).not.toMatch(/件中|全\d+件|合計/u);

        // The disclosure holds the identifiers that tie a record to the other logs.
        const details = page.locator(".audit-table details").first();
        await details.locator("summary").click();
        expect(await details.innerText()).toContain("記録ID");

        await page.getByRole("button", { name: "次のページ", exact: true }).click();
        await page
          .getByText("2ページ目 · このページ" + String(FILLER_READS + 10 - 50) + "件", {
            exact: true,
          })
          .waitFor();
        expect(await rows(page).count()).toBe(FILLER_READS + 10 - 50);
        expect(reads.at(-1)!.get("cursor")).toMatch(/^[A-Za-z0-9_-]+$/u);
        await page.getByText("最後のページです", { exact: true }).waitFor();
        expect(
          await page.getByRole("button", { name: "次のページ", exact: true }).isDisabled(),
        ).toBe(true);
        await page.getByRole("button", { name: "前のページ", exact: true }).click();
        await page.getByText("1ページ目 · このページ50件", { exact: true }).waitFor();

        // The table scrolls inside its region; the page itself never scrolls sideways.
        expect(await noPageOverflow(page)).toBe(true);
        const prefix = process.env["AUDIT_SCREENSHOT_PREFIX"];
        if (prefix)
          await page.screenshot({ path: `${prefix}-${viewport.name}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }, 60_000);

  test("filters are the server's closed values, sent as query parameters and reset paging", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${origin}/audit`);
      await rows(page).first().waitFor();
      const result = page.getByLabel("結果", { exact: true });
      const options = await result.locator("option").allInnerTexts();
      expect(options).toEqual([
        "すべての結果",
        "適用",
        "受付",
        "確認待ちとして準備",
        "読み取り",
        "同じ依頼の再送",
        "拒否",
        "失敗",
        "上限を超えた分の集計",
      ]);
      expect(await page.getByLabel("経路", { exact: true }).locator("option").count()).toBe(6);
      await result.selectOption("refused");
      await page.getByLabel("開始日（UTC）").fill("2026-10-09");
      await page.getByLabel("終了日（UTC）").fill("2026-10-09");
      await page.getByRole("button", { name: "条件を適用" }).click();
      await page.waitForURL(`${origin}/audit?result=refused&from=2026-10-09&to=2026-10-09`);
      await page.getByText("1ページ目 · このページ1件", { exact: true }).waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({
        result: "refused",
        from: "2026-10-09",
        to: "2026-10-09",
      });
      expect(await rows(page).count()).toBe(1);
      expect(await rows(page).first().innerText()).toContain("actor_not_supported");
      // The heading keeps its place: a filter is not a navigation.
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("H1");

      // A range that ends before it starts is not sent.
      await page.getByLabel("開始日（UTC）").fill("2026-10-10");
      await page.getByText("開始日を終了日以前にしてください。").waitFor();
      expect(await page.getByRole("button", { name: "条件を適用" }).isDisabled()).toBe(true);

      await page.getByRole("button", { name: "条件をクリア" }).click();
      await page.waitForURL(`${origin}/audit`);
      await page.getByText("1ページ目 · このページ50件", { exact: true }).waitFor();

      // An empty answer says so, and says nothing about a total.
      await page.goto(`${origin}/audit?operation=reconcile.propose`);
      await page.getByText("この条件に当てはまる記録はありません。").waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a URL filter outside the closed values is refused before any request", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/audit?result=approved`);
      await page.getByText("このURLの絞り込み条件は指定できません。").waitFor();
      expect(reads).toHaveLength(0);
      await page.getByRole("button", { name: "条件をクリア" }).click();
      await rows(page).first().waitFor();
      expect(reads).toHaveLength(1);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a non-operator is told the log is the operator's, and sees no record", async () => {
    operator = false;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${origin}/audit`);
      await page.getByText("監査ログは管理者だけが表示できます", { exact: true }).waitFor();
      expect(await rows(page).count()).toBe(0);
      expect(await page.locator("h1").innerText()).toBe("監査ログ");
      expect(await noPageOverflow(page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a malformed page is an error, never a partial table", async () => {
    malformed = true;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/audit`);
      await page
        .getByText("受信したデータの形式が対応していません。接続先を確認してください。")
        .waitFor();
      expect(await rows(page).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a cursor the server no longer honours restarts from the newest record", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/audit`);
      await rows(page).first().waitFor();
      staleCursor = true;
      await page.getByRole("button", { name: "次のページ", exact: true }).click();
      await page.getByText("続きのページを読めません", { exact: true }).waitFor();
      expect(await rows(page).count()).toBe(0);
      await page.getByRole("button", { name: "最新の記録から読み直す" }).click();
      await page.getByText("1ページ目 · このページ50件", { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);
});
