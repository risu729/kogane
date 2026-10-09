import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../../packages/read-model/test/collection-quality-fixture.ts";
import {
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../../../packages/application/src/query/collection-quality.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
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
    const executor: SqlExecutor = {
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
          return Response.json(await queryCollectionQualitySummary(executor));
        if (url.pathname.startsWith("/api/collection-quality/"))
          return Response.json(
            await queryCollectionQualityCells(executor, {
              sourceId: url.pathname.split("/").at(-1)!,
              offset: Number(url.searchParams.get("offset") ?? 0),
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
      expect(
        await page.getByRole("heading", { name: /^データ種別不明/ }).evaluate((heading) => ({
          fits: heading.scrollWidth <= heading.clientWidth,
          wrapped: heading.getBoundingClientRect().height > 60,
        })),
      ).toEqual({ fits: true, wrapped: true });
      const reads = requests.filter((request) =>
        request.path.startsWith("/api/collection-quality"),
      ).length;
      await page.getByRole("button", { name: "表示を更新", exact: false }).click();
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
});
