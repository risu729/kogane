// Reviewing a pending-to-posted card usage link on the カード利用 pages.
// Local synthetic fixtures only. What is proved here:
//
//  * candidates exist only where the capability is advertised, and the
//    decisions only where the change lifecycle is,
//  * a candidate shows both rows, its codes and exactly the actions the
//    server offers (a blocker takes the merge away),
//  * a decision plans `relation.accept` / `relation.reject` with the
//    candidate's own `relation` and the operator's reason, nothing built
//    locally, and opens the confirmation screen only for a plan pinned to
//    what was on screen,
//  * a plan that does anything but the chosen decision is not opened either,
//  * a merged purchase offers only the withdrawal, which is a reject; its plan
//    also pins the absorbed posted event at 0, which the page accepts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  capturedPurchase,
  linkCandidate,
  purchasePage,
  retiredPurchase,
} from "../../../packages/application/test/card-purchase-view-fixture.ts";
import type {
  CardPurchaseCandidate,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";
import {
  linkPlanTargets,
  mergedCandidate,
  mergedPurchase,
  PENDING_EVENT,
  plannedProposalStatus,
  POSTED_EVENT,
  serverPlanPins,
} from "./card-purchase-link-fixture.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const PLAN = "e".repeat(64);

describe.if(runnable)("pending-to-posted link review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let commands = true;
  let merged = false;
  let candidate: CardPurchaseCandidate = linkCandidate();
  /** Added to the proposal pin a plan answers with, as if the candidate moved meanwhile. */
  let pinDrift = 0;
  /** The proposal's next status a plan names instead of the one its kind and candidate imply. */
  let plannedStatus: string | null = null;
  /** The kind the last plan request named; a simulation answers for that plan. */
  let plannedKind = "relation.accept";
  const requests: URL[] = [];
  const posted: { operation: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    advertised = true;
    commands = true;
    merged = false;
    candidate = linkCandidate();
    pinDrift = 0;
    plannedStatus = null;
    plannedKind = "relation.accept";
    requests.length = 0;
    posted.length = 0;
  });

  function items(): CardPurchaseView[] {
    if (merged) return [mergedPurchase()];
    return [
      { ...capturedPurchase(), candidates: [candidate] },
      { ...retiredPurchase(), candidates: [candidate] },
    ];
  }

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
              cardPurchaseRecognition: advertised,
            },
          });
        if (url.pathname === "/api/v2/card-purchases") {
          requests.push(url);
          const eventId = url.searchParams.get("eventId");
          if (eventId === null) return Response.json({ apiVersion: 2, ...purchasePage(items()) });
          const item = items().find((entry) => entry.eventId === eventId);
          return item
            ? Response.json({ apiVersion: 2, ...purchasePage([item]) })
            : Response.json({ error: "not_found" }, { status: 404 });
        }
        if (url.pathname.startsWith("/api/command/v1/")) {
          const operation = url.pathname.split("/").at(-1)!;
          const body = (await request.json()) as Record<string, unknown>;
          posted.push({ operation, body });
          if (operation === "plan") plannedKind = String(body.kind);
          const shown = merged ? mergedCandidate() : candidate;
          // What the server pins and names: the candidate's subjects (plus the
          // absorbed event at 0 for a merged link) and the proposal's next status.
          const pins = serverPlanPins(shown);
          pins[`proposal:${shown.proposalId}`] = shown.proposalRevision + pinDrift;
          const simulation = {
            kind: plannedKind,
            targets: linkPlanTargets(
              shown,
              plannedKind,
              pins,
              plannedStatus ?? plannedProposalStatus(shown, plannedKind),
            ),
            before: { attributedObservations: 0, relations: shown.relationRevision },
            after: { attributedObservations: 0, relations: shown.relationRevision + 1 },
            invalidations: ["review:card-purchase-link"],
            affectedScopes: ["vpass"],
            affectedParseRuns: 0,
            outboxTargets: [],
          };
          const plan = {
            planId: PLAN,
            planDigest: PLAN,
            kind: simulation.kind,
            baseContextId: `card-purchase-link:${shown.proposalId}`,
            expectedRevisions: pins,
            simulation,
            createdBy: "human:synthetic",
            createdAt: "2026-09-24T00:00:00Z",
            expiresAt: "2099-01-01",
            status: "planned",
          };
          if (operation === "plan") return Response.json({ plan, created: true });
          return Response.json({
            report: { ...plan, currentRevisions: pins, stale: false, resimulatedPlanId: PLAN },
          });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
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

  async function open(path: string, heading: string) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(origin + path);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return page;
  }
  const openList = () => open("/purchases", "カード利用");
  const openDetail = (eventId = POSTED_EVENT) => open(`/purchases/${eventId}`, "カード利用の説明");
  const plans = () => posted.filter((row) => row.operation === "plan");

  test("candidates are hidden without the capability, and decisions without the lifecycle", async () => {
    advertised = false;
    const hidden = await openList();
    await hidden.getByText("この接続先はカード利用の説明を提供していません。").waitFor();
    expect(await hidden.getByText("確認待ちの未確定・確定の対応候補").count()).toBe(0);
    expect(requests).toHaveLength(0);
    await hidden.close();

    advertised = true;
    commands = false;
    const page = await openDetail();
    const review = page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await review.waitFor();
    // The evidence stays readable; the decision does not exist here.
    expect(await review.getByRole("list", { name: "未確定の明細と確定の明細" }).count()).toBe(1);
    expect(await page.getByLabel("判断の理由", { exact: true }).count()).toBe(0);
    for (const name of ["同一の利用として統合", "別の利用として扱う", "統合を取り消す"])
      expect(await page.getByRole("button", { name }).count()).toBe(0);
    expect(await review.innerText()).toContain("ここから判断することはできません");
    expect(posted).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("the list names each open candidate once, between the coverage note and the list", async () => {
    const page = await openList();
    const section = page.getByRole("region", {
      name: "確認待ちの未確定・確定の対応候補",
      exact: true,
    });
    await section.waitFor();
    // Two events on this page carry the same candidate; it is listed once.
    const entries = section.getByRole("list", { name: "確認待ちの対応候補" }).getByRole("listitem");
    expect(await entries.count()).toBe(1);
    const text = (await entries.first().innerText()).replace(/\s+/gu, " ");
    for (const expected of ["未確定", "2026-08-03", "-800 JPY", "確定", "2026-08-15", "-1234 JPY"])
      expect(text).toContain(expected);
    expect(text).toContain("金額・日付などからの候補");
    expect(
      await section.getByRole("link", { name: "候補を確認して判断" }).getAttribute("href"),
    ).toBe(`/purchases/${POSTED_EVENT}`);
    // Order: coverage note, candidates, then the purchase list.
    const order = await page.evaluate(() => {
      const main = document.querySelector("main")!.innerText;
      return [
        main.indexOf("一覧に含まれない利用があります。"),
        main.indexOf("確認待ちの未確定・確定の対応候補"),
        main.indexOf("利用の一覧"),
      ];
    });
    expect(order[0]! < order[1]! && order[1]! < order[2]!).toBe(true);
    // A decided candidate is not waiting for anyone.
    await page.close();
    candidate = linkCandidate({
      proposalStatus: "rejected",
      proposalRevision: 1,
      relationStatus: "rejected",
      relationRevision: 1,
      actions: [],
      blockers: ["proposal_closed"],
    });
    const decided = await openList();
    await decided.getByRole("region", { name: "利用の一覧", exact: true }).waitFor();
    expect(await decided.getByText("確認待ちの未確定・確定の対応候補").count()).toBe(0);
    await decided.close();
  }, 30_000);

  test("a proposed candidate shows both rows, its codes and only the offered actions", async () => {
    const page = await openDetail();
    const review = page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await review.waitFor();
    const text = await review.innerText();
    for (const expected of [
      "確認待ち",
      "金額・日付などからの候補",
      "2026-08-03",
      "-800 JPY",
      "状態不明（合計に含めていません）",
      "2026-08-15",
      "-1234 JPY",
      // Rationale codes and rejection conditions, as words.
      "未確定の明細と確定の明細の組",
      "同じ請求月",
      "カード会社の対応番号はない",
      "統合する前に確かめること",
      "利用先が異なる",
      "金額が異なる",
      "ほかにも候補がある",
    ])
      expect(text).toContain(expected);
    // Each row links to its record and original, and to its own purchase.
    const sides = review.getByRole("list", { name: "未確定の明細と確定の明細" });
    const hrefs = await sides
      .getByRole("link", { name: "明細の記録と原本" })
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(hrefs).toEqual(["/observations/transaction/23", "/observations/transaction/21"]);
    expect(await sides.getByRole("link", { name: "この利用の説明" }).getAttribute("href")).toBe(
      `/purchases/${PENDING_EVENT}`,
    );
    expect(await sides.innerText()).toContain("この画面の利用");
    // Exactly the server's actions, each waiting for a reason.
    const accept = page.getByRole("button", { name: "同一の利用として統合", exact: true });
    const reject = page.getByRole("button", { name: "別の利用として扱う", exact: true });
    expect(await accept.isDisabled()).toBe(true);
    expect(await reject.isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "統合を取り消す" }).count()).toBe(0);
    await page.getByLabel("判断の理由", { exact: true }).fill("   ");
    expect(await accept.isDisabled()).toBe(true);
    expect(posted).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("a blocker takes the merge away and a closed candidate offers nothing", async () => {
    candidate = linkCandidate({ actions: ["reject"], blockers: ["posted_not_captured"] });
    const page = await openDetail();
    const review = page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await review.getByRole("note").filter({ hasText: "確定の状態ではありません" }).waitFor();
    expect(await review.innerText()).toContain("現時点では同一の利用として統合できません。");
    expect(await page.getByRole("button", { name: "同一の利用として統合" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "別の利用として扱う" }).count()).toBe(1);
    await page.close();

    candidate = linkCandidate({
      proposalStatus: "rejected",
      proposalRevision: 1,
      relationStatus: "rejected",
      relationRevision: 1,
      actions: [],
      blockers: ["proposal_closed"],
    });
    const closed = await openDetail();
    const decided = closed.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await decided.waitFor();
    // A decided candidate starts collapsed; its evidence stays behind the disclosure.
    await decided.getByText("候補の詳細と判断", { exact: true }).click();
    await decided.getByText("この候補はすでに別の利用と判断されたか").waitFor();
    expect(await decided.innerText()).toContain("別の利用と判断済み");
    expect(await closed.getByLabel("判断の理由", { exact: true }).count()).toBe(0);
    expect(await closed.getByRole("button", { name: "別の利用として扱う" }).count()).toBe(0);
    await closed.close();
  }, 30_000);

  test("merging plans relation.accept with the candidate's relation unchanged plus the reason", async () => {
    const page = await openDetail(PENDING_EVENT);
    await page.getByLabel("判断の理由", { exact: true }).fill("同じ利用先の同じ日の利用と確認した");
    await page.getByRole("button", { name: "同一の利用として統合", exact: true }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe(`/confirm/${PLAN}`);
    expect(plans()).toHaveLength(1);
    expect(plans()[0]!.body).toEqual({
      kind: "relation.accept",
      payload: { ...candidate.relation, reason: "同じ利用先の同じ日の利用と確認した" },
      baseContextId: `card-purchase-link:${candidate.proposalId}`,
    });
    // Planning is not deciding: nothing was approved or committed.
    expect(posted.some((row) => row.operation === "approve" || row.operation === "commit")).toBe(
      false,
    );
    await page.close();
  }, 30_000);

  test("treating the rows as two purchases plans relation.reject", async () => {
    const page = await openDetail();
    await page.getByLabel("判断の理由", { exact: true }).fill("利用先が異なっていた");
    await page.getByRole("button", { name: "別の利用として扱う", exact: true }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(plans()[0]!.body).toEqual({
      kind: "relation.reject",
      payload: { ...candidate.relation, reason: "利用先が異なっていた" },
      baseContextId: `card-purchase-link:${candidate.proposalId}`,
    });
    await page.close();
  }, 30_000);

  test("a plan pinned to anything but the candidate on screen is not opened", async () => {
    pinDrift = 1;
    const page = await openDetail();
    await page.getByLabel("判断の理由", { exact: true }).fill("同じ利用と確認した");
    await page.getByRole("button", { name: "同一の利用として統合", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "候補または利用の記録が更新されています" })
      .waitFor();
    expect(new URL(page.url()).pathname).toBe(`/purchases/${POSTED_EVENT}`);
    expect(posted.map((row) => row.operation)).toEqual(["plan"]);
    await page.close();
  }, 30_000);

  test("a plan that does anything but the chosen decision is not opened", async () => {
    // Chosen: treat the rows as two purchases. The server, reading a link that
    // was accepted meanwhile, planned its withdrawal instead.
    plannedStatus = "withdrawn";
    const page = await openDetail();
    await page.getByLabel("判断の理由", { exact: true }).fill("利用先が異なっていた");
    await page.getByRole("button", { name: "別の利用として扱う", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "候補または利用の記録が更新されています" })
      .waitFor();
    expect(new URL(page.url()).pathname).toBe(`/purchases/${POSTED_EVENT}`);
    expect(posted.map((row) => row.operation)).toEqual(["plan"]);
    await page.close();
  }, 30_000);

  test("a merged purchase shows its accepted link with only the withdrawal, which is a reject", async () => {
    merged = true;
    const page = await openDetail(PENDING_EVENT);
    const review = page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await review.waitFor();
    expect(await review.innerText()).toContain("統合済み");
    // An accepted link is not waiting for a decision; its review starts collapsed.
    await review.getByText("候補の詳細と判断", { exact: true }).click();
    const sides = review.getByRole("list", { name: "未確定の明細と確定の明細" });
    expect(await sides.getByRole("link", { name: "この利用の説明" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "同一の利用として統合" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "別の利用として扱う" }).count()).toBe(0);
    expect(await review.innerText()).toContain("元の2件の記録に戻します");
    await page.getByText("記録の履歴と根拠の参照", { exact: true }).click();
    expect(await page.locator("main").innerText()).toContain("版 3: 統合");
    await page.getByLabel("判断の理由", { exact: true }).fill("別の日の利用だった");
    await page.getByRole("button", { name: "統合を取り消す", exact: true }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    const shown = mergedCandidate();
    expect(plans()[0]!.body).toEqual({
      kind: "relation.reject",
      payload: { ...shown.relation, reason: "別の日の利用だった" },
      baseContextId: `card-purchase-link:${shown.proposalId}`,
    });
    // The confirmation screen reads the same candidate back and names the split.
    const confirm = page.getByRole("region", { name: "未確定と確定の明細の対応", exact: true });
    await confirm.getByText("統合を取り消す", { exact: true }).waitFor();
    expect(await confirm.innerText()).toContain("元の2件の記録に戻します");
    // The absorbed posted event, pinned at 0, is neither read nor a mismatch.
    expect(requests.map((url) => url.searchParams.get("eventId"))).not.toContain(POSTED_EVENT);
    expect(await confirm.getByText("不一致", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "承認する", exact: true }).isDisabled()).toBe(
      false,
    );
    await page.close();
  }, 30_000);

  test("list, review and confirmation fit a phone width without sideways page scroll", async () => {
    const page = await openList();
    // Measure the page with the candidate on it, not a page still loading.
    await page
      .getByRole("region", { name: "確認待ちの未確定・確定の対応候補", exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);
    await page.goto(`${origin}/purchases/${POSTED_EVENT}`);
    await page.getByRole("button", { name: "同一の利用として統合", exact: true }).waitFor();
    expect(await fits()).toBe(true);
    const prefix = process.env["PURCHASE_SCREENSHOT_PREFIX"];
    if (prefix) await page.screenshot({ path: `${prefix}-candidate-mobile.png`, fullPage: true });
    await page.getByLabel("判断の理由", { exact: true }).fill("同じ利用と確認した");
    await page.getByRole("button", { name: "同一の利用として統合", exact: true }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    // The candidate read back from the purchase is part of what must fit.
    await page
      .getByRole("region", { name: "未確定と確定の明細の対応", exact: true })
      .getByRole("list", { name: "未確定の明細と確定の明細" })
      .waitFor();
    await page.getByRole("button", { name: "承認する", exact: true }).waitFor();
    expect(await fits()).toBe(true);
    if (prefix)
      await page.screenshot({ path: `${prefix}-link-confirm-mobile.png`, fullPage: true });
    await page.close();
  }, 30_000);
});
