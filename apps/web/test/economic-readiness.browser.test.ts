// Synthetic responses in the production client; no provider, login or collection.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import type { ObservationDetail } from "../../../packages/observation-shared/src/api-contract.ts";
import { economicReadinessFixture } from "../../../packages/observation-shared/test/economic-readiness-fixture.ts";
import { auditView } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) process.exitCode = 1;
function detail(id: number): ObservationDetail {
  return {
    kind: id === 4 ? "balance" : "transaction",
    row: { id, parse_run_id: 7, source_account: "synthetic", raw_locator: "row:1" },
    extra: {},
    extraRaw: "{}",
    extraParsed: true,
    provenance: {
      source_id: id === 3 ? "myjcb" : "sbi-shinsei-bank",
      parser_name: id === 3 ? "myjcb-credit-ledger" : "sbi-shinsei-top-balances-and-activity",
      parse_run_id: 7,
      parser_version: "1",
      parsed_at: "2030-01-01T00:00:00Z",
      parse_status: "ok",
      error: null,
      warnings: { list: [], raw: "[]", parsed: true },
      superseded_by_parse_run_id: id === 1 ? 8 : null,
      artifact_id: 1,
      dataset: "synthetic",
      url: null,
      mime: "application/json",
      fetched_at: "2030-01-01T00:00:00Z",
      sha256: "a".repeat(64),
      size: 2,
      content_type: "application/json",
      fetch_run_id: 1,
      tool: "synthetic",
      external_run_id: null,
      fetch_status: "success",
      started_at: "2030-01-01T00:00:00Z",
      completed_at: "2030-01-01T00:00:00Z",
    },
  };
}

