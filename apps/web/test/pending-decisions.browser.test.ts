// The ホーム page's 判断待ち panel (ADR 0126) against a synthetic server: one
// line per kind with its count, a link to the page that decides the first
// item, the reason of a line that cannot be counted, and no panel for a
// caller the route refuses or on a store that does not advertise the route.
// Every id is synthetic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { Overview } from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  PENDING_DECISION_HANDLERS,
  PENDING_DECISION_KINDS,
  PENDING_DECISIONS_COUNT_BOUND,
  PENDING_DECISIONS_ID_BYTES,
  PENDING_DECISIONS_IDS_SHOWN,
  PENDING_DECISIONS_MAX_BYTES,
  PENDING_DECISIONS_NOT_COVERED,
  type PendingDecisionLine,
} from "../../../packages/domain/src/pending-decisions.ts";
import {
  PENDING_DECISIONS_PATH,
  validPendingDecisions,
} from "../../../packages/observation-shared/src/pending-decisions-contract.ts";
import { auditPage } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

const overview: Overview = { counts: [], sources: [], fetchRuns: [], parseRuns: [] };

const lines: PendingDecisionLine[] = PENDING_DECISION_KINDS.map((kind) => {
  const base = {
    kind,
    handler: PENDING_DECISION_HANDLERS[kind],
    timeBasis: kind.includes("candidate") ? ("not_recorded" as const) : ("created" as const),
  };
  if (kind === "maintenance-survey.proposal")
    return {
      ...base,
      state: "unavailable",
      reason: "unauthorized",
      count: null,
      complete: false,
      ids: [],
      oldestAt: null,
    };
  if (kind === "card-settlement.statement")
    return {
      ...base,
      state: "counted",
      reason: null,
      count: 3,
      complete: true,
      ids: ["cs_synthetic_1", "cs_synthetic_2"],
      oldestAt: "2099-01-05T00:00:00Z",
    };
  if (kind === "pending-posted.link")
    return {
      ...base,
      state: "counted",
      reason: null,
      count: PENDING_DECISIONS_COUNT_BOUND,
      complete: false,
      ids: ["rp_synthetic"],
      oldestAt: "2099-01-01T00:00:00Z",
    };
  return {
    ...base,
    state: "counted",
    reason: null,
    count: 0,
    complete: true,
    ids: [],
    oldestAt: null,
  };
});
const answer = {
  apiVersion: 2,
  schemaVersion: "kogane-pending-decisions-v1",
  asOf: "2099-01-10T00:00:00.000Z",
  bounds: {
    idsShown: PENDING_DECISIONS_IDS_SHOWN,
    idBytes: PENDING_DECISIONS_ID_BYTES,
    countBound: PENDING_DECISIONS_COUNT_BOUND,
    maxBytes: PENDING_DECISIONS_MAX_BYTES,
  },
  kinds: lines,
  notCovered: PENDING_DECISIONS_NOT_COVERED,
  decisions: "elsewhere",
};

describe("the wire contract", () => {
  test("accepts the fixture and refuses what the summary cannot produce", () => {
    expect(validPendingDecisions(answer)).toBe(true);
    const mutate = (change: (copy: any) => void): boolean => {
      const copy = structuredClone(answer) as any;
      change(copy);
      return validPendingDecisions(copy);
    };
    // A kind out of order, a handler the summary does not name, a cut count
    // that is not the bound, more ids than the count, a time on a zero line,
    // a count on an unavailable line, six ids.
    expect(mutate((copy) => copy.kinds.reverse())).toBe(false);
    expect(mutate((copy) => (copy.kinds[0].handler.page = "/elsewhere"))).toBe(false);
    expect(mutate((copy) => (copy.kinds[6].count = 5))).toBe(false);
    expect(mutate((copy) => (copy.kinds[0].count = 1))).toBe(false);
    expect(mutate((copy) => (copy.kinds[2].oldestAt = "2099-01-01T00:00:00Z"))).toBe(false);
    expect(mutate((copy) => (copy.kinds[7].count = 0))).toBe(false);
    expect(
      mutate((copy) => {
        copy.kinds[0].count = 9;
        copy.kinds[0].ids = ["a", "b", "c", "d", "e", "f"];
      }),
    ).toBe(false);
    expect(mutate((copy) => (copy.decisions = "here"))).toBe(false);
  });
});

