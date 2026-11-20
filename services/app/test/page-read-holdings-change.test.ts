// `kogane.reported-holdings-change.read` and its route on a store where many
// holdings change (ADR 0075, amendment 2026-11-19): the summary of changed
// lines is the default on both, each page fits what an MCP client shows, the
// pages join into every listed line once, a cursor is refused with the
// route's codes, and `full` is still the route's whole comparison. Every code
// and quantity is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const CHANGE = "kogane.reported-holdings-change.read";
const PATH = "/api/v2/reported-holdings-change";
const RANGE = "from=2026-09-03&to=2026-09-09";
const ARGS = { from: "2026-09-03", to: "2026-09-09" } as const;
const page = pageReadHarness("holdings-change-read");

/** What an MCP client shows of a tool result. */
const MCP_SHOWN = 8192;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One capture of the domestic positions container, recorded at `at`. */
async function capture(at: string, positions: [code: string, quantity: string][]) {
  vi.setSystemTime(new Date(at));
  const run = await seedRun({
    source: "sbi-securities",
    count: 1,
    dataset: "domestic-cash-positions",
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sbi-domestic-cash-positions','1','2026-09-01T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch(
    positions.map(([code, quantity], index) =>
      env.DB.prepare(
        `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,'sbi-securities:domestic:deposit-type=1',?,NULL,'XTKS',?,?,'JPY',NULL,NULL,?,'{}')`,
      ).bind(
        parse!.id,
        code,
        quantity,
        quantity.includes(".") ? quantity.split(".")[1]!.length : 0,
        `$.positions[${index}]`,
      ),
    ),
  );
}

/** 70 grown, 5 unchanged, 3 removed, 2 added holdings. */
const codes = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => String(from + index));
const GROWN = codes(2000, 70);
const UNCHANGED = codes(3000, 5);
const REMOVED = codes(4000, 3);
const ADDED = codes(5000, 2);

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','sbi-securities')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','sbi-securities')",
    ),
  ]);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await capture("2026-09-03T03:00:00.000Z", [
      ...GROWN.map((code) => [code, "100"] as [string, string]),
      ...UNCHANGED.map((code) => [code, "50"] as [string, string]),
      ...REMOVED.map((code) => [code, "10"] as [string, string]),
    ]);
    await capture("2026-09-09T03:00:00.000Z", [
      ...GROWN.map((code, index) => [code, `${100 + index}.125`] as [string, string]),
      ...UNCHANGED.map((code) => [code, "50"] as [string, string]),
      ...ADDED.map((code) => [code, "1"] as [string, string]),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

describe("the holdings change summary over the route and MCP", () => {
  it("answers the same summary, full answer and continuation on the route and both agent paths", async () => {
    const before = await tableCounts();
    const first = await page.expectSameAnswer(`${PATH}?${RANGE}`, CHANGE, ARGS);
    expect(first.status).toBe(200);
    expect(validApiResponse(PATH, first.body)).toBe(true);
    const summary = first.body as Record<string, any>;
    expect(summary).toMatchObject({
      detail: "summary",
      unchanged: 5,
      counts: { compared: 75, listed_at_start_only: 3, listed_at_end_only: 2, not_comparable: 0 },
      page: { offset: 0, limit: 10, listed: 75, hasMore: true },
    });
    const cursor = summary.page.nextCursor as string;
    for (const [query, args] of [
      [`${PATH}?${RANGE}&detail=summary`, { ...ARGS, detail: "summary" }],
      [`${PATH}?${RANGE}&limit=25`, { ...ARGS, limit: 25 }],
      [`${PATH}?${RANGE}&cursor=${cursor}&limit=50`, { ...ARGS, cursor, limit: 50 }],
      [`${PATH}?${RANGE}&detail=full`, { ...ARGS, detail: "full" }],
    ] as const) {
      const served = await page.expectSameAnswer(query, CHANGE, args);
      expect(served.status, query).toBe(200);
      expect(validApiResponse(PATH, served.body), query).toBe(true);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("fits a default page in what an MCP client shows, and its pages join into every changed line", async () => {
    const first = await page.mcp(CHANGE, ARGS);
    expect(first.isError).toBe(false);
    const full = await page.mcp(CHANGE, { ...ARGS, detail: "full" });
    const sizes: number[] = [];
    const lines: [string, string, string | null][] = [];
    let cursor: string | null = null;
    let answer = first;
    for (;;) {
      expect(answer.isError).toBe(false);
      sizes.push(bytes(answer.body));
      for (const item of answer.body.data.items)
        lines.push([item.securityCode, item.status, item.change]);
      cursor = answer.body.data.page.nextCursor;
      if (cursor === null) break;
      answer = await page.mcp(CHANGE, { ...ARGS, cursor });
    }
    console.info(
      `holdings change on the route's store, 80 holdings: full ${bytes(full.body)} B; summary ${sizes.length} pages, ${Math.min(...sizes)}–${Math.max(...sizes)} B`,
    );
    expect(Math.max(...sizes)).toBeLessThan(MCP_SHOWN);
    expect(bytes(full.body)).toBeGreaterThan(10 * MCP_SHOWN);
    expect(sizes).toHaveLength(8);
    // Every changed line once, changes first; unchanged holdings are counted only.
    expect(lines).toEqual([
      ...GROWN.map((code, index) => [code, "compared", `${index}.125`]),
      ...REMOVED.map((code) => [code, "listed_at_start_only", null]),
      ...ADDED.map((code) => [code, "listed_at_end_only", null]),
    ]);
    // Each line names the position that reads it in full.
    const item = first.body.data.items[0];
    const position = await page.mcp("kogane.observations.get", {
      kind: "position",
      id: Number(item.end.positionRef.slice("position:".length)),
    });
    expect(position.isError).toBe(false);
    expect(JSON.stringify(position.body.data)).toContain(item.securityCode);
  });

  it("refuses a cursor of another request on the route and the tool with the same codes", async () => {
    const first = await page.mcp(CHANGE, ARGS);
    const cursor = first.body.data.page.nextCursor as string;
    for (const [query, args, status, code] of [
      [
        `${PATH}?${RANGE}&source=sbi-securities&cursor=${cursor}`,
        { ...ARGS, source: "sbi-securities", cursor },
        400,
        "cursor_mismatch",
      ],
      [
        `${PATH}?from=2026-09-04&to=2026-09-09&cursor=${cursor}`,
        { ...ARGS, from: "2026-09-04", cursor },
        400,
        "cursor_mismatch",
      ],
      [`${PATH}?${RANGE}&cursor=abc`, { ...ARGS, cursor: "abc" }, 400, "invalid_cursor"],
      [
        `${PATH}?${RANGE}&detail=full&cursor=${cursor}`,
        { ...ARGS, detail: "full", cursor },
        400,
        "invalid_query",
      ],
      [`${PATH}?${RANGE}&limit=20`, { ...ARGS, limit: 20 }, 400, "invalid_query"],
    ] as const) {
      const refused = await page.expectSameAnswer(query, CHANGE, args);
      expect(refused.status, query).toBe(status);
      expect((refused.body as { error: string }).error, query).toBe(code);
      // A cursor of other dates or filters names what must repeat (ADR 0123).
      if (code === "cursor_mismatch")
        expect((refused.body as { mustMatch?: string[] }).mustMatch, query).toEqual([
          "from",
          "to",
          "source",
          "account",
        ]);
    }
    // A detail outside the closed schema is the tool's own refusal.
    const bad = await page.http(CHANGE, { ...ARGS, detail: "compact" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a grant without records.read or narrower than the whole store, whatever the detail", async () => {
    for (const args of [
      { ...ARGS, detail: "summary" },
      { ...ARGS, detail: "full" },
    ])
      for (const [grant, code] of [
        [{ ...RECORDS_GRANT, capabilities: ["summary.read"] }, "unauthorized"],
        [
          { ...RECORDS_GRANT, scopes: { sources: ["sbi-securities"], accounts: "*" } },
          "evidence_restricted",
        ],
        [
          { ...RECORDS_GRANT, scopes: { sources: "*", accounts: ["acct-synthetic"] } },
          "evidence_restricted",
        ],
      ] as const) {
        const answer = await page.direct(CHANGE, args, grant);
        expect(answer.status).toBe(403);
        expect(answer.body).toMatchObject({ code });
      }
  });

  it("records each call with the page's line count, truncated while lines follow", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    expect((await page.http(CHANGE, ARGS)).status).toBe(200);
    expect((await page.http(CHANGE, { ...ARGS, limit: 100 })).status).toBe(200);
    const rows = (
      await env.DB.prepare(
        "SELECT operation,risk_class,result,diff_json FROM audit_records WHERE rowid>? AND operation='reported-holdings-change.read' ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(rows).toEqual([
      {
        operation: "reported-holdings-change.read",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 10, truncated: true }),
      },
      {
        operation: "reported-holdings-change.read",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 75, truncated: false }),
      },
    ]);
  });

  // Last: it records a third capture, which moves the comparison.
  it("expires a cursor once the comparison's inputs move, on the route and the tool", async () => {
    const first = await page.mcp(CHANGE, ARGS);
    const cursor = first.body.data.page.nextCursor as string;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await capture("2026-09-09T05:00:00.000Z", [["2000", "1"]]);
    } finally {
      vi.useRealTimers();
    }
    const expired = await page.expectSameAnswer(`${PATH}?${RANGE}&cursor=${cursor}`, CHANGE, {
      ...ARGS,
      cursor,
    });
    expect(expired.status).toBe(410);
    expect((expired.body as { error: string }).error).toBe("context_expired");
    const now = await page.mcp(CHANGE, ARGS);
    expect(now.body.data.contextId).not.toBe(first.body.data.contextId);
  });
});
