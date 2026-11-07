// Per-source instrument resolution counts over the real Worker, the real CORE
// migrations and the production identity writer: `GET
// /api/identity/instrument-coverage` for the browser and
// `kogane.instruments.coverage` for an agent, over HTTP and MCP, answer one
// read (ADR 0073 and its 2026-11-06 amendment). A synthetic SBI Securities
// capture holds one code on a mapped venue and trades it on a venue the SBI
// rule does not map, so its two identifiers wait on one proposed candidate.
// Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CAPABILITIES, type Grant } from "../../../packages/application/src/grants.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { identifyParse } from "../../processor/src/identity-store";
import { readMcpTools } from "../src/read-tools";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/identity/instrument-coverage";
const AGENT_PATH = "/api/agent/v1/instruments.coverage";
const TOOL = "kogane.instruments.coverage";
/** The ADR 0073 authority: `summary.read` over the whole store, and nothing else. */
const SUMMARY_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
};
/** The MCP Access application's audience (ADR 0047); `/mcp` accepts nothing else. */
const MCP_AUDIENCE = "fixture-mcp-audience";
/** Provider text the synthetic capture holds; no answer or record may carry it. */
const PROVIDER_TEXT = ["SYN7101", "Synthetic Seventy", "SYNTHETIC-VENUE", "TKY"];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

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
  const artifactId = (await seedRun({ count: 1, source: "sbi-securities" })).artifacts[0]!.id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'coverage-fixture','1','2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,security_name,market,currency,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','SYN7101','Synthetic Seventy','TKY','JPY','1',0,'synthetic','{}')`).bind(
      parse!.id,
    ),
    env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,currency,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','JPY','synthetic',?)`).bind(
      parse!.id,
      JSON.stringify({
        issueCode: "SYN7101",
        issueName: "Synthetic Seventy",
        marketLabel: "SYNTHETIC-VENUE",
        accountLabel: "synthetic",
      }),
    ),
  ]);
  const verified =
    await env.DB.prepare(`SELECT p.id,a.id artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN financial_fetch_runs r ON r.id=a.fetch_run_id WHERE p.id=?`)
      .bind(parse!.id)
      .first<{
        id: number;
        artifact_id: number;
        source_id: string;
        producer_id: string;
        fetch_run_id: number;
      }>();
  while (await identifyParse(env.DB, verified!, resolveIdentity)) {
    // Resume the production writer's bounded pages until the run is sealed.
  }
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://instrument-coverage-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(query = "", method = "GET", authenticated = true) {
  const token = authenticated
    ? await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience("fixture-audience")
        .setSubject("synthetic-reader")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
    : null;
  return worker.fetch(
    new Request(`https://fixture.test${PATH}${query}`, {
      method,
      headers: token ? { "cf-access-jwt-assertion": token } : {},
    }),
    { ...env, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: "fixture-audience" } as Env,
  );
}

/** One agent call: `/api/agent/v1/*` under a browser subject, or `/mcp` as `mcp-client:<sub>`. */
async function agentCall(path: string, body: unknown) {
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
    .setSubject("synthetic-agent")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    } as Env,
  );
}

/** One `/mcp` message's JSON-RPC answer. */
async function mcp(message: Record<string, unknown>) {
  const response = await agentCall("/mcp", { jsonrpc: "2.0", id: 1, ...message });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

/** The tool's MCP result: `structuredContent` and `isError`. */
async function mcpCoverage(arguments_: unknown) {
  const message = await mcp({
    method: "tools/call",
    params: { name: TOOL, arguments: arguments_ },
  });
  return message["result"] as { structuredContent: unknown; isError: boolean };
}

/**
 * Every table's row count, so "writes nothing" is checkable. An agent call's
 * own audit record (ADR 0064) is the one write it makes, so `audit: false`
 * leaves the audit tables out.
 */
async function tables({ audit = true } = {}) {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results.filter(
    ({ name }) => audit || (name !== "audit_records" && name !== "audit_overflow_counters"),
  ))
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}

