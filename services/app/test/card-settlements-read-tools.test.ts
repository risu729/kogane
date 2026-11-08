// `kogane.card-settlements.read`, `kogane.card-settlements.statements` and
// `kogane.card-settlements.ownership` (ADR 0081): the カード照合 page's reads
// for an agent, over MCP and the agent HTTP route. Native Worker/D1 and signed Access fixtures only; no production data.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture";
import { seedRegistry, seedRun, publishParse } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import { readMcpTools } from "../src/read-tools";
import { fullGrant, GRANT_LIMITS, type Grant } from "../../../packages/application/src/index";
import { readerGrant } from "../src/agent-api";

const OWNER = "synthetic-settlement-owner";
const PRINCIPAL = `mcp-client:${OWNER}`;
const APP_AUD = "synthetic-settlement-browser";
const MCP_AUD = "synthetic-settlement-mcp";
const LIST = "kogane.card-settlements.read";
const OWNERSHIP = "kogane.card-settlements.ownership";
const STATEMENTS = "kogane.card-settlements.statements";
const ID = "card-settlement-read-tool";
const GRANT = {
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 1 },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
/** Another candidate over the same synthetic rows, under the given keys. */
let insertCandidate: (
  id: string,
  statementKey: string,
  bankKey: string,
  digest: string,
  createdAt: string,
) => Promise<void>;

