// 依頼の経過 in the production client, against a server that answers
// `GET /api/ops/v1/operations/{id}` with synthetic records in the shape the
// application builds (operation-contract.ts; the App and Processor suites
// validate the real records against the same contract). The page shows the
// stored status, the stages, the collector execution and each reported run
// followed to its 取得記録, names every closed code, reads once per opening
// and again only when asked, tells a non-operator plainly that the trail is
// the operator's, and refuses a malformed record. Every value is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  OPERATION_RECORD_PATH_PREFIX,
  OPERATION_RECORD_STAGES_BY_KIND,
  validOperationRecord,
  type OperationRecordKind,
  type OperationRecordWire,
} from "../../../packages/observation-shared/src/operation-contract.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const id = (digit: string) => `op_${digit.repeat(64)}`;
const PUBLISHED = id("1");
const WAITING = id("2");
const REBUILD = id("3");
const MISSING = id("4");

const pending = (kind: OperationRecordKind) =>
  OPERATION_RECORD_STAGES_BY_KIND[kind].map((stage) => ({
    stage,
    state: "pending" as const,
    evidenceRef: null,
    failureCode: null,
    attempts: 0,
    updatedAt: null,
  }));

/** A collection followed to publication; one run published, one never registered. */
const published: OperationRecordWire = {
  schemaVersion: "kogane-operation-v1",
  operationId: PUBLISHED,
  kind: "collection",
  status: "running",
  source: "synthetic-bank",
  targetRef: "collector:synthetic-bank-collect",
  dispatch: { state: "dispatched", attempts: 1 },
  stages: pending("collection").map((stage) =>
    stage.stage === "projected"
      ? stage
      : {
          ...stage,
          state: "completed",
          evidenceRef: stage.stage === "persisted" ? "runs:2" : "r_12",
          attempts: 1,
          updatedAt: "2026-09-11T00:15:00Z",
        },
  ),
  failureCode: null,
  acceptedAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:15:00Z",
  execution: {
    action: "collect",
    state: "published",
    connectionId: "synthetic-bank-collect",
    reasonCode: null,
    scope: "collector_default",
    waits: 1,
    expiresAt: "2026-09-12T00:00:00.000Z",
    startedAt: "2026-09-11T00:05:00.000Z",
    collectedAt: "2026-09-11T00:06:00.000Z",
    publishedAt: "2026-09-11T00:15:00.000Z",
    finishedAt: "2026-09-11T00:15:00.000Z",
    runs: [
      {
        runId: "synthetic-run-001",
        state: "published",
        reasonCode: null,
        blockedCode: null,
        providerOutcome: "success",
        evidenceRunId: "r_12",
        registeredAt: "2026-09-11T00:10:00.000Z",
        artifacts: {
          total: 3,
          parseSelected: 2,
          published: 1,
          pending: 0,
          parseFailed: 1,
          notPublished: 1,
        },
      },
      {
        runId: "synthetic-run-002",
        state: "blocked",
        reasonCode: "registration_blocked",
        blockedCode: "terminal_digest_conflict",
        providerOutcome: "partial",
        evidenceRunId: null,
        registeredAt: null,
        artifacts: null,
      },
    ],
  },
};

/** Accepted and waiting: the connection is not enabled for operations. */
const waiting: OperationRecordWire = {
  schemaVersion: "kogane-operation-v1",
  operationId: WAITING,
  kind: "collection",
  status: "accepted",
  source: "synthetic-bank",
  targetRef: null,
  dispatch: { state: "dispatch_pending", attempts: 0 },
  stages: pending("collection"),
  failureCode: null,
  acceptedAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  execution: {
    action: "collect",
    state: "waiting",
    connectionId: "synthetic-bank-collect",
    reasonCode: "collector_dispatch_disabled",
    scope: "collector_default",
    waits: 3,
    expiresAt: "2026-09-12T00:00:00.000Z",
    startedAt: null,
    collectedAt: null,
    publishedAt: null,
    finishedAt: null,
    runs: [],
  },
};

/** A read-model rebuild: no collector, one stage. */
const rebuild: OperationRecordWire = {
  schemaVersion: "kogane-operation-v1",
  operationId: REBUILD,
  kind: "projection",
  status: "accepted",
  source: null,
  targetRef: `projection:${REBUILD}`,
  dispatch: { state: "dispatched", attempts: 1 },
  stages: [
    {
      stage: "projected",
      state: "retryable",
      evidenceRef: null,
      failureCode: "snapshot_incomplete",
      attempts: 1,
      updatedAt: "2026-09-11T00:10:00Z",
    },
  ],
  failureCode: null,
  acceptedAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:10:00Z",
  execution: null,
};

const RECORDS = new Map(
  [published, waiting, rebuild].map((record) => [record.operationId, record]),
);

