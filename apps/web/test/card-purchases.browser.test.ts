import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  capturedPurchase,
  purchasePage,
} from "../../../packages/application/test/card-purchase-view-fixture.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

describe.if(runnable)("card purchase explanation", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let empty = false;
  const requests: URL[] = [];
  beforeEach(() => {
    advertised = true;
    empty = false;
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
            capabilities: {
              ...CENTRAL_STORE_CAPABILITIES,
              cardSettlementReconciliation: true,
              cardPurchaseRecognition: advertised,
            },
          });
        if (url.pathname === "/api/v2/card-purchases") {
          requests.push(url);
          const page = purchasePage(empty ? [] : undefined);
          const eventId = url.searchParams.get("eventId");
          if (eventId !== null) {
            const item = page.items.find((entry) => entry.eventId === eventId);
            return item
              ? Response.json({ apiVersion: 2, ...purchasePage([item]) })
              : Response.json({ error: "not_found" }, { status: 404 });
          }
          return Response.json({ apiVersion: 2, ...page });
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
  async function open(path = "/purchases", heading = "カード利用") {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(origin + path);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  }

  test("an unadvertised feature has no navigation entry and requests nothing", async () => {
    advertised = false;
    const page = await open();
    expect(await page.getByRole("link", { name: "カード利用", exact: true }).count()).toBe(0);
    await page.getByText("この接続先はカード利用の説明を提供していません。").waitFor();
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("captured, authorized, refunds and vanished rows are separate figures, never a total", async () => {
    const page = await open();
    expect(
      await page.getByRole("link", { name: "カード利用", exact: true }).getAttribute("href"),
    ).toBe("/purchases");
    const figures = page.getByRole("list", { name: "状態ごとの利用額" });
    const tiles = await figures.getByRole("listitem").allInnerTexts();
    expect(tiles.map((text) => text.replace(/\s+/gu, " ").trim())).toEqual([
      "1234 JPY 確定",
      "1200 JPY 未確定",
      "300 JPY 返金（対応不明）",
      "0 JPY 未確定の返金（対応不明）",
      "1件 取得元に表示されなくなった利用",
    ]);
    const main = await page.locator("main").innerText();
    // No figure adds captured and authorized, or subtracts a refund.
    for (const combined of ["2434", "2734", "934", "2134"]) expect(main).not.toContain(combined);
    expect(main).toContain("引落は購入費用に加算しません");
    expect(main).toContain("3 件は、この一覧に含まれていません");
    // The statement total is reference only, behind its own disclosure.
    await page.getByText("カード会社の請求総額（参考）", { exact: true }).click();
    expect(await page.locator("main").innerText()).toContain("1734 JPY");
    const rows = page.getByRole("region", { name: "カード利用の一覧" }).locator("tbody tr");
    expect(await rows.count()).toBe(4);
    expect(await rows.nth(3).innerText()).toContain("取得元に表示されなくなった");
    expect(await rows.nth(3).innerText()).toContain("合計に含めていません");
    expect(requests[0]?.searchParams.get("offset")).toBe("0");
    expect(requests[0]?.searchParams.has("period")).toBe(false);
    await page.close();
  }, 30_000);

  test("the chain links usage, statement and bank debit to their records and to review", async () => {
    const page = await open();
    const item = capturedPurchase();
    await page
      .getByRole("row")
      .filter({ hasText: "2026-08-15" })
      .getByRole("link", { name: "説明を見る" })
      .click();
    await page.getByRole("heading", { name: "カード利用の説明", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe(`/purchases/${item.eventId}`);
    const chain = page.getByRole("list", { name: "利用から請求、引落までの経路" });
    await chain.waitFor();
    const href = (name: string) =>
      chain.getByRole("link", { name, exact: true }).getAttribute("href");
    expect(await href("明細の記録と原本")).toBe("/observations/transaction/21");
    expect(await href("請求の記録と原本")).toBe("/observations/balance/31");
    expect(await href("銀行明細と原本")).toBe("/observations/transaction/41");
    expect(await href("カード照合で確認")).toBe("/reconciliation");
    const text = await chain.innerText();
    for (const expected of ["利用", "請求", "引落", "2026-09 請求分", "1734 JPY", "採用済み"])
      expect(text).toContain(expected);
    expect(text).toContain("引落は購入費用に加算しません");
    expect(requests.at(-1)?.searchParams.get("eventId")).toBe(item.eventId);
    await page.getByText("記録の履歴と根拠の参照", { exact: true }).click();
    expect(await page.locator("main").innerText()).toContain(`event:${item.eventId}@1`);
    await page.close();
  }, 30_000);

  test("an empty list says it does not prove there were no purchases", async () => {
    empty = true;
    const page = await open();
    const main = await page.locator("main").innerText();
    expect(main).toContain("表示できるカード利用はありません。");
    expect(main).toContain("一覧が空でも、カードの利用がなかったことにはなりません。");
    await page.close();
  }, 30_000);

  test("the statement-month filter is sent to the server and resets paging", async () => {
    const page = await open();
    await page.getByLabel("請求月", { exact: true }).fill("2026-09");
    await page.getByRole("button", { name: "絞り込む", exact: true }).click();
    await page.getByRole("heading", { name: "2026-09 請求分の状態ごとの利用額" }).waitFor();
    expect(requests.at(-1)?.searchParams.get("period")).toBe("2026-09");
    expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
    await page.getByRole("button", { name: "すべて表示", exact: true }).click();
    await page.getByRole("heading", { name: "状態ごとの利用額", exact: true }).waitFor();
    expect(requests.at(-1)?.searchParams.has("period")).toBe(false);
    await page.close();
  }, 30_000);

  test("list and explanation fit a phone width without sideways page scroll", async () => {
    const page = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.goto(`${origin}/purchases/${capturedPurchase().eventId}`);
    await page.getByRole("heading", { name: "カード利用の説明", exact: true }).waitFor();
    await page.getByRole("list", { name: "利用から請求、引落までの経路" }).waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    const prefix = process.env["PURCHASE_SCREENSHOT_PREFIX"];
    if (prefix) await page.screenshot({ path: `${prefix}-detail-mobile.png`, fullPage: true });
    await page.close();
  }, 30_000);
});
