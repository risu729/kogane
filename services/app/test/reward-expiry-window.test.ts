// "Which reward points expire soon?" in one call (ADR 0049, amendment of
// 2026-11-19; issue 1414, gap G5): `GET /api/v2/rewards/expiry` and
// `kogane.rewards.read` with a deadline window (`from`, `before`) and
// `detail: summary`, over a reward snapshot the Processor's lane builds from
// synthetic claims. The route, the agent HTTP path and MCP answer the same
// `data` (ADR 0081). Every programme slot, amount and date is invented.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import type { RewardExpirySummary } from "../../../packages/observation-shared/src/reward-contract";
import { runRewardReadProjection } from "../../processor/src/reward-read-projection";
import { rewardExpiryFromRead, type RewardReadContext } from "../src/rewards-read";
import { HttpError } from "../src/http";
import { publishParse, seedRegistry } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT } from "./page-read-harness";
import { seedRewardCapture } from "./reward-capture-fixture";

const REWARDS = "kogane.rewards.read";
const page = pageReadHarness("reward-expiry-window");

/** Noon on 2026-11-30 in Tokyo. */
const NOON = "2026-11-30T03:00:00.000Z";
/** One millisecond before and at Tokyo midnight between 2026-11-30 and 2026-12-01. */
const BEFORE_MIDNIGHT = "2026-11-30T14:59:59.999Z";
const MIDNIGHT = "2026-11-30T15:00:00.000Z";

interface Claim {
  slot: string;
  program?: string;
  holding?: string;
  unit?: string;
  kind: string;
  amount: string | null;
  expires: string | null;
}

const V_POINT = "program:v-point";
const CLAIMS: Claim[] = [
  { slot: "vp-boundary", kind: "restricted", amount: "1000", expires: "2026-11-30" },
  { slot: "vp-yesterday", kind: "restricted", amount: "400", expires: "2026-11-29" },
  { slot: "vp-dec-01", kind: "time-limited", amount: "250", expires: "2026-12-01" },
  { slot: "vp-dec-14", kind: "restricted", amount: "600", expires: "2026-12-14" },
  { slot: "vp-dec-15", kind: "restricted", amount: "700", expires: "2026-12-15" },
  { slot: "vp-unparsed", kind: "restricted", amount: null, expires: "2026-12-20" },
  { slot: "vp-undated-1", kind: "regular", amount: "3000", expires: null },
  { slot: "vp-undated-2", kind: "unclassified", amount: "5", expires: null },
  // Enough dated rows in January that one page of 25 does not hold them.
  ...Array.from({ length: 14 }, (_, index) => ({
    slot: `vp-bulk-${String(index).padStart(2, "0")}`,
    kind: "restricted",
    amount: String(10 + index),
    expires: `2027-01-${String(index + 2).padStart(2, "0")}`,
  })),
  {
    slot: "vpp-balance",
    program: "program:v-point-pay",
    holding: "program:v-point-pay:prepaid-yen",
    unit: "JPY",
    kind: "regular",
    amount: "3000",
    expires: "2026-12-05",
  },
];

