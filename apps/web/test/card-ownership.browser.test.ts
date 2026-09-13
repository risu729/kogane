import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { ownershipReview } from "../../../packages/application/test/card-ownership-fixture.ts";
const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;
const PLAN = "c".repeat(64);
describe.if(runnable)("explicit card ownership review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let review = ownershipReview();
  let advertised = true;
  let stale = false;
  let action = "accept";
  let party = "party:本人A";
  let committed = false;
  const posted: { operation: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    review = ownershipReview();
    advertised = true;
    stale = false;
    action = "accept";
    party = "party:本人A";
    committed = false;
    posted.length = 0;
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
            capabilities: {
              ...CENTRAL_STORE_CAPABILITIES,
              commands: true,
              cardSettlementReconciliation: true,
              cardOwnershipReview: advertised,
            },
          });
        if (url.pathname.endsWith("/card-settlements/ownership"))
          return Response.json({
            ...review,
            sides: review.sides.map((s, i) => ({
              ...s,
              ownershipRevision: stale && i === 0 ? s.ownershipRevision + 1 : s.ownershipRevision,
            })),
          });
        if (url.pathname.startsWith("/api/command/v1/")) {
          const operation = url.pathname.split("/").at(-1)!;
          const body = (await request.json()) as Record<string, unknown>;
          posted.push({ operation, body });
          if (operation === "plan") {
            action = String(body.kind).split(".")[1]!;
            party = (body.payload as { toRef: string }).toRef;
          }
          const side = review.sides[0]!;
          const subject = `relation:${side.role}|account:${side.accountId}|${party}`;
          const refs = {
            [`card-settlement:${review.proposalId}`]: review.revision,
            [`account_mapping:${side.sourceAccountId}`]: side.mappingRevision,
            [`ownership:${side.role}|${side.accountId}`]: side.ownershipRevision,
            [subject]: 0,
          };
          const targets = Object.entries(refs).map(([subjectRef, currentRevision]) => ({
            subjectRef,
            currentRevision,
            currentTargetRef: null,
            proposedTargetRef: subjectRef.startsWith("ownership:")
              ? party
              : subjectRef === subject
                ? action === "accept"
                  ? "accepted"
                  : "rejected"
                : null,
          }));
          const simulation = {
            kind: `relation.${action}`,
            targets,
            before: { attributedObservations: 0, relations: 0 },
            after: { attributedObservations: 0, relations: 1 },
            invalidations: ["review:card-ownership"],
            affectedScopes: ["myjcb", "smbc-bank"],
            affectedParseRuns: 2,
            outboxTargets: ["identity-projection"],
          };
          const plan = {
            planId: PLAN,
            planDigest: PLAN,
            kind: simulation.kind,
            baseContextId: "synthetic",
            expectedRevisions: refs,
            simulation,
            createdBy: "human:synthetic",
            createdAt: "2026-09-13",
            expiresAt: "2099-01-01",
            status: "planned",
          };
          if (operation === "plan") return Response.json({ plan });
          if (operation === "simulate")
            return Response.json({
              report: { ...plan, currentRevisions: refs, stale: false, resimulatedPlanId: PLAN },
            });
          if (operation === "approve")
            return Response.json({
              approval: {
                approvalId: "ap_" + "d".repeat(64),
                planId: PLAN,
                planDigest: PLAN,
                approverActor: "human:synthetic",
                expiresAt: "2099-01-01",
                usesRemaining: 1,
              },
            });
          if (operation === "commit") committed = true;
          return Response.json({
            receipt: {
              operationId: "op-synthetic",
              operationKind: simulation.kind,
              planId: PLAN,
              status: "accepted",
              acceptedAt: "2026-09-13",
              publishedAt: null,
              decisionRevisionId: "decision-new",
              outboxTargets: ["identity-projection"],
              result: {},
            },
          });
        }
        const f = Bun.file(join(client, url.pathname === "/" ? "/index.html" : url.pathname));
        return new Response((await f.exists()) ? f : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });
  async function open(path = `/reconciliation/${review.proposalId}/ownership`) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await page.goto(origin + path);
    if (path.startsWith("/confirm"))
      await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    else if (advertised)
      await page.getByRole("heading", { name: "口座の保有者を確認", exact: true }).waitFor();
    return page;
  }
  test("no default owner, no plan without explicit evidence and reason, and separate human confirmation", async () => {
    const page = await open();
    const form = page.getByRole("region", { name: "カード請求の支払義務を負う人", exact: true });
    expect(await form.getByLabel("保有者の識別名", { exact: true }).inputValue()).toBe("");
    const button = form.getByRole("button", { name: "この保有者の関係を確認", exact: true });
    expect(await button.isDisabled()).toBe(true);
    await form.getByLabel("保有者の識別名", { exact: true }).fill("本人A");
    await form
      .getByLabel("判断の理由・原本で確認した箇所", { exact: true })
      .fill("原本の名義と口座の対応を確認した");
    expect(await button.isDisabled()).toBe(true);
    await form.getByRole("checkbox").check();
    await button.click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted.find((p) => p.operation === "plan")?.body).toMatchObject({
      kind: "relation.accept",
      payload: {
        toRef: "party:本人A",
        validFrom: null,
        validTo: null,
        evidenceRefs: [
          "card-settlement:card-settlement-synthetic",
          "balance:11",
          "parse_run:1",
          "account_mapping:mapping-card",
        ],
      },
    });
    expect(committed).toBe(false);
    await page.getByRole("button", { name: "承認する", exact: true }).click();
    await page.getByRole("button", { name: "承認済み", exact: true }).waitFor();
    await page.getByRole("button", { name: "確定する", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "読み取りモデルへの反映はまだ完了" })
      .waitFor();
    expect(committed).toBe(true);
    expect(await page.locator("main").innerText()).toContain("カード決済は採用されません");
    await page.close();
  });
  test("a competing ownership claim blocks approval even when the candidate revision is unchanged", async () => {
    stale = true;
    const page = await open(`/confirm/${PLAN}`);
    await page
      .getByRole("alert")
      .filter({ hasText: "口座または保有者の記録が計画作成後に変わっています" })
      .waitFor();
    expect(await page.getByRole("button", { name: "承認する", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(committed).toBe(false);
    await page.close();
  });
  test("missing mappings cannot be cured by typing a plausible owner and mobile evidence wraps", async () => {
    review.sides[0]!.blockers = ["account_mapping_unresolved"];
    review.sides[0]!.accountId = null;
    const page = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    const form = page.getByRole("region", { name: "カード請求の支払義務を負う人", exact: true });
    await form.getByLabel("保有者の識別名", { exact: true }).fill("本人A");
    await form.getByLabel("判断の理由・原本で確認した箇所", { exact: true }).fill("名義を確認");
    await form.getByRole("checkbox").check();
    expect(
      await form.getByRole("button", { name: "この保有者の関係を確認", exact: true }).isDisabled(),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    if (process.env["OWNERSHIP_SCREENSHOT_PREFIX"])
      await page.screenshot({
        path: process.env["OWNERSHIP_SCREENSHOT_PREFIX"] + "-mobile.png",
        fullPage: true,
      });
    await page.close();
  });
  test("unadvertised ownership review never offers a form", async () => {
    advertised = false;
    const page = await open();
    await page.getByText("この接続先は保有者の確認を提供していません。", { exact: true }).waitFor();
    expect(await page.getByRole("textbox").count()).toBe(0);
    expect(posted).toEqual([]);
    await page.close();
  });

  test("an existing owner can be explicitly rejected without erasing its proof", async () => {
    review.sides[0]!.claims = [
      {
        id: "relation-old",
        partyRef: "party:本人A",
        status: "accepted",
        validFrom: null,
        validTo: null,
        evidenceRefs: ["decision:old"],
        decisionRevisionId: "decision-old",
      },
    ];
    review.sides[0]!.ownershipRevision = 1;
    const page = await open();
    const form = page.getByRole("region", { name: "カード請求の支払義務を負う人", exact: true });
    expect(await form.getByLabel("保有者の識別名", { exact: true }).inputValue()).toBe("");
    await form.getByLabel("保有者の識別名", { exact: true }).fill("本人A");
    await form
      .getByLabel("判断の理由・原本で確認した箇所", { exact: true })
      .fill("以前の関係が別の人を指していたため訂正する");
    await form.getByRole("checkbox").check();
    await form
      .getByRole("button", { name: "この保有者の関係を却下する内容を確認", exact: true })
      .click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted.find((row) => row.operation === "plan")?.body.kind).toBe("relation.reject");
    expect(await page.locator("main").innerText()).toContain("の関係を却下します");
    expect(committed).toBe(false);
    expect(review.sides[0]!.claims[0]!.decisionRevisionId).toBe("decision-old");
    await page.close();
  });
});