describe.if(runnable)("transaction economic-readiness explanation", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let mode: "ok" | "unavailable" | "refused" | "mismatch" | "malformed" | "delayed" = "ok";
  let release: (() => void) | undefined;
  let received: (() => void) | undefined;
  let requests: URL[] = [];
  beforeEach(() => {
    mode = "ok";
    requests = [];
    release = undefined;
    received = undefined;
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
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        const observation = /^\/api\/observations\/(transaction|balance)\/([0-9]+)$/u.exec(
          url.pathname,
        );
        if (observation) return Response.json(detail(Number(observation[2])));
        if (url.pathname === "/api/v2/economic-readiness") {
          requests.push(url);
          const id = Number(url.searchParams.get("observationId"));
          if (mode === "unavailable")
            return Response.json(
              { status: "unavailable", reason: "readiness_store_unavailable" },
              { status: 503 },
            );
          if (mode === "refused") return Response.json({ error: "unauthorized" }, { status: 403 });
          if (mode === "malformed")
            return Response.json({ status: "ok", providerText: "private response" });
          const body = economicReadinessFixture(mode === "mismatch" ? id + 1 : id);
          if (id === 1)
            body.manifest.rows[0]!.reasons = ["evidence_not_current", "ownership_unresolved"];
          if (mode === "delayed" && id === 1)
            await new Promise<void>((resolve) => {
              release = resolve;
              received?.();
            });
          return Response.json(body);
        }
        if (url.pathname.startsWith("/api/raw/"))
          return new Response("Synthetic original evidence");
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname));
        return new Response((await file.exists()) ? file : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    release?.();
    await browser?.close();
    server?.stop(true);
  });
  const panel = (page: Page) =>
    page.getByRole("region", { name: "銀行の入出金の計算への反映", exact: true });
  async function screenshot(page: Page, name: string) {
    const screenshots = process.env["READINESS_REVIEW_SCREENSHOTS"];
    if (!screenshots) return;
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
  }
  async function open(id = 1, width = 1280) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(`${origin}/observations/${id === 4 ? "balance" : "transaction"}/${id}`);
    await page
      .getByRole("heading", { name: `${id === 4 ? "残高" : "取引"}の詳細 #${id}`, exact: true })
      .waitFor();
    return page;
  }
  for (const width of [1280, 390])
    test(`lazy exact old-parse explanation preserves evidence and layout at ${width}px`, async () => {
      const page = await open(1, width);
      const before = requests.length;
      expect(await page.getByText("これは旧解析の記録です", { exact: true }).count()).toBe(1);
      expect(requests).toHaveLength(0);
      await screenshot(page, `readiness-collapsed-${width}`);
      await panel(page).getByRole("button").click();
      await panel(page).getByText("識別条件を満たしています", { exact: false }).waitFor();
      expect(requests.length).toBe(before + 1);
      expect(requests.at(-1)!.searchParams.get("parseRunId")).toBe("7");
      expect(await panel(page).innerText()).toContain("この記録は旧解析のものです");
      expect(await panel(page).innerText()).toContain("計算への反映は未対応です");
      expect(await panel(page).innerText()).not.toContain("writerEnabled");
      const popup = page.waitForEvent("popup");
      await page.getByRole("link", { name: "この記録の原本を開く ↗" }).click();
      const raw = await popup;
      await raw.waitForLoadState();
      expect(await raw.locator("body").innerText()).toContain("Synthetic original evidence");
      await raw.close();
      await screenshot(page, `readiness-expanded-${width}`);
      if (width === 1280) expect(await auditView(page)).toEqual([]);
      await page.close();
    });
  test("unavailable, refused, malformed and unrelated responses fail locally", async () => {
    for (const failure of ["unavailable", "refused", "malformed", "mismatch"] as const) {
      mode = failure;
      const page = await open();
      await panel(page).getByRole("button").click();
      await panel(page)
        .getByText("反映できない理由を取得できませんでした。", { exact: false })
        .waitFor();
      expect(await panel(page).innerText()).not.toContain("識別条件を満たしています");
      expect(await page.getByRole("link", { name: "この記録の原本を開く ↗" }).count()).toBe(1);
      expect(await page.locator("main").innerText()).not.toContain("private response");
      if (failure === "unavailable") await screenshot(page, "readiness-unavailable-1280");
      await page.close();
    }
  });
  test("navigation cancels the old request and requires a fresh opt-in for another row", async () => {
    mode = "delayed";
    const page = await open();
    const sent = new Promise<void>((resolve) => {
      received = resolve;
    });
    await panel(page).getByRole("button").click();
    await sent;
    await panel(page).getByRole("status").waitFor();
    await page.evaluate(() => {
      history.pushState(null, "", "/observations/transaction/2");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("heading", { name: "取引の詳細 #2", exact: true }).waitFor();
    await panel(page).getByRole("button").waitFor();
    release?.();
    await panel(page).getByRole("button").click();
    await panel(page).getByText("識別条件を満たしています", { exact: false }).waitFor();
    expect(requests.at(-1)!.searchParams.get("observationId")).toBe("2");
    expect(await panel(page).innerText()).not.toContain("この記録は旧解析のものです");
    await page.close();
  });
  test("a failed refresh never leaves the preceding diagnostic displayed as current", async () => {
    const page = await open();
    await panel(page).getByRole("button").click();
    await panel(page).getByText("識別条件を満たしています", { exact: false }).waitFor();
    mode = "unavailable";
    const refreshed = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/v2/economic-readiness",
    );
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await refreshed;
    await panel(page)
      .getByText("反映できない理由を取得できませんでした。", { exact: false })
      .waitFor();
    expect(await panel(page).innerText()).not.toContain("識別条件を満たしています");
    expect(await panel(page).innerText()).not.toContain("この記録は旧解析のものです");
    await page.close();
  });
  test("unsupported card and non-transaction details never offer the diagnostic", async () => {
    for (const id of [3, 4]) {
      const page = await open(id);
      expect(await page.locator("[id^=economic-readiness-]").count()).toBe(0);
      await page.close();
    }
    expect(requests).toHaveLength(0);
  });
});
