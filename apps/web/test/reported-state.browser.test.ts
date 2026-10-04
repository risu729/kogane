// 基準日の保有状況 in the production client against a server whose answers
// the query itself produces (packages/application/test/reported-state-world.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  reportedStateBody,
  reportedStateWorld,
} from "../../../packages/application/test/reported-state-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { tokyoToday } from "../src/reported-state-api.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

describe.if(runnable)("reported state on a date", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let tooMany = false;
  const requests: URL[] = [];
  const world = reportedStateWorld();
  beforeEach(() => {
    advertised = true;
    tooMany = false;
    requests.length = 0;
  });
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, reportedStateOnDate: advertised },
          });
        if (url.pathname === "/api/v2/reported-state") {
          requests.push(url);
          if (tooMany) return Response.json({ error: "result_limit_exceeded" }, { status: 413 });
          return Response.json(await reportedStateBody(world, url.searchParams.get("date")!));
        }
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
  async function open() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${origin}/state`);
    await page.getByRole("heading", { name: "基準日の保有状況", exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  }
  async function choose(page: Awaited<ReturnType<typeof open>>, date: string) {
    await page.getByRole("textbox", { name: "基準日", exact: true }).fill(date);
    await page.getByRole("button", { name: "表示する", exact: true }).click();
    await page.getByRole("heading", { name: `${date} の保有状況`, exact: true }).waitFor();
  }

  test("an unadvertised feature has no navigation entry and requests nothing", async () => {
    advertised = false;
    const page = await open();
    expect(await page.getByRole("link", { name: "基準日の保有状況", exact: true }).count()).toBe(0);
    await page.getByText("この接続先は基準日の保有状況を提供していません。").waitFor();
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("today is asked first, then the chosen date", async () => {
    const page = await open();
    expect(
      await page.getByRole("link", { name: "基準日の保有状況", exact: true }).getAttribute("href"),
    ).toBe("/state");
    await page.getByRole("heading", { name: `${tokyoToday()} の保有状況` }).waitFor();
    expect(requests[0]?.searchParams.get("date")).toBe(tokyoToday());
    await choose(page, "2026-09-10");
    expect(requests.at(-1)?.searchParams.get("date")).toBe("2026-09-10");
    await page.close();
  }, 30_000);

  test("accounts show capture times, freshness and provider values unconverted, never a total", async () => {
    const page = await open();
    await choose(page, "2026-09-10");
    const main = await page.locator("main").innerText();
    // Capture times and their freshness on the date.
    expect(main).toContain("取得日時 2026-09-09T23:30:00.000Z");
    expect(main).toContain("当日取得");
    expect(main).toContain("4日以上前の取得");
    expect(main).toContain("3日以内に取得");
    // Provider valuations in the provider's currency, side by side.
    expect(main).toContain("12000 JPY");
    expect(main).toContain("150.25 USD");
    expect(main).toContain("50000 JPY");
    // An unreadable balance stays unknown, never zero.
    expect(main).toContain("不明（stored:unparsed） · JPY");
    // Nothing is added: no sum of the JPY figures appears anywhere.
    for (const combined of ["62000", "80000", "92000", "112000"])
      expect(main).not.toContain(combined);
    expect(main).toContain("この一覧は資産や負債の合計ではありません。");
    await page.close();
  }, 30_000);

  test("card payables say where each stands on the date", async () => {
    const page = await open();
    await choose(page, "2026-09-10");
    const payables = page.getByRole("region", { name: "カードの請求の一覧" });
    const text = await payables.innerText();
    expect(text).toContain("基準日より後に引落予定");
    expect(text).toContain("引落予定日を過ぎ、引落は未確認");
    expect(text).toContain("引落予定日が不明");
    expect(text).toContain("採用済み");
    await choose(page, "2026-09-26");
    expect(await payables.innerText()).toContain("基準日までに引落を確認");
    await page.close();
  }, 30_000);

  test("coverage names containers without a capture and the missing liabilities", async () => {
    const page = await open();
    await choose(page, "2026-09-10");
    const coverage = page.getByRole("list", { name: "取得結果のない取得元" });
    const missing = await coverage.innerText();
    expect(missing).toContain("mizuho-bank");
    expect(missing).toContain("st-george");
    const main = await page.locator("main").innerText();
    expect(main).toContain("負債は一部だけです。");
    expect(main).toContain("まだ請求に載っていないカード利用");
    await page.close();
  }, 30_000);

  test("a date with too many records says so instead of a partial answer", async () => {
    tooMany = true;
    const page = await open();
    await page.getByText("一部だけの表示はしません。", { exact: false }).waitFor();
    expect(await page.locator("main").innerText()).not.toContain("読み込めませんでした");
    await page.close();
  }, 30_000);

  test("the page fits a phone width without sideways page scroll", async () => {
    const page = await open();
    await choose(page, "2026-09-10");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    const prefix = process.env["REPORTED_STATE_SCREENSHOT_PREFIX"];
    if (prefix) {
      await page.screenshot({ path: `${prefix}-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.screenshot({ path: `${prefix}-desktop.png`, fullPage: true });
    }
    await page.close();
  }, 30_000);
});