async function seedClaims() {
  const run = await seedRewardCapture();
  const parse = (await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'v-point-balance-info','1.0.0','2026-11-20','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>())!.id;
  const statements = [];
  for (const [index, claim] of CLAIMS.entries()) {
    const program = claim.program ?? V_POINT;
    const bucket = `${program}:${claim.slot}`;
    const fact = (await env.DB.prepare(
      `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json)
       VALUES(?,?,'available_point_bucket',?,0,'V_POINT','2026-11-20T00:00:00.000Z','synthetic:reward-window','{}') RETURNING id`,
    )
      .bind(parse, bucket, claim.amount ?? "unreadable")
      .first<{ id: number }>())!.id;
    statements.push(
      env.DB.prepare(
        `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
          program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
          quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
          promotion_release,recorded_at)
         VALUES(?1,?2,'balance',?3,?4,?5,?6,?7,'[]',?8,?9,?10,?11,?12,'2026-11-20T00:00:00.000Z',
           'reward-promotion-v2','2026-11-21T00:00:00.000Z')`,
      ).bind(
        `reward-window-claim-${String(index).padStart(2, "0")}`,
        parse,
        fact,
        program,
        claim.holding ?? "program:v-point:member",
        bucket,
        claim.kind,
        claim.unit ?? "points:v-point",
        claim.amount,
        claim.amount === null ? null : 0,
        claim.amount === null ? "unparsed" : "exact",
        claim.expires === null
          ? null
          : JSON.stringify({
              kind: "local-date",
              value: claim.expires,
              zone: "Asia/Tokyo",
              basis: "provider",
            }),
      ),
    );
  }
  await publishParse(parse);
  await env.DB.batch(statements);
}

/** A J-POINT total whose provider displays one expiring portion (ADR 0068). */
async function seedProviderDisplay() {
  const run = await seedRewardCapture("myjcb", ["jpoint-balance"], "synthetic-window");
  const parse = (await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'myjcb-jpoint-balance','1.0.0','2026-11-20T00:00:00.000Z','ok','[]') RETURNING id",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>())!.id;
  const metadata = {
    coverage: "observed",
    reasonCode: null,
    displays: [
      {
        displayRef: "total-expiring-subset",
        scope: "holding-subset",
        quantity: {
          unitRef: "points:j-point",
          value: {
            status: "exact",
            value: { coefficient: "200", scale: 0 },
            normalizationVersion: "decimal-v1",
          },
        },
        expires: { kind: "local-date", value: "2026-12-20", zone: "Asia/Tokyo", basis: "provider" },
        rawLocator: "json:$.expiring",
      },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json) VALUES(?,'myjcb:synthetic-window:j-point:total','displayed_jpoint_total','1000',0,'J_POINT','2026-11-20T00:00:00.000Z','json:$.total',?)",
  )
    .bind(parse, JSON.stringify({ _kogane: { rewardExpiryDisplays: metadata } }))
    .run();
  await publishParse(parse);
  const { promoteRewardClaims } = await import("../../processor/src/reward-claims-job.ts");
  expect(await promoteRewardClaims(env.DB as never)).toMatchObject({ promoted: 1 });
}

beforeAll(async () => {
  await seedRegistry();
  await seedClaims();
  await seedProviderDisplay();
  const built = await runRewardReadProjection(
    { ...env, REWARD_READ_PROJECTION_ENABLED: "true" } as never,
    env.EVIDENCE as never,
    { now: () => "2026-11-25T00:00:00.000Z" },
  );
  expect(built).toMatchObject({ status: "complete" });
});

afterEach(() => {
  vi.useRealTimers();
});

function at(instant: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

type Summary = RewardExpirySummary;
interface WindowedPage {
  rows: { bucketRef: string; ruleRef: string; expiresOn: string | null }[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  window?: Summary["window"] & {
    rows: Summary["counts"]["buckets"];
  };
}

describe("the reward expiry window and summary", () => {
  it("answers which points expire soon in one call under 8 KB, the same on every path", async () => {
    at(NOON);
    const query = "/api/v2/rewards/expiry?detail=summary&before=2026-12-15";
    const args = { collection: "expiry", detail: "summary", before: "2026-12-15" };
    const served = await page.expectSameAnswer(query, REWARDS, args);
    expect(served.status).toBe(200);
    const summary = served.body as Summary;
    expect(validApiResponse("/api/v2/rewards/expiry", summary)).toBe(true);
    expect(summary.window).toEqual({
      from: "2026-11-30",
      before: "2026-12-15",
      fromBasis: "today",
      today: "2026-11-30",
      calendar: "Asia/Tokyo",
    });
    // Each V Point bucket has a row under each of its two rules: counted once.
    expect(summary.programs).toEqual([
      {
        programId: "program:v-point",
        unitRef: "points:v-point",
        buckets: 3,
        total: { status: "exact", value: "1850" },
        lines: [
          expect.objectContaining({
            bucketRef: "program:v-point:vp-boundary",
            expiresOn: "2026-11-30",
            amount: { status: "exact", value: "1000" },
          }),
          expect.objectContaining({ bucketRef: "program:v-point:vp-dec-01" }),
          expect.objectContaining({ bucketRef: "program:v-point:vp-dec-14" }),
        ],
      },
      {
        programId: "program:v-point-pay",
        unitRef: "JPY",
        buckets: 1,
        total: { status: "exact", value: "3000" },
        lines: [expect.objectContaining({ expiresOn: "2026-12-05", basis: "provider-observed" })],
      },
    ]);
    expect(summary.counts.buckets).toEqual({
      inWindow: 4,
      beforeWindow: 1,
      // 2026-12-15 itself (exclusive), the unparsed lot and January's.
      afterWindow: 16,
      leftOut: [{ reasonCode: "deadline_unknown", count: 2 }],
    });
    // The J-POINT portion expires after the window: counted, not listed.
    expect(summary.providerDisplays).toEqual([]);
    expect(summary.counts.providerDisplays).toMatchObject({ inWindow: 0, afterWindow: 1 });

    const message = await page.mcpMessage({
      method: "tools/call",
      params: { name: REWARDS, arguments: args },
    });
    const result = message["result"] as {
      content: { type: string; text: string }[];
      structuredContent: unknown;
    };
    for (const part of [
      JSON.stringify(result.structuredContent),
      ...result.content.map((entry) => entry.text),
    ])
      expect(new TextEncoder().encode(part).length).toBeLessThan(8192);
  });

  it("does not add an amount that is not exact, and lists provider portions apart", async () => {
    at(NOON);
    const served = await page.expectSameAnswer(
      "/api/v2/rewards/expiry?detail=summary&before=2027-01-01",
      REWARDS,
      { collection: "expiry", detail: "summary", before: "2027-01-01" },
    );
    const summary = served.body as Summary;
    const vPoint = summary.programs.find((program) => program.programId === V_POINT)!;
    expect(vPoint.buckets).toBe(5);
    expect(vPoint.total).toEqual({
      status: "not-exact",
      value: null,
      reasonCodes: ["unparsed:decimal-v1:unparsed"],
    });
    expect(vPoint.lines.find((line) => line.bucketRef.endsWith("vp-unparsed"))?.amount).toEqual({
      status: "unparsed",
      value: null,
      reasonCode: "decimal-v1:unparsed",
    });
    expect(summary.providerDisplays).toEqual([
      {
        programId: "program:j-point",
        holdingRef: "program:j-point:myjcb:synthetic-window:j-point:total",
        parentBucketRef: "program:j-point:myjcb:synthetic-window:j-point:total",
        displayRef: "total-expiring-subset",
        unitRef: "points:j-point",
        expiresOn: "2026-12-20",
        amount: { status: "exact", value: "200" },
      },
    ]);
    // A portion is never a programme total.
    expect(summary.programs.map((program) => program.programId)).not.toContain("program:j-point");
  });

  it("moves today's default `from` at Tokyo midnight, not UTC midnight", async () => {
    const lines = async () =>
      (
        (await page.route("/api/v2/rewards/expiry?detail=summary&before=2026-12-15"))
          .body as Summary
      ).programs.flatMap((program) => program.lines.map((line) => line.bucketRef));
    at(BEFORE_MIDNIGHT);
    expect(await lines()).toContain("program:v-point:vp-boundary");
    at(MIDNIGHT);
    expect(await lines()).not.toContain("program:v-point:vp-boundary");
    const after = (await page.route("/api/v2/rewards/expiry?detail=summary&before=2026-12-15"))
      .body as Summary;
    expect(after.window).toMatchObject({ from: "2026-12-01", today: "2026-12-01" });
    expect(after.counts.buckets.beforeWindow).toBe(2);
  });

  it("pages a window's rows with a cursor bound to that window", async () => {
    at(NOON);
    const base = "/api/v2/rewards/expiry?from=2027-01-01&before=2027-02-01";
    const first = (await page.route(`${base}&limit=25`)).body as WindowedPage;
    expect(validApiResponse("/api/v2/rewards/expiry", first)).toBe(true);
    // 14 January buckets, each under V Point's two rules.
    expect(first.window).toEqual({
      from: "2027-01-01",
      before: "2027-02-01",
      fromBasis: "request",
      today: "2026-11-30",
      calendar: "Asia/Tokyo",
      rows: {
        inWindow: 28,
        beforeWindow: 13,
        afterWindow: 0,
        leftOut: [{ reasonCode: "deadline_unknown", count: 4 }],
      },
    });
    expect(first.rows).toHaveLength(25);
    expect(first.page.hasMore).toBe(true);
    for (const row of first.rows) expect(row.expiresOn?.startsWith("2027-01-")).toBe(true);
    const cursor = encodeURIComponent(first.page.nextCursor!);

    const second = await page.expectSameAnswer(`${base}&limit=25&cursor=${cursor}`, REWARDS, {
      collection: "expiry",
      from: "2027-01-01",
      before: "2027-02-01",
      limit: 25,
      cursor: first.page.nextCursor,
    });
    expect(second.status).toBe(200);
    const rest = second.body as WindowedPage;
    expect(rest.rows).toHaveLength(3);
    expect(rest.page.hasMore).toBe(false);
    const key = (row: WindowedPage["rows"][number]) => `${row.ruleRef}|${row.bucketRef}`;
    const whole = (await page.route(`${base}&limit=200`)).body as WindowedPage;
    expect([...first.rows, ...rest.rows].map(key)).toEqual(whole.rows.map(key));

    // Another offered page size continues the same window (ADR 0119).
    const wider = await page.route(`${base}&limit=50&cursor=${cursor}`);
    expect(wider.status).toBe(200);
    expect((wider.body as WindowedPage).rows.map(key)).toEqual(rest.rows.map(key));

    // Another window, no window, or a cursor of an unwindowed read: another query.
    for (const query of [
      `/api/v2/rewards/expiry?from=2027-01-01&before=2027-01-31&limit=25&cursor=${cursor}`,
      `/api/v2/rewards/expiry?from=2027-01-02&before=2027-02-01&limit=25&cursor=${cursor}`,
      `/api/v2/rewards/expiry?before=2027-02-01&limit=25&cursor=${cursor}`,
      `/api/v2/rewards/expiry?limit=25&cursor=${cursor}`,
    ]) {
      const refused = await page.route(query);
      expect(refused.status, query).toBe(400);
      expect(refused.body, query).toMatchObject({ error: "cursor_mismatch" });
    }
    const plain = (await page.route("/api/v2/rewards/expiry?limit=25")).body as WindowedPage;
    expect(plain.page.hasMore).toBe(true);
    const crossed = await page.expectSameAnswer(
      `${base}&limit=25&cursor=${encodeURIComponent(plain.page.nextCursor!)}`,
      REWARDS,
      {
        collection: "expiry",
        from: "2027-01-01",
        before: "2027-02-01",
        limit: 25,
        cursor: plain.page.nextCursor,
      },
    );
    expect(crossed.status).toBe(400);
    expect(crossed.body).toMatchObject({ error: "cursor_mismatch" });
  });

  it("keeps the unwindowed page as it was, with or without `detail: full`", async () => {
    at(NOON);
    const plain = await page.route("/api/v2/rewards/expiry?limit=50");
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty("window");
    expect(plain.body).not.toHaveProperty("detail");
    expect((await page.route("/api/v2/rewards/expiry?limit=50&detail=full")).body).toEqual(
      plain.body,
    );
    // The page keeps every row, dated or not.
    expect((plain.body as WindowedPage).rows.some((row) => row.expiresOn === null)).toBe(true);
  });

  it("refuses a malformed date, an empty window and a paged summary, as the tool does", async () => {
    at(NOON);
    for (const [query, args, code] of [
      [
        "/api/v2/rewards/expiry?before=2026-02-30",
        { collection: "expiry", before: "2026-02-30" },
        "invalid_date",
      ],
      [
        "/api/v2/rewards/expiry?from=2026-12-1",
        { collection: "expiry", from: "2026-12-1" },
        "invalid_date",
      ],
      [
        "/api/v2/rewards/expiry?from=2026-12-15&before=2026-12-15",
        { collection: "expiry", from: "2026-12-15", before: "2026-12-15" },
        "invalid_date_range",
      ],
      // `from` defaults to today (2026-11-30).
      [
        "/api/v2/rewards/expiry?detail=summary&before=2026-11-30",
        { collection: "expiry", detail: "summary", before: "2026-11-30" },
        "invalid_date_range",
      ],
      [
        "/api/v2/rewards/expiry?detail=summary&limit=25",
        { collection: "expiry", detail: "summary", limit: 25 },
        "invalid_query",
      ],
      [
        "/api/v2/rewards/expiry?detail=summary&cursor=c",
        { collection: "expiry", detail: "summary", cursor: "c" },
        "invalid_query",
      ],
      [
        "/api/v2/rewards/holdings?before=2026-12-15",
        { collection: "holdings", before: "2026-12-15" },
        "invalid_query",
      ],
    ] as const) {
      const refused = await page.expectSameAnswer(query, REWARDS, args);
      expect(refused.status, query).toBe(400);
      expect(refused.body, query).toMatchObject({ error: code });
    }
    // Another `detail` is the route's `invalid_query` and outside the tool's closed schema.
    expect((await page.route("/api/v2/rewards/expiry?detail=compact")).body).toMatchObject({
      error: "invalid_query",
    });
    expect(
      (await page.http(REWARDS, { collection: "expiry", detail: "compact" })).body,
    ).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a grant narrower than the whole store, never serving a filtered summary", async () => {
    at(NOON);
    for (const scopes of [
      { sources: ["v-point"], accounts: "*" },
      { sources: "*", accounts: ["program:v-point:member"] },
    ]) {
      const answer = await page.direct(
        REWARDS,
        { collection: "expiry", detail: "summary", before: "2026-12-15" },
        { ...RECORDS_GRANT, scopes },
      );
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: "evidence_restricted" });
      expect(JSON.stringify(answer.body)).not.toContain("program:v-point:vp-");
    }
  });

  it("refuses a snapshot over the row bound rather than summing part of it", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ row_seq: index }));
    const read = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: rows }) }),
      }),
    };
    const context = {
      read,
      readInstanceId: "synthetic",
      snapshot: { snapshot_id: "synthetic" },
      revision: { coreEpoch: "e", visibilityRevision: 0 },
    } as unknown as RewardReadContext;
    for (const query of ["detail=summary", "before=2999-01-01"]) {
      const refused = await rewardExpiryFromRead(
        context,
        new URL(`https://fixture.test/api/v2/rewards/expiry?${query}`),
        undefined,
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(HttpError);
      expect(refused).toMatchObject({ status: 413, code: "result_limit_exceeded" });
    }
  });
});
