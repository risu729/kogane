// 依頼の一覧 in the production client, on a desktop and a phone viewport,
// against a server whose pages the application's own `listOperations` reads
// from a synthetic store (bun:sqlite with every CORE migration). The page
// sends only the route's closed `kind`, `status` and `cursor`, never a page
// size; pages by the cursor without a total; links each row to its 依頼の経過;
// reads once per page and polls nothing; tells a non-operator plainly that the
// list is the operator's; shows each request with the status its 依頼の経過
// page shows (a stored `running` collection whose `projected` stage a
// synthetic READ covers is 完了, with its stored 進行中 beside it) while the
// status filter matches the stored status; and refuses a malformed page, or
// one that answers other filters than it sent. Every value is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  OPERATION_LIST_PATH,
  OPERATION_RECORD_KINDS,
  OPERATION_RECORD_STATUSES,
  validOperationListPage,
} from "../../../packages/observation-shared/src/operation-contract.ts";
import {
  listOperations,
  type OperationKind,
  type OperationStatus,
  type Principal,
  readOperation,
  STAGES_BY_KIND,
} from "../../../packages/application/src/index.ts";
import {
  publishedReadDatabase,
  sqliteExecutor as executor,
} from "../../../packages/application/test/read-store.ts";
import {
  migratedDatabase,
  sqliteCommandStore,
} from "../../../packages/application/test/sqlite-store.ts";
import { auditView } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const PRINCIPAL: Principal = {
  id: "operator@synthetic.test",
  kind: "human",
  verification: "server",
  capabilities: [],
};
/** 25 requests: one page of the route's 20 and a second of 5. */
const SIZE = 25;
const id = (index: number) => `op_${index.toString(16).padStart(64, "0")}`;
/** The newest request: the first row of the unfiltered list. */
const NEWEST = id(SIZE);
/** A collection stored `running` (20 % 5 is collection, 20 % 6 is running) that READ covers. */
const PROJECTED = id(20);

/** The synthetic store: every kind and status, failure codes, and two requests accepted together. */
function seed(db: Database): void {
  for (let index = 1; index <= SIZE; index++) {
    const kind: OperationKind = OPERATION_RECORD_KINDS[index % OPERATION_RECORD_KINDS.length]!;
    const status: OperationStatus =
      OPERATION_RECORD_STATUSES[index % OPERATION_RECORD_STATUSES.length]!;
    // Requests 2 and 5 share a second, so the id orders them: 5, then 2, then 4.
    const second = index === 2 ? 5 : index;
    const at = `2026-09-11T00:00:${String(second).padStart(2, "0")}Z`;
    db.run(
      `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,
        source_id,request_json,status,dispatch_state,created_at,updated_at)
       VALUES(?1,?2,?3,?1,?4,?5,'{"reason":"synthetic rebuild reason"}','accepted','dispatch_pending',?6,?6)`,
      [
        id(index),
        kind,
        index % 2 === 0 ? PRINCIPAL.id : "mcp-client:synthetic-client",
        "0".repeat(64),
        kind === "projection" ? null : "sony-bank",
        at,
      ],
    );
    if (status === "accepted") continue;
    db.run(
      `UPDATE ops_requests SET status=?2,dispatch_state='dispatched',dispatch_attempts=?3,
        failure_code=?4,updated_at='2026-09-11T01:00:00Z' WHERE operation_id=?1`,
      [
        id(index),
        status,
        1 + (index % 3),
        status === "failed"
          ? "collection_failed"
          : status === "blocked"
            ? "registration_blocked"
            : null,
      ],
    );
  }
  // PROJECTED reached adoption, and its publication stored the CORE revision
  // READ has to reach (ADR 0048, amended): its record reads completed once
  // the synthetic READ below covers that revision.
  for (const stage of STAGES_BY_KIND.collection)
    db.run(
      `INSERT INTO ops_request_stages(operation_id,stage,state,evidence_ref,failure_code,attempts,updated_at)
       VALUES(?1,?2,?3,?4,NULL,1,'2026-09-11T01:00:00Z')`,
      [
        PROJECTED,
        stage,
        stage === "projected" ? "pending" : "completed",
        stage === "projected" ? "core-revision:core-epoch-1:1" : "r_1",
      ],
    );
}

/** A READ database whose published pointer covers revision 1 of CORE's first epoch. */
const readDatabase = (): Database => publishedReadDatabase(1, "core-epoch-1");

