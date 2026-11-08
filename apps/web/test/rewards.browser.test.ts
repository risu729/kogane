// ポイント・前払式残高 in the production client, against a server that answers
// the reward routes with synthetic pages in the shapes the shared response
// check accepts. What is proved here: a connection without the reward routes
// is told so instead of loading forever; a page at the server's bound states
// that bound and offers no link that would reopen the same first page; and
// every panel is told apart from the others by its name. Every value is
// synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  CENTRAL_STORE_CAPABILITIES,
  withRewardsV2,
} from "../../../packages/observation-shared/src/api-schema.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import type {
  RewardExpiryRow,
  RewardHoldingRow,
  RewardPage,
  RewardReadExpiryPage,
  RewardReadExpiryRow,
} from "../../../packages/observation-shared/src/reward-contract.ts";
import { auditView } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const quantity = {
  unitRef: "points:synthetic",
  value: {
    status: "exact" as const,
    value: { coefficient: "100", scale: 0 },
    normalizationVersion: "decimal-v1" as const,
  },
};
const holding = (id: string): RewardHoldingRow => ({
  programId: `program:${id}`,
  programRef: `Synthetic ${id}`,
  institutionRef: "institution:synthetic",
  sourceId: "synthetic-source",
  holdingRef: `holding:${id}`,
  holdingKind: "reward-points",
  unitRef: "points:synthetic",
  termsEvidenceRefs: [],
  consumable: quantity,
  byKind: [],
  excluded: [],
  buckets: [],
  qualificationMeasures: [],
  membership: [],
  valueModel: { netAssetEligible: false, cashLikeRedemptionEstimate: null, reasonCode: "none" },
});
/** One rule over two holdings: the rule alone does not tell the panels apart. */
const legacyExpiry = (id: string): RewardExpiryRow => ({
  holdingRef: `holding:${id}`,
  programId: `program:${id}`,
  ruleRef: "rule:synthetic@v1",
  family: "inactivity",
  verification: "verified",
  state: "partial",
  uncertaintyCodes: [],
  deadlineZone: "Asia/Tokyo",
  deadlineZoneBasis: "assumed",
  rows: [],
  sourceExpiryRefs: [],
});
/** Two time-limited buckets of one programme: the kind alone does not tell them apart. */
const readExpiry = (bucketRef: string, expiresOn: string): RewardReadExpiryRow => ({
  holdingRef: "holding:a",
  programId: "program:a",
  bucketRef,
  bucketKind: "time-limited",
  ruleRef: "rule:synthetic@v1",
  state: "computed",
  basis: "provider-observed",
  expiresOn,
  quantity,
  providerObserved: { kind: "local-date", value: expiresOn, zone: "Asia/Tokyo", basis: "provider" },
  policyEstimated: null,
  reasonCodes: [],
  uncertaintyCodes: [],
  basisRefs: [],
});
const readPage: RewardReadExpiryPage = {
  rows: [readExpiry("bucket:first", "2026-12-31"), readExpiry("bucket:second", "2027-03-31")],
  page: { limit: 50, hasMore: false, nextCursor: null },
  snapshot: {
    snapshotId: "a".repeat(64),
    evaluatedAt: "2026-09-12T00:00:00.000Z",
    evaluationCalendar: "Asia/Tokyo",
    ruleSetDigest: "b".repeat(64),
    ruleCount: 1,
    claimsRelease: "reward-promotion-v1",
    claimsHighWater: 2,
    release: "reward-policy-v1",
  },
};
const page = <T>(rows: T[], truncated = false): RewardPage<T> => ({
  rows,
  coverage: { limit: 200, truncated, nextOffset: truncated ? 200 : null },
});

describe.if(runnable)("the rewards page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let holdings: RewardPage<RewardHoldingRow> = page([]);
  let expiry: RewardPage<RewardExpiryRow> | RewardReadExpiryPage = page([]);
  const reads: string[] = [];

  beforeEach(() => {
    advertised = true;
    reads.length = 0;
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
            capabilities: withRewardsV2(CENTRAL_STORE_CAPABILITIES, advertised),
          });
        if (url.pathname.startsWith("/api/v2/rewards/")) {
          reads.push(url.pathname + url.search);
          if (!advertised) return Response.json({ error: "not_found" }, { status: 404 });
          if (url.pathname === "/api/v2/rewards/holdings") return Response.json(holdings);
          if (url.pathname === "/api/v2/rewards/expiry") return Response.json(expiry);
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
  });

  test("a connection without the reward routes says so and asks for nothing", async () => {
    advertised = false;
    const tab = await browser.newPage();
    try {
      await tab.goto(`${origin}/rewards`);
      await tab
        .getByText("この接続先はポイント・前払式残高を提供していません。")
        .waitFor({ timeout: 10_000 });
      // Nothing is requested, so nothing may claim to be loading.
      expect(await tab.getByRole("status").filter({ hasText: "読み込んでいます" }).count()).toBe(0);
      expect(reads).toEqual([]);
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("a page at the server's bound states the bound and offers no link back to itself", async () => {
    holdings = page([holding("a")], true);
    expiry = page([]);
    expect(validApiResponse("/api/v2/rewards/holdings", holdings)).toBe(true);
    const tab = await browser.newPage();
    try {
      await tab.goto(`${origin}/rewards`);
      await tab.getByText("表示は先頭 200 件です。残りは取得していません。").waitFor();
      // The page reads only the first page; a "next 500" link would reopen it.
      expect(await tab.getByRole("link", { name: /次の500件/u }).count()).toBe(0);
      expect(await tab.getByText("最大500件").count()).toBe(0);
      expect(reads.filter((read) => read.startsWith("/api/v2/rewards/holdings"))).toEqual([
        "/api/v2/rewards/holdings?offset=0",
      ]);
    } finally {
      await tab.close();
    }
  }, 30_000);

  for (const [name, response] of [
    ["published snapshot", readPage],
    ["rule over two holdings", page([legacyExpiry("a"), legacyExpiry("b")])],
  ] as const)
    test(`expiry panels are told apart by name (${name})`, async () => {
      holdings = page([holding("a"), holding("b")]);
      expiry = response;
      expect(validApiResponse("/api/v2/rewards/expiry", expiry)).toBe(true);
      const tab = await browser.newPage();
      try {
        await tab.goto(`${origin}/rewards`);
        await tab.getByText("期限が確認できない残高も一覧から外さず").waitFor();
        expect(await auditView(tab)).toEqual([]);
      } finally {
        await tab.close();
      }
    }, 60_000);
});