describe("GET /api/identity/instrument-coverage", () => {
  it("counts each source's identifiers by candidate state and writes nothing", async () => {
    const before = await tables();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toEqual({
      schemaVersion: "kogane-instrument-coverage-v1",
      policy: "instrument-candidates-v1",
      query: { source: null },
      rows: [
        {
          source: "sbi-securities",
          identifiers: 2,
          states: {
            "unresolved-candidates": 2,
            "resolved-by-decision": 0,
            "shared-without-decision": 0,
            "kept-separate": 0,
            "no-candidate": 0,
          },
        },
      ],
    });
    expect((await call("", "HEAD")).status).toBe(200);
    expect(await tables()).toEqual(before);
  });

  it("filters by source; a source with no identifier in scope has no row", async () => {
    expect(await (await call("?source=sbi-securities")).json()).toMatchObject({
      query: { source: "sbi-securities" },
      rows: [{ source: "sbi-securities", identifiers: 2 }],
    });
    const absent = await (await call("?source=sony-bank")).json();
    expect(absent).toMatchObject({ query: { source: "sony-bank" }, rows: [] });
    expect(validApiResponse(PATH, absent)).toBe(true);
  });

  it("is Access-gated and GET-only, and refuses an unknown, repeated or malformed parameter", async () => {
    expect((await call("", "GET", false)).status).toBe(401);
    expect((await call("", "POST")).status).toBe(405);
    for (const query of [
      "?offset=0",
      "?identityRead=as-recorded",
      "?source=",
      "?source=a&source=b",
      `?source=${"x".repeat(129)}`,
      "?source=a%01",
    ]) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
  });
});

