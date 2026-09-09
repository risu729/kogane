// Local, synthetic integration only: the production bundle and both API families.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import { buildFixture, HOSTILE_DESCRIPTION } from "./fixture.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../shared/api-schema.ts";

const client = join(import.meta.dir, "../web/dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("production browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}

describe.if(runnable)("combined production client", () => {
  const fixture = buildFixture();
  const observation = fixture.store.db
    .query("SELECT id FROM transaction_observations WHERE description = ?")
    .get(HOSTILE_DESCRIPTION) as { id: number };
  const requests: string[] = [];
  // Informational only: a test below renames it and expects identical behaviour.
  let sourceKind = "central-store";
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
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
            source: { kind: sourceKind, classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
            parsingHealth: { pending: 0, running: 0, failed: 1 },
          });
        if (url.pathname === "/api/filter-options")
          return Response.json({
            sources: ["demo-bank", "opaque-source-" + "a".repeat(64)],
            accounts: [{ source_id: "demo-bank", source_account: "demo-bank:main" }],
            instruments: ["JPY"],
            metrics: ["ledger"],
          });
        if (url.pathname === "/api/evidence/v1/meta")
          return Response.json({
            apiVersion: "evidence-v1",
            source: { kind: "central-raw-store", classification: "financial" },
            capabilities: {
              readOnly: true,
              rawEvidence: true,
              parsedObservations: false,
              liveCollectors: false,
            },
            sources: [{ id: "sony-bank", label: "テスト銀行" }],
          });
        if (url.pathname === "/api/evidence/v1/sources/sony-bank/runs")
          return Response.json({
            apiVersion: "evidence-v1",
            sourceId: "sony-bank",
            coverage: "sealed-only",
            items: [],
            nextCursor: null,
          });
        if (url.pathname === "/api/v2/query") {
          // The shared query service this fixture advertises through
          // `sharedQuery`. It answers the `coverage` intent from the same
          // overview the page would otherwise sum itself, so the counts the
          // client renders are the service's, not the page's arithmetic.
          if (url.searchParams.get("intent") !== "coverage" || url.searchParams.size !== 1)
            return Response.json(
              {
                schemaVersion: "financial-error-v1",
                code: "unsupported_semantics",
                requestId: "fixture",
                message: "the fixture serves the coverage intent only",
                refs: [],
              },
              { status: 400 },
            );
          const overviewUrl = new URL(url);
          overviewUrl.pathname = "/api/overview";
          overviewUrl.search = "";
          const overview = (await (
            await api.fetch(new Request(overviewUrl))
          ).json()) as import("../shared/api-contract.ts").Overview;
          const scopes = overview.sources.map((source) => ({
            sourceRef: source.id,
            provider: source.provider,
            ingestion: source.ingestion,
            artifactCount: source.artifact_count,
            collectionRunCount: overview.fetchRuns.filter((run) => run.source_id === source.id)
              .length,
          }));
          const gaps = scopes
            .filter((scope) => scope.artifactCount === 0)
            .map((scope) => ({
              reasonCode: "no_artifacts_collected",
              scopeRef: `source:${scope.sourceRef}`,
            }));
          const dimension = (state: string, reasonCodes: string[]) => ({
            state,
            reasonCodes,
            evidenceRefs: [],
          });
          return Response.json({
            schemaVersion: "kogane-query-response-v1",
            contextId: `ctx_${"0".repeat(64)}`,
            resultRef: `result:${"1".repeat(64)}`,
            unresolvedInputs: [
              {
                key: "valuation",
                question: "whether amounts are valued in a common unit",
                chosen: "no valuation policy is adopted",
                reasonCode: "no_valuation_policy_adopted",
              },
            ],
            result: {
              schemaVersion: "financial-result-v1",
              contextId: `ctx_${"0".repeat(64)}`,
              resolvedQuery: {
                schemaVersion: "query-spec-v1",
                intent: "coverage",
                perimeterRef: "perimeter:sources=*;accounts=*",
                effectiveTime: {
                  kind: "instant",
                  value: "2026-09-09T00:00:00Z",
                  zone: "UTC",
                  basis: "derived",
                },
                basisRefs: {},
                filters: {},
                limit: 100,
              },
              completeness: gaps.length === 0 ? "complete" : "partial",
              data: {
                intent: "coverage",
                scopes,
                sourceCount: scopes.length,
                artifactCount: scopes.reduce((total, scope) => total + scope.artifactCount, 0),
                collectionRunCount: overview.fetchRuns.length,
              },
              coverage: {
                scopeRef: "perimeter:sources=*;accounts=*",
                coveredRef: `covered-sources:${scopes.map((scope) => scope.sourceRef).join(",")}`,
                gaps,
                truncated: false,
              },
              quality: {
                identity: dimension("not-applicable", ["identity_not_used_by_coverage"]),
                freshness: dimension(gaps.length === 0 ? "verified" : "partial", ["fixture"]),
                numeric: dimension("not-applicable", ["counts_are_exact_integers"]),
                reconciliation: dimension("not-applicable", ["reconciliation_not_implemented"]),
                valuation: dimension("not-applicable", ["no_valuation_policy_adopted"]),
              },
              nextCursor: null,
              explanationRefs: scopes.map((scope) => `source:${scope.sourceRef}`),
              warnings: [],
            },
          });
        }
        if (url.pathname.startsWith("/api/")) {
          // Use the real observation DTOs, adding the production pagination envelope.
          const clean = new URL(url);
          clean.search = "";
          const response = await api.fetch(new Request(clean));
          if (["/api/artifacts", "/api/transactions"].includes(url.pathname)) {
            const value = (await response.json()) as Record<string, unknown>;
            if (url.pathname === "/api/transactions") {
              value["transactions"] = (value["transactions"] as Record<string, unknown>[]).map(
                (row) => ({ ...row, source_account: `account-hmac-${"a".repeat(128)}` }),
              );
            }
            if (url.pathname === "/api/artifacts" && url.searchParams.has("cursor"))
              value["artifacts"] = (value["artifacts"] as Record<string, unknown>[]).map((row) => ({
                ...row,
                dataset: "SECOND_PAGE_SENTINEL",
              }));
            return Response.json({
              ...value,
              coverage: {
                limit: 500,
                truncated: !url.searchParams.has("cursor") && !url.searchParams.has("offset"),
                ...(url.pathname === "/api/artifacts"
                  ? { nextCursor: url.searchParams.has("cursor") ? null : "1" }
                  : { nextOffset: url.searchParams.has("offset") ? null : 500 }),
              },
            });
          }
          return response;
        }
        const file = Bun.file(
          url.pathname.startsWith("/assets/")
            ? join(client, url.pathname)
            : join(client, "index.html"),
        );
        return new Response(file, {
          headers: {
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          },
        });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("all observation routes render under production CSP at desktop and mobile widths", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const [path, expected] of [
        ["/", "Demo Bank"],
        ["/transactions", HOSTILE_DESCRIPTION],
        ["/balances", "248,820"],
        ["/positions", "EXAMPLE <FUND>"],
        ["/artifacts", "statement"],
        [`/artifacts/${fixture.artifactId}`, "現行の解析"],
        [`/observations/transaction/${observation.id}`, "json:$.rows[0]"],
        ["/evidence", "テスト銀行"],
      ]) {
        await page.goto(origin + path, { waitUntil: "networkidle" });
        expect(await page.locator("h1").count()).toBe(1);
        const text = await page.locator("body").innerText();
        expect(text).toContain(expected!);
        for (const error of [
          "データの形式が対応していません",
          "データを取得できませんでした",
          "指定されたデータが見つかりません",
          "ページが見つかりません",
        ])
          expect(text).not.toContain(error);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);

  test("summary counts come from the shared query service, with its hand-off references", async () => {
    const page = await browser.newPage();
    const before = requests.length;
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    const observed = requests.slice(before);
    // The page asks the shared service, and only for the coverage intent.
    expect(observed).toContain("/api/v2/query?intent=coverage");
    expect(observed.filter((path) => path.startsWith("/api/v2/query"))).toEqual([
      "/api/v2/query?intent=coverage",
    ]);
    // Capabilities are known before the service is asked; nothing is guessed.
    expect(observed.indexOf("/api/meta")).toBeLessThan(
      observed.indexOf("/api/v2/query?intent=coverage"),
    );
    const overview = (await (await fetch(origin + "/api/v2/query?intent=coverage")).json()) as {
      result: { data: { artifactCount: number; sourceCount: number } };
    };
    const counts = await page.locator(".overview-stat-value").allInnerTexts();
    expect(counts[0]).toBe(String(overview.result.data.sourceCount));
    expect(counts[1]).toBe(String(overview.result.data.artifactCount));
    // The hand-off is by reference: the ids, not the numbers, go to an agent.
    await page.getByText("この数字の出どころ").click();
    const text = await page.locator("body").innerText();
    expect(text).toContain(`ctx_${"0".repeat(64)}`);
    expect(text).toContain(`result:${"1".repeat(64)}`);
    await page.close();
  });

  test("evidence navigation preserves observation routes and does not deny available parsing", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/transactions", { waitUntil: "networkidle" });
    const shell = await page.locator(".app-shell").elementHandle();
    const sidebar = await page.locator(".sidebar").elementHandle();
    const header = await page.locator(".workspace-bar").elementHandle();
    const footer = await page.locator(".workspace-footer").innerText();
    const sidebarText = await page.locator(".sidebar").innerText();
    const noticeText = await page.locator(".source-notice").innerText();
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "取得履歴", exact: true })
      .click();
    await page.getByRole("heading", { name: "取得履歴と原本", exact: true }).waitFor();
    // Identical labels are insufficient: the actual shell nodes must survive.
    expect(await shell!.evaluate((node) => node === document.querySelector(".app-shell"))).toBe(
      true,
    );
    expect(await sidebar!.evaluate((node) => node === document.querySelector(".sidebar"))).toBe(
      true,
    );
    expect(
      await header!.evaluate((node) => node === document.querySelector(".workspace-bar")),
    ).toBe(true);
    expect(await page.locator(".sidebar").innerText()).toBe(sidebarText);
    expect(await page.locator(".workspace-footer").innerText()).toBe(footer);
    expect(await page.locator(".source-notice").innerText()).toBe(noticeText);
    expect(await page.locator("main").count()).toBe(1);
    expect(await page.locator(".nav a[aria-current='page']").innerText()).toBe("取得履歴");
    expect(await page.title()).toBe("取得履歴と原本 | kogane");
    expect(await page.evaluate(() => document.activeElement === document.querySelector("h1"))).toBe(
      true,
    );
    expect(await page.locator("body").innerText()).not.toContain("解析結果はまだ提供していません");
    for (const name of ["取引", "残高", "保有資産", "原本・証跡", "ホーム"])
      expect(
        await page
          .getByRole("navigation", { name: "メインナビゲーション" })
          .getByRole("link", { name, exact: true })
          .count(),
      ).toBe(1);
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "取引", exact: true })
      .click();
    await page.waitForLoadState("networkidle");
    expect(await page.locator("h1").innerText()).toBe("取引");
    await page.goBack();
    expect(await page.locator("h1").innerText()).toBe("取得履歴と原本");
    await page.close();
  });

  test("query-only paging, filtering, reset and back refetch correct production pages", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/artifacts?source=demo-bank", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "次の500件" }).click();
    await page.locator("td").filter({ hasText: "SECOND_PAGE_SENTINEL" }).first().waitFor();
    expect(requests).toContain("/api/artifacts?source=demo-bank&cursor=1");
    expect(await page.locator("body").innerText()).toContain("SECOND_PAGE_SENTINEL");
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "原本・証跡", exact: true })
      .click();
    await page.locator("td").filter({ hasText: "statement" }).first().waitFor();
    expect(new URL(page.url()).search).toBe("");
    expect(await page.locator("body").innerText()).not.toContain("SECOND_PAGE_SENTINEL");
    await page.getByLabel("全記録の取得元", { exact: true }).selectOption("demo-bank");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).search).toBe("?source=demo-bank");
    await page.goBack();
    await page.waitForLoadState("networkidle");
    expect(await page.getByLabel("全記録の取得元", { exact: true }).inputValue()).toBe("");
    await page.close();
  });

  test("observation provenance links to its artifact and protected original without auto-fetch", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/observations/transaction/${observation.id}`, {
      waitUntil: "networkidle",
    });
    expect(await page.locator("body").innerText()).toContain("json:$.rows[0]");
    const raw = page.locator(`a[href='/api/raw/${fixture.sha256}']`).first();
    expect(await raw.count()).toBe(1);
    expect(requests.some((path) => path.startsWith("/api/raw/"))).toBe(false);
    await page.locator(`a[href='/artifacts/${fixture.artifactId}']`).first().click();
    await page.getByText("現行の解析", { exact: true }).waitFor();
    expect(await page.locator("body").textContent()).toContain("demo-statement");
    await page.goBack();
    await page.getByText("json:$.rows[0]", { exact: true }).first().waitFor();
    expect(await page.locator("body").innerText()).toContain("json:$.rows[0]");
    await page.close();
  });

  test("renaming the connection kind changes labels only, never requests or controls", async () => {
    const page = await browser.newPage();
    async function observe(kind: string) {
      sourceKind = kind;
      const before = requests.length;
      await page.goto(origin + "/summaries", { waitUntil: "networkidle" });
      const nav = page.getByRole("navigation", { name: "メインナビゲーション" });
      return {
        requests: requests.slice(before).filter((path) => path.startsWith("/api/balances")),
        serverControls: await page.getByRole("region", { name: "全記録の絞り込み" }).count(),
        clientControls: await page.getByLabel("取得元", { exact: true }).count(),
        identities: await nav.getByRole("link", { name: "口座・銘柄", exact: true }).count(),
        evidence: await nav.getByRole("link", { name: "取得履歴", exact: true }).count(),
        status: await page.getByRole("status").first().innerText(),
      };
    }
    try {
      const central = await observe("central-store");
      const renamed = await observe("archive-store");
      expect(central.requests).toEqual(["/api/balances?view=summaries"]);
      expect({ ...renamed, status: "" }).toEqual({ ...central, status: "" });
      expect(central.serverControls).toBe(1);
      expect(central.clientControls).toBe(0);
      expect(central.identities).toBe(1);
      expect(central.evidence).toBe(1);
      expect(central.status).toBe("中央保管庫に接続");
      expect(renamed.status).toBe("保存された記録に接続");
    } finally {
      sourceKind = "central-store";
      await page.close();
    }
  });

  test("no list request is sent with guessed parameters before capabilities are known", async () => {
    const page = await browser.newPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/meta", async (route) => {
      await gate;
      await route.continue();
    });
    const before = requests.length;
    await page.goto(origin + "/balances", { waitUntil: "domcontentloaded" });
    await page.getByRole("status").filter({ hasText: "接続を確認中" }).first().waitFor();
    expect(requests.slice(before).filter((path) => path.startsWith("/api/balances"))).toEqual([]);
    release();
    await page.waitForLoadState("networkidle");
    const observed = requests.slice(before);
    expect(observed.filter((path) => path.startsWith("/api/balances"))).toEqual([
      "/api/balances?view=balances",
    ]);
    expect(observed.indexOf("/api/meta")).toBeLessThan(
      observed.indexOf("/api/balances?view=balances"),
    );
    await page.close();
  });

  test("search drafts do not navigate per keystroke and invalid date ranges do not submit", async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/transactions", { waitUntil: "networkidle" });
    await page.getByLabel("内容を検索", { exact: true }).fill("日本語の検索");
    expect(new URL(page.url()).search).toBe("");
    await page.getByLabel("開始日", { exact: true }).fill("2026-09-02");
    await page.getByLabel("終了日", { exact: true }).fill("2026-09-01");
    expect(await page.getByRole("button", { name: "検索条件を適用" }).isDisabled()).toBe(true);
    await page.getByLabel("終了日", { exact: true }).fill("2026-09-03");
    await page.getByRole("button", { name: "検索条件を適用" }).click();
    expect(new URL(page.url()).searchParams.get("q")).toBe("日本語の検索");
    expect(new URL(page.url()).searchParams.get("from")).toBe("2026-09-02");
    await page.goBack();
    expect(new URL(page.url()).search).toBe("");
    await page.close();
  });
});
