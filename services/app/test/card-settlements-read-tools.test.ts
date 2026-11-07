// `kogane.card-settlements.read` and `kogane.card-settlements.ownership` (ADR
// 0081): the カード照合 page's reads for an agent, over MCP and the agent HTTP
// route. Native Worker/D1 and signed Access fixtures only; no production data.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture";
import { seedRegistry, seedRun, publishParse } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import worker from "../src/worker";

const OWNER = "synthetic-settlement-owner";
const PRINCIPAL = `mcp-client:${OWNER}`;
const APP_AUD = "synthetic-settlement-browser";
const MCP_AUD = "synthetic-settlement-mcp";
const LIST = "kogane.card-settlements.read";
const OWNERSHIP = "kogane.card-settlements.ownership";
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
  await env.DB.prepare(`INSERT INTO card_settlement_candidates
    (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
    VALUES(?,'statement-read-tool','bank-read-tool',?,?,?,?,'card-statement-settlement-v1',?,?,'2026-09-11T00:00:00Z')`)
    .bind(ID, card!.id, cardParse, bank!.id, bankParse, JSON.stringify(facts), "b".repeat(64))
    .run();
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
const environment = (grant: unknown) =>
  ({
    ...env,
    DB: schemaAhead ? withoutSettlementViews(env.DB) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    AGENT_API_GRANTS: JSON.stringify({ [OWNER]: grant, [PRINCIPAL]: grant }),
    MCP_DELEGATIONS: "",
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
      {
        operation: "card-settlements.ownership",
        risk_class: "R0",
        result: "read",
        diff_json: '{"kind":"read","rows":1,"truncated":false}',
      },
    ]);
  });

  it("are listed and answered only to records.read over the whole store", async () => {
    expect(await listed()).toEqual(expect.arrayContaining([LIST, OWNERSHIP]));
    for (const [grant, code] of [
      [{ ...GRANT, capabilities: ["summary.read"] }, "unauthorized"],
      [{ ...GRANT, scopes: { sources: ["myjcb"], accounts: "*" } }, "evidence_restricted"],
      [{ ...GRANT, scopes: { sources: "*", accounts: ["synthetic-card"] } }, "evidence_restricted"],
    ] as const) {
      const names = await listed(grant);
      expect(names).not.toContain(LIST);
      expect(names).not.toContain(OWNERSHIP);
      for (const [tool, args] of [
        [LIST, {}],
        [OWNERSHIP, { proposalId: ID }],
      ] as const) {
        const viaHttp = await http(tool, args, grant);
        const viaMcp = await call(tool, args, grant);
        expect(viaHttp.status).toBe(403);
        expect(viaMcp.isError).toBe(true);
        expect(await viaHttp.json()).toEqual(viaMcp.structuredContent);
        expect(viaMcp.structuredContent).toMatchObject({ code });
      }
    }
  });

  it("page only as deep as the grant's maxRows, before any read", async () => {
    const shallow = { ...GRANT, budget: { ...GRANT.budget, maxRows: 50 } };
    expect((await http(LIST, { offset: 0 }, shallow)).status).toBe(200);
    expect(
      (await http(LIST, { proposalId: ID }, { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } }))
        .status,
    ).toBe(200);
    const viaHttp = await http(LIST, { offset: 1 }, shallow);
    const viaMcp = await call(LIST, { offset: 1 }, shallow);
    expect(viaHttp.status).toBe(413);
    expect(viaMcp.isError).toBe(true);
    expect(await viaHttp.json()).toEqual(viaMcp.structuredContent);
    expect(viaMcp.structuredContent).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=50"],
    });
  });

  it("are absent, not refused, while the route is not served", async () => {
    schemaAhead = true;
    const names = await listed();
    expect(names).not.toContain(LIST);
    expect(names).not.toContain(OWNERSHIP);
    for (const [tool, args] of [
      [LIST, {}],
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
});
