// The correction confirmation screen (A09, addendum 11 §5). Local synthetic
// fixtures only; no connection to a real account. What is proved here:
//
//  * without the advertised `commands` capability the screen is read-only,
//  * a stale plan cannot be approved or committed from the screen,
//  * the server-computed diff is what is shown (the client never recomputes),
//  * `accepted` and `published` are shown as different states,
//  * a pending-to-posted card usage review compares every pinned revision
//    with the candidate the server shows now, names its invalidation and its
//    effect, and cannot be approved while any of them disagrees.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { purchasePage } from "../../../packages/application/test/card-purchase-view-fixture.ts";
import type {
  CardPurchaseCandidate,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";
import {
  authorizedCandidate,
  authorizedPendingPurchase,
  linkPlanPins,
  linkPlanTargets,
  mergedCandidate,
  mergedPurchase,
  PENDING_EVENT,
  POSTED_EVENT,
  serverPlanPins,
} from "./card-purchase-link-fixture.ts";

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
  /**
   * A pending-to-posted review plan: its kind, its pins, the proposal status
   * the simulation names (the server's own by default) and the purchase the
   * server shows now.
   */
  let link: {
    kind: "relation.accept" | "relation.reject";
    planned: CardPurchaseCandidate;
    pins?: Record<string, number>;
    proposedStatus?: string | null;
    purchase: CardPurchaseView;
  } | null = null;
  let purchaseAdvertised = true;
  const purchaseReads: string[] = [];
  beforeEach(() => {
    link = null;
    purchaseAdvertised = true;
    purchaseReads.length = 0;
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
              commands,
              cardPurchaseRecognition: purchaseAdvertised,
            },
          });
        if (url.pathname === "/api/v2/card-purchases") {
          const eventId = url.searchParams.get("eventId") ?? "";
          purchaseReads.push(eventId);
          return link !== null && link.purchase.eventId === eventId
            ? Response.json({ apiVersion: 2, ...purchasePage([link.purchase]) })
            : Response.json({ error: "not_found" }, { status: 404 });
        }
        if (url.pathname.startsWith("/api/command/v1/")) {
          posted.push(url.pathname);
          const operation = url.pathname.slice("/api/command/v1/".length);
          if (operation === "simulate" && link !== null) {
            const pins = link.pins ?? serverPlanPins(link.planned);
            return Response.json({
              report: {
                planId: PLAN_ID,
                planDigest: PLAN_ID,
                simulation: {
                  kind: link.kind,
                  targets:
                    link.proposedStatus === undefined
                      ? linkPlanTargets(link.planned, link.kind, pins)
                      : linkPlanTargets(link.planned, link.kind, pins, link.proposedStatus),
                  before: { attributedObservations: 0, relations: link.planned.relationRevision },
                  after: {
                    attributedObservations: 0,
                    relations: link.planned.relationRevision + 1,
                  },
                  invalidations: ["review:card-purchase-link"],
                  affectedScopes: ["vpass"],
                  affectedParseRuns: 0,
                  outboxTargets: [],
                },
                expectedRevisions: pins,
                currentRevisions: pins,
                stale: false,
                resimulatedPlanId: PLAN_ID,
              },
            });
          }
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
    // The page head renders before the plan resolves; wait for every loading
    // skeleton (outer plan and nested evidence boundaries) to be gone.
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  const linkReview = (page: Awaited<ReturnType<typeof open>>) =>
    page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
  const approveButton = (page: Awaited<ReturnType<typeof open>>) =>
    page.getByRole("button", { name: "承認する", exact: true });

  test("a pending-to-posted merge shows each pin against the candidate, its invalidation and effect, then approves and commits", async () => {
    commands = true;
    stale = false;
    published = false;
    posted.length = 0;
    link = {
      kind: "relation.accept",
      planned: authorizedCandidate(),
      purchase: authorizedPendingPurchase(),
    };
    const page = await open();
    const review = linkReview(page);
    await review.getByText("同一の利用として統合", { exact: true }).waitFor();
    const text = await review.innerText();
    // One event, authorized → captured, and no amount added or removed.
    expect(text).toContain("未確定 → 確定");
    expect(text).toContain("確定の合計は変わりません");
    expect(text).toContain("review:card-purchase-link");
    for (const subject of Object.keys(linkPlanPins(authorizedCandidate())))
      expect(text).toContain(subject);
    expect(await review.getByText("一致", { exact: true }).count()).toBe(4);
    expect(await review.getByText("不一致", { exact: true }).count()).toBe(0);
    // The candidate is read back from the pending-origin purchase the plan pinned.
    expect(new Set(purchaseReads)).toEqual(new Set([PENDING_EVENT]));
    expect(await review.getByRole("list", { name: "未確定の明細と確定の明細" }).count()).toBe(1);
    await approveButton(page).click();
    await page.getByRole("button", { name: "承認済み", exact: true }).waitFor();
    await page.getByRole("button", { name: "確定する", exact: true }).click();
    await page.getByRole("button", { name: "反映状況を再確認" }).waitFor();
    expect(posted).toContain("/api/command/v1/commit");
    await page.close();
  }, 30_000);

  test("a withdrawal of a merged link names the split and its one merged pin", async () => {
    commands = true;
    stale = false;
    // The server also pins the posted event the merge absorbed, at 0, first.
    link = { kind: "relation.reject", planned: mergedCandidate(), purchase: mergedPurchase() };
    expect(Object.keys(serverPlanPins(mergedCandidate()))[0]).toBe(`card-purchase:${POSTED_EVENT}`);
    const page = await open();
    const review = linkReview(page);
    await review.getByText("統合を取り消す", { exact: true }).waitFor();
    const text = await review.innerText();
    expect(text).toContain("元の2件の記録に戻します");
    expect(text).toContain("確定の合計は変わりません");
    expect(await review.getByText("一致", { exact: true }).count()).toBe(3);
    // The candidate is read from the live merged event, never the absorbed one.
    expect(new Set(purchaseReads)).toEqual(new Set([PENDING_EVENT]));
    expect(await approveButton(page).isDisabled()).toBe(false);
    await page.close();
  }, 30_000);

  test("an action the plan does not state as the server's own cannot be approved", async () => {
    commands = true;
    stale = false;
    // Every pin matches, but the simulation names a proposal status that is
    // not a merge although the plan's kind is `relation.accept`.
    link = {
      kind: "relation.accept",
      planned: authorizedCandidate(),
      proposedStatus: "rejected",
      purchase: authorizedPendingPurchase(),
    };
    const page = await open();
    const review = linkReview(page);
    await review
      .getByRole("alert")
      .filter({ hasText: "この候補では計画した操作を実行できません" })
      .waitFor();
    // The candidate stays readable; only the decision is refused.
    expect(await review.getByRole("list", { name: "未確定の明細と確定の明細" }).count()).toBe(1);
    expect(await review.getByText("不一致", { exact: true }).count()).toBe(0);
    expect(await review.getByText("計画作成後に変わっています").count()).toBe(0);
    expect(await approveButton(page).isDisabled()).toBe(true);
    await page.close();
  }, 30_000);

  test("a pin that moved since planning, or an action no longer offered, blocks approval and commit", async () => {
    commands = true;
    stale = false;
    posted.length = 0;
    // The proposal gained a decision after the plan was made.
    const moved = authorizedPendingPurchase();
    moved.candidates = [{ ...authorizedCandidate(), proposalRevision: 1 }];
    link = { kind: "relation.accept", planned: authorizedCandidate(), purchase: moved };
    const page = await open();
    const review = linkReview(page);
    await review.getByRole("alert").filter({ hasText: "計画作成後に変わっています" }).waitFor();
    expect(await review.getByText("不一致", { exact: true }).count()).toBe(1);
    expect(await approveButton(page).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "確定する", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.close();

    // The same pins, but a blocker took the merge away.
    const blocked = authorizedPendingPurchase();
    blocked.candidates = [
      { ...authorizedCandidate(), actions: ["reject"], blockers: ["posted_not_captured"] },
    ];
    link = { kind: "relation.accept", planned: authorizedCandidate(), purchase: blocked };
    const refused = await open();
    await linkReview(refused)
      .getByRole("alert")
      .filter({ hasText: "この候補では計画した操作を実行できません" })
      .waitFor();
    expect(await approveButton(refused).isDisabled()).toBe(true);
    expect(posted.some((path) => path.endsWith("/approve") || path.endsWith("/commit"))).toBe(
      false,
    );
    await refused.close();
  }, 30_000);

  test("a review whose candidate cannot be read back cannot be approved", async () => {
    commands = true;
    stale = false;
    // A merge plan without the holder pins names no purchase to read the candidate from.
    link = {
      kind: "relation.accept",
      planned: authorizedCandidate(),
      pins: Object.fromEntries(
        Object.entries(linkPlanPins(authorizedCandidate())).filter(
          ([ref]) => !ref.startsWith("card-purchase:"),
        ),
      ),
      purchase: authorizedPendingPurchase(),
    };
    const page = await open();
    await linkReview(page)
      .getByRole("alert")
      .filter({ hasText: "計画した候補と利用の記録を特定できない" })
      .waitFor();
    expect(await approveButton(page).isDisabled()).toBe(true);
    expect(purchaseReads).toHaveLength(0);
    await page.close();

    // A connection that does not serve card purchases cannot show the candidate either.
    purchaseAdvertised = false;
    link = {
      kind: "relation.accept",
      planned: authorizedCandidate(),
      purchase: authorizedPendingPurchase(),
    };
    const unserved = await open();
    await linkReview(unserved)
      .getByRole("alert")
      .filter({ hasText: "カード利用の説明を取得できない接続先" })
      .waitFor();
    expect(await approveButton(unserved).isDisabled()).toBe(true);
    expect(purchaseReads).toHaveLength(0);
    await unserved.close();
  }, 30_000);
});
