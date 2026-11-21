// `kogane.financial.query` under the one paging contract (ADR 0128 slice S7):
// a row intent's answer (`activity`, `reported-state`) carries `next` and
// `paging` beside `result`, saying what `result.nextCursor` says; `coverage`
// and `holdings` answer whole and carry neither. The walk follows only
// `next.arguments` over `/mcp`; the route (`GET /api/v2/query`), the agent
// HTTP path and `/mcp` give one answer; and, with the two fields stripped,
// every answer is byte for byte the answer of the function as it shipped
// before S7 (`query-response-frozen.ts`). `financial-error-v1` is untouched:
// whether it gains the paging refusals in place or moves to a v2 is the
// owner's open decision. Every row is invented.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { walkPages } from "../../../packages/observation-shared/test-support/paging-walk";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { parseQueryRequest, type Grant } from "../../../packages/application/src/index";
import { queryResponse, toolContext } from "../src/agent-service";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";
import { frozenQueryResponse } from "./query-response-frozen";

const page = pageReadHarness("paging-conformance-query");

/** Transactions of two sources: three pages of ten and a short one. */
const TRANSACTIONS = 33;
/** Latest balances, each of its own account: one page of ten and a short one. */
const BALANCES = 12;
const transactionRefs: string[] = [];
const balanceRefs: string[] = [];
const NOW = "2026-09-09T00:00:00Z";