describe.if(runnable)("the 判断待ち panel on ホーム", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let refuse = false;
  let advertised = true;
  let requested = 0;
  let current: unknown = answer;
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
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, pendingDecisions: advertised },
          });
        if (url.pathname === "/api/overview") return Response.json(overview);
        if (url.pathname === PENDING_DECISIONS_PATH) requested += 1;
        if (url.pathname === PENDING_DECISIONS_PATH)
          return refuse
            ? Response.json({ error: "operator_required" }, { status: 403 })
            : Response.json(current);
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
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("each kind is one line, linked to the page that decides it", async () => {
    refuse = false;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      const panel = page.locator('section[aria-labelledby="pending-decisions"]');
      await panel.getByRole("heading", { name: "判断待ち" }).waitFor();
      await panel.getByText("カード請求と引落の照合").waitFor();
      expect(await panel.locator("li").count()).toBe(PENDING_DECISION_KINDS.length);
      expect(await panel.getByText("3件", { exact: true }).count()).toBe(1);
      expect(await panel.getByText(`${PENDING_DECISIONS_COUNT_BOUND}件以上`).count()).toBe(1);
      expect(await panel.getByText("この権限では数えられません").count()).toBe(1);
      // A cut line and an uncounted one leave the total a lower bound.
      expect(await panel.locator(".panel-head .count").textContent()).toBe(
        `${String(3 + PENDING_DECISIONS_COUNT_BOUND)}件以上`,
      );
      const links = panel.getByRole("link", { name: "確認する →" });
      expect(await links.count()).toBe(2);
      expect(await links.nth(0).getAttribute("href")).toBe("/reconciliation/cs_synthetic_1");
      expect(await links.nth(1).getAttribute("href")).toBe("/purchases");
      expect(await auditPage(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the total says 以上 exactly when some line is cut or could not be counted", async () => {
    refuse = false;
    // Every line counted and complete but for the change lifecycle, which
    // this deployment does not serve: the total is exact. Each other way a
    // line can fall short, on its own, makes it a lower bound (INV05).
    const unavailable = { state: "unavailable", count: null, complete: false, ids: [] };
    const cases: [Partial<Record<string, object>>, string][] = [
      [{}, "8件"],
      [{ "account-candidate.open": { ...unavailable, reason: "budget_exceeded" } }, "8件以上"],
      [{ "card-ownership.account": { ...unavailable, reason: "unauthorized" } }, "8件以上"],
      [
        { "pending-posted.link": { count: PENDING_DECISIONS_COUNT_BOUND, complete: false } },
        `${String(3 + PENDING_DECISIONS_COUNT_BOUND)}件以上`,
      ],
    ];
    try {
      for (const [changes, total] of cases) {
        const kinds = lines.map((line) => ({
          ...line,
          ...(line.kind === "maintenance-survey.proposal"
            ? { state: "counted", reason: null, count: 0, complete: true }
            : {}),
          ...(line.kind === "pending-posted.link" ? { count: 5, complete: true } : {}),
          ...(line.kind === "change-plan.open"
            ? { ...unavailable, reason: "not_served", oldestAt: null }
            : {}),
          ...changes[line.kind],
        }));
        current = { ...answer, kinds };
        expect(validPendingDecisions(current), total).toBe(true);
        const page = await browser.newPage();
        try {
          await page.goto(`${origin}/`);
          const panel = page.locator('section[aria-labelledby="pending-decisions"]');
          await panel.getByText("カード請求と引落の照合").waitFor();
          expect(await panel.locator(".panel-head .count").textContent()).toBe(total);
        } finally {
          await page.close();
        }
      }
    } finally {
      current = answer;
    }
  }, 60_000);

  test("a caller the route refuses sees no panel", async () => {
    refuse = true;
    const page = await browser.newPage();
    try {
      // Listen before navigating: the refusal can arrive before the heading
      // renders, and a listener added after it would wait forever.
      const refused = page.waitForResponse((response) =>
        response.url().endsWith(PENDING_DECISIONS_PATH),
      );
      await page.goto(`${origin}/`);
      await page.getByRole("heading", { name: "ホーム", exact: true }).waitFor();
      await refused;
      await page.waitForTimeout(200);
      expect(await page.locator('section[aria-labelledby="pending-decisions"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a store that does not advertise the route is never asked and shows no panel", async () => {
    refuse = false;
    advertised = false;
    requested = 0;
    const page = await browser.newPage();
    try {
      // The local evidence browser serves no such route: probing it would be
      // a failed request in the console on every visit to ホーム.
      await page.goto(`${origin}/`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "ホーム", exact: true }).waitFor();
      expect(await page.locator('section[aria-labelledby="pending-decisions"]').count()).toBe(0);
      expect(requested).toBe(0);
    } finally {
      advertised = true;
      await page.close();
    }
  }, 30_000);
});
