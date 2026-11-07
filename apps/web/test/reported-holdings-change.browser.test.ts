// 保有数量の変化 (the /state page's panel) in the production client against a
// server whose answers the queries themselves produce
// (packages/application/test/holdings-change-world.ts and reported-state-world.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { auditView } from "./a11y-audit.ts";
import {
  holdingsChangeBody,
  holdingsChangeWorld,
} from "../../../packages/application/test/holdings-change-world.ts";
import {
  reportedStateBody,
  reportedStateWorld,
} from "../../../packages/application/test/reported-state-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };

describe.if(runnable)("reported holdings change between two dates", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let tooMany = false;
  const requests: URL[] = [];
  const state = reportedStateWorld();
  const holdings = holdingsChangeWorld();
  beforeEach(() => {
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
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, reportedStateOnDate: true },
          });
        if (url.pathname === "/api/v2/reported-state")
          return Response.json(await reportedStateBody(state, url.searchParams.get("date")!));
        if (url.pathname === "/api/v2/reported-holdings-change") {
          requests.push(url);
          if (tooMany) return Response.json({ error: "result_limit_exceeded" }, { status: 413 });
          return Response.json(
            await holdingsChangeBody(holdings, {
              from: url.searchParams.get("from")!,
              to: url.searchParams.get("to")!,
            }),
          );
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

  /** The /state page on 2026-09-10, before any comparison is asked. */
  async function open(viewport = DESKTOP): Promise<Page> {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/state`);
    await page.getByRole("heading", { name: "基準日の保有状況", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "基準日", exact: true }).fill("2026-09-10");
    await page.getByRole("button", { name: "表示する", exact: true }).click();
    await page.getByRole("heading", { name: "2026-09-10 の保有状況", exact: true }).waitFor();
    await page.getByRole("heading", { name: "保有数量の変化", exact: true }).waitFor();
    return page;
  }
  async function compare(page: Page, from: string): Promise<void> {
    await page.getByRole("textbox", { name: "比較の開始日", exact: true }).fill(from);
    await page.getByRole("button", { name: "比べる", exact: true }).click();
    await page.getByRole("region", { name: "保有数量の変化の一覧" }).waitFor();
  }
  /** Each row's holding code and its change cell, as shown. */
  async function changes(page: Page): Promise<[string, string][]> {
    const rows = page.getByRole("region", { name: "保有数量の変化の一覧" }).locator("tbody tr");
    const result: [string, string][] = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const code = (await row.locator("th").innerText()).split(/\s/u)[0]!;
      result.push([code, (await row.locator("td").nth(2).innerText()).trim()]);
    }
    return result;
  }

  test("nothing is asked until a start date is chosen; then from it to the page's date", async () => {
    const page = await open();
    expect(await page.locator("main").innerText()).toContain(
      "開始日を選ぶと、その日から基準日までの保有数量の変化を表示します。",
    );
    expect(requests).toHaveLength(0);
    await compare(page, "2026-09-01");
    expect(requests).toHaveLength(1);
    expect([...requests[0]!.searchParams]).toEqual([
      ["from", "2026-09-01"],
      ["to", "2026-09-10"],
    ]);
    await page.close();
  }, 30_000);

  test("compared rows show the exact change; one-date rows and not comparable rows show no number", async () => {
    const page = await open();
    await compare(page, "2026-09-01");
    expect(await changes(page)).toEqual([
      ["1001", "+2.5"],
      ["1002", "数値なし（基準日の取得結果に記載なし）"],
      ["1003", "数値なし（開始日の取得結果に記載なし）"],
      ["1004", "数値なし（比較できません）"],
      ["1005", "±0"],
      ["1006", "-3.5"],
      ["VTX", "数値なし（比較できません）"],
    ]);
    const region = await page.getByRole("region", { name: "保有数量の変化の一覧" }).innerText();
    // Statuses and the closed reasons, in words.
    expect(region).toContain("比較済み");
    expect(region).toContain("開始日だけに記載");
    expect(region).toContain("基準日だけに記載");
    expect(region).toContain("基準日の数量を正確に読み取れません");
    expect(region).toContain("開始日までにこの取得元の完全な取得結果がありません");
    // Each row's reasons are their own list, named after the holding.
    expect(
      await page.getByRole("list", { name: "1004 を比較できない理由", exact: true }).innerText(),
    ).toContain("基準日の数量を正確に読み取れません");
    // The provider's quantities as reported, and the absent side as a status.
    expect(region).toContain("12.5");
    expect(region).toContain("unreadable");
    expect(region).toContain("記載なし");
    expect(region).toContain("取得結果なし");
    // Nothing is added: neither side's quantities nor the changes are summed.
    const tokens = new Set(region.split(/[\s·]+/u));
    for (const total of ["29", "18.25", "-1", "+-1", "−1"]) expect(tokens.has(total)).toBe(false);
    const main = await page.locator("main").innerText();
    expect(main).toContain("保有数量の合計や評価額ではありません。");
    expect(main).toContain("比較済み 3 件");
    await page.close();
  }, 30_000);

  test("a start date on or after the page's date cannot be asked", async () => {
    const page = await open();
    await page.getByRole("textbox", { name: "比較の開始日", exact: true }).fill("2026-09-10");
    expect(await page.getByRole("button", { name: "比べる", exact: true }).isDisabled()).toBe(true);
    await page
      .getByText("比較の開始日は基準日（2026-09-10）より前の日付を指定してください。")
      .waitFor();
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("too many holdings say so instead of a partial answer", async () => {
    tooMany = true;
    const page = await open();
    await page.getByRole("textbox", { name: "比較の開始日", exact: true }).fill("2026-09-01");
    await page.getByRole("button", { name: "比べる", exact: true }).click();
    await page
      .getByText("一度に比べられません。一部だけの表示はしません。", { exact: false })
      .waitFor();
    expect(await page.locator("main").innerText()).not.toContain("読み込めませんでした");
    await page.close();
  }, 30_000);

  for (const [name, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const)
    test(`the panel fits a ${name} width without sideways page scroll`, async () => {
      const page = await open(viewport);
      await compare(page, "2026-09-01");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      const prefix = process.env["HOLDINGS_CHANGE_SCREENSHOT_PREFIX"];
      if (prefix) await page.screenshot({ path: `${prefix}-${name}.png`, fullPage: true });
      await page.close();
    }, 30_000);

  test("the compared panel passes the accessibility audit", async () => {
    const page = await open();
    await compare(page, "2026-09-01");
    expect(await auditView(page)).toEqual([]);
    await page.close();
  }, 60_000);
});