const WHOLE_STORE: Grant = {
  principal: "mcp-client:synthetic-agent",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

async function parseOf(source: string): Promise<number> {
  const run = await seedRun({ source, count: 1 });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'query-walk','1','2026-09-07','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  return parse!.id;
}

beforeAll(async () => {
  await seedRegistry();
  const statements: D1PreparedStatement[] = [];
  for (const [source, from, to] of [
    ["sony-bank", 0, 20],
    ["other-test", 20, TRANSACTIONS],
  ] as const) {
    const parse = await parseOf(source);
    for (let n = from; n < to; n++)
      statements.push(
        env.DB.prepare(
          `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
           VALUES(?,?,?,?,?,'JPY','synthetic','{}','synthetic line')`,
        ).bind(
          parse,
          `walk-account-${source}`,
          `walk-${String(n).padStart(3, "0")}`,
          `2026-08-${String(1 + (n % 28)).padStart(2, "0")}`,
          100 + n,
        ),
      );
  }
  const balances = await parseOf("sony-bank");
  for (let n = 0; n < BALANCES; n++)
    statements.push(
      env.DB.prepare(
        `INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
         VALUES(?,?,'balance','JPY',?,'2026-08-31','synthetic','{}')`,
      ).bind(balances, `walk-balance-${String(n).padStart(2, "0")}`, 1000 + n),
    );
  await env.DB.batch(statements);
  const ids = await env.DB.prepare("SELECT id FROM transaction_observations ORDER BY id").all<{
    id: number;
  }>();
  for (const row of ids.results) transactionRefs.push(`observation:transaction:${String(row.id)}`);
  const balanceIds = await env.DB.prepare("SELECT id FROM balance_observations ORDER BY id").all<{
    id: number;
  }>();
  for (const row of balanceIds.results) balanceRefs.push(`observation:balance:${String(row.id)}`);
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

/** `/mcp`'s answer, failing on any refusal. */
async function overMcp(args: Record<string, unknown>) {
  const answer = await page.mcp("kogane.financial.query", args);
  expect({ args, isError: answer.isError }).toEqual({ args, isError: false });
  return answer.body as Record<string, any>;
}

const rowsOf = (answer: Record<string, any>) =>
  answer["result"].data.rows as { observationRef: string }[];

describe("kogane.financial.query, walked by next.arguments alone", () => {
  it("activity: every transaction once, three full pages and a short last one", async () => {
    const walk = await walkPages({
      first: { intent: "activity", limit: 10 },
      call: async (args) => {
        const body = await overMcp(args);
        expect(validApiResponse("/api/v2/query", body)).toBe(true);
        // The same cursor as the result's own field, beside `result`.
        expect(Object.keys(body).slice(-2)).toEqual(["next", "paging"]);
        expect(body["next"]).toEqual(
          body["result"].nextCursor === null
            ? null
            : { arguments: { cursor: body["result"].nextCursor } },
        );
        return body;
      },
      items: rowsOf,
      id: (row) => row.observationRef,
    });
    expect(walk.calls).toHaveLength(4);
    expect(walk.calls.slice(1).every((call) => typeof call["cursor"] === "string")).toBe(true);
    expect(walk.calls.every((call) => call["intent"] === "activity" && call["limit"] === 10)).toBe(
      true,
    );
    expect(walk.withheld).toBe(false);
    expect(walk.items.map((row) => row.observationRef).sort()).toEqual([...transactionRefs].sort());
  });

  it("activity of one source: the filter repeats as it was, only the cursor changes", async () => {
    const walk = await walkPages({
      first: { intent: "activity", limit: 7, filters: { source: "sony-bank" } },
      call: overMcp,
      items: rowsOf,
      id: (row) => row.observationRef,
    });
    expect(walk.calls).toHaveLength(3);
    expect(
      walk.calls.every((call) => JSON.stringify(call["filters"]) === '{"source":"sony-bank"}'),
    ).toBe(true);
    expect(walk.items).toHaveLength(20);
  });

  it("reported-state: every latest balance once", async () => {
    const walk = await walkPages({
      first: { intent: "reported-state", limit: 10 },
      call: async (args) => {
        const body = await overMcp(args);
        expect(validApiResponse("/api/v2/query", body)).toBe(true);
        return body;
      },
      items: rowsOf,
      id: (row) => row.observationRef,
    });
    expect(walk.calls).toHaveLength(2);
    expect(walk.items.map((row) => row.observationRef).sort()).toEqual([...balanceRefs].sort());
  });

  it("a page of exactly the rows left is the last one", async () => {
    const body = await overMcp({ intent: "reported-state", limit: BALANCES });
    expect(body["next"]).toBeNull();
    expect(body["paging"]).toEqual({
      limit: BALANCES,
      returned: BALANCES,
      hasMore: false,
      stoppedBy: null,
    });
    expect(body["result"].nextCursor).toBeNull();
  });

  it("coverage and holdings answer whole and carry neither field", async () => {
    for (const intent of ["coverage", "holdings"]) {
      const body = await overMcp({ intent });
      expect(validApiResponse("/api/v2/query", body)).toBe(true);
      expect(Object.hasOwn(body, "next"), intent).toBe(false);
      expect(Object.hasOwn(body, "paging"), intent).toBe(false);
    }
  });

  it("the route, the agent HTTP path and /mcp give one answer, page for page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const first = await page.route("/api/v2/query?intent=activity&limit=10");
    expect(first.status).toBe(200);
    const routeBody = first.body as Record<string, any>;
    const cursor = routeBody["next"].arguments.cursor as string;
    const second = await page.route(
      `/api/v2/query?intent=activity&limit=10&cursor=${encodeURIComponent(cursor)}`,
    );
    for (const [args, answer] of [
      [{ intent: "activity", limit: 10 }, routeBody],
      [{ intent: "activity", limit: 10, cursor }, second.body as Record<string, any>],
    ] as const) {
      expect(validApiResponse("/api/v2/query", answer)).toBe(true);
      const overHttp = await page.http("kogane.financial.query", args);
      expect(overHttp.status).toBe(200);
      const viaMcp = await overMcp(args);
      for (const other of [overHttp.body, viaMcp]) {
        expect(other["next"]).toEqual(answer["next"]);
        expect(other["paging"]).toEqual(answer["paging"]);
        expect(other["result"].data).toEqual(answer["result"].data);
        expect(other["result"].nextCursor).toBe(answer["result"].nextCursor);
      }
    }
  });

  it("a continued call past the grant's maxRows is still refused 413 budget_exceeded (S7 open decision)", async () => {
    // financial.query does not withhold by budget: it offers the cursor, and
    // the continued call with the same limit is refused in financial-error-v1.
    // Whether it says `stoppedBy: "budget"` and how the refusal reads are the
    // owner's open S7 decision; until then `next` says exactly what
    // `nextCursor` says.
    const tight = { ...WHOLE_STORE, budget: { ...WHOLE_STORE.budget, maxRows: 25 } };
    const one = await page.direct(
      "kogane.financial.query",
      { intent: "activity", limit: 10 },
      tight,
    );
    const two = await page.direct(
      "kogane.financial.query",
      { intent: "activity", limit: 10, ...one.body.next.arguments },
      tight,
    );
    expect(two.body.paging).toEqual({ limit: 10, returned: 10, hasMore: true, stoppedBy: "limit" });
    const three = await page.direct(
      "kogane.financial.query",
      { intent: "activity", limit: 10, ...two.body.next.arguments },
      tight,
    );
    expect(three.status).toBe(413);
    expect(three.body).toMatchObject({
      schemaVersion: "financial-error-v1",
      code: "budget_exceeded",
      refs: ["budget:maxRows=25"],
    });
  });

  it("a refused cursor keeps its financial-error-v1 code and status until the owner decides", async () => {
    const first = await overMcp({ intent: "activity", limit: 1 });
    const answer = await page.direct(
      "kogane.financial.query",
      { intent: "reported-state", limit: 1, cursor: first["next"].arguments.cursor },
      WHOLE_STORE,
    );
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      schemaVersion: "financial-error-v1",
      code: "stale_context",
    });
  });
});

