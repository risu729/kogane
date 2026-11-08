import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { auditView } from "./a11y-audit.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../../packages/read-model/test/collection-quality-fixture.ts";
import {
  queryAccountCoverage,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../../../packages/application/src/query/collection-quality.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
/** Every age is counted to this instant: two Tokyo days after the synthetic capture. */
const AS_OF = "2099-01-03T00:00:00.000Z";
const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
describe.if(runnable)("collection quality browser", () => {
  let browser: Browser, server: ReturnType<typeof Bun.serve>, store: QualityStore, origin: string;
  const requests: { path: string; method: string }[] = [];
  beforeAll(async () => {
    store = new QualityStore();
    store.run({
      source: "vpass",
      at: "2099-01-01T00:00:00Z",
      outcome: "partial",
      units: {
        ["synthetic-card-" + "x".repeat(450)]: {
          outcome: "human_required",
          code: "human_required_reauth",
        },
      },
      artifacts: [],
    });
    // One GLOBAL PASS month whose observation the identity layer maps to an
    // unresolved account, and one whose parse is still pending.
    const month = store.run({
      source: "global-pass",
      at: "2099-01-02T00:00:00Z",
      artifacts: [
        { key: "activity-2099-01.html", dataset: "globalpass-activity" },
        { key: "activity-2098-12.html", dataset: "globalpass-activity" },
      ],
    });
    const parse = store.parse(month.artifacts[0]!, "global-pass-activity", { kind: "published" })!;
    store.parse(month.artifacts[1]!, "global-pass-activity", { kind: "pending" });
    store.db.run(
      "INSERT INTO transaction_observations(id,parse_run_id,source_account,raw_locator,extra_json) VALUES(990001,?,'synthetic-ref','$[0]','{}')",
      [parse],
    );
    store.db.run(
      "INSERT INTO source_accounts VALUES('synthetic-ref','global-pass','collector-r2-importer','[\"synthetic-ref\"]')",
    );
    store.db.run(
      "INSERT INTO accounts VALUES('synthetic-account','Synthetic browser account','synthetic-role','unresolved')",
    );
    store.db.run(
      "INSERT INTO account_mappings VALUES('synthetic-map','synthetic-ref',1,'synthetic-account','rule','synthetic_reason',1,'2099-01-01','Synthetic browser account','unresolved')",
    );
    store.db.run("INSERT INTO identity_runs VALUES('synthetic-identity',?,1,'2099-01-01')", [
      parse,
    ]);
    store.db.run(
      "INSERT INTO identity_observations VALUES('synthetic-identity-1','synthetic-identity','transaction',990001,'synthetic-ref','synthetic-map','[]')",
    );
    store.db.run("INSERT INTO identity_run_seals VALUES('synthetic-identity',1,'2099-01-01')");
    const executor: Parameters<typeof queryCollectionQualityCells>[0] = {
      all: async <T>(sql: string, args: readonly unknown[]) =>
        store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
      first: async <T>(sql: string, args: readonly unknown[]) =>
        (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
    };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({ path: url.pathname + url.search, method: request.method });
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        if (url.pathname === "/api/collection-quality")
          return Response.json(await queryCollectionQualitySummary(executor, { asOf: AS_OF }));
        if (
          url.pathname.startsWith("/api/collection-quality/") &&
          url.pathname.endsWith("/accounts")
        )
          return Response.json(
            await queryAccountCoverage(executor, {
              sourceId: url.pathname.split("/").at(-2)!,
              asOf: AS_OF,
            }),
          );
        if (url.pathname.startsWith("/api/collection-quality/"))
          return Response.json(
            await queryCollectionQualityCells(executor, {
              sourceId: url.pathname.split("/").at(-1)!,
              offset: Number(url.searchParams.get("offset") ?? 0),
              asOf: AS_OF,
            }),
          );
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "index.html" : url.pathname));
        return new Response((await file.exists()) ? file : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    store?.db.close();
  });
  test("scope selection, empty/failure explanations and refresh never trigger collection", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${origin}/collection-quality`);
      await page
        .getByText("取得元を選ぶと、対象を限定して状態を読み込みます。", { exact: true })
        .waitFor();
      expect(requests.some((request) => request.path.startsWith("/api/collection-quality/"))).toBe(
        false,
      );
      await page.getByRole("link", { name: "vpass", exact: true }).click();
      await page
        .getByText("この口座・カードの原本ファイルがありません", { exact: false })
        .waitFor();
      expect(
        await page.getByText("本人による認証・操作が必要です", { exact: false }).count(),
      ).toBeGreaterThan(0);
      // collection-freshness-v1: the chosen source's newest run is two days old
      // (GLOBAL PASS, listed before it, is one day old); the unit with no file
      // waits on a person and has no current capture.
      expect(
        await page
          .locator("p", { hasText: "最新の取得記録の新しさ" })
          .locator('.freshness[data-state="recent"]')
          .textContent(),
      ).toBe("2日前の取得");
      const listed = (sourceId: string) =>
        page
          .locator("nav li")
          .filter({ has: page.getByRole("link", { name: sourceId, exact: true }) })
          .locator(".freshness")
          .textContent();
      expect(await listed("vpass")).toBe("2日前の取得");
      expect(await listed("global-pass")).toBe("1日前の取得");
      expect(
        await page.locator('.freshness[data-state="human-required"]').first().textContent(),
      ).toBe("本人操作待ち（取得なし）");
      expect(
        await page.locator('nav .freshness[data-state="human-required"]').count(),
      ).toBeGreaterThan(0);
      // PRESTIA bank's only job is disabled and it was never captured.
      expect(
        await page.locator('nav .freshness[data-state="disabled"]').first().textContent(),
      ).toBe("定期実行の停止中（取得なし）");
      // provider-data-types-v1: what Vpass offers and what of it is collected.
      expect(await page.getByText("カード利用明細: 収集・解析済み", { exact: false }).count()).toBe(
        1,
      );
      expect(await page.locator('li[data-status="collected"]').count()).toBeGreaterThan(0);
      expect(
        await page.getByText("予約状態を確認できません", { exact: false }).count(),
      ).toBeGreaterThan(0);
      expect(
        await page
          .getByText("原本なし。空の履歴や完全取得を意味しません。", { exact: true })
          .count(),
      ).toBe(1);
      expect(await page.getByText("現在の表示対象なし", { exact: false }).count()).toBeGreaterThan(
        0,
      );
      // INV05: with no published parse, counts are not 0 but not counted.
      expect(
        await page.getByText("保存された観測は未集計", { exact: false }).count(),
      ).toBeGreaterThan(0);
      expect(
        await page.getByText("未確定の観測は未集計", { exact: false }).count(),
      ).toBeGreaterThan(0);
      expect(await page.getByText("保存された観測 0 件", { exact: false }).count()).toBe(0);
      expect(
        await page.getByRole("heading", { name: /^データ種別不明/ }).evaluate((heading) => ({
          fits: heading.scrollWidth <= heading.clientWidth,
          wrapped: heading.getBoundingClientRect().height > 60,
        })),
      ).toEqual({ fits: true, wrapped: true });
      const reads = requests.filter((request) =>
        request.path.startsWith("/api/collection-quality"),
      ).length;
      // The spinner appears only once the query cache reports the refetch, so
      // its absence right after the click proves nothing: wait for the read.
      const refetched = page.waitForResponse((response) =>
        new URL(response.url()).pathname.startsWith("/api/collection-quality"),
      );
      await page.getByRole("button", { name: "表示を更新", exact: false }).click();
      await refetched;
      await page.waitForFunction(() => !document.querySelector(".refresh-symbol.is-refreshing"));
      expect(
        requests.filter((request) => request.path.startsWith("/api/collection-quality")).length,
      ).toBeGreaterThan(reads);
      await page.getByRole("link", { name: "sony-bank", exact: true }).click();
      await page
        .getByText("この範囲の取得・解析記録がありません。完全取得や取引ゼロとは判定できません。", {
          exact: true,
        })
        .waitFor();
      expect(await page.getByText("synthetic-card", { exact: false }).count()).toBe(0);
      // provider-data-types-v1: Sony Bank's history is partial and its term
      // deposits are not collected, each linked to the issue that tracks it;
      // the source list counts the types not wholly collected.
      expect(await page.locator('li[data-status="partial"]').count()).toBeGreaterThan(0);
      expect(
        await page.locator('li[data-status="not_collected"]', { hasText: "term_deposit" }).count(),
      ).toBe(1);
      expect(
        await page
          .locator('li[data-status="partial"]', { hasText: "cash_movement" })
          .getByRole("link", { name: "残りの対応 #449" })
          .getAttribute("href"),
      ).toBe("https://github.com/risu729/kogane/issues/449");
      expect(await page.getByText(/未収集・一部のみのデータ種別 \d+ 件/).count()).toBeGreaterThan(
        0,
      );
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
      expect(
        requests.some(
          (request) =>
            request.path.includes("/ops/") ||
            (request.path.includes("collect") && !request.path.includes("collection-quality")),
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);
  test("the scope picker and a chosen source pass the accessibility audit", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${origin}/collection-quality`);
      await page
        .getByText("取得元を選ぶと、対象を限定して状態を読み込みます。", { exact: true })
        .waitFor();
      expect(await auditView(page)).toEqual([]);
      await page.getByRole("link", { name: "vpass", exact: true }).click();
      await page
        .getByText("この口座・カードの原本ファイルがありません", { exact: false })
        .waitFor();
      expect(await auditView(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60000);
  test("the account view lists a source's periods per account and the records no account names", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      const before = requests.length;
      await page.goto(`${origin}/collection-quality?source=global-pass`);
      // The default view reads the cells, never the account regrouping.
      await page.getByRole("heading", { name: "口座・カード × データ種別 × 期間" }).waitFor();
      expect(requests.slice(before).some((request) => request.path.endsWith("/accounts"))).toBe(
        false,
      );
      await page.getByRole("link", { name: "口座ごと", exact: true }).click();
      await page.getByRole("heading", { name: "口座 × データ種別 × 期間", exact: true }).waitFor();
      expect(
        await page
          .getByRole("link", { name: "口座ごと", exact: true })
          .getAttribute("aria-current"),
      ).not.toBeNull();
      await page.getByRole("heading", { name: "Synthetic browser account" }).waitFor();
      expect(await page.getByText("口座の対応が未確定", { exact: false }).count()).toBe(1);
      expect(
        await page
          .getByText("カード利用明細 · 取引 · globalpass-activity", { exact: true })
          .count(),
      ).toBe(1);
      expect(await page.getByText("最新の取得が現在の表示対象", { exact: false }).count()).toBe(1);
      expect(await page.getByText("この口座の観測 1 件", { exact: false }).count()).toBe(1);
      // collection-freshness-v1: the account, its data type and its one month
      // stand on the month captured one day before the answer's date.
      const panel = page.locator("section.panel").filter({
        has: page.getByRole("heading", { name: "Synthetic browser account" }),
      });
      expect(await panel.locator('.freshness[data-state="recent"]').allTextContents()).toEqual([
        "1日前の取得",
        "1日前の取得",
        "1日前の取得",
      ]);
      expect(
        await page
          .getByText("（日本時間）までの日数です。口座とデータ種別の新しさは", { exact: false })
          .count(),
      ).toBe(1);
      expect(await page.getByText("2099-01-03", { exact: false }).count()).toBeGreaterThan(0);
      // The pending month names no account: it is listed apart with its reason.
      const apart = page.locator("section.panel").filter({
        has: page.getByRole("heading", { name: "口座に対応付けられない保存記録" }),
      });
      expect(await apart.getByText("解析待ち・解析中です", { exact: false }).count()).toBe(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(
        requests.slice(before).filter((request) => request.path.endsWith("/accounts")),
      ).toEqual([{ path: "/api/collection-quality/global-pass/accounts", method: "GET" }]);
      expect(await auditView(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);
  test("the account view states an empty answer as unknown and shows a refused one as refused, never in part", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      // vpass has a unit with no file and no observation: no account is named.
      await page.goto(`${origin}/collection-quality?source=vpass&view=accounts`);
      await page.getByRole("heading", { name: "口座 × データ種別 × 期間", exact: true }).waitFor();
      expect(
        await page
          .getByText(
            "口座に対応付けられた観測がありません。取得や取引がないことの証明ではありません。",
            {
              exact: true,
            },
          )
          .count(),
      ).toBe(1);
      const apart = page.locator("section.panel").filter({
        has: page.getByRole("heading", { name: "口座に対応付けられない保存記録" }),
      });
      expect(
        await apart
          .getByText("この口座・カードの原本ファイルがありません", { exact: false })
          .count(),
      ).toBeGreaterThan(0);
      expect(await auditView(page)).toEqual([]);
      // The account answer owns the catalogue: gaps remain visible even
      // when no observation names an account, without relying on summary data.
      await page.goto(`${origin}/collection-quality?source=sony-bank&view=accounts`);
      const catalogue = page
        .locator("section.panel")
        .filter({
          has: page.getByRole("heading", { name: "口座表示の提供元データ種別", exact: true }),
        });
      await catalogue.waitFor();
      expect(await catalogue.getByText("入出金明細", { exact: false }).count()).toBe(1);
      expect(await catalogue.getByText("一部のみ", { exact: false }).count()).toBeGreaterThan(0);
      expect(await catalogue.getByText("未収集", { exact: false }).count()).toBeGreaterThan(0);
      expect(
        await catalogue.locator('a[href="https://github.com/risu729/kogane/issues/449"]').count(),
      ).toBeGreaterThan(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(await auditView(page)).toEqual([]);
      // More cells than the bound is refused whole (413): no account, period
      // or count is shown, only the refusal.
      await page.route("**/api/collection-quality/global-pass/accounts", (route) =>
        route.fulfill({ status: 413, json: { error: "result_limit_exceeded" } }),
      );
      await page.goto(`${origin}/collection-quality?source=global-pass&view=accounts`);
      await page.getByRole("alert").filter({ hasText: "(HTTP 413)" }).waitFor();
      expect(
        await page.getByRole("heading", { name: "口座 × データ種別 × 期間", exact: true }).count(),
      ).toBe(0);
      expect(await page.getByText("Synthetic browser account", { exact: false }).count()).toBe(0);
      expect(await page.getByText("この口座の観測", { exact: false }).count()).toBe(0);
      expect(await auditView(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);
});
