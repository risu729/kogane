// The ホーム page's 最近の変化 panel (ADR 0127 amendment of 2026-11-20) against a
// synthetic server: per source, the new runs, captures, parses and
// observations by their closed state; a cut count as a lower bound; the
// unchanged sources collapsed; the events line and what is not covered; the
// continuation; no panel for a refused caller or a deployment without the
// route; an error state, never zeros, for a failed or malformed answer. Every
// id, time and count is synthetic.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Overview } from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  CHANGES_SINCE_CAPTURE_BOUND,
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_HANDLERS,
  CHANGES_SINCE_MAX_BYTES,
  CHANGES_SINCE_MAX_DAYS,
  CHANGES_SINCE_NOT_COVERED,
  CHANGES_SINCE_OBSERVATION_BOUND,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_RUN_WALK,
  CHANGES_SINCE_SOURCE_BOUND,
  ECONOMIC_EVENT_KINDS,
  type ChangesSinceSourceLine,
} from "../../../packages/domain/src/changes-since.ts";
import {
  CHANGES_SINCE_PATH,
  validChangesSince,
} from "../../../packages/observation-shared/src/changes-since-contract.ts";
import { auditView } from "./a11y-audit.ts";
import { settledTest } from "./settle.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

const overview: Overview = {
  counts: [],
  sources: [
    { id: "synthetic-bank", provider: "Synthetic Bank", ingestion: "synthetic", artifact_count: 2 },
  ],
  fetchRuns: [],
  parseRuns: [],
};

const HOUR = 3_600_000;
/** An instant `hours` before the module loaded, inside every window the panel offers. */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();
const zeros = (length: number): number[] => Array.from({ length }, () => 0);
const runs = (counts: Partial<Record<(typeof CHANGES_SINCE_RUN_STATUSES)[number], number>>) =>
  CHANGES_SINCE_RUN_STATUSES.map((state) => counts[state] ?? 0);
const parses = (counts: Partial<Record<(typeof CHANGES_SINCE_PARSE_STATES)[number], number>>) =>
  CHANGES_SINCE_PARSE_STATES.map((state) => counts[state] ?? 0);
const observations = (
  counts: Partial<Record<(typeof CHANGES_SINCE_OBSERVATION_KINDS)[number], number>>,
) => CHANGES_SINCE_OBSERVATION_KINDS.map((kind) => counts[kind] ?? 0);
const events = (counts: Partial<Record<(typeof ECONOMIC_EVENT_KINDS)[number], number>>) =>
  ECONOMIC_EVENT_KINDS.map((kind) => counts[kind] ?? 0);

/** A source with new runs of three states, their captures, parses and rows. */
const bank: ChangesSinceSourceLine = {
  source: "synthetic-bank",
  cut: [],
  runs: runs({ success: 2, failed: 1, open: 1 }),
  captures: 6,
  parses: parses({ published: 3, failed: 1 }),
  observations: observations({ transaction: 12, balance: 3 }),
  newestRunAt: hoursAgo(3),
  newestSealedRunId: "r_42",
  newestParsedAt: hoursAgo(2.9),
  newestParsedArtifactId: 7,
};
/** A source whose parse and observation counts the walks cut. */
const card: ChangesSinceSourceLine = {
  source: "synthetic-card",
  cut: ["parses", "observations"],
  runs: zeros(CHANGES_SINCE_RUN_STATUSES.length),
  captures: 0,
  parses: parses({ published: 5000 }),
  observations: observations({ transaction: 50000 }),
  newestRunAt: null,
  newestSealedRunId: null,
  newestParsedAt: hoursAgo(4),
  newestParsedArtifactId: 9,
};
const securities: ChangesSinceSourceLine = {
  ...bank,
  source: "synthetic-securities",
  runs: runs({ human_required: 1 }),
  captures: 0,
  parses: zeros(CHANGES_SINCE_PARSE_STATES.length),
  observations: zeros(CHANGES_SINCE_OBSERVATION_KINDS.length),
  newestSealedRunId: "r_43",
  newestParsedAt: null,
  newestParsedArtifactId: null,
};