beforeAll(async () => {
  await seedRegistry();
  for (const source of ["myjcb", "smbc-bank"])
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT OR IGNORE INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]);
  const cardRun = await seedRun({ source: "myjcb", count: 1 });
  const bankRun = await seedRun({ source: "smbc-bank", count: 1 });
  async function parse(artifactId: number) {
    const row =
      await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,'card-settlement-read-tool-fixture','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`)
        .bind(artifactId)
        .first<{ id: number }>();
    await publishParse(row!.id);
    return row!.id;
  }
  const cardParse = await parse(cardRun.artifacts[0]!.id);
  const bankParse = await parse(bankRun.artifacts[0]!.id);
  const card =
    await env.DB.prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json)
    VALUES(?,'synthetic-card','credit_statement_payment_amount','JPY','synthetic-card','{}') RETURNING id`)
      .bind(cardParse)
      .first<{ id: number }>();
  const bank =
    await env.DB.prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
    VALUES(?,'synthetic-bank','JPY','synthetic-bank','{}') RETURNING id`)
      .bind(bankParse)
      .first<{ id: number }>();
  const facts = settlementFacts(true);
  facts.statement.ref = {
    kind: "balance",
    id: `balance:${card!.id}`,
    revision: `parse_run:${cardParse}`,
  };
  facts.bankDebit.ref = {
    kind: "transaction",
    id: `transaction:${bank!.id}`,
    revision: `parse_run:${bankParse}`,
  };
  facts.bankDebit.sourceId = "smbc-bank";
  insertCandidate = async (id, statementKey, bankKey, digest, createdAt) => {
    await env.DB.prepare(`INSERT INTO card_settlement_candidates
    (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
    VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,?)`)
      .bind(
        id,
        statementKey,
        bankKey,
        card!.id,
        cardParse,
        bank!.id,
        bankParse,
        JSON.stringify(facts),
        digest,
        createdAt,
      )
      .run();
  };
  await insertCandidate(
    ID,
    "statement-read-tool",
    "bank-read-tool",
    "b".repeat(64),
    "2026-09-11T00:00:00Z",
  );
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://settlement-read-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** The store with the settlement views not yet applied, as the route's test builds it. */
function withoutSettlementViews(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_settlement_reviews")
              ? "SELECT 0 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
let schemaAhead = false;
afterEach(() => {
  schemaAhead = false;
});
// No table configures a grant any more (ADR 0084): every MCP client, and the
// browser operator, holds the whole-store grant. A narrower grant is given to
// the shared service directly, which is where scope and capability are graded.
const environment = (_grant?: unknown) =>
  ({
    ...env,
    DB: schemaAhead ? withoutSettlementViews(env.DB) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    AGENT_GRANTS: "[]",
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
  }) as Env;
async function token(audience: string) {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}
/** The operator's page route: the answer an agent must receive unchanged. */
async function page(query: string) {
  const response = await worker.fetch(
    new Request(`https://fixture.test/api/v2/reconciliation/card-settlements${query}`, {
      headers: { "cf-access-jwt-assertion": await token(APP_AUD) },
    }),
    environment(GRANT),
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function http(tool: string, body: unknown, grant: unknown = GRANT) {
  return worker.fetch(
    new Request(`https://fixture.test/api/agent/v1/${tool.slice("kogane.".length)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await token(APP_AUD),
      },
      body: JSON.stringify(body),
    }),
    environment(grant),
  );
}
async function mcp(body: unknown, grant: unknown = GRANT) {
  const response = await worker.fetch(
    new Request("https://fixture.test/mcp", {
      method: "POST",
      headers: {
        ...MCP_CLIENT_HEADERS,
        "mcp-protocol-version": "2025-11-25",
        "cf-access-jwt-assertion": await token(MCP_AUD),
      },
      body: JSON.stringify(body),
    }),
    environment(grant),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result: {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
      tools: { name: string }[];
    };
  }>;
}
const call = async (name: string, args: unknown, grant: unknown = GRANT) =>
  (
    await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      grant,
    )
  ).result;
/** The service's answer and listing under a grant no deployment configures. */
const NOW = "2026-11-07T00:00:00Z";
const direct = (name: string, args: unknown, grant: typeof GRANT) =>
  callTool(
    name as never,
    args,
    toolContext(environment(), { principal: PRINCIPAL, ...grant } as Grant, NOW),
  );
const listedUnder = (grant: typeof GRANT) =>
  readMcpTools({ principal: PRINCIPAL, ...grant } as Grant, {
    reportedState: true,
    cardSettlements: true,
  }).map((tool) => tool.name);
const listed = async (grant: unknown = GRANT) =>
  (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, grant)).result.tools.map(
    (tool) => tool.name,
  );
async function writes() {
  return env.DB.prepare(`SELECT
    (SELECT count(*) FROM card_settlement_decisions) AS decisions,
    (SELECT count(*) FROM change_plans) AS plans,
    (SELECT count(*) FROM decision_revisions) AS revisions,
    (SELECT count(*) FROM entity_relations) AS relations,
    (SELECT count(*) FROM economic_claims) AS claims`).first();
}

describe("card settlement reads for agents", () => {
  it("answer exactly what the page reads, on both transports, and write only audit records", async () => {
    const before = await writes();
    for (const [tool, args, query] of [
      [LIST, {}, ""],
      [LIST, { offset: 0 }, "?offset=0"],
      [LIST, { proposalId: ID }, `?proposalId=${ID}`],
      [STATEMENTS, {}, "/statements"],
      [STATEMENTS, { offset: 0 }, "/statements?offset=0"],
      [OWNERSHIP, { proposalId: ID }, `/ownership?proposalId=${ID}`],
    ] as const) {
      const expected = await page(query);
      const viaHttp = await http(tool, args);
      expect(viaHttp.status).toBe(200);
      expect(await viaHttp.json()).toEqual(expected);
      const viaMcp = await call(tool, args);
      expect(viaMcp.isError).not.toBe(true);
      expect(viaMcp.structuredContent).toEqual(expected);
    }
    expect(await writes()).toEqual(before);
    const audit = await env.DB.prepare(`SELECT operation,risk_class,result,diff_json
      FROM audit_records WHERE operation LIKE 'card-settlements.%' AND path='mcp' ORDER BY rowid`).all();
    expect(audit.results).toEqual([
      ...[1, 2, 3].map(() => ({
        operation: "card-settlements.read",
        risk_class: "R0",
        result: "read",
        diff_json: '{"kind":"read","rows":1,"truncated":false}',
      })),
      // One statement on the page: a count of statements, never their candidates.
      ...[1, 2].map(() => ({
        operation: "card-settlements.statements",
        risk_class: "R0",
        result: "read",
        diff_json: '{"kind":"read","rows":1,"truncated":false}',
      })),
      {
        operation: "card-settlements.ownership",
        risk_class: "R0",
        result: "read",
        diff_json: '{"kind":"read","rows":1,"truncated":false}',
      },
    ]);
  });

  it("are listed and answered only to records.read over the whole store", async () => {
    // Every MCP client holds that grant, so all three are listed to it.
    expect(await listed()).toEqual(expect.arrayContaining([LIST, STATEMENTS, OWNERSHIP]));
    expect(listedUnder(GRANT)).toEqual(expect.arrayContaining([LIST, STATEMENTS, OWNERSHIP]));
    for (const [grant, code] of [
      [{ ...GRANT, capabilities: ["summary.read"] }, "unauthorized"],
      [{ ...GRANT, scopes: { sources: ["myjcb"], accounts: "*" } }, "evidence_restricted"],
      [{ ...GRANT, scopes: { sources: "*", accounts: ["synthetic-card"] } }, "evidence_restricted"],
    ] as const) {
      const names = listedUnder(grant);
      expect(names).not.toContain(LIST);
      expect(names).not.toContain(STATEMENTS);
      expect(names).not.toContain(OWNERSHIP);
      for (const [tool, args] of [
        [LIST, {}],
        [STATEMENTS, {}],
        [STATEMENTS, { offset: -1 }],
        [OWNERSHIP, { proposalId: ID }],
      ] as const) {
        const answer = await direct(tool, args, grant);
        expect(answer.status).toBe(403);
        expect(answer.body).toMatchObject({ code });
      }
    }
  });

  it("page only as deep as the grant's maxRows, before any read", async () => {
    const shallow = { ...GRANT, budget: { ...GRANT.budget, maxRows: 50 } };
    expect((await direct(LIST, { offset: 0 }, shallow)).status).toBe(200);
    expect(
      (
        await direct(
          LIST,
          { proposalId: ID },
          { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } },
        )
      ).status,
    ).toBe(200);
    const answer = await direct(LIST, { offset: 1 }, shallow);
    expect(answer.status).toBe(413);
    expect(answer.body).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=50"],
    });
    // Past the published bound, the whole-store grant refuses alike on both transports.
    const viaHttp = await http(LIST, { offset: 1000 });
    const viaMcp = await call(LIST, { offset: 1000 });
    expect(viaHttp.status).toBe(413);
    expect(viaMcp.isError).toBe(true);
    expect(await viaHttp.json()).toEqual(viaMcp.structuredContent);
  });

  it("are absent, not refused, while the route is not served", async () => {
    schemaAhead = true;
    const names = await listed();
    expect(names).not.toContain(LIST);
    expect(names).not.toContain(STATEMENTS);
    expect(names).not.toContain(OWNERSHIP);
    for (const [tool, args] of [
      [LIST, {}],
      [STATEMENTS, {}],
      [OWNERSHIP, { proposalId: ID }],
    ] as const) {
      expect((await http(tool, args)).status).toBe(404);
      const response = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      });
      expect(JSON.stringify(response)).toContain("unknown_tool");
    }
  });

  it("refuse malformed requests and do not turn a missing candidate into an empty answer", async () => {
    for (const [tool, args] of [
      [LIST, { offset: -1 }],
      [LIST, { offset: 1_000_001 }],
      [LIST, { offset: 0, proposalId: ID }],
      [LIST, { proposalId: "/etc" }],
      [LIST, { source: "myjcb" }],
      [OWNERSHIP, {}],
      [OWNERSHIP, { proposalId: ID, offset: 0 }],
    ] as const) {
      const viaHttp = await http(tool, args);
      expect(viaHttp.status).toBe(400);
      expect((await call(tool, args)).isError).toBe(true);
    }
    for (const [tool, args] of [
      [LIST, { proposalId: "missing" }],
      [OWNERSHIP, { proposalId: "missing" }],
    ] as const) {
      expect((await http(tool, args)).status).toBe(404);
      expect((await call(tool, args)).isError).toBe(true);
    }
  });

  it("refuse and page alike on the page route and both agent transports, each under its own grant", async () => {
    // The page holds the browser's reader grant and an MCP client the full
    // grant; both carry the published row budget, so they page equally deep.
    expect(readerGrant(OWNER).budget.maxRows).toBe(GRANT_LIMITS.maxRows);
    expect(fullGrant(PRINCIPAL).budget.maxRows).toBe(GRANT_LIMITS.maxRows);
    const STATEMENT = "statementKey=statement-read-tool";
    for (const [args, query, status, code] of [
      [{}, "", 200, null],
      [{ offset: 0 }, "?offset=0", 200, null],
      [{ offset: 950 }, "?offset=950", 200, null],
      [{ offset: 951 }, "?offset=951", 413, "budget_exceeded"],
      [{ offset: 1_000_000 }, "?offset=1000000", 413, "budget_exceeded"],
      [{ offset: -1 }, "?offset=-1", 400, "invalid_query"],
      [{ offset: 1_000_001 }, "?offset=1000001", 400, "invalid_query"],
      [{ offset: 1e20 }, "?offset=100000000000000000000", 400, "invalid_query"],
      [{ offset: 1.5 }, "?offset=1.5", 400, "invalid_query"],
      [{ offset: "abc" }, "?offset=abc", 400, "invalid_query"],
      [{ offset: "01" }, "?offset=01", 400, "invalid_query"],
      [{ offset: "" }, "?offset=", 400, "invalid_query"],
      [{ proposalId: ID }, `?proposalId=${ID}`, 200, null],
      [{ proposalId: ID, offset: 0 }, `?proposalId=${ID}&offset=0`, 400, "invalid_query"],
      [{ statementKey: "statement-read-tool", offset: 950 }, `?${STATEMENT}&offset=950`, 200, null],
      [
        { statementKey: "statement-read-tool", offset: 951 },
        `?${STATEMENT}&offset=951`,
        413,
        "budget_exceeded",
      ],
      [{ relatedTo: ID, offset: 951 }, `?relatedTo=${ID}&offset=951`, 413, "budget_exceeded"],
      // The budget precedes the anchor's read: a missing anchor deep down is not looked up.
      [
        { relatedTo: "missing", offset: 951 },
        "?relatedTo=missing&offset=951",
        413,
        "budget_exceeded",
      ],
    ] as const) {
      const route = await worker.fetch(
        new Request(`https://fixture.test/api/v2/reconciliation/card-settlements${query}`, {
          headers: { "cf-access-jwt-assertion": await token(APP_AUD) },
        }),
        environment(),
      );
      const expected = (await route.json()) as Record<string, unknown>;
      expect({ query, status: route.status, code: expected["code"] ?? null }).toEqual({
        query,
        status,
        code,
      });
      const viaHttp = await http(LIST, args);
      expect({ query, status: viaHttp.status, body: await viaHttp.json() }).toEqual({
        query,
        status,
        body: expected,
      });
      const viaMcp = await call(LIST, args);
      expect({ query, isError: viaMcp.isError === true, body: viaMcp.structuredContent }).toEqual({
        query,
        isError: status >= 400,
        body: expected,
      });
    }
    // The grouped list takes `offset` alone and pages ten statements at a
    // time, so the same budget reaches offset 990.
    for (const [args, query, status, code] of [
      [{}, "", 200, null],
      [{ offset: 0 }, "?offset=0", 200, null],
      [{ offset: 990 }, "?offset=990", 200, null],
      [{ offset: 991 }, "?offset=991", 413, "budget_exceeded"],
      [{ offset: 1_000_000 }, "?offset=1000000", 413, "budget_exceeded"],
      [{ offset: -1 }, "?offset=-1", 400, "invalid_query"],
      [{ offset: 1_000_001 }, "?offset=1000001", 400, "invalid_query"],
      [{ offset: 1e20 }, "?offset=100000000000000000000", 400, "invalid_query"],
      [{ offset: 1.5 }, "?offset=1.5", 400, "invalid_query"],
      [{ offset: "abc" }, "?offset=abc", 400, "invalid_query"],
      [{ offset: "01" }, "?offset=01", 400, "invalid_query"],
      [{ offset: "" }, "?offset=", 400, "invalid_query"],
      [{ offset: [0, 0] }, "?offset=0&offset=0", 400, "invalid_query"],
      [{ proposalId: ID }, `?proposalId=${ID}`, 400, "invalid_query"],
      [{ statementKey: "statement-read-tool" }, `?${STATEMENT}`, 400, "invalid_query"],
      [{ relatedTo: ID, offset: 0 }, `?relatedTo=${ID}&offset=0`, 400, "invalid_query"],
      [{ source: "myjcb" }, "?source=myjcb", 400, "invalid_query"],
    ] as const) {
      const route = await worker.fetch(
        new Request(
          `https://fixture.test/api/v2/reconciliation/card-settlements/statements${query}`,
          { headers: { "cf-access-jwt-assertion": await token(APP_AUD) } },
        ),
        environment(),
      );
      const expected = (await route.json()) as Record<string, unknown>;
      expect({ query, status: route.status, code: expected["code"] ?? null }).toEqual({
        query,
        status,
        code,
      });
      const viaHttp = await http(STATEMENTS, args);
      expect({ query, status: viaHttp.status, body: await viaHttp.json() }).toEqual({
        query,
        status,
        body: expected,
      });
      const viaMcp = await call(STATEMENTS, args);
      expect({ query, isError: viaMcp.isError === true, body: viaMcp.structuredContent }).toEqual({
        query,
        isError: status >= 400,
        body: expected,
      });
    }
    // The ownership read takes `proposalId` alone, on every path.
    for (const [args, query] of [
      [{ proposalId: ID, offset: -1 }, `?proposalId=${ID}&offset=-1`],
      [{ proposalId: ID, statementKey: "k" }, `?proposalId=${ID}&statementKey=k`],
      [{}, ""],
    ] as const) {
      const route = await worker.fetch(
        new Request(
          `https://fixture.test/api/v2/reconciliation/card-settlements/ownership${query}`,
          { headers: { "cf-access-jwt-assertion": await token(APP_AUD) } },
        ),
        environment(),
      );
      expect(route.status).toBe(400);
      const expected = await route.json();
      expect(expected).toMatchObject({ code: "invalid_query" });
      expect(await (await http(OWNERSHIP, args)).json()).toEqual(expected);
      expect((await call(OWNERSHIP, args)).structuredContent).toEqual(expected);
    }
  });

  // Last: it adds candidates the tests above do not expect.
  it("read one statement's candidates and a review's competitors as the pages do, on both transports", async () => {
    // A recapture of the same statement, paired with another debit.
    await insertCandidate(
      "card-settlement-read-tool-recapture",
      "statement-read-tool",
      "bank-read-tool-other",
      "c".repeat(64),
      "2026-09-12T00:00:00Z",
    );
    const before = await writes();
    for (const [args, query] of [
      [{ statementKey: "statement-read-tool" }, "?statementKey=statement-read-tool"],
      [
        { statementKey: "statement-read-tool", offset: 1 },
        "?statementKey=statement-read-tool&offset=1",
      ],
      [{ statementKey: "statement-none" }, "?statementKey=statement-none"],
      [{ relatedTo: ID }, `?relatedTo=${ID}`],
      [{ relatedTo: ID, offset: 0 }, `?relatedTo=${ID}&offset=0`],
      [
        { relatedTo: "card-settlement-read-tool-recapture" },
        "?relatedTo=card-settlement-read-tool-recapture",
      ],
    ] as const) {
      const expected = await page(query);
      const viaHttp = await http(LIST, args);
      expect(viaHttp.status).toBe(200);
      expect(await viaHttp.json()).toEqual(expected);
      const viaMcp = await call(LIST, args);
      expect(viaMcp.isError).not.toBe(true);
      expect(viaMcp.structuredContent).toEqual(expected);
    }
    // The grouped list carries both under their statement, on both transports.
    const grouped = (await page("/statements")) as {
      statements: { statementKey: string; candidateCount: number; candidates: unknown[] }[];
    };
    expect(
      grouped.statements.map((group) => [
        group.statementKey,
        group.candidateCount,
        group.candidates.length,
      ]),
    ).toEqual([["statement-read-tool", 2, 2]]);
    const viaHttp = await http(STATEMENTS, {});
    expect(viaHttp.status).toBe(200);
    expect(await viaHttp.json()).toEqual(grouped);
    expect((await call(STATEMENTS, {})).structuredContent).toEqual(grouped);
    // The competitors never include the review itself.
    expect(
      ((await page(`?relatedTo=${ID}`)) as { items: { proposalId: string }[] }).items.map(
        (item) => item.proposalId,
      ),
    ).toEqual(["card-settlement-read-tool-recapture"]);
    expect(await writes()).toEqual(before);
    // A missing anchor is not found on every path, never an empty page.
    const route = await worker.fetch(
      new Request("https://fixture.test/api/v2/reconciliation/card-settlements?relatedTo=missing", {
        headers: { "cf-access-jwt-assertion": await token(APP_AUD) },
      }),
      environment(GRANT),
    );
    expect(route.status).toBe(404);
    const missingHttp = await http(LIST, { relatedTo: "missing" });
    expect(missingHttp.status).toBe(404);
    const missingMcp = await call(LIST, { relatedTo: "missing" });
    expect(missingMcp.isError).toBe(true);
    expect(missingMcp.structuredContent).toEqual(await missingHttp.json());
    for (const args of [
      { relatedTo: ID, proposalId: ID },
      { relatedTo: ID, statementKey: "statement-read-tool" },
      { statementKey: "statement-read-tool", proposalId: ID },
      { relatedTo: "/etc" },
      { statementKey: "" },
      { statementKey: "k".repeat(1025) },
    ]) {
      const refused = await http(LIST, args);
      expect(refused.status).toBe(400);
      const answer = await call(LIST, args);
      expect(answer.isError).toBe(true);
    }
    const shallow = { ...GRANT, budget: { ...GRANT.budget, maxRows: 50 } };
    for (const args of [
      { relatedTo: ID, offset: 1 },
      { statementKey: "statement-read-tool", offset: 1 },
    ]) {
      const answer = await direct(LIST, args, shallow);
      expect(answer.status).toBe(413);
      expect(answer.body).toMatchObject({ code: "budget_exceeded" });
    }
  });

  // After the test above: it adds 61 candidates, 51 of one statement and ten
  // statements of one candidate each.
  it("offer no next page the caller's grant is refused, on the tool and the page alike", async () => {
    for (let n = 0; n < 51; n++)
      await insertCandidate(
        `card-settlement-paging-${String(n).padStart(2, "0")}`,
        "statement-paging",
        `bank-paging-${String(n)}`,
        n.toString(16).padStart(64, "d"),
        new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
      );
    for (let n = 0; n < 10; n++)
      await insertCandidate(
        `card-settlement-single-${String(n)}`,
        `statement-single-${String(n)}`,
        `bank-single-${String(n)}`,
        n.toString(16).padStart(64, "e"),
        new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString(),
      );
    // Twelve statements now: the three above and the ten singles.
    const STATEMENT = { statementKey: "statement-paging" };
    const under = (maxRows: number) => ({ ...GRANT, budget: { ...GRANT.budget, maxRows } });
    for (const [name, args, size, maxRows] of [
      [LIST, {}, 50, 60],
      [LIST, STATEMENT, 50, 60],
      [LIST, { relatedTo: "card-settlement-paging-00" }, 50, 60],
      [STATEMENTS, {}, 10, 15],
    ] as const) {
      // A grant that may read the next page is offered it.
      const deep = await direct(name, args, under(2 * size));
      expect({ name, args, body: deep.body }).toMatchObject({
        name,
        args,
        body: { nextOffset: size, nextPage: "offered" },
      });
      // One that may not is told why, and its request is the refusal.
      const shallow = await direct(name, args, under(maxRows));
      expect({ name, args, status: shallow.status, body: shallow.body }).toMatchObject({
        name,
        args,
        status: 200,
        body: { nextOffset: null, nextPage: "budget_exceeded" },
      });
      const refused = await direct(name, { ...args, offset: size }, under(maxRows));
      expect({ name, args, status: refused.status, body: refused.body }).toMatchObject({
        name,
        args,
        status: 413,
        body: { code: "budget_exceeded", refs: [`budget:maxRows=${String(maxRows)}`] },
      });
    }
    // The page route, the agent HTTP route and MCP answer one body, under the
    // same published budget: the next page is offered while it is readable.
    for (const [args, query] of [
      [STATEMENT, "?statementKey=statement-paging"],
      [{ ...STATEMENT, offset: 50 }, "?statementKey=statement-paging&offset=50"],
    ] as const) {
      const expected = (await page(query)) as { nextOffset: unknown; nextPage: unknown };
      expect(await (await http(LIST, args)).json()).toEqual(expected);
      expect((await call(LIST, args)).structuredContent).toEqual(expected);
      expect([expected.nextOffset, expected.nextPage]).toEqual(
        "offset" in args ? [null, "none"] : [50, "offered"],
      );
    }
  });
});