describe.if(runnable)("the operator's 依頼の経過 page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let operator = true;
  let malformed = false;
  const reads: string[] = [];

  beforeEach(() => {
    operator = true;
    malformed = false;
    reads.length = 0;
  });
  beforeAll(async () => {
    for (const record of RECORDS.values())
      expect(validOperationRecord(record, record.operationId)).toBe(true);
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
        if (url.pathname.startsWith(OPERATION_RECORD_PATH_PREFIX)) {
          reads.push(url.pathname.slice(OPERATION_RECORD_PATH_PREFIX.length));
          if (request.method !== "GET")
            return Response.json({ error: "method_not_allowed" }, { status: 405 });
          if (!operator) return Response.json({ error: "approval_required" }, { status: 403 });
          const record = RECORDS.get(url.pathname.slice(OPERATION_RECORD_PATH_PREFIX.length));
          if (!record) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json(malformed ? { ...record, status: "done" } : record);
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "index.html" : url.pathname));
        return new Response((await file.exists()) ? file : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const noPageOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const text = async (page: Page) => (await page.locator("main").innerText()).replace(/\s+/gu, " ");

  for (const viewport of VIEWPORTS)
    test(`${viewport.name}: a collection followed from its request to its runs`, async () => {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        await page.goto(`${origin}/operations/${PUBLISHED}`);
        await page.getByRole("heading", { level: 1, name: "依頼の経過" }).waitFor();
        await page.waitForFunction(() => document.title === "依頼の経過 | kogane");
        await page.getByRole("heading", { level: 2, name: "報告された収集実行" }).waitFor();
        // One read for one opening; the page never polls.
        expect(reads).toEqual([PUBLISHED]);
        const shown = await text(page);
        for (const expected of [
          "収集",
          "進行中",
          "処理へ引き渡し済み",
          "collector:synthetic-bank-collect",
          // The stages in order, the untraced READ projection still not reached.
          "収集結果の保存",
          "取得記録への登録",
          "読み取りモデルへの反映",
          "未到達",
          "公開を確認",
          // The requested window is stored, not applied.
          "依頼で指定した期間は保存されるだけで、収集には使われません。",
          "synthetic-run-001",
          "公開済み",
          "ファイル 3件",
          "解析対象 2件",
          "公開されず 1件（うち解析失敗 1件）",
          "synthetic-run-002",
          "登録を拒否",
          "取得記録への登録が拒否されました",
          "terminal_digest_conflict",
          "登録前のため未集計",
          "一部のみ",
        ])
          expect(shown).toContain(expected);
        // A registered run links to its 取得記録 in the evidence browser.
        const runLinks = page.getByRole("link", { name: "取得記録 r_12" });
        // Three stages and the published run name the same fetch run.
        expect(await runLinks.count()).toBe(4);
        expect(await runLinks.last().getAttribute("href")).toBe("/runs/r_12");
        // Back to where operations are found.
        expect(
          await page
            .getByRole("link", { name: "監査ログ", exact: true })
            .first()
            .getAttribute("href"),
        ).toBe("/audit");
        expect(await noPageOverflow(page)).toBe(true);
        const prefix = process.env["OPERATION_SCREENSHOT_PREFIX"];
        if (prefix)
          await page.screenshot({ path: `${prefix}-${viewport.name}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }, 60_000);

  test("a waiting request says why it waits, and re-reads only when asked", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations/${WAITING}`);
      await page.getByRole("heading", { level: 2, name: "収集の実行" }).waitFor();
      const shown = await text(page);
      for (const expected of [
        "受付済み（未実行）",
        "開始待ち",
        "この接続からの実行は有効になっていません",
        "collector_dispatch_disabled",
        "3回",
        "まだありません",
        "収集処理はまだ実行記録を報告していません。",
      ])
        expect(shown).toContain(expected);
      expect(reads).toEqual([WAITING]);
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(WAITING)),
        page.getByRole("button", { name: "最新の状態を読み直す" }).click(),
      ]);
      expect(reads).toEqual([WAITING, WAITING]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a rebuild has its one stage and no collector execution", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations/${REBUILD}`);
      await page.getByRole("heading", { level: 2, name: "段階" }).waitFor();
      const shown = await text(page);
      expect(shown).toContain("読み取りモデルの再構築");
      expect(shown).toContain("再試行待ち");
      expect(shown).toContain("snapshot_incomplete");
      expect(shown).toContain("指定なし");
      expect(await page.getByRole("heading", { level: 2, name: "収集の実行" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a non-operator is told the trail is the operator's, and sees no record", async () => {
    operator = false;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${origin}/operations/${PUBLISHED}`);
      await page.getByText("依頼の経過は管理者だけが表示できます", { exact: true }).waitFor();
      expect(await page.locator("main").getByRole("heading", { level: 2 }).count()).toBe(0);
      expect(await noPageOverflow(page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("an unknown operation reads as not found, saying whose it may be", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations/${MISSING}`);
      await page.getByText("この依頼は見つかりません。", { exact: false }).waitFor();
      expect(reads).toEqual([MISSING]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a path that is not an operation id sends no request", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations/op_123`);
      await page.locator("h1").first().waitFor();
      expect(await page.locator("h1").first().innerText()).not.toBe("依頼の経過");
      expect(reads).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a malformed record is an error, never a partial trail", async () => {
    malformed = true;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations/${PUBLISHED}`);
      await page
        .getByText("受信したデータの形式が対応していません。接続先を確認してください。")
        .waitFor();
      expect(await page.locator("main").getByRole("heading", { level: 2 }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