describe.if(runnable)("the operator's 依頼の一覧 page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let db: Database;
  let read: Database;
  let operator = true;
  let provided = true;
  let malformed = false;
  let ignoreFilters = false;
  const reads: URLSearchParams[] = [];

  beforeEach(() => {
    operator = true;
    provided = true;
    malformed = false;
    ignoreFilters = false;
    reads.length = 0;
  });

  /** The route as `services/app` answers it, over the application's own `listOperations`. */
  async function answer(params: URLSearchParams): Promise<Response> {
    const keys = [...params.keys()];
    if (keys.some((key) => !["kind", "status", "cursor", "limit"].includes(key)))
      return Response.json({ error: "invalid_query" }, { status: 400 });
    const kind = params.get("kind");
    const status = params.get("status");
    const outcome = await listOperations({
      store: sqliteCommandStore(db),
      principal: PRINCIPAL,
      readStore: executor(read),
      query: {
        kind: ignoreFilters ? null : (kind as OperationKind | null),
        status: ignoreFilters ? null : (status as OperationStatus | null),
        cursor: params.get("cursor"),
        limit: params.has("limit") ? Number(params.get("limit")) : 20,
      },
    });
    if (!outcome.ok)
      return Response.json({ error: outcome.error, refs: outcome.refs ?? [] }, { status: 404 });
    if (malformed) return Response.json({ ...outcome.page, total: SIZE });
    return Response.json(outcome.page);
  }

  beforeAll(async () => {
    db = migratedDatabase();
    seed(db);
    read = readDatabase();
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
        if (url.pathname === OPERATION_LIST_PATH) {
          reads.push(url.searchParams);
          if (request.method !== "GET")
            return Response.json({ error: "method_not_allowed" }, { status: 405 });
          if (!provided) return Response.json({ error: "not_found" }, { status: 404 });
          if (!operator) return Response.json({ error: "approval_required" }, { status: 403 });
          return answer(url.searchParams);
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
    db?.close();
    read?.close();
  });

  const rows = (page: Page) =>
    page.getByRole("region", { name: "依頼の一覧の表", exact: true }).locator("tbody tr");
  const noPageOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const text = async (page: Page) => (await page.locator("main").innerText()).replace(/\s+/gu, " ");

  test("the store's pages are ones the contract accepts", async () => {
    const first = await (await answer(new URLSearchParams())).json();
    expect(validOperationListPage(first)).toBe(true);
    expect(first.operations).toHaveLength(20);
    expect(first.nextCursor).toBe(first.operations[19].operationId);
    // The covered collection is listed as its record reads it, beside its stored status.
    const record = await readOperation({
      store: sqliteCommandStore(db),
      readStore: executor(read),
      principal: PRINCIPAL,
      now: "2026-09-11T02:00:00Z",
      operationId: PROJECTED,
    });
    if (!record.ok) throw new Error(record.error);
    expect(record.receipt.status).toBe("completed");
    expect(
      first.operations.find((row: { operationId: string }) => row.operationId === PROJECTED),
    ).toMatchObject({ kind: "collection", status: "completed", storedStatus: "running" });
  });

  for (const viewport of VIEWPORTS)
    test(`${viewport.name}: navigation, labels, links and cursor paging without a total`, async () => {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        await page.goto(`${origin}/`);
        await page.locator("h1").first().waitFor();
        // The navigation entry is always listed, like the audit log's.
        const link = page.getByRole("link", { name: "依頼の一覧", exact: true });
        await link.click();
        await page.getByRole("heading", { level: 1, name: "依頼の一覧" }).waitFor();
        expect(page.url()).toBe(`${origin}/operations`);
        await page.waitForFunction(() => document.title === "依頼の一覧 | kogane");
        expect(await link.getAttribute("aria-current")).toBe("page");

        await rows(page).first().waitFor();
        expect(await rows(page).count()).toBe(20);
        // One read for one opening, with no filter and no page size.
        expect(reads).toHaveLength(1);
        expect([...reads[0]!.keys()]).toEqual([]);
        await page.getByText("1ページ目 · このページ20件", { exact: true }).waitFor();
        await page.getByText("依頼の一覧のページ：続きがあります", { exact: true }).waitFor();
        const shown = await text(page);
        for (const expected of [
          "収集",
          "取り込み（保存済みの収集結果の登録）",
          "再処理（解析のやり直し）",
          "読み取りモデルの再構築",
          "セッション更新",
          "受付済み（未実行）",
          "本人操作待ち",
          "進行中",
          "完了",
          "失敗",
          "停止",
          "収集処理が失敗を報告しました",
          "collection_failed",
          "取得記録への登録が拒否されました",
          "registration_blocked",
          "処理へ引き渡し済み",
          "処理への引き渡し待ち",
          "sony-bank",
          "指定なし",
          "2026-09-11T00:00:25Z",
        ])
          expect(shown).toContain(expected);
        // No total, no principal and no request payload is shown.
        expect(shown).not.toMatch(/件中|全\d+件|合計/u);
        expect(shown).not.toContain("synthetic-client");
        expect(shown).not.toContain(PRINCIPAL.id);
        expect(shown).not.toContain("synthetic rebuild reason");
        // Nor in any attribute or accessible name: the whole document holds neither.
        const html = await page.content();
        for (const hidden of ["synthetic-client", PRINCIPAL.id, "synthetic rebuild reason"])
          expect(html).not.toContain(hidden);
        // The page says the status is 依頼の経過's, and the filter the stored one.
        expect(shown).toContain(
          "状態は依頼の経過と同じく、読み取りモデルへの反映まで確かめた状態です。",
        );
        expect(shown).toContain(
          "絞り込みは保存された状態で行うため、「進行中」で絞り込むとそうした「完了」の依頼も表示され、「完了」で絞り込むと表示されません。",
        );
        // Each row links to its 依頼の経過 page by its id.
        const first = rows(page).first().getByRole("link", { name: NEWEST, exact: true });
        expect(await first.getAttribute("href")).toBe(`/operations/${NEWEST}`);

        await page.getByRole("button", { name: "次のページ", exact: true }).click();
        await page.getByText("2ページ目 · このページ5件", { exact: true }).waitFor();
        expect(await rows(page).count()).toBe(5);
        expect(reads).toHaveLength(2);
        expect(Object.fromEntries(reads[1]!)).toEqual({ cursor: id(6) });
        await page.getByText("依頼の一覧のページ：最後のページです", { exact: true }).waitFor();
        expect(
          await page.getByRole("button", { name: "次のページ", exact: true }).isDisabled(),
        ).toBe(true);
        // Requests 2 and 5 were accepted in the same second: the higher id
        // first, and both before the earlier request 4.
        const last = (await rows(page).allInnerTexts()).map((row) => row.replace(/\s+/gu, ""));
        expect(
          [id(5), id(2), id(4), id(3), id(1)].map((op) =>
            last.findIndex((row) => row.includes(op)),
          ),
        ).toEqual([0, 1, 2, 3, 4]);
        await page.getByRole("button", { name: "前のページ", exact: true }).click();
        await page.getByText("1ページ目 · このページ20件", { exact: true }).waitFor();

        // The table scrolls inside its region; the page itself never scrolls sideways.
        expect(await noPageOverflow(page)).toBe(true);
        const prefix = process.env["OPERATIONS_SCREENSHOT_PREFIX"];
        if (prefix)
          await page.screenshot({ path: `${prefix}-${viewport.name}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }, 60_000);

  test("the list passes the accessibility audit", async () => {
    const page = await browser.newPage();
    try {
      // Both widths, with a row that shows its stored status beside its status.
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const search of ["", "?status=running"]) {
          await page.goto(`${origin}/operations${search}`);
          await rows(page).first().waitFor();
          expect(await page.getByText("保存された状態：", { exact: false }).count()).toBe(1);
          expect([viewport.name, search, await auditView(page)]).toEqual([
            viewport.name,
            search,
            [],
          ]);
        }
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  test("filters are the route's closed values, sent as query parameters, and reset paging", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`${origin}/operations`);
      await rows(page).first().waitFor();
      await page.getByRole("button", { name: "次のページ", exact: true }).click();
      await page.getByText("2ページ目 · このページ5件", { exact: true }).waitFor();
      const kind = page.getByLabel("依頼の種類", { exact: true });
      expect(await kind.locator("option").allInnerTexts()).toEqual([
        "すべての種類",
        "収集",
        "取り込み（保存済みの収集結果の登録）",
        "再処理（解析のやり直し）",
        "読み取りモデルの再構築",
        "セッション更新",
      ]);
      // The status filter names its basis: the stored status.
      expect(await page.getByLabel("状態", { exact: true }).count()).toBe(0);
      expect(
        await page.getByLabel("保存された状態", { exact: true }).locator("option").count(),
      ).toBe(7);
      await kind.selectOption("import");
      await page.getByRole("button", { name: "条件を適用" }).click();
      await page.waitForURL(`${origin}/operations?kind=import`);
      // A new filter is a new read from the newest request: the earlier cursor is not sent.
      await page.getByText("1ページ目 · このページ5件", { exact: true }).waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ kind: "import" });
      for (const row of await rows(page).allInnerTexts())
        expect(row).toContain("取り込み（保存済みの収集結果の登録）");

      // No import is running in the store.
      await page.getByLabel("保存された状態", { exact: true }).selectOption("running");
      await page.getByRole("button", { name: "条件を適用" }).click();
      await page.waitForURL(`${origin}/operations?kind=import&status=running`);
      await page.getByText("この条件に当てはまる依頼はありません。", { exact: true }).waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ kind: "import", status: "running" });

      await page.getByRole("button", { name: "条件をクリア" }).click();
      await page.waitForURL(`${origin}/operations`);
      await page.getByText("1ページ目 · このページ20件", { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a filtered URL deep-links, and a filter outside the closed lists sends nothing", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations?status=failed`);
      await rows(page).first().waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ status: "failed" });
      expect(await page.getByLabel("保存された状態", { exact: true }).inputValue()).toBe("failed");
      reads.length = 0;
      for (const search of ["?kind=rebuild", "?status=failed&status=blocked", "?limit=50"]) {
        await page.goto(`${origin}/operations${search}`);
        await page.getByText("このURLの絞り込み条件は指定できません。").waitFor();
      }
      expect(reads).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a covered collection is 完了 with its stored 進行中 under a 進行中 filter, and absent under 完了", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const rowOf = (op: string) =>
      rows(page).filter({ has: page.getByRole("link", { name: op, exact: true }) });
    try {
      await page.goto(`${origin}/operations?status=running`);
      await rows(page).first().waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ status: "running" });
      const covered = (await rowOf(PROJECTED).innerText()).replace(/\s+/gu, " ");
      expect(covered).toContain("完了 completed");
      expect(covered).toContain("保存された状態：進行中 running");
      // A request READ does not move shows its stored status once.
      const others = (await rows(page).allInnerTexts()).filter((row) => !row.includes(PROJECTED));
      expect(others.length).toBeGreaterThan(0);
      for (const row of others) {
        expect(row).toContain("進行中");
        expect(row).not.toContain("保存された状態");
      }
      expect(await noPageOverflow(page)).toBe(true);
      await page.goto(`${origin}/operations?status=completed`);
      await rows(page).first().waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ status: "completed" });
      expect(await rowOf(PROJECTED).count()).toBe(0);
      for (const row of await rows(page).allInnerTexts())
        expect(row).not.toContain("保存された状態");
    } finally {
      await page.close();
    }
  }, 60_000);

  test("the page re-reads only when asked", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations`);
      await rows(page).first().waitFor();
      expect(reads).toHaveLength(1);
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(OPERATION_LIST_PATH)),
        page.getByRole("button", { name: "最新の依頼から読み直す" }).click(),
      ]);
      expect(reads).toHaveLength(2);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a non-operator is told the list is the operator's, and sees no request", async () => {
    operator = false;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${origin}/operations`);
      await page.getByText("依頼の一覧は管理者だけが表示できます", { exact: true }).waitFor();
      expect(await page.locator("main table").count()).toBe(0);
      expect(await noPageOverflow(page)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a deployment without the operations API says the list is not provided", async () => {
    provided = false;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/operations`);
      await page
        .getByText("この接続先は依頼の一覧を提供していません。", { exact: false })
        .waitFor();
      expect(await page.locator("main table").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a malformed page, or one that answers other filters, is an error and never a partial list", async () => {
    const page = await browser.newPage();
    try {
      malformed = true;
      await page.goto(`${origin}/operations`);
      await page
        .getByText("受信したデータの形式が対応していません。接続先を確認してください。")
        .waitFor();
      expect(await page.locator("main table").count()).toBe(0);
      malformed = false;
      ignoreFilters = true;
      await page.goto(`${origin}/operations?kind=import`);
      await page
        .getByText("受信したデータの形式が対応していません。接続先を確認してください。")
        .waitFor();
      expect(Object.fromEntries(reads.at(-1)!)).toEqual({ kind: "import" });
      expect(await page.locator("main table").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