describe("kogane.instruments.coverage", () => {
  it("lists every read tool by its own rule under every capability set and scope shape", () => {
    // Pins the rule of each read tool, the earlier ones included, over all
    // capability sets and the four whole/listed scope shapes.
    let shapes = 0;
    for (let mask = 0; mask < 1 << AGENT_CAPABILITIES.length; mask++) {
      const capabilities = AGENT_CAPABILITIES.filter((_, bit) => mask & (1 << bit));
      for (const sources of ["*", ["sbi-securities"]] as const)
        for (const accounts of ["*", ["sbi-securities:domestic"]] as const) {
          const grant = { ...SUMMARY_GRANT, scopes: { sources, accounts }, capabilities } as Grant;
          const whole = sources === "*" && accounts === "*";
          // The dated reported state's and the card settlement reads are listed
          // only where their routes are served.
          for (const [reportedState, cardSettlements] of [
            [false, false],
            [false, true],
            [true, false],
            [true, true],
          ] as const) {
            const expected = [
              ...(capabilities.includes("records.read") && whole
                ? ["kogane.instruments.history"]
                : []),
              ...(reportedState && capabilities.includes("records.read") && whole
                ? ["kogane.reported-state.read"]
                : []),
              ...(capabilities.includes("summary.read") && whole ? [TOOL] : []),
              ...(capabilities.includes("records.read") && whole
                ? [
                    "kogane.accounts.candidates",
                    "kogane.card-settlements.unmatched",
                    "kogane.economic-readiness.read",
                  ]
                : []),
              ...(cardSettlements && capabilities.includes("records.read") && whole
                ? ["kogane.card-settlements.read", "kogane.card-settlements.ownership"]
                : []),
              ...(capabilities.includes("audit.read") && accounts === "*"
                ? ["kogane.audit.search", "kogane.audit.get"]
                : []),
            ];
            expect(
              readMcpTools(grant, { reportedState, cardSettlements }).map((tool) => tool.name),
              JSON.stringify({ grant, reportedState, cardSettlements }),
            ).toEqual(expected);
            shapes += 1;
          }
        }
    }
    expect(shapes).toBe(16 << AGENT_CAPABILITIES.length);
  });

  it("is listed to every MCP client under the whole-store grant (ADR 0084)", async () => {
    // The published schema is closed and has the route's one parameter.
    const tools = (await mcp({ method: "tools/list" }))["result"].tools as {
      name: string;
      inputSchema: Record<string, any>;
      annotations: unknown;
    }[];
    const tool = tools.find((entry) => entry.name === TOOL)!;
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", minLength: 1, maxLength: 128 } },
    });
    expect(tool.inputSchema["required"] ?? []).toEqual([]);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("answers the browser route's counts over HTTP and MCP, and carries no provider text", async () => {
    const before = await tables({ audit: false });
    for (const [query, body] of [
      ["", {}],
      ["?source=sbi-securities", { source: "sbi-securities" }],
      ["?source=sony-bank", { source: "sony-bank" }],
    ] as const) {
      const route = await (await call(query)).json();
      const http = await agentCall(AGENT_PATH, body);
      expect(http.status, query).toBe(200);
      const overHttp = await http.json();
      const overMcp = await mcpCoverage(body);
      expect(overMcp.isError, query).toBe(false);
      expect(overHttp, query).toEqual(route);
      expect(overMcp.structuredContent, query).toEqual(route);
      expect(validApiResponse(PATH, overMcp.structuredContent), query).toBe(true);
      for (const text of PROVIDER_TEXT) expect(JSON.stringify(overHttp)).not.toContain(text);
    }
    expect(await (await agentCall(AGENT_PATH, {})).json()).toMatchObject({
      rows: [{ source: "sbi-securities", identifiers: 2 }],
    });
    expect(await tables({ audit: false })).toEqual(before);
  });

  it("refuses a malformed input with the same closed answer on both transports", async () => {
    const before = await tables({ audit: false });
    // The input is a closed object: an unknown key or a malformed source is
    // refused before the service runs, the same way over both transports.
    for (const body of [
      { identifierId: "x" },
      { source: "" },
      { source: "x".repeat(129) },
      { source: "a\u0001" },
      { source: 1 },
      { source: null },
    ]) {
      const http = await agentCall(AGENT_PATH, body);
      expect(http.status, JSON.stringify(body)).toBe(400);
      const overHttp = await http.json();
      expect(overHttp).toEqual({ error: "invalid_request" });
      const overMcp = await mcpCoverage(body);
      expect(overMcp.isError).toBe(true);
      expect(overMcp.structuredContent).toEqual(overHttp);
    }
    expect(await tables({ audit: false })).toEqual(before);
  });

  it("records each served call as one R0 read of its row count, and a refusal under its tool (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const records = async () =>
      (
        await env.DB.prepare(
          "SELECT path,principal,subject,principal_kind,risk_class,result,result_code,diff_json FROM audit_records WHERE operation='instruments.coverage' AND rowid>? ORDER BY rowid",
        )
          .bind(last)
          .all<Record<string, unknown>>()
      ).results;
    // The browser route is not an agent call and records nothing.
    expect((await call()).status).toBe(200);
    expect((await agentCall(AGENT_PATH, {})).status).toBe(200);
    expect((await mcpCoverage({ source: "sony-bank" })).isError).toBe(false);
    expect((await agentCall(AGENT_PATH, { source: "" })).status).toBe(400);
    const read = {
      principal_kind: "agent",
      risk_class: "R0",
      result: "read",
      result_code: null,
    };
    const rows = await records();
    expect(rows).toEqual([
      {
        path: "agent-http",
        principal: "synthetic-agent",
        subject: "synthetic-agent",
        ...read,
        diff_json: JSON.stringify({ kind: "read", rows: 1, truncated: false }),
      },
      {
        path: "mcp",
        principal: "mcp-client:synthetic-agent",
        subject: "synthetic-agent",
        ...read,
        diff_json: JSON.stringify({ kind: "read", rows: 0, truncated: false }),
      },
      expect.objectContaining({
        path: "agent-http",
        principal: "synthetic-agent",
        risk_class: "R0",
        result: "refused",
        result_code: "invalid_request",
      }),
    ]);
    // Counts and closed codes only: no source, identifier or provider text.
    const recorded = JSON.stringify(rows);
    for (const text of [...PROVIDER_TEXT, "sbi-securities", "sony-bank"])
      expect(recorded).not.toContain(text);
  });
});
