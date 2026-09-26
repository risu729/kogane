import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { settlementReview } from "../../../packages/application/test/card-settlement-fixture.ts";
import { cardSettlementImpact } from "../../../packages/domain/src/card-settlement.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const PLAN = "a".repeat(64);

describe.if(runnable)("card settlement review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let review = settlementReview();
  let advertised = true;
  let detailRevision = 0;
  let planRevision = 0;
  let action = "accept";
  const posted: { operation: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    review = settlementReview();
    advertised = true;
    detailRevision = 0;
    planRevision = 0;
    action = "accept";
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
              cardSettlementReconciliation: advertised,
            },
          });
        if (url.pathname === "/api/v2/reconciliation/card-settlements")
          return Response.json({
            items: [
              {
                ...review,
                revision: url.searchParams.has("proposalId") ? detailRevision : review.revision,
              },
            ],
            nextOffset: null,
            coverage: {
              scope: "card-statement-bank-debit-candidates",
              completeTransactionHistory: false,
              netAssets: "unknown",
              limit: 50,
            },
          });
        if (url.pathname.startsWith("/api/command/v1/")) {
          const operation = url.pathname.split("/").at(-1)!;
          const body = (await request.json()) as Record<string, unknown>;
          posted.push({ operation, body });
          if (operation === "plan") action = String(body.kind).split(".")[1]!;
          const subject = `card-settlement:${review.proposalId}`;
          const simulation = {
            kind: `card-settlement.${action}`,
            targets: [
              {
                subjectRef: subject,
                currentRevision: planRevision,
                currentTargetRef: null,
                proposedTargetRef: review.proposalId,
              },
            ],
            before: { attributedObservations: 0, relations: 0 },
            after: { attributedObservations: 0, relations: 1 },
            invalidations: [],
            affectedScopes: ["myjcb", "sony-bank"],
            affectedParseRuns: 0,
            outboxTargets: [],
          };
          const plan = {
            planId: PLAN,
            planDigest: PLAN,
            kind: simulation.kind,
            baseContextId: "test",
            expectedRevisions: { [subject]: planRevision },
            simulation,
            createdBy: "human:synthetic",
            createdAt: "2026-09-11T00:00:00Z",
            expiresAt: "2099-01-01",
            status: "planned",
          };
          if (operation === "plan") return Response.json({ plan });
          if (operation === "simulate")
            return Response.json({
              report: {
                ...plan,
                currentRevisions: { [subject]: planRevision },
                stale: false,
                resimulatedPlanId: PLAN,
              },
            });
          if (operation === "approve")
            return Response.json({
              approval: {
                approvalId: `ap_${"b".repeat(64)}`,
                planId: PLAN,
                planDigest: PLAN,
                approverActor: "human:synthetic",
                expiresAt: "2099-01-01",
                usesRemaining: 1,
              },
            });
          return Response.json({
            receipt: {
              operationId: "op-synthetic",
              operationKind: simulation.kind,
              planId: PLAN,
              status: "accepted",
              acceptedAt: "2026-09-11T00:00:00Z",
              publishedAt: null,
              decisionRevisionId: "decision-synthetic",
              outboxTargets: [],
              result: {},
            },
          });
        }
        const file = Bun.file(join(client, url.pathname === "/" ? "/index.html" : url.pathname));
        return (await file.exists())
          ? new Response(file)
          : new Response(Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });
  async function open(path = "/reconciliation") {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await page.goto(origin + path);
    await page
      .getByRole("heading", {
        name: path.startsWith("/confirm/") ? "変更の確認" : "カード請求と引落の照合",
        exact: true,
      })
      .waitFor();
    // The page head renders before the list or plan resolves; wait for every
    // loading skeleton (outer and nested boundaries) to be gone.
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  }

  test("unknown ownership blocks adoption, preserves evidence access and allows explicit rejection planning", async () => {
    review = settlementReview(true);
    const page = await open();
    expect(await page.getByRole("button", { name: "採用内容を確認" }).isDisabled()).toBe(true);
    await page.getByLabel("判断の理由", { exact: true }).fill("同一保有者の根拠がないため");
    expect(await page.getByRole("button", { name: "採用内容を確認" }).isDisabled()).toBe(true);
    expect(
      await page.getByRole("link", { name: "請求の記録と原本", exact: true }).getAttribute("href"),
    ).toBe("/observations/balance/11");
    expect(
      await page.getByRole("link", { name: "銀行明細と原本", exact: true }).getAttribute("href"),
    ).toBe("/observations/transaction/12");
    expect(await page.locator("main").innerText()).toContain("純資産への影響");
    await page.getByRole("button", { name: "却下内容を確認" }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted.filter((row) => row.operation === "plan")[0]?.body).toMatchObject({
      kind: "card-settlement.reject",
      payload: { proposalId: review.proposalId, reason: "同一保有者の根拠がないため" },
    });
    expect(posted.some((row) => row.operation === "approve" || row.operation === "commit")).toBe(
      false,
    );
    await page.close();
  });

  test("the bank is named by its adapter, and an unlabelled source is shown as stored", async () => {
    review.facts.bankDebit.sourceId = "sbi-shinsei-bank";
    let page = await open();
    let text = await page.locator("main").innerText();
    expect(text).toContain("SBI新生銀行 · synthetic-bank");
    expect(text).not.toContain("sbi-shinsei-bank");
    await page.close();
    review = settlementReview();
    page = await open();
    text = await page.locator("main").innerText();
    expect(text).toContain("sony-bank · synthetic-bank");
    await page.close();
  });

  test("server impact remains separate from purchase expense and requires approve then commit", async () => {
    const page = await open();
    const text = await page.locator("main").innerText();
    expect(text).toContain("3000 JPY");
    expect(text).toContain("追加する現金移動");
    expect(text).toContain("0 JPY");
    expect(text).toContain("候補・未適用");
    await page.getByLabel("判断の理由", { exact: true }).fill("請求原本と銀行明細の対応を確認した");
    await page.getByRole("button", { name: "採用内容を確認" }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "確定する", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.getByRole("button", { name: "承認する", exact: true }).click();
    await page.getByRole("button", { name: "承認済み", exact: true }).waitFor();
    await page.getByRole("button", { name: "確定する", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "読み取りモデルへの反映はまだ完了" })
      .waitFor();
    expect(posted.map((row) => row.operation)).toContain("commit");
    await page.close();
  });

  test("a detail revision newer than the plan blocks both approval and commit", async () => {
    detailRevision = 1;
    const page = await open(`/confirm/${PLAN}`);
    await page.getByRole("alert").filter({ hasText: "候補の判断が計画作成後に更新" }).waitFor();
    expect(await page.getByRole("button", { name: "承認する", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(await page.getByRole("button", { name: "確定する", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(posted.some((row) => row.operation === "approve" || row.operation === "commit")).toBe(
      false,
    );
    await page.close();
  });

  test("accepted correspondence offers withdrawal, with original evidence and history retained", async () => {
    review = {
      ...review,
      revision: 1,
      status: "accepted",
      impact: cardSettlementImpact(review.facts, "accepted"),
      history: [
        {
          revision: 1,
          status: "accepted",
          decisionRevisionId: "decision-1",
          createdAt: "2026-09-11T00:00:00Z",
        },
      ],
    };
    detailRevision = 1;
    planRevision = 1;
    const page = await open();
    // A decided candidate starts collapsed; the withdrawal form is behind its disclosure.
    await page.getByText("候補の詳細と判断", { exact: true }).click();
    expect(await page.getByRole("button", { name: "採用内容を確認" }).count()).toBe(0);
    await page.getByLabel("判断の理由", { exact: true }).fill("別の銀行明細が支払に対応していた");
    await page.getByRole("button", { name: "採用を解除する内容を確認" }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    // As in open(): the page head renders before the plan resolves.
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    expect(await page.locator("main").innerText()).toContain("現金が返却されたことにはなりません");
    expect(posted.find((row) => row.operation === "plan")?.body.kind).toBe(
      "card-settlement.withdraw",
    );
    await page.close();
  });

  test("an unadvertised feature has no review actions", async () => {
    advertised = false;
    const page = await open();
    expect(await page.getByRole("button", { name: "採用内容を確認" }).count()).toBe(0);
    expect(posted).toHaveLength(0);
    await page.close();
  });

  test("a changed acceptance condition blocks approval even before the proposal revision changes", async () => {
    review = { ...review, acceptanceBlockers: ["allocation_already_used"] };
    const page = await open(`/confirm/${PLAN}`);
    await page
      .getByRole("alert")
      .filter({ hasText: "この候補では計画した操作を実行できません" })
      .waitFor();
    expect(await page.getByRole("button", { name: "承認する", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(posted.some((row) => row.operation === "approve" || row.operation === "commit")).toBe(
      false,
    );
    await page.close();
  });
  test("long evidence references wrap and confirmation actions remain usable on narrow screens", async () => {
    review = {
      ...review,
      facts: { ...review.facts, ownershipEvidenceRefs: [`ownership-evidence-${"a".repeat(128)}`] },
    };
    const page = await open();
    await page.getByText("再確認する条件と判断の履歴", { exact: true }).click();
    expect(
      await page
        .locator(".settlement-history")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    const prefix = process.env["SETTLEMENT_SCREENSHOT_PREFIX"];
    if (prefix) await page.screenshot({ path: `${prefix}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.getByLabel("判断の理由", { exact: true }).fill("原本と口座の保有者を確認した");
    expect(
      await page
        .locator(".settlement-history")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    if (prefix) await page.screenshot({ path: `${prefix}-mobile.png`, fullPage: true });
    await page.getByRole("button", { name: "採用内容を確認", exact: true }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    await page.getByRole("button", { name: "承認する", exact: true }).waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    const bounds = await page.getByRole("button", { name: "確定する", exact: true }).boundingBox();
    expect(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(true);
    if (prefix) await page.screenshot({ path: `${prefix}-confirm-mobile.png`, fullPage: true });
    await page.close();
  });
  test("terminal candidates have no mutable action and review fits a narrow screen", async () => {
    review = {
      ...review,
      status: "rejected",
      revision: 1,
      impact: cardSettlementImpact(review.facts, "rejected"),
    };
    const page = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByLabel("判断の理由", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "採用内容を確認" }).count()).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.close();
  });
});