describe("the answer beside next and paging is the one shipped before S7", () => {
  /** One request through the shipped and the frozen function, on one context and clock. */
  async function both(body: Record<string, unknown>, grant: Grant = WHOLE_STORE) {
    const parsed = parseQueryRequest(body);
    if (!parsed.ok) throw new Error(`invalid request ${JSON.stringify(body)}`);
    const context = toolContext(env as unknown as Env, grant, NOW);
    const shipped = await queryResponse(context, parsed.value);
    const frozen = await frozenQueryResponse(context, parsed.value);
    return { shipped, frozen };
  }

  /** The shipped body without `next` and `paging`, after checking they agree with `nextCursor`. */
  function stripped(label: string, status: number, body: unknown): string {
    const answer = body as Record<string, any>;
    if (status !== 200) return JSON.stringify(answer);
    expect({ label, valid: validApiResponse("/api/v2/query", answer) }).toEqual({
      label,
      valid: true,
    });
    if (!Object.hasOwn(answer, "paging")) return JSON.stringify(answer);
    expect(Object.keys(answer).slice(-2), label).toEqual(["next", "paging"]);
    const { next: _next, paging: _paging, ...rest } = answer;
    return JSON.stringify(rest);
  }

  it("is byte-identical on every intent, limit, filter, page and refusal", async () => {
    // A seeded sequence of limits, so the matrix reaches odd page edges too.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const limits = [
      1,
      7,
      10,
      12,
      33,
      34,
      100,
      ...Array.from({ length: 6 }, () => 1 + Math.floor(random() * 40)),
    ];
    const requests: Record<string, unknown>[] = [{ intent: "coverage" }, { intent: "holdings" }];
    for (const limit of limits)
      for (const filters of [{}, { source: "sony-bank" }, { source: "other-test" }])
        for (const intent of ["activity", "reported-state"])
          requests.push({ intent, limit, filters });
    let compared = 0;
    for (const first of requests) {
      // Every page of the walk, each compared before it is followed.
      let request: Record<string, unknown> | null = first;
      while (request !== null) {
        const { shipped, frozen } = await both(request);
        const label = JSON.stringify(request);
        expect(shipped.status, label).toBe(frozen.status);
        expect(stripped(label, shipped.status, shipped.body), label).toBe(
          JSON.stringify(frozen.body),
        );
        compared += 1;
        const next = (shipped.body as { next?: { arguments: Record<string, unknown> } | null })
          .next;
        request = next ? { ...request, ...next.arguments } : null;
      }
    }
    // Refusals: a foreign cursor, an invented one and a page past the budget.
    const foreign = (await both({ intent: "activity", limit: 1 })).shipped.body as Record<
      string,
      any
    >;
    const tight = { ...WHOLE_STORE, budget: { ...WHOLE_STORE.budget, maxRows: 25 } };
    for (const [request, grant] of [
      [
        { intent: "reported-state", limit: 1, cursor: foreign["next"].arguments.cursor },
        WHOLE_STORE,
      ],
      [{ intent: "activity", cursor: "not-a-cursor" }, WHOLE_STORE],
      [{ intent: "activity", limit: 30 }, tight],
    ] as const) {
      const { shipped, frozen } = await both(request, grant);
      expect(shipped.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(shipped.body)).toBe(JSON.stringify(frozen.body));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(100);
  });
});