function answer(since: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 2,
    schemaVersion: "kogane-changes-since-v1",
    since,
    asOf: new Date().toISOString(),
    after: null,
    basis: "recorded",
    bounds: {
      maxDays: CHANGES_SINCE_MAX_DAYS,
      sources: CHANGES_SINCE_SOURCE_BOUND,
      runWalk: CHANGES_SINCE_RUN_WALK,
      captures: CHANGES_SINCE_CAPTURE_BOUND,
      parseWalk: CHANGES_SINCE_PARSE_WALK,
      observations: CHANGES_SINCE_OBSERVATION_BOUND,
      eventWalk: CHANGES_SINCE_EVENT_WALK,
      maxBytes: CHANGES_SINCE_MAX_BYTES,
    },
    order: {
      runs: CHANGES_SINCE_RUN_STATUSES,
      parses: CHANGES_SINCE_PARSE_STATES,
      observations: CHANGES_SINCE_OBSERVATION_KINDS,
      events: ECONOMIC_EVENT_KINDS,
    },
    sections: { runs: "counted", captures: "counted", parses: "counted", observations: "counted" },
    sources: [bank, card],
    unchanged: ["synthetic-alpha", "synthetic-points", "synthetic-zeta"],
    next: null,
    events: {
      state: "counted",
      reason: null,
      complete: false,
      new: events({ purchase: 3, transfer: 1 }),
      revised: events({ purchase: 1 }),
      newestAt: hoursAgo(2.8),
    },
    handlers: CHANGES_SINCE_HANDLERS,
    notCovered: CHANGES_SINCE_NOT_COVERED,
    ...change,
  };
}

/** The first of two answers: the byte bound stopped it after `synthetic-card`. */
const firstPage = (since: string) =>
  answer(since, { unchanged: ["synthetic-alpha"], next: { after: "synthetic-card" } });
/** The answer that continues after `synthetic-card`. */
const secondPage = (since: string) =>
  answer(since, {
    after: "synthetic-card",
    sources: [securities],
    unchanged: ["synthetic-points"],
  });

const SINCE = hoursAgo(24);

type Mode =
  | "answer"
  | "paged"
  | "continuation_failed"
  | "bounded"
  | "refused"
  | "not_served"
  | "failed"
  | "malformed"
  | "narrow";

// Launched while the module loads, and only for a suite that runs: a timeout
// kills a browser a hook launched (test/settle.ts).
let browser: Browser;
if (runnable) browser = await chromium.launch({ executablePath });
const test = settledTest();

describe("the fixtures", () => {
  test("are answers the wire contract admits", () => {
    for (const value of [answer(SINCE), firstPage(SINCE), secondPage(SINCE)])
      expect(validChangesSince(value)).toBe(true);
  });
});

