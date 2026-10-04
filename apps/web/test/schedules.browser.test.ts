import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import jobs from "../../../config/alarm-jobs.json";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema";
import type { ScheduleSnapshot } from "../../../packages/collection/src/schedule-model";
const client = join(import.meta.dir, "../dist-production"),
  executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
describe.if(runnable)("operator schedule administration", () => {
  let browser: Browser,
    server: ReturnType<typeof Bun.serve>,
    origin: string,
    snapshot: ScheduleSnapshot;
  let writes: {
    path: string;
    body: Record<string, unknown>;
    origin: string | null;
    marker: string | null;
  }[] = [];
  beforeEach(() => {
    writes = [];
    snapshot = {
      schedules: jobs.map((job) => ({
        ...job,
        revision: 1,
        nextNominalAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        nextRunAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        actualAlarmAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        reservation: job.enabled ? "armed" : "disabled",
        maintenance: {
          status: "not-found",
          referenceUrl: "https://example.test/maintenance",
          verifiedAt: "2026-10-04T14:40:00.000Z",
        },
        latest:
          job.id === "sony-bank"
            ? {
                id: "synthetic",
                scheduleId: job.id,
                nominalAt: "2026-10-04T21:00:00.000Z",
                startedAt: "2026-10-04T21:00:00.000Z",
                finishedAt: "2026-10-04T21:01:00.000Z",
                status: "completed",
                runIds: ["synthetic-sony"],
                runLinks: [{ runId: "synthetic-sony", evidenceId: "r_123" }],
                failureCode: null,
              }
            : null,
      })),
      maintenance: [],
      occurrences: [],
      leases: [],
    } as ScheduleSnapshot;
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
        if (url.pathname === "/api/ops/v1/schedules") return Response.json(snapshot);
        if (url.pathname.startsWith("/api/ops/v1/schedules/") && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          writes.push({
            path: url.pathname,
            body,
            origin: request.headers.get("origin"),
            marker: request.headers.get("x-kogane-settings"),
          });
          const id = url.pathname.split("/").at(-1);
          const row = snapshot.schedules.find((s) => s.id === id);
          if (row) {
            Object.assign(row, { ...body, revision: row.revision + 1 });
          }
          return Response.json({ saved: true, reservation: "armed" });
        }
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
  });
  for (const width of [1280, 390])
    test(`daily time edits persist and exact evidence links remain visible at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      await page.goto(`${origin}/schedules`);
      await page.getByRole("heading", { name: "収集スケジュール", exact: true }).waitFor();
      const card = page
        .locator(".schedule-card")
        .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
      await card.getByRole("link", { name: "取得記録を見る", exact: true }).waitFor();
      expect(
        await card.getByRole("link", { name: "取得記録を見る", exact: true }).getAttribute("href"),
      ).toBe("/runs/r_123");
      expect(await page.getByText("管理者による設定変更", { exact: true }).count()).toBe(1);
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('[aria-label="ソニー銀行の実行時刻"]')?.value ===
          "06:40",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: "/api/ops/v1/schedules/sony-bank",
        origin,
        marker: "1",
        body: {
          revision: 1,
          enabled: true,
          timezone: "Asia/Tokyo",
          pattern: { kind: "daily", time: "06:40", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        },
      });
      await page.reload();
      await page.getByLabel("ソニー銀行の実行時刻").waitFor();
      expect(await page.getByLabel("ソニー銀行の実行時刻").inputValue()).toBe("06:40");
      const manual = page
        .locator(".schedule-card")
        .filter({ has: page.getByRole("heading", { name: "SMBCダイレクト", exact: true }) });
      expect(await manual.getByRole("button", { name: "設定を保存" }).count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (process.env["ALARM_SCREENSHOT_DIRECTORY"])
        await page.screenshot({
          path: `${process.env["ALARM_SCREENSHOT_DIRECTORY"]}/alarms-admin-${width}.png`,
        });
      await page.close();
    }, 30000);
  test("a dated maintenance change uses Japan time and retains provenance", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/schedules`);
    await page.getByRole("button", { name: "停止時間を追加", exact: true }).click();
    const form = page.locator(".maintenance-editor");
    await form.getByLabel("設定名（半角英数字・ハイフン）").fill("synthetic-outage");
    await form.getByLabel("取得元", { exact: true }).selectOption("sony-bank");
    await form.getByLabel("開始（日本時間）", { exact: true }).fill("2026-10-06T01:00");
    await form.getByLabel("終了（日本時間）", { exact: true }).fill("2026-10-06T05:00");
    await form
      .getByLabel("公式案内のURL", { exact: true })
      .fill("https://example.test/maintenance");
    await form
      .getByLabel("公式案内を確認した日時（日本時間）", { exact: true })
      .fill("2026-10-04T23:00");
    await form.getByRole("button", { name: "停止時間を保存", exact: true }).click();
    await form.waitFor({ state: "detached" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      id: "synthetic-outage",
      source: "sony-bank",
      revision: 0,
      referenceUrl: "https://example.test/maintenance",
      verifiedAt: "2026-10-04T14:00:00.000Z",
      pattern: { kind: "once", from: "2026-10-05T16:00:00.000Z", to: "2026-10-05T20:00:00.000Z" },
    });
    await page.close();
  }, 30000);
});
