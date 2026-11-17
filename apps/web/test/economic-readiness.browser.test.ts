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
      superseded_by_parse_run_id: id === 1 || (id >= 101 && id <= 104) ? 8 : null,
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
  let mode: "ok" | "unavailable" | "refused" | "mismatch" | "malformed" | "delayed" | "held" = "ok";
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
          if (mode === "held")
            body.manifest.rows[0]!.reasons = ["ownership_unresolved", "economic_claim_held"];
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
    page.getByRole("region", { name: "銀行の入出金からの新しい計算用取引", exact: true });
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
      // The heading renders from the route before the detail response arrives.
      const notice = page.getByText("これは旧解析の記録です", { exact: true });
      await notice.waitFor();
      expect(await notice.count()).toBe(1);
      expect(requests).toHaveLength(0);
      await screenshot(page, `readiness-collapsed-${width}`);
      await panel(page).getByRole("button").click();
      await panel(page).getByText("識別条件を満たしています", { exact: false }).waitFor();
      expect(requests.length).toBe(before + 1);
      expect(requests.at(-1)!.searchParams.get("parseRunId")).toBe("7");
      expect(await panel(page).innerText()).toContain("この記録は旧解析のものです");
      expect(await panel(page).innerText()).toContain(
        "この機能から新しい計算用取引を作成することは、まだできません。",
      );
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
    const failures = [
      ["unavailable", "データを取得できませんでした。時間をおいて再試行してください。"],
      ["refused", "このデータを表示する権限がありません。接続先のアクセス権を確認してください。"],
      ["malformed", "受信したデータの形式が対応していません。接続先を確認してください。"],
      ["mismatch", "別の記録の応答を受信しました。この記録の判定は表示できません。"],
    ] as const;
    const page = await open(101);
    try {
      for (const [index, [failure, message]] of failures.entries()) {
        const id = 101 + index;
        mode = failure;
        if (index > 0)
          await page.evaluate((observationId) => {
            history.pushState(null, "", `/observations/transaction/${observationId}`);
            dispatchEvent(new PopStateEvent("popstate"));
          }, id);
        await page.getByRole("heading", { name: `取引の詳細 #${id}`, exact: true }).waitFor();
        const diagnostic = panel(page);
        const optIn = diagnostic.getByRole("button", {
          name: "新規作成の条件を確認する",
          exact: true,
        });
        await optIn.waitFor();
        expect(await page.getByText("これは旧解析の記録です", { exact: true }).count()).toBe(1);
        const before = await diagnostic.innerText();
        expect(before).not.toContain("新規作成の条件を取得できませんでした。");
        expect(before).not.toContain("記録の識別状態:");
        expect(before).not.toContain(
          "この機能から新しい計算用取引を作成することは、まだできません。",
        );
        expect(requests).toHaveLength(index);
        const rowRequests = () =>
          requests.filter(
            (url) =>
              url.searchParams.get("family") === "bank-movement" &&
              url.searchParams.get("observationId") === String(id) &&
              url.searchParams.get("parseRunId") === "7",
          );
        expect(rowRequests()).toHaveLength(0);
        await optIn.click();
        await diagnostic
          .getByText("新規作成の条件を取得できませんでした。", { exact: false })
          .waitFor();
        await diagnostic.getByText(message, { exact: true }).waitFor();
        expect(requests).toHaveLength(index + 1);
        expect(rowRequests()).toHaveLength(1);
        expect(await diagnostic.innerText()).not.toContain("識別条件を満たしています");
        expect(await page.getByRole("link", { name: "この記録の原本を開く ↗" }).count()).toBe(1);
        expect(await page.locator("main").innerText()).not.toContain("private response");
        if (failure === "unavailable") await screenshot(page, "readiness-unavailable-1280");
      }
    } finally {
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
      .getByText("新規作成の条件を取得できませんでした。", { exact: false })
      .waitFor();
    expect(await panel(page).innerText()).not.toContain("識別条件を満たしています");
    expect(await panel(page).innerText()).not.toContain("この記録は旧解析のものです");
    await page.close();
  });
  test("unsupported card and non-transaction details never offer the diagnostic", async () => {
    for (const id of [3, 4]) {
      const page = await open(id);
      // Wait for the detail body so the absence is not read before it renders.
      await page.getByRole("link", { name: "この記録の原本を開く ↗" }).waitFor();
      expect(await page.locator("[id^=economic-readiness-]").count()).toBe(0);
      await page.close();
    }
    expect(requests).toHaveLength(0);
  });
  test("a held observation can already be used while new generation from this feature stays unavailable", async () => {
    mode = "held";
    const page = await open(2);
    await panel(page)
      .getByRole("button", { name: "新規作成の条件を確認する", exact: true })
      .click();
    await panel(page)
      .getByText("この記録はすでに別の計算用取引が参照しています。", { exact: true })
      .waitFor();
    const text = await panel(page).innerText();
    expect(text).toContain("口座の所有者を、この計算で確認する仕組みが未対応です。");
    expect(text).toContain("既存の計算用取引で使われている場合もあります。");
    expect(text).toContain("この機能から新しい計算用取引を作成することは、まだできません。");
    expect(text).not.toContain("計算への反映は未対応です");
    expect(text).not.toContain("反映できない理由");
    const original = page.getByRole("link", { name: "この記録の原本を開く ↗" });
    expect(await original.getAttribute("href")).toBe(`/api/raw/${"a".repeat(64)}`);
    await screenshot(page, "readiness-held-1280");
    await page.close();
  });
});
