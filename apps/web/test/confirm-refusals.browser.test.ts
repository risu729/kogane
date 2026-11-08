// The confirmation screen's refusals and re-checks (A09). Local synthetic
// fixtures only; no connection to a real account. What is proved here:
//
//  * a plan the server refuses to simulate is named by the refusal's own
//    fixed message, not a generic "is the API up" text,
//  * a refused receipt re-check says what the server refused,
//  * one receipt re-check runs at a time, so an older answer can never
//    replace a newer one on screen.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("confirm refusals browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}

const PLAN_ID = "a".repeat(64);
const MISSING_PLAN_ID = "e".repeat(64);
const SUBJECT = "account_mapping:synthetic-reference";
const simulation = {
  kind: "identity.assign",
  targets: [
    {
      subjectRef: SUBJECT,
      currentRevision: 7,
      currentTargetRef: "acct-rule",
      proposedTargetRef: "acct-operator",
    },
  ],
  before: { attributedObservations: 2, relations: 0 },
  after: { attributedObservations: 2, relations: 0 },
  invalidations: ["read-model:identity-catalogue"],
  affectedScopes: ["synthetic-source"],
  affectedParseRuns: 1,
  outboxTargets: ["identity-projection"],
};

function receipt(published: boolean) {
  return {
    operationId: "op-synthetic",
    operationKind: "identity.assign",
    planId: PLAN_ID,
    status: published ? "published" : "accepted",
    acceptedAt: "2098-01-01T00:00:00.000Z",
    publishedAt: published ? "2098-01-01T00:05:00.000Z" : null,
    decisionRevisionId: `dr_${"d".repeat(64)}`,
    outboxTargets: simulation.outboxTargets,
    result: { action: "assign", revision: 8 },
  };
}

describe.if(runnable)("change confirmation refusals", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  /** How the next `operation` re-check answers. */
  let operation: "refused" | "held" | "published" = "published";
  /** Settles with the release of a held re-check once the server holds one. */
  let held = Promise.withResolvers<() => void>();
  let operationCalls = 0;
  beforeEach(() => {
    operation = "published";
    held = Promise.withResolvers<() => void>();
    operationCalls = 0;
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
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands: true },
          });
        if (url.pathname.startsWith("/api/command/v1/")) {
          const command = url.pathname.slice("/api/command/v1/".length);
          const body = (await request.json()) as { planId?: string };
          if (command === "simulate")
            return body.planId === PLAN_ID
              ? Response.json({
                  report: {
                    planId: PLAN_ID,
                    planDigest: PLAN_ID,
                    simulation,
                    expectedRevisions: { [SUBJECT]: 7 },
                    currentRevisions: { [SUBJECT]: 7 },
                    stale: false,
                    resimulatedPlanId: PLAN_ID,
                  },
                })
              : Response.json({ error: "plan_not_found" }, { status: 404 });
          if (command === "approve")
            return Response.json({
              approval: {
                approvalId: `ap_${"c".repeat(64)}`,
                planId: PLAN_ID,
                planDigest: PLAN_ID,
                approverActor: "operator@synthetic.test",
                expiresAt: "2098-01-01T00:10:00.000Z",
                usesRemaining: 1,
              },
            });
          if (command === "commit") return Response.json({ receipt: receipt(false) });
          operationCalls += 1;
          if (operation === "refused")
            return Response.json({ error: "receipt_not_found" }, { status: 404 });
          if (operation === "held")
            await new Promise<void>((resolve) => {
              held.resolve(resolve);
            });
          return Response.json({ receipt: receipt(true) });
        }
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(client, path));
        return (await file.exists())
          ? new Response(file)
          : new Response(Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const open = async (planId: string): Promise<Page> => {
    const page = await browser.newPage();
    await page.goto(`${origin}/confirm/${planId}`);
    await page.getByRole("heading", { name: "変更の確認" }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  };

  const commit = async (page: Page): Promise<void> => {
    await page.getByRole("button", { name: "承認する" }).click();
    await page.getByRole("button", { name: "承認済み" }).waitFor();
    await page.getByRole("button", { name: "確定する" }).click();
    await page.getByRole("button", { name: "反映状況を再確認" }).waitFor();
  };

  test("a plan the server refuses to simulate is named by the refusal", async () => {
    const page = await open(MISSING_PLAN_ID);
    try {
      const alert = page.getByRole("alert").filter({ hasText: "確認内容を読み込めませんでした" });
      await alert.waitFor();
      const text = await alert.innerText();
      expect(text).toContain("計画が見つかりません。一覧から選び直してください。");
      expect(text).toContain("HTTP 404");
      expect(text).not.toContain("接続先の API が利用できるか確認し");
      // Asking again for a plan that does not exist meets the same refusal.
      expect(await alert.getByRole("button", { name: "再試行" }).count()).toBe(0);
      // Nothing can be approved for a plan the server could not show.
      expect(await page.getByRole("button", { name: "承認する" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a refused receipt re-check says what was refused and never offers a resend", async () => {
    const page = await open(PLAN_ID);
    try {
      await commit(page);
      operation = "refused";
      await page.getByRole("button", { name: "反映状況を再確認" }).click();
      const record = page.getByRole("region", { name: "操作の記録" });
      const alert = record.getByRole("alert");
      await alert.waitFor();
      const text = await alert.innerText();
      expect(text).toContain("この操作の記録は見つかりません。");
      expect(text).toContain("受理済みの判断を再送せず");
      // The accepted receipt stays on screen; the commit is not offered again.
      expect(await record.innerText()).toContain("受理");
      expect(await page.getByRole("button", { name: "確定する" }).isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("one receipt re-check runs at a time, and its answer replaces the earlier error", async () => {
    const page = await open(PLAN_ID);
    try {
      await commit(page);
      operation = "refused";
      await page.getByRole("button", { name: "反映状況を再確認" }).click();
      const record = page.getByRole("region", { name: "操作の記録" });
      await record.getByRole("alert").waitFor();
      operation = "held";
      await page.getByRole("button", { name: "反映状況を再確認" }).click();
      // While the answer is outstanding the re-check cannot be sent again, so
      // a slower earlier answer can never land after a newer one.
      const pending = page.getByRole("button", { name: "反映状況を確認中…" });
      await pending.waitFor();
      expect(await pending.isDisabled()).toBe(true);
      expect(await record.getByRole("alert").count()).toBe(0);
      (await held.promise)();
      await record.getByText("反映済み", { exact: true }).waitFor();
      expect(await record.innerText()).toContain("2098-01-01T00:05:00.000Z");
      expect(operationCalls).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);
});
