// The correction confirmation screen (A09, addendum 11 §5). Local synthetic
// fixtures only; no connection to a real account. What is proved here:
//
//  * without the advertised `commands` capability the screen is read-only,
//  * a stale plan cannot be approved or committed from the screen,
//  * the server-computed diff is what is shown (the client never recomputes),
//  * `accepted` and `published` are shown as different states.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("confirm browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}

const PLAN_ID = "a".repeat(64);
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
  before: { attributedObservations: 12, relations: 0 },
  after: { attributedObservations: 12, relations: 0 },
  invalidations: ["read-model:identity-catalogue", "read-model:balances"],
  affectedScopes: ["synthetic-source"],
  affectedParseRuns: 3,
  outboxTargets: ["identity-projection", "balance-projection"],
};

describe.if(runnable)("change confirmation screen", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let commands = true;
  let stale = false;
  let published = false;
  const posted: string[] = [];

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
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands },
          });
        if (url.pathname.startsWith("/api/command/v1/")) {
          posted.push(url.pathname);
          const operation = url.pathname.slice("/api/command/v1/".length);
          if (operation === "simulate")
            return Response.json({
              report: {
                planId: PLAN_ID,
                planDigest: PLAN_ID,
                simulation,
                expectedRevisions: { [SUBJECT]: 7 },
                currentRevisions: { [SUBJECT]: stale ? 8 : 7 },
                stale,
                resimulatedPlanId: stale ? "b".repeat(64) : PLAN_ID,
              },
            });
          if (operation === "approve")
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
          const receipt = {
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
          return Response.json({ receipt });
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

  const open = async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/confirm/${PLAN_ID}`);
    await page.getByRole("heading", { name: "変更の確認" }).waitFor();
    return page;
  };

  test("shows the server's diff and is read-only without the capability", async () => {
    commands = false;
    const page = await open();
    // Counts come from the response; nothing is recomputed in the browser.
    const main = await page.locator("main").innerText();
    expect(main).toContain("12 件 → 12 件");
    expect(main).toContain("read-model:identity-catalogue");
    expect(main).toContain("synthetic-source");
    expect(await page.getByRole("button", { name: "承認する" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "確定する" }).isDisabled()).toBe(true);
    expect(main).toContain("この接続先では確認操作が有効ではないため、承認・確定は行えません。");
    await page.close();
  });

  test("refuses to act on a stale plan and offers the re-simulated plan id", async () => {
    commands = true;
    stale = true;
    const page = await open();
    const main = await page.locator("main").innerText();
    expect(main).toContain("対象が変更されています");
    expect(main).toContain("b".repeat(64));
    expect(await page.getByRole("button", { name: "承認する" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "確定する" }).isDisabled()).toBe(true);
    await page.close();
  });

  test("approve then commit shows accepted, and published only once the outbox reports it", async () => {
    commands = true;
    stale = false;
    published = false;
    posted.length = 0;
    const page = await open();
    expect(await page.getByRole("button", { name: "確定する" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "承認する" }).click();
    await page.getByRole("button", { name: "承認済み" }).waitFor();
    await page.getByRole("button", { name: "確定する" }).click();
    await page.getByRole("button", { name: "反映状況を再確認" }).waitFor();
    const accepted = await page.locator("main").innerText();
    expect(accepted).toContain("受理");
    expect(accepted).toContain(
      "判断は保存されました。読み取りモデルへの反映はまだ完了していません。",
    );
    expect(accepted).not.toContain("2098-01-01T00:05:00.000Z");
    // Accepted is not published: the screen offers a re-check, not a claim.
    published = true;
    await page.getByRole("button", { name: "反映状況を再確認" }).click();
    await page
      .getByRole("region", { name: "操作の記録" })
      .getByText("反映済み", { exact: true })
      .waitFor();
    expect(await page.locator("main").innerText()).toContain("2098-01-01T00:05:00.000Z");
    // The commit re-reads the plan from the server rather than mutating a
    // local copy of it.
    expect(posted).toEqual([
      "/api/command/v1/simulate",
      "/api/command/v1/approve",
      "/api/command/v1/commit",
      "/api/command/v1/simulate",
      "/api/command/v1/operation",
    ]);
    await page.close();
  });
});
