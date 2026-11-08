// A UI read route and its MCP page read (ADR 0081), called the way the Worker
// serves them: the route under a signed-in browser subject, the tool on
// `/api/agent/v1/*` under a browser subject's grant and on `/mcp` as
// `mcp-client:<sub>`. Each page-read test compares the three answers.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import type { Grant } from "../../../packages/application/src/index";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

/** The UI's authority over these pages: records over the whole store. */
export const RECORDS_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
} as const;

const MCP_AUDIENCE = "fixture-mcp-audience";
/**
 * Each harness's certificate URL, so two harnesses in one file share the one
 * `fetch` mock rather than the later replacing the earlier.
 */
const CERTS = new Map<string, unknown>();
const AUDIENCE = "fixture-audience";

export function pageReadHarness(label: string, extraEnv: Record<string, unknown> = {}) {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: { keys: unknown[] };
  let issuer = "";
  let sequence = 0;
  beforeAll(async () => {
    keys = await generateKeyPair("RS256", { extractable: true });
    jwks = {
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
    };
  });
  beforeEach(() => {
    issuer = `https://${label}-${++sequence}.cloudflareaccess.com`;
    CERTS.set(`${issuer}/cdn-cgi/access/certs`, jwks);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const certs = CERTS.get(String(input));
      if (!certs) throw new Error("Unexpected synthetic test request");
      return Response.json(certs);
    });
  });
  afterEach(() => {
    CERTS.clear();
    vi.restoreAllMocks();
  });

  const token = (subject: string, audience: string) =>
    new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  // No table configures a grant any more (ADR 0084): an MCP client and the
  // browser operator hold the whole-store grant, a browser subject in
  // `AGENT_GRANTS` the reader grant. A narrower grant goes to the shared
  // service directly (`direct`), which is where it is graded.
  const environment = () =>
    ({
      ...env,
      OPERATOR_SUBJECTS: '["synthetic-agent"]',
      // A page the operator alone reads names its browser subject here too.
      ...extraEnv,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: AUDIENCE,
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    }) as Env;

  /** The UI route's response as the signed-in browser receives it. */
  async function routeResponse(pathAndQuery: string): Promise<Response> {
    return worker.fetch(
      new Request(`https://fixture.test${pathAndQuery}`, {
        headers: { "cf-access-jwt-assertion": await token("synthetic-reader", AUDIENCE) },
      }),
      environment(),
    );
  }

  /** The UI route as the signed-in browser reads it. */
  async function route(pathAndQuery: string): Promise<{ status: number; body: unknown }> {
    const response = await routeResponse(pathAndQuery);
    return { status: response.status, body: await response.json() };
  }

  /** The tool's service answer under a grant no deployment configures. */
  async function direct(
    tool: string,
    args: unknown,
    grant: unknown,
  ): Promise<{ status: number; body: any }> {
    const answer = await callTool(
      tool as never,
      args,
      toolContext(
        environment(),
        { principal: "mcp-client:synthetic-agent", ...(grant as object) } as Grant,
        new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      ),
    );
    return { status: answer.status, body: answer.body };
  }

  /** The tool on `/api/agent/v1/*`. */
  async function http(tool: string, args: unknown): Promise<{ status: number; body: any }> {
    const response = await worker.fetch(
      new Request(`https://fixture.test/api/agent/v1/${tool.slice("kogane.".length)}`, {
        method: "POST",
        headers: { "cf-access-jwt-assertion": await token("synthetic-agent", AUDIENCE) },
        body: JSON.stringify(args),
      }),
      environment(),
    );
    return { status: response.status, body: await response.json() };
  }

  /** The Worker's response to one `/mcp` JSON-RPC message as `mcp-client:synthetic-agent`. */
  async function mcpResponse(message: Record<string, unknown>): Promise<Response> {
    return worker.fetch(
      new Request("https://fixture.test/mcp", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await token("synthetic-agent", MCP_AUDIENCE),
          ...MCP_CLIENT_HEADERS,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
      }),
      environment(),
    );
  }

  /** One `/mcp` JSON-RPC message as `mcp-client:synthetic-agent`. */
  async function mcpMessage(message: Record<string, unknown>) {
    const response = await mcpResponse(message);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, any>;
  }

  /** The tool on `/mcp`: its structured content and whether it is an error. */
  async function mcp(tool: string, args: unknown): Promise<{ isError: boolean; body: any }> {
    const message = await mcpMessage({
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    return { isError: message["result"].isError, body: message["result"].structuredContent };
  }

  /** The tool names `/mcp` lists to an MCP client. */
  async function listed(): Promise<string[]> {
    const message = await mcpMessage({ method: "tools/list" });
    return message["result"].tools.map((entry: { name: string }) => entry.name);
  }

  /**
   * The route's answer for `pathAndQuery` against the tool's for `args`, on
   * both agent transports: a served page is the route's body under `data`;
   * a refusal is the route's status and closed code.
   */
  async function expectSameAnswer(
    pathAndQuery: string,
    tool: string,
    args: unknown,
    grant: unknown = RECORDS_GRANT,
  ) {
    const page = await route(pathAndQuery);
    const overHttp = await http(tool, args, grant);
    const overMcp = await mcp(tool, args, grant);
    const label = `${pathAndQuery} ${JSON.stringify(args)}`;
    expect(overHttp.status, label).toBe(page.status);
    expect(overMcp.isError, label).toBe(page.status >= 400);
    if (page.status === 200) {
      expect(overHttp.body, label).toEqual({
        schemaVersion: "kogane-page-read-v1",
        data: page.body,
      });
    } else {
      const { requestId: _requestId, ...refusal } = page.body as Record<string, unknown>;
      expect(overHttp.body, label).toEqual(refusal);
    }
    expect(overMcp.body, label).toEqual(overHttp.body);
    return page;
  }

  return {
    route,
    routeResponse,
    http,
    mcp,
    mcpMessage,
    mcpResponse,
    direct,
    listed,
    expectSameAnswer,
  };
}

/**
 * A store whose schema answers "absent" to every `sqlite_master` probe, as
 * before the migrations a served-only page read depends on.
 */
export function withoutTables(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(sql.includes("sqlite_master") ? "SELECT 0 AS present" : sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Every table's row count except the audit tables, so "writes nothing but its
 * own audit record" is checkable.
 */
export async function tableCounts(): Promise<Record<string, number>> {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('audit_records','audit_overflow_counters') ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results)
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}
