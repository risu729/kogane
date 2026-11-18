import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { auditView } from "./a11y-audit.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { settlementReview } from "../../../packages/application/test/card-settlement-fixture.ts";
import { cardSettlementImpact } from "../../../packages/domain/src/card-settlement.ts";
import type { CardSettlementReview } from "../../../packages/domain/src/card-settlement-review.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const PLAN = "a".repeat(64);
const yen = (coefficient: string) => ({
  unitRef: "JPY",
  value: {
    status: "exact",
    value: { coefficient, scale: 0 },
    normalizationVersion: "exact-arith-v1",
  },
});
/** Each card's debit account, as the service answers it (ADR 0114); every value invented. */
const SMBC_ACCOUNT = { bankSourceId: "smbc-bank", bankSourceAccount: "smbc-bank:synthetic-a" };
const SHINSEI_ACCOUNT = {
  bankSourceId: "sbi-shinsei-bank",
  bankSourceAccount: "sbi-shinsei:synthetic-b",
};
const namedReading = {
  readingRef: {
    kind: "typed-claim",
    id: "card_debit_account_statement:7",
    revision: "reader:synthetic-1",
  },
  observedAt: "2098-01-12T00:00:00Z",
  accounts: [SMBC_ACCOUNT],
  visibleDigitCount: 4,
  reasons: [],
};
const noReader = {
  status: "absent",
  reason: "source_has_no_debit_account_statement",
  latest: null,
  lastNamed: null,
};
const debitAccounts = {
  apiVersion: 2,
  schemaVersion: "kogane-card-debit-accounts-v1",
  manifest: {
    rule: "card-debit-account-answer-v1",
    statedPolicy: "card-debit-account-statement-v3",
    readerVersion: "myjcb-card-information-1.0.0",
    bases: ["provider-stated", "accepted-settlement"],
    cardsMax: 100,
  },
  items: [
    {
      card: { sourceId: "myjcb", sourceAccount: "myjcb:synthetic:root", accountId: null },
      latestStatement: {
        ref: { kind: "balance", id: "balance:31", revision: "parse_run:9" },
        period: "2098-02",
        paymentDate: {
          kind: "local-date",
          value: "2098-02-10",
          zone: "Asia/Tokyo",
          basis: "provider",
        },
        amount: yen("0"),
      },
      stated: { status: "named", reason: null, latest: namedReading, lastNamed: namedReading },
      settled: [],
      proposed: [],
      answer: {
        basis: "provider-stated",
        account: SMBC_ACCOUNT,
        readingRef: namedReading.readingRef,
        observedAt: namedReading.observedAt,
        codes: [],
      },
    },
    {
      card: { sourceId: "vpass", sourceAccount: "vpass:card-001", accountId: null },
      latestStatement: null,
      stated: noReader,
      settled: [
        {
          ...SHINSEI_ACCOUNT,
          statements: 2,
          latest: { proposalId: "cs_settled-1", debitDate: "2098-01-27", period: "2098-01" },
        },
      ],
      proposed: [],
      answer: {
        basis: "accepted-settlement",
        account: SHINSEI_ACCOUNT,
        proposalId: "cs_settled-1",
        debitDate: "2098-01-27",
        codes: [],
      },
    },
    {
      card: { sourceId: "vpass", sourceAccount: "vpass:card-002", accountId: null },
      latestStatement: null,
      stated: noReader,
      settled: [],
      proposed: [
        {
          ...SMBC_ACCOUNT,
          statements: 1,
          latest: { proposalId: "cs_open-1", debitDate: "2098-01-26", period: "2098-01" },
        },
      ],
      answer: { basis: "unknown", reason: "only_unreviewed_candidates" },
    },
  ],
  cardsTruncated: false,
};
/** A page of statements without a candidate, as the service answers it; every value invented. */
const unmatched = {
  apiVersion: 2,
  schemaVersion: "kogane-card-statements-unmatched-v1",
  query: { offset: 0 },
  manifest: {
    codes: [],
    planner: {
      release: "card-statement-allocation-v2",
      policy: {
        policyVersion: "card-statement-unmatched-display-v1",
        window: { minDaysFromDue: -3, maxDaysFromDue: 3 },
        maxDebitsPerAllocation: 3,
      },
      partition: "page-overlapping-windows",
      bounds: { statements: 16, debits: 32, allocations: 50 },
    },
    pageSize: 50,
    acceptance: "single-debit-candidates-only",
  },
  items: [
    {
      statement: {
        ref: { kind: "balance", id: "balance:21", revision: "parse_run:5" },
        sourceId: "myjcb",
        sourceAccount: "synthetic-card",
        accountId: null,
        amount: yen("3000"),
        paymentDate: {
          kind: "local-date",
          value: "2098-01-10",
          zone: "Asia/Tokyo",
          basis: "provider",
        },
        period: "2098-01",
      },
      code: "no_equal_amount_debit",
      debitsInWindow: 2,
      planner: {
        status: "proposed",
        codes: [],
        allocations: [
          {
            kind: "multiple-debits",
            ownership: "unknown",
            rejectionConditions: ["owner_not_established"],
            members: [
              {
                ref: { kind: "transaction", id: "transaction:31", revision: "parse_run:6" },
                sourceId: "smbc-bank",
                sourceAccount: "synthetic-bank",
                accountId: null,
                amount: yen("1000"),
              },
              {
                ref: { kind: "transaction", id: "transaction:32", revision: "parse_run:6" },
                sourceId: "smbc-bank",
                sourceAccount: "synthetic-bank",
                accountId: null,
                amount: yen("2000"),
              },
            ],
          },
        ],
        allocationCount: 1,
        allocationsTruncated: false,
      },
      acceptable: false,
    },
    {
      statement: {
        ref: { kind: "balance", id: "balance:22", revision: "parse_run:5" },
        sourceId: "vpass",
        sourceAccount: "synthetic-card-2",
        accountId: null,
        amount: yen("-1200"),
        paymentDate: {
          kind: "local-date",
          value: "2098-02-10",
          zone: "Asia/Tokyo",
          basis: "provider",
        },
        period: "2098-02",
      },
      code: "statement_total_refund_or_zero",
      debitsInWindow: 0,
      planner: null,
      acceptable: false,
    },
  ],
  nextOffset: null,
  nextPage: "none",
};
/** One statement whose window holds 32 equal debits: 4,960 exact sums, the first 50 listed. */
const truncated = {
  ...unmatched,
  items: [
    {
      ...unmatched.items[0]!,
      debitsInWindow: 32,
      planner: {
        status: "needs_review",
        codes: ["candidate_not_unique"],
        allocations: Array.from({ length: 50 }, (_, index) => ({
          kind: "multiple-debits",
          ownership: "unknown",
          rejectionConditions: ["owner_not_established"],
          members: [0, 1, 2].map((offset) => ({
            ref: {
              kind: "transaction",
              id: `transaction:${100 + index + offset}`,
              revision: "parse_run:6",
            },
            sourceId: "smbc-bank",
            sourceAccount: "synthetic-bank",
            accountId: null,
            amount: yen("1000"),
          })),
        })),
        allocationCount: 4960,
        allocationsTruncated: true,
      },
    },
  ],
};