describe.if(runnable)("the 最近の変化 panel on ホーム", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let mode: Mode = "answer";
  /** The server's clock in mode `bounded`, which refuses a `since` past the digest's bound. */
  let serverNow = Date.now();
  const requests: URLSearchParams[] = [];
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
        if (url.pathname === "/api/overview") return Response.json(overview);
        if (url.pathname === CHANGES_SINCE_PATH) {
          requests.push(url.searchParams);
          const since = url.searchParams.get("since") ?? "";
          const after = url.searchParams.get("after");
          switch (mode) {
            case "refused":
              return Response.json({ error: "unauthorized" }, { status: 403 });
            case "not_served":
              return Response.json({ error: "not_found" }, { status: 404 });
            case "failed":
              return Response.json({ error: "internal" }, { status: 500 });
            case "malformed":
              // A count the order does not have: the contract refuses it.
              return Response.json(
                answer(since, { sources: [{ ...bank, parses: [...bank.parses, 0] }] }),
              );
            case "narrow":
              // A grant without evidence.read, where the events projection
              // is not served.
              return Response.json(
                answer(since, {
                  sections: {
                    runs: "unauthorized",
                    captures: "unauthorized",
                    parses: "counted",
                    observations: "counted",
                  },
                  sources: [
                    {
                      ...bank,
                      runs: null,
                      captures: null,
                      newestRunAt: null,
                      newestSealedRunId: null,
                    },
                  ],
                  events: {
                    state: "unavailable",
                    reason: "not_served",
                    complete: false,
                    new: null,
                    revised: null,
                    newestAt: null,
                  },
                }),
              );
            case "paged":
              return Response.json(after === null ? firstPage(since) : secondPage(since));
            case "bounded":
              return Date.parse(since) < serverNow - CHANGES_SINCE_MAX_DAYS * 24 * HOUR
                ? Response.json({ error: "invalid_query" }, { status: 400 })
                : Response.json(after === null ? firstPage(since) : secondPage(since));
            case "continuation_failed":
              return after === null
                ? Response.json(firstPage(since))
                : Response.json({ error: "internal" }, { status: 500 });
            default:
              return Response.json(answer(since));
          }
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        return new Response(
          Bun.file(
            url.pathname.startsWith("/assets/")
              ? join(client, url.pathname)
              : join(client, "index.html"),
          ),
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const panelOf = (page: Page) => page.locator('section[aria-labelledby="changes-since"]');
  const open = async (page: Page) => {
    await page.goto(`${origin}/`);
    const panel = panelOf(page);
    await panel.getByRole("heading", { name: "最近の変化" }).waitFor();
    return panel;
  };

  test("each source shows its new runs, captures, parses and rows by state", async () => {
    mode = "answer";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.getByRole("heading", { name: "Synthetic Bank · synthetic-bank" }).waitFor();
      const bankLine = panel.locator("li.changes-source").filter({ hasText: "synthetic-bank" });
      for (const text of [
        "収集成功 2件",
        "収集失敗 1件",
        "結果未確定 1件",
        "6件",
        "現行の解析 3件",
        "解析失敗 1件",
        "取引 12件",
        "残高 3件",
      ])
        expect(await bankLine.getByText(text, { exact: true }).count(), text).toBe(1);
      expect(await bankLine.getByRole("link", { name: "原本 #7" }).getAttribute("href")).toBe(
        "/artifacts/7",
      );
      // No count of the bank line is a lower bound.
      expect(await bankLine.getByText(/以上/u).count()).toBe(0);
      expect(await panel.locator(".panel-head .count").textContent()).toBe("取得元 2件");
      // The window asked for is the last 24 hours.
      const since = Date.parse(requests.at(-1)!.get("since")!);
      expect(Math.abs(Date.now() - 24 * HOUR - since)).toBeLessThan(5 * 60_000);
      expect(await panel.getByRole("button", { name: "24時間" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(await auditView(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a cut count reads as a lower bound, never as exact", async () => {
    mode = "answer";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      const cardLine = panel.locator("li.changes-source").filter({ hasText: "synthetic-card" });
      await cardLine.waitFor();
      expect(await cardLine.getByText("現行の解析 5,000件以上", { exact: true }).count()).toBe(1);
      expect(await cardLine.getByText("取引 50,000件以上", { exact: true }).count()).toBe(1);
      expect(await cardLine.getByText("上限で打ち切り").count()).toBe(2);
      // Its run sections were not cut, so their nothing is exact.
      expect(await cardLine.getByText("なし", { exact: true }).count()).toBe(2);
      // The events walk stopped short: each of its counts is a lower bound.
      expect(await panel.getByText("購入: 新規 3件以上 · 更新 1件以上").count()).toBe(1);
      expect(await panel.getByText("振替: 新規 1件以上 · 更新 0件以上").count()).toBe(1);
      // A state or kind the cut answer read as 0 is a lower bound too, never
      // an absence that reads as exactly none (INV05).
      expect(await cardLine.getByText("そのほか 0件以上", { exact: true }).count()).toBe(2);
      expect(await panel.getByText("そのほかの種類: 0件以上", { exact: true }).count()).toBe(1);
      const bankLine = panel.locator("li.changes-source").filter({ hasText: "synthetic-bank" });
      expect(await bankLine.getByText(/そのほか/u).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("unchanged sources are collapsed, and what is not counted is named", async () => {
    mode = "answer";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      const unchanged = panel.locator("details").filter({ hasText: "新しい記録のない取得元" });
      await unchanged.waitFor();
      expect(await unchanged.locator("summary").textContent()).toBe(
        "新しい記録のない取得元（3件）",
      );
      expect(await unchanged.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
      expect(await panel.getByText("synthetic-zeta").isVisible()).toBe(false);
      await unchanged.locator("summary").click();
      expect(await panel.getByText("synthetic-zeta").isVisible()).toBe(true);
      const notCovered = panel.locator("details").filter({ hasText: "この一覧で数えていないもの" });
      await notCovered.locator("summary").click();
      expect(await notCovered.locator("li").count()).toBe(CHANGES_SINCE_NOT_COVERED.length);
      expect(await notCovered.getByText(/金額は比べていません/u).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a longer window asks from further back", async () => {
    mode = "answer";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.locator("li.changes-source").first().waitFor();
      const asked = page.waitForRequest((request) =>
        request.url().includes(`${CHANGES_SINCE_PATH}?`),
      );
      await panel.getByRole("button", { name: "7日間" }).click();
      const since = Date.parse(new URL((await asked).url()).searchParams.get("since")!);
      expect(Math.abs(Date.now() - 7 * 24 * HOUR - since)).toBeLessThan(5 * 60_000);
      expect(await panel.getByRole("button", { name: "7日間" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a refetch reads the window from the clock again, and a continuation keeps its page's since", async () => {
    mode = "paged";
    const page = await browser.newPage();
    try {
      const start = Date.now();
      await page.clock.setFixedTime(start);
      const panel = await open(page);
      await panel.getByText("一覧は続きます", { exact: false }).waitFor();
      const chosen = page.waitForResponse((response) =>
        response.url().includes(`${CHANGES_SINCE_PATH}?`),
      );
      await panel.getByRole("button", { name: "30日間" }).click();
      const first = new URL((await chosen).url()).searchParams.get("since")!;
      expect(first).toBe(new Date(start - 30 * 24 * HOUR).toISOString());
      await panel.getByRole("button", { name: "続きを読み込む" }).waitFor();
      const continued = page.waitForResponse((response) => response.url().includes("after="));
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      expect(new URL((await continued).url()).searchParams.get("since")).toBe(first);
      // A day later the tab is focused again: the same since would now be
      // more than 31 days back (`since:too_old`), so both pages are read again
      // from 30 days before the clock, the continuation with the first page's.
      const later = start + 25 * HOUR;
      await page.clock.setFixedTime(later);
      const again = new Date(later - 30 * 24 * HOUR).toISOString();
      const refetched = page.waitForResponse(
        (response) =>
          response.url().includes("after=") &&
          new URL(response.url()).searchParams.get("since") === again,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await refetched;
      await panel.locator(`time[datetime="${again}"]`).waitFor();
      expect(await panel.locator(`time[datetime="${first}"]`).count()).toBe(0);
      expect(await panel.getByRole("alert").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("an answer the byte bound stopped continues on request", async () => {
    mode = "paged";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.getByText("一覧は続きます", { exact: false }).waitFor();
      // The sources listed so far, and more may follow.
      expect(await panel.locator(".panel-head .count").textContent()).toBe("取得元 2件以上");
      expect(await panel.locator("summary").first().textContent()).toBe(
        "新しい記録のない取得元（1件以上）",
      );
      expect(await panel.getByText("synthetic-securities").count()).toBe(0);
      const asked = page.waitForRequest((request) => request.url().includes("after="));
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      expect(new URL((await asked).url()).searchParams.get("after")).toBe("synthetic-card");
      const continued = panel
        .locator("li.changes-source")
        .filter({ hasText: "synthetic-securities" });
      await continued.waitFor();
      expect(await continued.getByText("操作が必要 1件", { exact: true }).count()).toBe(1);
      expect(await panel.getByRole("button", { name: "続きを読み込む" }).count()).toBe(0);
      expect(await panel.locator(".panel-head .count").textContent()).toBe("取得元 3件");
      expect(await panel.locator("summary").first().textContent()).toBe(
        "新しい記録のない取得元（2件）",
      );
      expect(await auditView(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a failed continuation keeps the answer read, and nothing reads as complete", async () => {
    mode = "continuation_failed";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      await panel
        .getByRole("alert")
        .filter({ hasText: "最近の変化の続きを読み込めませんでした" })
        .waitFor({ timeout: 10_000 });
      // The first answer's lines stay, still as an unfinished list.
      expect(await panel.locator("li.changes-source").count()).toBe(2);
      expect(await panel.getByText("一覧は続きます", { exact: false }).count()).toBe(1);
      expect(await panel.locator("summary").first().textContent()).toBe(
        "新しい記録のない取得元（1件以上）",
      );
      // No header count while the read is in error, and no whole-panel error.
      expect(await panel.locator(".panel-head .count").count()).toBe(0);
      expect(
        await panel
          .getByRole("alert")
          .filter({ hasText: "最近の変化を読み込めませんでした" })
          .count(),
      ).toBe(0);
      expect(await panel.getByText("この期間に新しく記録されたものはありません。").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a window whose continuation failed keeps its answer while it is read again on return", async () => {
    mode = "continuation_failed";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      const failed = panel
        .getByRole("alert")
        .filter({ hasText: "最近の変化の続きを読み込めませんでした" });
      await failed.waitFor({ timeout: 10_000 });
      // Another window is read and settles; the first window's failed
      // continuation is still its query's error.
      const week = page.waitForResponse(
        (response) =>
          response.url().includes(`${CHANGES_SINCE_PATH}?`) && !response.url().includes("after="),
      );
      await panel.getByRole("button", { name: "7日間" }).click();
      await week;
      await panel.getByRole("button", { name: "続きを読み込む" }).waitFor({ timeout: 10_000 });
      // Back on the first window, its stale answer is read again. The reread
      // is held: while it runs, the answer read and the error beside the
      // button stay, not a whole-panel error in their place.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**${CHANGES_SINCE_PATH}?*`, async (request) => {
        await held;
        await request.continue();
      });
      const reread = page.waitForRequest((request) =>
        request.url().includes(`${CHANGES_SINCE_PATH}?`),
      );
      await panel.getByRole("button", { name: "24時間" }).click();
      await reread;
      await failed
        .getByRole("button", { name: "最近の変化の続きを再試行中…" })
        .waitFor({ timeout: 10_000 });
      expect(await panel.locator("li.changes-source").count()).toBe(2);
      expect(
        await panel
          .getByRole("alert")
          .filter({ hasText: "最近の変化を読み込めませんでした" })
          .count(),
      ).toBe(0);
      release();
      // The reread settles with no error, and the continuation is offered again.
      await panel.getByRole("button", { name: "続きを読み込む" }).waitFor({ timeout: 10_000 });
      expect(await panel.getByRole("alert").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a continuation refused as too old is retried by reading the answer again from the clock", async () => {
    mode = "bounded";
    const page = await browser.newPage();
    try {
      const start = Date.now();
      serverNow = start;
      await page.clock.setFixedTime(start);
      const panel = await open(page);
      await panel.getByText("一覧は続きます", { exact: false }).waitFor();
      const chosen = page.waitForResponse((response) =>
        response.url().includes(`${CHANGES_SINCE_PATH}?`),
      );
      await panel.getByRole("button", { name: "30日間" }).click();
      expect((await chosen).status()).toBe(200);
      // A day later, with no refocus in between, the first page's since is
      // past the digest's bound, so its continuation is refused as sent.
      const later = start + 25 * HOUR;
      serverNow = later;
      await page.clock.setFixedTime(later);
      const refused = page.waitForResponse((response) => response.url().includes("after="));
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      expect((await refused).status()).toBe(400);
      const failed = panel
        .getByRole("alert")
        .filter({ hasText: "最近の変化の続きを読み込めませんでした" });
      await failed.waitFor({ timeout: 10_000 });
      // The retry reads the first page again from 30 days before the clock,
      // not the refused continuation again.
      const again = new Date(later - 30 * 24 * HOUR).toISOString();
      const reread = page.waitForRequest(
        (request) => {
          const query = new URL(request.url()).searchParams;
          return (
            request.url().includes(`${CHANGES_SINCE_PATH}?`) &&
            query.get("after") === null &&
            query.get("since") === again
          );
        },
        { timeout: 10_000 },
      );
      // The reread is held until the panel is checked: while it runs, the
      // answer read and the error beside the button stay, not a whole-panel
      // error in their place.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**${CHANGES_SINCE_PATH}?*`, async (request) => {
        await held;
        await request.continue();
      });
      await failed.getByRole("button", { name: "再試行" }).click();
      await reread;
      await failed
        .getByRole("button", { name: "最近の変化の続きを再試行中…" })
        .waitFor({ timeout: 10_000 });
      expect(await panel.locator("li.changes-source").count()).toBe(2);
      expect(
        await panel
          .getByRole("alert")
          .filter({ hasText: "最近の変化を読み込めませんでした" })
          .count(),
      ).toBe(0);
      release();
      await panel.locator(`time[datetime="${again}"]`).waitFor();
      const continued = page.waitForResponse((response) => response.url().includes("after="));
      await panel.getByRole("button", { name: "続きを読み込む" }).click();
      const answered = await continued;
      expect(answered.status()).toBe(200);
      expect(new URL(answered.url()).searchParams.get("since")).toBe(again);
      await panel
        .locator("li.changes-source")
        .filter({ hasText: "synthetic-securities" })
        .waitFor();
      expect(await panel.getByRole("alert").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a grant without evidence and a store without events say so", async () => {
    mode = "narrow";
    const page = await browser.newPage();
    try {
      const panel = await open(page);
      await panel.getByText("この環境では提供されていません").waitFor();
      expect(
        await panel.getByText(/収集の実行と取得した原本は、この権限では数えていません/u).count(),
      ).toBe(1);
      const bankLine = panel.locator("li.changes-source").filter({ hasText: "synthetic-bank" });
      expect(await bankLine.getByText("収集の実行").count()).toBe(0);
      expect(await bankLine.getByText("現行の解析 3件", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const [refusal, status] of [
    ["refused", 403],
    ["not_served", 404],
  ] as const)
    test(`a ${String(status)} from the route leaves no panel`, async () => {
      mode = refusal;
      const page = await browser.newPage();
      try {
        // Listen before navigating: the refusal can arrive before the heading
        // renders, and a listener added after it would wait forever.
        const answered = page.waitForResponse((response) =>
          response.url().includes(`${CHANGES_SINCE_PATH}?`),
        );
        await page.goto(`${origin}/`);
        await page.getByRole("heading", { name: "ホーム", exact: true }).waitFor();
        expect((await answered).status()).toBe(status);
        await page.getByRole("heading", { name: "取得元", exact: true }).waitFor();
        await page.waitForTimeout(200);
        expect(await panelOf(page).count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);

  for (const failure of ["failed", "malformed"] as const)
    test(`a ${failure} answer shows an error, never zeros`, async () => {
      mode = failure;
      const page = await browser.newPage();
      try {
        const panel = await open(page);
        await panel
          .getByRole("alert")
          .filter({ hasText: "最近の変化を読み込めませんでした" })
          .waitFor({ timeout: 10_000 });
        expect(await panel.locator("li.changes-source").count()).toBe(0);
        expect(await panel.getByText(/0件/u).count()).toBe(0);
        expect(await panel.locator(".panel-head .count").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);
});
