// 評価レポート in the production client against a server that answers the
// fixed report routes with synthetic bodies in the shapes the App Worker
// writes (apps/web/test/report-fixture.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { auditView } from "./a11y-audit.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  COLON_ID,
  COMPLETE_ID,
  completeDetail,
  explanationOf,
  listPage,
  MISMATCH_ID,
  MISSING_ID,
  missingDetail,
  PARTIAL_ID,
  partialDetail,
  RESTRICTED_ID,
  UNEXPLAINED_ID,
} from "./report-fixture.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const STORED = 60;

describe.if(runnable)("fixed report artifacts", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let malformed = false;
  const requests: URL[] = [];
  beforeEach(() => {
    advertised = true;
    malformed = false;
    requests.length = 0;
  });

  function detailFor(id: string): Response {
    if (id === PARTIAL_ID) {
      const detail = partialDetail();
      // A blank amount is malformed, never zero.
      if (malformed)
        (detail.body.rows[0] as { value: { coefficient: string } }).value.coefficient = "";
      return Response.json(detail);
    }
    if (id === COMPLETE_ID) return Response.json(completeDetail());
    if (id === RESTRICTED_ID) return Response.json(partialDetail(RESTRICTED_ID, "restricted"));
    if (id === UNEXPLAINED_ID) return Response.json(partialDetail(UNEXPLAINED_ID));
    if (id === COLON_ID) return Response.json(partialDetail(COLON_ID));
    if (id === MISSING_ID) return Response.json(missingDetail());
    if (id === MISMATCH_ID)
      return Response.json({ error: "report_digest_mismatch" }, { status: 503 });
    return Response.json({ error: "not_found" }, { status: 404 });
  }

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
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, reportArtifacts: advertised },
          });
        if (url.pathname === "/api/v2/reports") {
          requests.push(url);
          return Response.json(listPage(Number(url.searchParams.get("offset") ?? "0"), STORED));
        }
        const match = /^\/api\/v2\/reports\/([^/]+)(\/explanation|\/export)?$/u.exec(url.pathname);
        if (match) {
          requests.push(url);
          const id = decodeURIComponent(match[1]!);
          if (match[2] === undefined) return detailFor(id);
          if (match[2] === "/export")
            return id === PARTIAL_ID || id === COLON_ID
              ? Response.json({ ...partialDetail(id), view: "export" })
              : Response.json({ error: "evidence_restricted" }, { status: 403 });
          if (id === PARTIAL_ID) return Response.json(explanationOf(partialDetail()));
          if (id === COMPLETE_ID) return Response.json(explanationOf(completeDetail()));
          return Response.json({ error: "not_found" }, { status: 404 });
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

  async function open(path: string, heading: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${origin}${path}`);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  }
  const explanationRequests = () => requests.filter((url) => url.pathname.endsWith("/explanation"));

  test("an unadvertised feature has no navigation entry and requests nothing", async () => {
    advertised = false;
    const page = await open("/reports", "評価レポート");
    expect(await page.getByRole("link", { name: "評価レポート", exact: true }).count()).toBe(0);
    await page.getByText("この接続先は評価レポートを提供していません。").waitFor();
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("the list pages through the catalogue newest first, without inventing a total", async () => {
    const page = await open("/", "ホーム");
    const nav = page.getByRole("link", { name: "評価レポート", exact: true });
    expect(await nav.getAttribute("href")).toBe("/reports");
    await nav.click();
    await page.getByRole("heading", { name: "評価レポート", exact: true }).waitFor();
    await page.getByRole("region", { name: "評価レポートの一覧" }).waitFor();
    await page.waitForFunction(() => document.title === "評価レポート | kogane");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    const rows = page.getByRole("region", { name: "評価レポートの一覧" }).locator("tbody tr");
    expect(await rows.count()).toBe(50);
    expect(await rows.first().innerText()).toContain(PARTIAL_ID);
    expect(await rows.first().innerText()).toContain("保有資産の評価");
    const pager = page.getByLabel("評価レポートのページ");
    expect(await pager.innerText()).toContain("1–50件目");
    // No count the server did not send.
    expect(await page.locator("main").innerText()).not.toContain("件中");
    expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
    await page.getByRole("button", { name: "次の50件", exact: true }).click();
    await page.getByText("51–60件目").waitFor();
    expect(requests.at(-1)?.searchParams.get("offset")).toBe("50");
    expect(await rows.count()).toBe(10);
    expect(await page.getByRole("button", { name: "次の50件", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.close();
  }, 30_000);

  test("a partial report shows exact amounts, reasons instead of zeros and its explanation", async () => {
    const page = await open("/reports", "評価レポート");
    await page.getByRole("link", { name: "内容を見る" }).first().click();
    await page.getByRole("heading", { name: "評価レポートの内容", exact: true }).waitFor();
    await page.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    await page.waitForFunction(() => document.title === "評価レポートの内容 | kogane");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    const rows = await page.getByRole("region", { name: "保有資産ごとの評価" }).innerText();
    // Formatted by the shared formatter; a place JPY cannot hold is shown as stored.
    expect(rows).toContain("1,200,000 JPY");
    expect(rows).toContain("34567.5 JPY");
    expect(rows).toContain("未評価 同じ取得結果の価格がない");
    expect(rows).not.toMatch(/(^|\s)0 JPY/u);
    const main = await page.locator("main").innerText();
    expect(main).toContain("1234567.5 JPY");
    expect(main).toContain("評価できた保有資産だけの小計");
    expect(main).toContain("確認できた範囲のみ評価");
    expect(main).toContain("資産全体の合計でも、その下限でもありません");
    expect(main).toContain("入力から再計算できる");
    // The events, the related report linked by its id.
    expect(
      await page.getByRole("link", { name: COMPLETE_ID, exact: true }).getAttribute("href"),
    ).toBe(`/reports/${COMPLETE_ID}`);
    expect(main).toContain("訂正版を作成");
    // The explanation links every input to its observation.
    await page.getByText("入力にした保有資産の記録（3件）").click();
    expect(await page.getByRole("link", { name: "#901", exact: true }).getAttribute("href")).toBe(
      "/observations/position/901",
    );
    await page.getByText("使った価格（1件）").click();
    expect(await page.getByRole("link", { name: "観測記録を開く" }).getAttribute("href")).toBe(
      "/observations/valuation/951",
    );
    // Read only: no recompute, share or other command.
    expect(await page.locator("main button").count()).toBe(0);
    expect(explanationRequests()).toHaveLength(1);
    await page.close();
  }, 30_000);

  test("a complete report names its whole figure and a truncated catalogue", async () => {
    const page = await open(`/reports/${COMPLETE_ID}`, "評価レポートの内容");
    await page.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    const main = await page.locator("main").innerText();
    expect(main).toContain("評価額の合計");
    expect(main).toContain("すべて評価済み");
    expect(main).toContain("保存内容のみ（入力からは再計算できない）");
    expect(main).toContain("保有資産が上限で打ち切られています。");
    await page.close();
  }, 30_000);

  test("a restricted report keeps its body and asks for no explanation", async () => {
    const page = await open(`/reports/${RESTRICTED_ID}`, "評価レポートの内容");
    await page.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    await page
      .getByText("根拠にした記録の利用が制限されたため、説明は表示しません。", { exact: false })
      .waitFor();
    expect(await page.locator("main").innerText()).toContain("根拠の利用が制限されている");
    expect(explanationRequests()).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("the export is offered only where the report's capabilities allow it", async () => {
    const exportLink = (page: Page) =>
      page.getByRole("link", { name: "保存内容を書き出す（JSON）" });
    for (const id of [PARTIAL_ID, COMPLETE_ID]) {
      const page = await open(`/reports/${id}`, "評価レポートの内容");
      await page.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
      expect(await exportLink(page).getAttribute("href")).toBe(`/api/v2/reports/${id}/export`);
      await page.close();
    }
    // A restricted or unavailable report is refused by the server: no link to a refusal.
    const restricted = await open(`/reports/${RESTRICTED_ID}`, "評価レポートの内容");
    await restricted.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    await restricted
      .getByText("根拠にした記録の利用が制限されたため、書き出しはできません。")
      .waitFor();
    expect(await exportLink(restricted).count()).toBe(0);
    await restricted.close();
    const missing = await open(`/reports/${MISSING_ID}`, "評価レポートの内容");
    await missing.getByText("保存内容を読み出せないため、書き出しはできません。").waitFor();
    expect(await exportLink(missing).count()).toBe(0);
    await missing.close();
    // The id is one encoded path segment, and the link downloads the export.
    const page = await open(`/reports/${encodeURIComponent(COLON_ID)}`, "評価レポートの内容");
    await page.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    const link = exportLink(page);
    expect(await link.getAttribute("href")).toBe("/api/v2/reports/rpt-synthetic%3Aexport.1/export");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(new URL(download.url()).pathname).toBe(
      "/api/v2/reports/rpt-synthetic%3Aexport.1/export",
    );
    expect(requests.filter((url) => url.pathname.endsWith("/export"))).toHaveLength(1);
    await download.cancel();
    await page.close();
  }, 30_000);

  test("an explanation that is not stored is said, not rebuilt", async () => {
    const page = await open(`/reports/${UNEXPLAINED_ID}`, "評価レポートの内容");
    await page.getByText("このレポートの説明は保存されていません。").waitFor();
    expect(explanationRequests()).toHaveLength(1);
    await page.close();
  }, 30_000);

  test("a body that is gone, or not the bytes it was fixed with, is never shown", async () => {
    const missing = await open(`/reports/${MISSING_ID}`, "評価レポートの内容");
    await missing
      .getByText("保存されたレポートの内容を読み出せません。別の内容で作り直すことはしません。")
      .waitFor();
    expect(await missing.locator("main").innerText()).toContain("保存内容を読み出せない");
    expect(await missing.getByRole("region", { name: "保有資産ごとの評価" }).count()).toBe(0);
    await missing.close();
    const mismatch = await open(`/reports/${MISMATCH_ID}`, "評価レポートの内容");
    await mismatch
      .getByText("保存された内容が、作成時に記録したダイジェストと一致しません。", { exact: false })
      .waitFor();
    await mismatch.close();
  }, 30_000);

  test("a malformed answer is an error, never a zero", async () => {
    malformed = true;
    const page = await open(`/reports/${PARTIAL_ID}`, "評価レポートの内容");
    await page.getByText("受信したデータの形式が対応していません。", { exact: false }).waitFor();
    expect(await page.getByRole("region", { name: "保有資産ごとの評価" }).count()).toBe(0);
    await page.close();
  }, 30_000);

  test("the pages fit a phone width without sideways page scroll", async () => {
    for (const [path, heading] of [
      ["/reports", "評価レポート"],
      [`/reports/${PARTIAL_ID}`, "評価レポートの内容"],
    ] as const) {
      const page = await open(path, heading);
      await page.locator("main table").first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      const prefix = process.env["REPORTS_SCREENSHOT_PREFIX"];
      if (prefix) {
        const name = path === "/reports" ? "list" : "detail";
        await page.screenshot({ path: `${prefix}-${name}-mobile.png`, fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({ path: `${prefix}-${name}-desktop.png`, fullPage: true });
      }
      await page.close();
    }
  }, 30_000);

  test("the list and a report pass the accessibility audit", async () => {
    const list = await open("/reports", "評価レポート");
    await list.getByRole("region", { name: "評価レポートの一覧" }).waitFor();
    expect(await auditView(list)).toEqual([]);
    await list.close();
    const report = await open(`/reports/${PARTIAL_ID}`, "評価レポートの内容");
    await report.getByRole("region", { name: "保有資産ごとの評価" }).waitFor();
    expect(await auditView(report)).toEqual([]);
    await report.close();
  }, 60_000);
});