describe.if(runnable)("card settlement review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let review = settlementReview();
  let advertised = true;
  let detailRevision = 0;
  let planRevision = 0;
  let action = "accept";
  let older: ReturnType<typeof settlementReview>[] = [];
  let leadSearch = "not_searched";
  /** A second statement's candidates, newest first; empty serves one statement. */
  let second: ReturnType<typeof settlementReview>[] = [];
  /** The candidates a `relatedTo` read returns, and the reads of them. */
  let related: CardSettlementReview[] = [];
  const relatedReads: URLSearchParams[] = [];
  let unmatchedPage: unknown = unmatched;
  /** The unmatched pages by `offset`, when a test serves more than one. */
  let unmatchedPages: Map<string, unknown> | null = null;
  const unmatchedReads: string[] = [];
  let debitAccountsPage: unknown = debitAccounts;
  const debitAccountReads: string[] = [];
  /** Why the grouped list has no next page. */
  let statementsEnd = "none";
  const posted: { operation: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    review = settlementReview();
    advertised = true;
    detailRevision = 0;
    planRevision = 0;
    action = "accept";
    older = [];
    leadSearch = "not_searched";
    second = [];
    related = [];
    relatedReads.length = 0;
    unmatchedPage = unmatched;
    unmatchedPages = null;
    unmatchedReads.length = 0;
    debitAccountsPage = debitAccounts;
    debitAccountReads.length = 0;
    statementsEnd = "none";
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
        if (url.pathname === "/api/v2/reconciliation/card-settlements/statements")
          return Response.json({
            statements: [
              {
                statementKey: "statement-synthetic",
                candidateCount: older.length + 1,
                candidates: [review, ...older.slice(0, 1)],
                leadSearch,
              },
              ...(second.length
                ? [
                    {
                      statementKey: "statement-synthetic-2",
                      candidateCount: second.length,
                      candidates: second.slice(0, 2),
                      leadSearch: "not_searched",
                    },
                  ]
                : []),
            ],
            nextOffset: null,
            nextPage: statementsEnd,
            coverage: {
              scope: "card-statement-bank-debit-candidates",
              completeTransactionHistory: false,
              netAssets: "unknown",
              limit: 10,
              candidatesPerStatement: 5,
              olderCandidatesSearched: 200,
            },
          });
        if (
          url.pathname === "/api/v2/reconciliation/card-settlements" &&
          url.searchParams.has("statementKey")
        )
          return Response.json({
            items:
              url.searchParams.get("statementKey") === "statement-synthetic-2"
                ? second
                : [review, ...older],
            nextOffset: null,
            nextPage: "none",
            coverage: {
              scope: "card-statement-bank-debit-candidates",
              completeTransactionHistory: false,
              netAssets: "unknown",
              limit: 50,
            },
          });
        if (
          url.pathname === "/api/v2/reconciliation/card-settlements" &&
          url.searchParams.has("relatedTo")
        ) {
          relatedReads.push(url.searchParams);
          return Response.json({
            items: related,
            nextOffset: null,
            nextPage: "none",
            coverage: {
              scope: "card-statement-bank-debit-candidates",
              completeTransactionHistory: false,
              netAssets: "unknown",
              limit: 50,
            },
          });
        }
        if (url.pathname === "/api/v2/reconciliation/card-settlements")
          return Response.json({
            items: [
              {
                ...review,
                revision: url.searchParams.has("proposalId") ? detailRevision : review.revision,
              },
            ],
            nextOffset: null,
            nextPage: "none",
            coverage: {
              scope: "card-statement-bank-debit-candidates",
              completeTransactionHistory: false,
              netAssets: "unknown",
              limit: 50,
            },
          });
        if (url.pathname === "/api/v2/reconciliation/card-statements-unmatched") {
          const offset = url.searchParams.get("offset") ?? "0";
          unmatchedReads.push(offset);
          return Response.json(unmatchedPages?.get(offset) ?? unmatchedPage);
        }
        if (url.pathname === "/api/v2/reconciliation/card-debit-accounts") {
          debitAccountReads.push(url.search);
          return Response.json(debitAccountsPage);
        }
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
        name: path.startsWith("/confirm/")
          ? "変更の確認"
          : path === "/reconciliation"
            ? "カード請求と引落の照合"
            : "請求と引落の照合候補",
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

  test("each card's debit account names the evidence it rests on, and offers no action", async () => {
    const page = await open();
    const section = page.getByRole("region", { name: "カードの引落口座" });
    await section.getByText("vpass:card-002").waitFor();
    const cards = section.locator(".debit-account-card");
    expect(await cards.count()).toBe(3);
    const stated = await cards.nth(0).innerText();
    expect(stated).toContain("カード会社の表示");
    // A stated answer with no note is the confirmed one.
    expect(
      await cards.nth(0).locator(".badge", { hasText: "カード会社の表示" }).getAttribute("class"),
    ).toContain("badge-ok");
    expect(stated).toContain("三井住友銀行 · smbc-bank:synthetic-a");
    expect(stated).toContain("2098-01-12T00:00:00Z に取得した明細");
    // The newest statement is a zero total, and the last known account still shows.
    expect(stated).toContain("最新の請求 2098-02");
    const settled = await cards.nth(1).innerText();
    expect(settled).toContain("採用済みの照合から");
    expect(settled).toContain("カード会社が示す口座ではありません");
    expect(settled).toContain("このカード会社の画面には引落口座の表示がありません");
    expect(await cards.nth(1).getByRole("link", { name: "照合を見る" }).getAttribute("href")).toBe(
      "/reconciliation/cs_settled-1",
    );
    const open_ = await cards.nth(2).innerText();
    expect(open_).toContain("引落口座は不明");
    expect(open_).toContain("まだ誰も採用していません");
    expect(open_).toContain("未判断の照合候補（判断には使いません）");
    expect(await section.getByRole("button").count()).toBe(0);
    expect(debitAccountReads).toEqual([""]);
    await page.close();
  });

  test("an older stated account says a newer reading does not confirm it, and a cut list says so", async () => {
    const unresolved = {
      ...namedReading,
      readingRef: { ...namedReading.readingRef, id: "card_debit_account_statement:8" },
      observedAt: "2098-02-12T00:00:00Z",
      accounts: [],
      visibleDigitCount: null,
      reasons: ["bank_not_resolved"],
    };
    const first = debitAccounts.items[0]!;
    debitAccountsPage = {
      ...debitAccounts,
      items: [
        {
          ...first,
          stated: {
            status: "not_named",
            reason: null,
            latest: unresolved,
            lastNamed: namedReading,
          },
          answer: { ...first.answer, codes: ["newer_reading_unresolved"] },
        },
      ],
      cardsTruncated: true,
    };
    const page = await open();
    const section = page.getByRole("region", { name: "カードの引落口座" });
    await section.getByText("myjcb:synthetic:root").waitFor();
    const text = await section.innerText();
    expect(text).toContain("2098-01-12T00:00:00Z に取得した明細");
    expect(text).toContain("より新しいカード情報ではこの口座を確認できませんでした");
    expect(text).toContain("引落口座が変わった可能性があります");
    expect(text).toContain("口座を特定できず");
    // The stated answer is a warning, not the confirmed badge.
    const badge = section.locator(".badge", { hasText: "カード会社の表示" });
    expect(await badge.getAttribute("class")).toContain("badge-warn");
    expect(await section.getByRole("note").innerText()).toBe(
      "カードが多いため、先頭の1枚だけを表示しています。",
    );
    expect(await auditView(page)).toEqual([]);
    await page.close();
  });

  test("an answer the evidence beside it does not carry is refused before it renders", async () => {
    debitAccountsPage = {
      ...debitAccounts,
      items: [
        {
          ...debitAccounts.items[0]!,
          answer: { ...debitAccounts.items[0]!.answer, account: SHINSEI_ACCOUNT },
        },
      ],
    };
    const page = await open();
    const section = page.getByRole("region", { name: "カードの引落口座" });
    await section.getByRole("alert").waitFor();
    expect(await section.innerText()).not.toContain("sbi-shinsei:synthetic-b");
    await page.close();
  });

  test("statements without a candidate show their reason and the planner's answer, with no action", async () => {
    const page = await open();
    const section = page.getByRole("region", { name: "照合候補のない請求" });
    await section.getByText("組み合わせ 1", { exact: false }).waitFor();
    const text = await section.innerText();
    expect(text).toContain("請求総額と同じ金額の出金はありません");
    expect(text).toContain("複数の出金の合計が一致");
    expect(text).toContain("三井住友銀行 · synthetic-bank · 1000 JPY");
    expect(text).toContain("三井住友銀行 · synthetic-bank · 2000 JPY");
    expect(text).toContain("返金の割り当ては未対応");
    expect(text).toContain("まだ採用できません");
    expect(await section.getByRole("button", { name: /採用/u }).count()).toBe(0);
    await page.close();
  });

  test("a statement with more combinations than the server lists says how many it does not show", async () => {
    unmatchedPage = truncated;
    const page = await open();
    const section = page.getByRole("region", { name: "照合候補のない請求" });
    const note = section.getByRole("note");
    await note.waitFor();
    expect(await note.innerText()).toContain(
      "一致する組み合わせ 4,960件のうち、出金の件数が少ない順に先頭の50件を表示しています。",
    );
    expect(await section.locator(".unmatched-allocation").count()).toBe(50);
    expect(await section.innerText()).toContain("組み合わせが一つに決まりません");
    expect(await section.getByRole("button", { name: /採用/u }).count()).toBe(0);
    await page.close();
  });

  test("a later page the list no longer reaches keeps its pager and never says no statement is left", async () => {
    // A statement leaves this list once the sweep pairs it with a debit, so a
    // later page read again can come back empty while the first still lists
    // statements. Every value is invented.
    const later = (refs: number[]) => ({
      ...unmatched,
      query: { offset: 50 },
      items: refs.map((ref) => ({
        ...unmatched.items[1]!,
        statement: {
          ...unmatched.items[1]!.statement,
          ref: { kind: "balance", id: `balance:${ref}`, revision: "parse_run:5" },
          period: "2098-03",
        },
      })),
    });
    unmatchedPages = new Map<string, unknown>([
      ["0", { ...unmatched, nextOffset: 50, nextPage: "offered" }],
      ["50", later([71])],
    ]);
    const page = await open();
    const section = page.getByRole("region", { name: "照合候補のない請求" });
    await section.getByText("2098-01", { exact: false }).waitFor();
    await section.getByRole("button", { name: "次の請求", exact: true }).click();
    await section.getByText("2098-03", { exact: false }).waitFor();
    // The sweep pairs the statements of the later page; the page is read again.
    unmatchedPages.set("50", later([]));
    const reads = unmatchedReads.length;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await section.getByText("2098-03", { exact: false }).waitFor({ state: "detached" });
    expect(unmatchedReads.length).toBeGreaterThan(reads);
    expect(unmatchedReads.at(-1)).toBe("50");
    const text = await section.innerText();
    expect(text).not.toContain("照合候補のない請求はありません。");
    expect(text).toContain("このページに表示する請求はありません。");
    // The way back to the statements the first page still lists stays.
    const back = section.getByRole("button", { name: "先頭に戻る", exact: true });
    expect(await back.isDisabled()).toBe(false);
    await back.click();
    await section.getByText("2098-01", { exact: false }).waitFor();
    expect(await auditView(page)).toEqual([]);
    await page.close();
  });

  test("two sections that fail to load each offer a retry named for its own read", async () => {
    // Shapes the client refuses, so both reads fail on one page.
    debitAccountsPage = { schemaVersion: "synthetic-invalid" };
    unmatchedPage = { schemaVersion: "synthetic-invalid" };
    const page = await open();
    for (const label of ["カードの引落口座", "照合候補のない請求"])
      await page.getByText(`${label}を読み込めませんでした`, { exact: false }).waitFor();
    expect(await auditView(page)).toEqual([]);
    // Each retry repeats its own read and no other.
    const debits = debitAccountReads.length;
    const unmatchedBefore = unmatchedReads.length;
    await page.getByRole("button", { name: "照合候補のない請求を再試行", exact: true }).click();
    // The page's own fetch, observed at the server.
    await page.waitForResponse((response) =>
      response.url().includes("/api/v2/reconciliation/card-statements-unmatched"),
    );
    expect(unmatchedReads.length).toBe(unmatchedBefore + 1);
    expect(debitAccountReads.length).toBe(debits);
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

  // One page load per outcome: each is its own test, so one slow load cannot
  // spend the budget of the others.
  const debitStatementRef = {
    kind: "typed-claim",
    id: "card_debit_account_statement:7",
    revision: "reader:myjcb-card-information-1.0.0",
  } as const;
  async function debitAccountText(
    debitAccount: ReturnType<typeof settlementReview>["debitAccount"],
  ): Promise<string> {
    review.debitAccount = debitAccount;
    const page = await open();
    const text = await page.locator("main").innerText();
    await page.close();
    return text;
  }

  test("the provider-stated debit account is shown as evidence and never unblocks adoption", async () => {
    review = settlementReview(true);
    review.debitAccount = {
      outcome: "supports",
      reason: null,
      policy: "card-debit-account-statement-v3",
      statementRef: debitStatementRef,
      bankSourceId: "sbi-shinsei-bank",
      bankSourceAccount: "synthetic-bank",
      visibleDigitCount: 4,
      recordedAt: "2026-09-11T00:00:00Z",
    };
    const page = await open();
    const text = await page.locator("main").innerText();
    expect(text).toContain("カード会社が示す引落口座");
    expect(text).toContain("照合した銀行口座と同じ");
    expect(text).toContain("先頭4桁が一致");
    expect(await page.getByRole("button", { name: "採用内容を確認" }).isDisabled()).toBe(true);
    await page.close();
  });

  test("a provider-stated debit account that names another account is shown as such", async () => {
    const text = await debitAccountText({
      outcome: "names_other_account",
      reason: null,
      policy: "card-debit-account-statement-v3",
      statementRef: debitStatementRef,
      bankSourceId: "sbi-shinsei-bank",
      bankSourceAccount: "synthetic-other-bank",
      visibleDigitCount: 4,
      recordedAt: "2026-09-11T00:00:00Z",
    });
    expect(text).toContain("照合した銀行口座とは別の口座 · SBI新生銀行 · synthetic-other-bank");
  });

  test("an undecided debit account statement shows its reason", async () => {
    const text = await debitAccountText({
      outcome: "not_proposed",
      reason: "ambiguous_accounts",
      policy: "card-debit-account-statement-v3",
      statementRef: debitStatementRef,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: "2026-09-11T00:00:00Z",
    });
    expect(text).toContain("判定なし（預金種目と口座番号の先頭桁が一致する口座が複数あります）");
  });

  test("a candidate with no recorded debit account outcome says it is not recorded", async () => {
    const text = await debitAccountText(settlementReview().debitAccount);
    expect(text).toContain("記録なし（この候補についての判定はまだ記録されていません）");
  });

  test("an absent debit account statement shows why it is absent", async () => {
    const text = await debitAccountText({
      outcome: "absent",
      reason: "card_information_table_invalid",
      policy: "card-debit-account-statement-v3",
      statementRef: null,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: null,
    });
    expect(text).toContain("記録なし（「カード情報」の表の形が想定と異なります）");
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
  test("the list links each candidate to its own page", async () => {
    const page = await open();
    expect(
      await page
        .getByRole("link", { name: "同じ請求・出金の他の候補を確認", exact: true })
        .getAttribute("href"),
    ).toBe(`/reconciliation/${review.proposalId}`);
    // The list itself reads no competitors.
    expect(relatedReads).toHaveLength(0);
    await page.close();
  });

  test("a wrong acceptance is corrected from its page: withdrawn there, the competitor opened from it", async () => {
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
    const other = settlementReview();
    other.proposalId = "cs-other-debit";
    other.facts.bankDebit.sourceAccount = "synthetic-bank-other";
    other.acceptanceBlockers = ["allocation_already_used"];
    related = [other];
    const page = await open(`/reconciliation/${review.proposalId}`);
    await page.getByRole("list", { name: "他の候補" }).waitFor();
    expect(relatedReads.map((params) => params.toString())).toEqual([
      `relatedTo=${review.proposalId}`,
    ]);
    const competitors = page.getByRole("list", { name: "他の候補" });
    const text = await competitors.innerText();
    expect(text).toContain("確認待ち");
    expect(text).toContain("synthetic-bank-other");
    expect(text).toContain("同じ請求・出金を別の決済へ配賦済みの場合は採用不可");
    expect(await competitors.getByRole("link").first().getAttribute("href")).toBe(
      "/reconciliation/cs-other-debit",
    );
    // The candidate's own review starts open, with its withdrawal and history.
    expect(await page.locator("main").innerText()).toContain(
      "解除しても、この判断と原本は履歴に残ります",
    );
    expect(
      await page
        .getByRole("link", { name: "照合候補の一覧に戻る", exact: true })
        .getAttribute("href"),
    ).toBe("/reconciliation");
    await page.getByLabel("判断の理由", { exact: true }).fill("別の銀行明細が支払に対応していた");
    await page.getByRole("button", { name: "採用を解除する内容を確認" }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    expect(posted.find((row) => row.operation === "plan")?.body).toMatchObject({
      kind: "card-settlement.withdraw",
      payload: { proposalId: review.proposalId },
    });
    // The confirmation returns to the candidate's page, not the list.
    expect(
      await page.getByRole("link", { name: "照合候補に戻る", exact: true }).getAttribute("href"),
    ).toBe(`/reconciliation/${review.proposalId}`);
    expect(posted.some((row) => row.operation === "approve" || row.operation === "commit")).toBe(
      false,
    );
    await page.close();
  });

  test("a candidate with no competitor says so, and fits a narrow screen", async () => {
    const page = await open(`/reconciliation/${review.proposalId}`);
    await page.getByText("同じ請求・出金を対象とする他の候補はありません。").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.close();
  });

  test("the review and its confirmation pass the accessibility audit", async () => {
    const page = await open();
    expect(await auditView(page)).toEqual([]);
    await page.getByLabel("判断の理由", { exact: true }).fill("同一保有者の根拠がないため");
    await page.getByRole("button", { name: "却下内容を確認" }).click();
    await page.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    await page.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    expect(await auditView(page)).toEqual([]);
    await page.close();
  }, 60_000);
  test("one statement's earlier candidates are collapsed under the one to review and stay reachable", async () => {
    const stale = (n: number) => ({
      ...settlementReview(),
      proposalId: `card-settlement-stale-${n}`,
      createdAt: `2026-09-0${n}T00:00:00Z`,
      acceptanceBlockers: ["statement_changed"],
    });
    older = [stale(2), stale(1)];
    const page = await open();
    // One statement, so one candidate is open for a decision.
    expect(await page.getByRole("button", { name: "採用内容を確認" }).count()).toBe(1);
    const summary = page.getByText("この請求のほかの候補（2 件）", {
      exact: true,
    });
    await summary.waitFor();
    expect(await page.locator(".settlement-older > section").first().isVisible()).toBe(false);
    await summary.click();
    expect(await page.locator(".settlement-older > section").count()).toBe(1);
    await page.getByRole("button", { name: "この請求の候補をすべて表示（3 件）" }).click();
    // The pager names its statement, and so does its spoken count.
    const pager = page.getByRole("navigation", {
      name: "請求 1 件目（MyJCB · synthetic-card · 2026-09）の候補のページ",
      exact: true,
    });
    expect(await pager.getByRole("status").textContent()).toBe(
      "請求 1 件目（MyJCB · synthetic-card · 2026-09）の候補：1–3 件目 / 3 件",
    );
    // The full list adds the one the group did not carry, and repeats none.
    expect(await page.locator(".settlement-older section.panel").count()).toBe(2);
    expect(await page.getByRole("button", { name: "採用内容を確認" }).count()).toBe(3);
    expect(await auditView(page)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.close();
  });

  test("a lead search the server stopped at its limit is said, and the full list stays one click away", async () => {
    const stale = (n: number) => ({
      ...settlementReview(),
      proposalId: `card-settlement-stale-${n}`,
      createdAt: `2026-09-0${n}T00:00:00Z`,
      acceptanceBlockers: ["statement_changed"],
    });
    review = { ...review, acceptanceBlockers: ["bank_debit_changed"] };
    older = [stale(2), stale(1)];
    leadSearch = "truncated";
    const page = await open();
    const note = page.getByRole("note").filter({ hasText: "この請求の古い候補" });
    await note.waitFor();
    expect(await note.textContent()).toContain("新しい順に 200 件まで確かめました");
    expect(await note.textContent()).toContain("採用できる候補がないとは限りません");
    // It names where the full list is: under the collapsed other candidates.
    expect(await note.textContent()).toContain(
      "「この請求のほかの候補」を開き、「この請求の候補をすべて表示」",
    );
    expect(await auditView(page)).toEqual([]);
    await page.close();
    leadSearch = "none_ready";
    const searched = await open();
    await searched.getByText("この請求のほかの候補（2 件）", { exact: true }).waitFor();
    expect(await searched.getByRole("note").filter({ hasText: "この請求の古い候補" }).count()).toBe(
      0,
    );
    await searched.close();
  });

  test("a list cut at the reader's row budget says so, never that nothing follows", async () => {
    const BOUND = "一度に先頭から読める件数の上限に達したため";
    // The last page of each list ends where every page ends: nothing is said.
    const ended = await open();
    await ended.getByRole("navigation", { name: "照合候補のページ" }).waitFor();
    await ended.getByRole("navigation", { name: "照合候補のない請求のページ" }).waitFor();
    expect(await ended.getByRole("note").filter({ hasText: BOUND }).count()).toBe(0);
    await ended.close();
    // Rows follow that the server may not page to: the pager stops, and says why.
    statementsEnd = "budget_exceeded";
    unmatchedPage = { ...unmatched, nextPage: "budget_exceeded" };
    const page = await open();
    const statements = page.getByRole("note").filter({ hasText: "照合候補の請求はこの先にも" });
    await statements.waitFor();
    expect(await statements.innerText()).toContain(BOUND);
    expect(await statements.innerText()).toContain("続きがないという意味ではありません。");
    expect(
      await page
        .getByRole("navigation", { name: "照合候補のページ" })
        .getByRole("button", { name: "次の請求" })
        .isDisabled(),
    ).toBe(true);
    const section = page.getByRole("region", { name: "照合候補のない請求" });
    const unmatchedNote = section
      .getByRole("note")
      .filter({ hasText: "照合候補のない請求はこの先にも" });
    await unmatchedNote.waitFor();
    expect(await unmatchedNote.innerText()).toContain(BOUND);
    expect(await section.getByRole("button", { name: "次の請求" }).isDisabled()).toBe(true);
    expect(await auditView(page)).toEqual([]);
    await page.close();
  });

  test("two statements' full candidate lists are paged under their own names", async () => {
    const stale = (n: number) => ({
      ...settlementReview(),
      proposalId: `card-settlement-stale-${n}`,
      createdAt: `2026-09-0${n}T00:00:00Z`,
      acceptanceBlockers: ["statement_changed"],
    });
    older = [stale(2), stale(1)];
    // Another statement of the same card, account and month: the importer-era
    // and collector-era captures of one month are two statements
    // (docs/card-settlements.md). Every value is invented.
    const recaptured = (n: number) => ({
      ...settlementReview(),
      proposalId: `card-settlement-recaptured-${n}`,
      createdAt: `2026-09-2${n}T00:00:00Z`,
      acceptanceBlockers: n === 3 ? [] : ["statement_changed"],
    });
    second = [recaptured(3), recaptured(2), recaptured(1)];
    const page = await open();
    for (const summary of await page.locator(".settlement-older > summary").all())
      await summary.click();
    // Each click replaces its button with the list, so take the first twice.
    const show = page.getByRole("button", { name: "この請求の候補をすべて表示（3 件）" });
    await show.first().click();
    await page.locator(".settlement-older nav").first().waitFor();
    await show.first().click();
    await page.locator(".settlement-older nav").nth(1).waitFor();
    const pagers = await page
      .locator(".settlement-older nav")
      .evaluateAll((navs) => navs.map((nav) => nav.getAttribute("aria-label")));
    // Each statement's pager says which statement it pages, by its place in
    // the list where card, account and month are the same.
    expect(pagers).toEqual([
      "請求 1 件目（MyJCB · synthetic-card · 2026-09）の候補のページ",
      "請求 2 件目（MyJCB · synthetic-card · 2026-09）の候補のページ",
    ]);
    expect(await auditView(page)).toEqual([]);
    await page.close();
  }, 60_000);
});
