// What a real MCP client meets on `/mcp`, over the real Worker, the real read
// model and a synthetic store (ADR 0047, docs/agent-api.md "Connecting an MCP
// client"). Every principal, audience, source and amount below is synthetic.
//
// The client path is Cloudflare Access Managed OAuth on a dedicated MCP Access
// application: Access turns the client's opaque token into a signed assertion
// for that application's audience, and the Worker only verifies it. These
// checks pin:
//   * the connection a client of either protocol era makes works end to end
//     through the official SDK (initialize/notifications/tools on 2025-11-25,
//     server/discover and tools on 2026-07-28);
//   * whoever signs in through the MCP application — the operator included —
//     is the agent-only principal `mcp-client:<sub>`: graded by its own
//     `AGENT_API_GRANTS` entry and nothing else, never re-classified as the
//     operator by `principalFor`, `opsContext` or `callOpsTool`, and refused
//     on every non-agent route;
//   * the operator's own application and its routes are unchanged;
//   * tools/list, tools/call and the refusals under each grant shape;
//   * the UI's query route, the HTTP agent route and MCP (both eras) return
//     one result object with the same gap reasons.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { AGENT_TOOL_NAMES } from "../src/agent-service";
import { principalFor } from "../src/grants";
import { HttpError } from "../src/http";
import { opsContext } from "../src/ops-api";
import { callOpsTool } from "../src/ops-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

/** The browser application's audience, and the MCP application's. */
const APP_AUD = "fixture-app-audience";
const MCP_AUD = "fixture-mcp-audience";
/** One synthetic person: the operator in the browser, an MCP client through the MCP application. */
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const AGENT = `mcp-client:${OWNER}`;
const ORIGIN = "https://fixture.test";
const MODERN = "2026-07-28";
const COLLECTION = {
  source: "sony-bank",
  requestedScope: { from: "2026-01-01", to: "2026-01-31" },
};

const WHOLE = { sources: "*", accounts: "*" } as const;
const BUDGET = { maxRows: 200, maxProposalTargets: 5, maxExplainDepth: 4 };
const READS = ["summary.read", "records.read", "evidence.read"];
const OPS_ENABLED = { OPS_API_ENABLED: "true", COMMANDS_ENABLED: "true" };

function grant(
  capabilities: readonly string[],
  scopes: { sources: unknown; accounts: unknown } = WHOLE,
  budget = BUDGET,
) {
  return { scopes, capabilities, budget };
}
function grants(table: Record<string, unknown>): Record<string, string> {
  return { AGENT_API_GRANTS: JSON.stringify(table) };
}

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let strangerKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let artifactId = 0;
const sourceAccounts: string[] = [];

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  strangerKeys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  for (const [source, account] of [
    ["sony-bank", "mcp-account-a"],
    ["other-test", "mcp-account-b"],
  ] as const) {
    const run = await seedRun({ count: 1, source });
    if (artifactId === 0) artifactId = run.artifacts[0].id;
    const parse = await env.DB.prepare(`INSERT INTO parse_runs
      (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'mcp-fixture','1','2026-09-07','ok','[]') RETURNING id`)
      .bind(run.artifacts[0].id)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    await env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
      VALUES (?,?,'1','2026-09-07',1,'JPY','$','{}','synthetic line')`)
      .bind(parse!.id, account)
      .run();
    const id = `sa_mcp_${source}`;
    await env.DB.prepare(
      "INSERT INTO source_accounts (id,source_id,producer_id,reference_json) VALUES (?,?,'evidence-test',?)",
    )
      .bind(id, source, JSON.stringify([account]))
      .run();
    sourceAccounts.push(id);
  }
});
beforeEach(() => {
  issuer = `https://mcp-client-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Who Access says the caller is. `via: "mcp"` is an assertion for the MCP
 * application — what Managed OAuth forwards for a connector's token — and
 * `via: "app"` one for the browser application.
 */
type Identity =
  | { via: "app" | "mcp" | "both"; subject: string }
  | { via: "app" | "mcp"; serviceToken: string }
  | { forged: true }
  | null;

async function assertion(identity: Exclude<Identity, null>): Promise<string> {
  const claims: Record<string, unknown> = { type: "app" };
  if ("serviceToken" in identity) claims["common_name"] = identity.serviceToken;
  const via = "via" in identity ? identity.via : "mcp";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(via === "both" ? [APP_AUD, MCP_AUD] : via === "app" ? APP_AUD : MCP_AUD)
    .setSubject("subject" in identity ? identity.subject : "")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign("forged" in identity ? strangerKeys.privateKey : keys.privateKey);
}

interface Options {
  method?: string;
  identity?: Identity;
  headers?: Record<string, string>;
  environment?: Record<string, unknown>;
  rawBody?: string;
}

async function send(path: string, body: unknown, options: Options = {}): Promise<Response> {
  const identity =
    options.identity === undefined ? { via: "mcp" as const, subject: OWNER } : options.identity;
  const headers: Record<string, string> = { ...options.headers };
  if (identity !== null) headers["cf-access-jwt-assertion"] = await assertion(identity);
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const init: RequestInit = { method, headers };
  if (options.rawBody !== undefined) init.body = options.rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    ...options.environment,
  } as Env);
}

/** The headers a client of the 2025-11-25 transport sends after `initialize`. */
const LEGACY = { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" };
let rpcId = 0;

async function rpc(method: string, params: unknown, options: Options = {}): Promise<Response> {
  return send(
    "/mcp",
    { jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) },
    { ...options, headers: { ...LEGACY, ...options.headers } },
  );
}

/** A request of the stateless 2026-07-28 revision: version in `_meta` and in the headers. */
async function modern(
  method: string,
  params: Record<string, unknown>,
  options: Options = {},
): Promise<Response> {
  const name = typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {};
  return send(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "synthetic-client", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    {
      ...options,
      headers: {
        ...MCP_CLIENT_HEADERS,
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...name,
        ...options.headers,
      },
    },
  );
}

interface ToolCall {
  isError: boolean;
  structuredContent: Record<string, any>;
  content: { type: string; text: string }[];
}

async function result(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const message = (await response.json()) as { result?: Record<string, any>; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result!;
}

async function callTool(name: string, args: unknown, options: Options = {}): Promise<ToolCall> {
  return (await result(await rpc("tools/call", { name, arguments: args }, options))) as ToolCall;
}

async function listTools(options: Options = {}): Promise<string[]> {
  const listed = await result(await rpc("tools/list", {}, options));
  return (listed["tools"] as { name: string }[]).map((tool) => tool.name);
}

async function relationCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM entity_relations").first<{
    n: number;
  }>();
  return row!.n;
}

async function opsRowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM ops_requests").first<{ n: number }>();
  return row!.n;
}

function proposal(extraEvidence = 0, reason = "synthetic proposal from an MCP client") {
  return {
    kind: "same_account",
    from: `source_account:${sourceAccounts[0]!}`,
    to: `source_account:${sourceAccounts[1]!}`,
    evidenceRefs: [
      `fetch_artifact:${String(artifactId)}`,
      ...Array.from(
        { length: extraEvidence },
        (_, index) => `observation:transaction:${index + 1}`,
      ),
    ],
    reason,
    method: "ai",
  };
}

describe("a client connects through the MCP application, in either protocol era", () => {
  it("initializes, acknowledges, lists and calls on the 2025-11-25 transport", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read"]) });
    // The first request carries no protocol header: the version is in the body.
    const opened = await send(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "synthetic-client", version: "0" },
        },
      },
      { environment, headers: MCP_CLIENT_HEADERS },
    );
    // Stateless: no session is minted, so a client sends none back.
    expect(opened.headers.get("mcp-session-id")).toBeNull();
    const init = await result(opened);
    expect(init).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "kogane-evidence-browser", version: "1" },
    });
    expect(typeof init["instructions"]).toBe("string");

    const acknowledged = await send(
      "/mcp",
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { environment, headers: LEGACY },
    );
    expect(acknowledged.status).toBe(202);
    expect(await acknowledged.text()).toBe("");

    expect(await listTools({ environment })).toEqual([...AGENT_TOOL_NAMES]);
    const capabilities = await callTool("kogane.capabilities", {}, { environment });
    expect(capabilities.isError).toBe(false);
    expect(capabilities.structuredContent).toMatchObject({
      principal: AGENT,
      capabilities: ["summary.read"],
      writes: { proposals: false, adoption: false, externalActions: false },
    });
    expect(capabilities.content).toEqual([
      { type: "text", text: JSON.stringify(capabilities.structuredContent) },
    ]);
  });

  it("negotiates the revision the client asks for when the SDK speaks it", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read"]) });
    for (const requested of ["2025-11-25", "2025-06-18", "2025-03-26"]) {
      const response = await send(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: requested,
            capabilities: {},
            clientInfo: { name: "synthetic-client", version: "0" },
          },
        },
        { environment, headers: MCP_CLIENT_HEADERS },
      );
      expect((await result(response))["protocolVersion"], requested).toBe(requested);
    }
  });

  it("serves the stateless 2026-07-28 revision with the same tools and the same answers", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read"]) });
    const discovered = await result(await modern("server/discover", {}, { environment }));
    expect(discovered["supportedVersions"]).toContain(MODERN);
    expect(discovered["capabilities"]).toMatchObject({ tools: {} });
    const listed = await result(await modern("tools/list", {}, { environment }));
    expect((listed["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual([
      ...AGENT_TOOL_NAMES,
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const current = (await result(
      await modern(
        "tools/call",
        { name: "kogane.financial.query", arguments: { intent: "coverage" } },
        { environment },
      ),
    )) as ToolCall;
    const legacy = await callTool(
      "kogane.financial.query",
      { intent: "coverage" },
      { environment },
    );
    expect(current.isError).toBe(false);
    expect(current.structuredContent).toEqual(legacy.structuredContent);
  });

  it("offers no GET stream and no session to delete", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read"]) });
    const stream = await send("/mcp", undefined, {
      environment,
      headers: { accept: "text/event-stream" },
    });
    expect(stream.status).toBe(405);
    const closed = await send("/mcp", undefined, {
      method: "DELETE",
      environment,
      headers: { "mcp-session-id": "synthetic-session" },
    });
    expect(closed.status).toBe(405);
  });

  it("refuses a cross-origin browser request before it reads a body or a grant", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read", "interpretation.propose"]) });
    const before = await relationCount();
    const viaMcp = await rpc(
      "tools/call",
      { name: "kogane.reconcile.propose", arguments: proposal() },
      { environment, headers: { origin: "https://elsewhere.invalid" } },
    );
    expect(viaMcp.status).toBe(403);
    expect(await viaMcp.json()).toMatchObject({ error: "origin_not_allowed" });
    const viaHttp = await send("/api/agent/v1/reconcile.propose", proposal(), {
      identity: { via: "app", subject: OTHER },
      environment: grants({ [OTHER]: grant(["summary.read", "interpretation.propose"]) }),
      headers: { origin: "null" },
    });
    expect(viaHttp.status).toBe(403);
    expect(await viaHttp.json()).toMatchObject({ error: "origin_not_allowed" });
    expect(await relationCount()).toBe(before);
    const same = await rpc("tools/list", {}, { environment, headers: { origin: ORIGIN } });
    expect(same.status).toBe(200);
  });

  it("runs no tool call it cannot answer, and leaves malformed traffic to the SDK's refusals", async () => {
    const environment = grants({ [AGENT]: grant(["summary.read", "interpretation.propose"]) });
    const before = await relationCount();
    // A tools/call without an id is a notification: accepted, never executed.
    const notification = await send(
      "/mcp",
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "kogane.reconcile.propose", arguments: proposal() },
      },
      { environment, headers: LEGACY },
    );
    expect(notification.status).toBe(202);
    expect(await relationCount()).toBe(before);
    // The transport's own refusals: media types, protocol header, body, bound.
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(70_000) },
    });
    const refusals: [Record<string, string>, string | undefined, number][] = [
      [{ ...LEGACY, "content-type": "text/plain" }, undefined, 415],
      [{ ...LEGACY, accept: "application/json" }, undefined, 406],
      [{ ...LEGACY, "mcp-protocol-version": "1900-01-01" }, undefined, 400],
      [LEGACY, "{", 400],
      [LEGACY, oversized, 413],
    ];
    for (const [headers, rawBody, status] of refusals) {
      const response = await send(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { headers, environment, ...(rawBody === undefined ? {} : { rawBody }) },
      );
      expect(response.status, `${JSON.stringify(headers)} ${String(rawBody?.length)}`).toBe(status);
    }
    // A method this server does not have is a JSON-RPC error, not an HTTP one.
    const missing = (await (await rpc("resources/list", {}, { environment })).json()) as {
      error: { code: number };
    };
    expect(missing.error.code).toBe(-32601);
    const unknown = (await (
      await rpc("tools/call", { name: "kogane.change.commit", arguments: {} }, { environment })
    ).json()) as { error: { code: number; message: string } };
    expect(unknown.error).toMatchObject({ code: -32602, message: "unknown_tool" });
  });

  it("publishes tool definitions that pass the checks a client makes before loading them", async () => {
    // SEP-986 names, and Claude Code's load-time checks: top-level property
    // names of 1-64 [A-Za-z0-9_.-], and no combinator at the schema root.
    const listed = await result(
      await rpc(
        "tools/list",
        {},
        {
          environment: {
            ...grants({ [AGENT]: grant(["summary.read"]) }),
            EVENTS_V2_ENABLED: "true",
          },
        },
      ),
    );
    const tools = listed["tools"] as {
      name: string;
      description: string;
      inputSchema: Record<string, any>;
    }[];
    expect(tools.length).toBe(AGENT_TOOL_NAMES.length + 1);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/u);
      expect(tool.description.length).toBeLessThanOrEqual(2048);
      expect(tool.inputSchema["type"]).toBe("object");
      for (const keyword of ["anyOf", "oneOf", "allOf", "not", "if"])
        expect(tool.inputSchema[keyword], `${tool.name} ${keyword}`).toBeUndefined();
      for (const property of Object.keys(tool.inputSchema["properties"] ?? {}))
        expect(property).toMatch(/^[A-Za-z0-9_.-]{1,64}$/u);
    }
  });
});

describe("whoever signs in through the MCP application is an agent-only principal", () => {
  // The hardest configuration: the same person is the operator, holds a full
  // read-and-propose grant under the bare subject, and the agent-only name is
  // even listed on the command path. Through the MCP application they are
  // still only `mcp-client:<sub>`, with exactly that entry's grant.
  const HOSTILE = {
    ...OPS_ENABLED,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    AGENT_GRANTS: JSON.stringify([AGENT]),
    ...grants({
      [OWNER]: grant([...READS, "interpretation.propose"]),
      [AGENT]: grant(["summary.read"]),
    }),
  };

  it("is graded by its own entry, never by the operator's", async () => {
    const report = await callTool("kogane.capabilities", {}, { environment: HOSTILE });
    expect(report.structuredContent).toMatchObject({
      principal: AGENT,
      capabilities: ["summary.read"],
      writes: { proposals: false },
    });
    const activity = await callTool(
      "kogane.financial.query",
      { intent: "activity" },
      { environment: HOSTILE },
    );
    expect(activity.structuredContent).toMatchObject({
      code: "unauthorized",
      refs: ["capability:records.read"],
    });
    const before = await relationCount();
    const proposed = await callTool("kogane.reconcile.propose", proposal(), {
      environment: HOSTILE,
    });
    expect(proposed.structuredContent).toMatchObject({ code: "unauthorized" });
    expect(await relationCount()).toBe(before);
    // Without its own entry it has nothing: the bare subject's grant is not a fallback.
    const bare = await rpc(
      "tools/list",
      {},
      { environment: { ...HOSTILE, ...grants({ [OWNER]: grant(READS) }) } },
    );
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({ error: "agent_api_not_configured" });
  });

  it("is never offered, and can never reach, an operations tool", async () => {
    expect(await listTools({ environment: HOSTILE })).toEqual([...AGENT_TOOL_NAMES]);
    const before = await opsRowCount();
    for (const [name, args] of [
      ["kogane.ops.collection.request", COLLECTION],
      ["kogane.ops.operation.get", { operationId: "op_synthetic" }],
    ] as const) {
      const called = (await (
        await rpc("tools/call", { name, arguments: args }, { environment: HOSTILE })
      ).json()) as { error: unknown };
      expect(called.error, name).toEqual({ code: -32602, message: "unknown_tool" });
    }
    expect(await opsRowCount()).toBe(before);
    // The same person through the browser application is still the operator
    // there: the operator's application is unchanged.
    const operator = await listTools({
      environment: HOSTILE,
      identity: { via: "app", subject: OWNER },
    });
    expect(operator.filter((name) => name.startsWith("kogane.ops."))).toHaveLength(6);
  });

  it("is refused by every grader downstream, whatever the lists say", async () => {
    const lists: Record<string, string>[] = [
      { OPERATOR_SUBJECTS: JSON.stringify([AGENT]) },
      { OPERATOR_SUBJECTS: JSON.stringify([OWNER]), AGENT_GRANTS: JSON.stringify([AGENT]) },
      {},
    ];
    for (const vars of lists) {
      const deployment = { ...env, ...OPS_ENABLED, ...vars } as Env;
      expect(() => principalFor(vars, AGENT), JSON.stringify(vars)).toThrow(
        new HttpError(403, "actor_not_supported"),
      );
      expect(() => opsContext(deployment, AGENT)).toThrow(
        new HttpError(403, "actor_not_supported"),
      );
      const before = await opsRowCount();
      const outcome = await callOpsTool(
        "kogane.ops.collection.request",
        COLLECTION,
        deployment,
        AGENT,
      );
      expect(outcome).toEqual({ status: 403, body: { error: "actor_not_supported" } });
      expect(await opsRowCount()).toBe(before);
    }
  });

  it("reaches no route but /mcp", async () => {
    const paths: [string, string][] = [
      ["GET", "/api/v2/query?intent=coverage"],
      ["GET", "/api/meta"],
      ["GET", "/api/overview"],
      ["GET", "/api/identity/accounts?offset=0"],
      ["GET", `/api/evidence/v1/runs/r_1/artifacts/a_${String(artifactId)}/raw`],
      ["POST", "/api/agent/v1/capabilities"],
      ["POST", "/api/command/v1"],
      ["POST", "/api/ops/v1/collections"],
      ["GET", "/api/ops/v1/health"],
      ["GET", "/"],
    ];
    for (const [method, path] of paths) {
      const response = await send(path, method === "POST" ? {} : undefined, {
        method,
        environment: HOSTILE,
      });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ error: "authentication_required" });
    }
  });

  it("records the agent-only principal, never the operator, as a proposal's actor", async () => {
    const environment = {
      ...HOSTILE,
      ...grants({ [AGENT]: grant(["summary.read", "interpretation.propose"]) }),
    };
    const outcome = await callTool(
      "kogane.reconcile.propose",
      proposal(0, "a proposal whose actor is pinned"),
      { environment },
    );
    const receipt = outcome.structuredContent as { relationId: string };
    const stored = await env.DB.prepare(
      `SELECT r.status, d.decision_kind, d.method, d.actor_id FROM entity_relations r
       JOIN decision_revisions d ON d.id = r.decision_revision_id WHERE r.id = ?`,
    )
      .bind(receipt.relationId)
      .first<Record<string, string>>();
    expect(stored).toEqual({
      status: "proposed",
      decision_kind: "propose",
      method: "ai",
      actor_id: AGENT,
    });
  });

  it("fails closed on the audience configuration and on ambiguous or borrowed identities", async () => {
    const environment = grants({ [AGENT]: grant(READS), [OWNER]: grant(READS) });
    const token = "0123456789abcdef0123456789abcdef.access";
    const cases: [Options, number, string][] = [
      // No MCP application configured: its assertions are accepted nowhere.
      [
        { environment: { ...environment, ACCESS_MCP_AUDIENCE: "" } },
        401,
        "authentication_required",
      ],
      // The MCP application may not share the browser application's audience.
      [
        { environment: { ...environment, ACCESS_MCP_AUDIENCE: APP_AUD } },
        503,
        "auth_not_configured",
      ],
      [
        { environment: { ...environment, ACCESS_MCP_AUDIENCE: ` ${MCP_AUD}` } },
        503,
        "auth_not_configured",
      ],
      // One assertion for both applications has no defined role.
      [{ environment, identity: { via: "both", subject: OWNER } }, 401, "authentication_required"],
      // A browser subject cannot claim the agent-only namespace.
      [{ environment, identity: { via: "app", subject: AGENT } }, 403, "actor_not_supported"],
      // A service token is not the client path, through either application.
      [
        { environment, identity: { via: "mcp", serviceToken: token } },
        401,
        "authentication_required",
      ],
      [
        { environment, identity: { via: "app", serviceToken: token } },
        401,
        "authentication_required",
      ],
      // No assertion, and one signed by another key.
      [{ environment, identity: null }, 401, "authentication_required"],
      [{ environment, identity: { forged: true } }, 401, "authentication_required"],
    ];
    for (const [options, status, code] of cases) {
      const response = await rpc("tools/list", {}, options);
      expect(response.status, JSON.stringify(options)).toBe(status);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });
});

describe("tools under each grant shape", () => {
  const shapes: [string, string[]][] = [
    ["no capability", []],
    ["summary.read", ["summary.read"]],
    ["records.read", ["records.read"]],
    ["evidence.read", ["evidence.read"]],
    ["interpretation.propose", ["interpretation.propose"]],
  ];
  for (const [label, capabilities] of shapes) {
    it(`lists the deployment's tools and grades each call: ${label}`, async () => {
      const environment = grants({ [AGENT]: grant(capabilities) });
      // The list describes this deployment; the grant is enforced on the call
      // and described by kogane.capabilities.
      expect(await listTools({ environment })).toEqual([...AGENT_TOOL_NAMES]);
      const report = await callTool("kogane.capabilities", {}, { environment });
      expect(report.structuredContent["capabilities"]).toEqual(capabilities);
      const expected: [string, unknown, string][] = [
        ["kogane.financial.query", { intent: "coverage" }, "summary.read"],
        ["kogane.financial.query", { intent: "activity" }, "records.read"],
        ["kogane.explain", { ref: "source:other-test" }, "summary.read"],
      ];
      for (const [tool, args, requires] of expected) {
        const outcome = await callTool(tool, args, { environment });
        if (capabilities.includes(requires)) {
          expect(outcome.isError, `${tool} ${JSON.stringify(args)}`).toBe(false);
        } else {
          expect(outcome.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
          expect(outcome.structuredContent).toMatchObject({
            code: "unauthorized",
            refs: [`capability:${requires}`],
          });
        }
      }
      const before = await relationCount();
      const proposed = await callTool(
        "kogane.reconcile.propose",
        proposal(0, `a proposal under ${label}`),
        { environment },
      );
      if (capabilities.includes("interpretation.propose")) {
        expect(proposed.isError).toBe(false);
        expect(proposed.structuredContent).toMatchObject({ status: "proposed", adopted: false });
        expect(await relationCount()).toBe(before + 1);
      } else {
        expect(proposed.structuredContent).toMatchObject({
          code: "unauthorized",
          refs: ["capability:interpretation.propose"],
        });
        expect(await relationCount()).toBe(before);
      }
    });
  }
});

describe("refusals a client sees", () => {
  it("scope: a source outside the grant is refused, as a row outside it is", async () => {
    const environment = grants({
      [AGENT]: grant(READS, { sources: ["other-test"], accounts: "*" }),
    });
    const filtered = await callTool(
      "kogane.financial.query",
      { intent: "coverage", filters: { source: "sony-bank" } },
      { environment },
    );
    expect(filtered.isError).toBe(true);
    expect(filtered.structuredContent).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:source"],
    });
    const explained = await callTool(
      "kogane.explain",
      { ref: "source:sony-bank" },
      { environment },
    );
    expect(explained.structuredContent).toMatchObject({ code: "evidence_restricted" });
    const inside = await callTool(
      "kogane.financial.query",
      { intent: "coverage" },
      { environment },
    );
    expect(inside.isError).toBe(false);
    expect(JSON.stringify(inside.structuredContent)).not.toContain("sony-bank");
  });

  it("raw evidence: no raw locator without evidence.read", async () => {
    const rows = await callTool(
      "kogane.financial.query",
      { intent: "activity" },
      { environment: grants({ [AGENT]: grant(READS) }) },
    );
    const ref = (
      rows.structuredContent["result"]["data"]["rows"] as { observationRef: string }[]
    )[0]!.observationRef;
    const closed = await callTool(
      "kogane.explain",
      { ref },
      { environment: grants({ [AGENT]: grant(["summary.read", "records.read"]) }) },
    );
    expect(closed.isError).toBe(false);
    expect(closed.structuredContent["restricted"]).toEqual(["evidence.read"]);
    expect(
      (closed.structuredContent["nodes"] as { kind: string }[]).some(
        (node) => node.kind === "raw-locator",
      ),
    ).toBe(false);
    const open = await callTool(
      "kogane.explain",
      { ref },
      { environment: grants({ [AGENT]: grant(READS) }) },
    );
    expect(
      (open.structuredContent["nodes"] as { kind: string }[]).some(
        (node) => node.kind === "raw-locator",
      ),
    ).toBe(true);
  });

  it("budget: a page or a proposal beyond the grant is refused, never truncated", async () => {
    const environment = grants({
      [AGENT]: grant(READS.concat("interpretation.propose"), WHOLE, {
        maxRows: 10,
        maxProposalTargets: 3,
        maxExplainDepth: 2,
      }),
    });
    const page = await callTool(
      "kogane.financial.query",
      { intent: "activity", limit: 50 },
      { environment },
    );
    expect(page.isError).toBe(true);
    expect(page.structuredContent).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=10"],
    });
    const before = await relationCount();
    const wide = await callTool("kogane.reconcile.propose", proposal(1), { environment });
    expect(wide.structuredContent).toMatchObject({ code: "budget_exceeded" });
    expect(await relationCount()).toBe(before);
  });
});

describe("the UI, HTTP and MCP return one result (AT72)", () => {
  it("returns the same object and the same gap reasons on every path and era", async () => {
    // Every answer is evaluated at one instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    // The same perimeter and read capabilities the browser reader holds.
    const environment = grants({ [AGENT]: grant(READS), [OTHER]: grant(READS) });
    const browser = { via: "app" as const, subject: OTHER };
    for (const intent of ["coverage", "holdings", "activity", "reported-state"]) {
      const ui = await send(`/api/v2/query?intent=${intent}`, undefined, {
        environment,
        identity: browser,
      });
      const http = await send(
        "/api/agent/v1/financial.query",
        { intent },
        { environment, identity: browser },
      );
      const legacy = await callTool("kogane.financial.query", { intent }, { environment });
      const current = (await result(
        await modern(
          "tools/call",
          { name: "kogane.financial.query", arguments: { intent } },
          { environment },
        ),
      )) as ToolCall;
      expect(ui.status, intent).toBe(200);
      expect(http.status, intent).toBe(200);
      const uiBody = (await ui.json()) as Record<string, any>;
      const httpBody = (await http.json()) as Record<string, any>;
      expect(legacy.isError).toBe(false);
      expect(legacy.structuredContent, intent).toEqual(httpBody);
      expect(current.structuredContent, intent).toEqual(httpBody);
      expect(uiBody, intent).toEqual(httpBody);
      const reasons = (body: Record<string, any>) =>
        (body["result"]["coverage"]["gaps"] as { reasonCode: string }[]).map(
          (gap) => gap.reasonCode,
        );
      expect(reasons(legacy.structuredContent), intent).toEqual(reasons(uiBody));
    }
    // `holdings` has no projection in this store: the reason is named, never a zero.
    const holdings = await callTool(
      "kogane.financial.query",
      { intent: "holdings" },
      { environment },
    );
    expect(holdings.structuredContent["result"]["completeness"]).toBe("unavailable");
    expect(
      (holdings.structuredContent["result"]["coverage"]["gaps"] as { reasonCode: string }[]).map(
        (gap) => gap.reasonCode,
      ),
    ).toContain("projection_not_built");
  });

  it("returns one refusal object over HTTP and MCP", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const narrow = grant(["summary.read"], { sources: ["other-test"], accounts: "*" });
    const environment = grants({ [AGENT]: narrow, [OTHER]: narrow });
    for (const [tool, args] of [
      ["financial.query", { intent: "activity" }],
      ["financial.query", { intent: "coverage", filters: { source: "sony-bank" } }],
      ["explain", { ref: "source:sony-bank" }],
      ["reconcile.propose", proposal()],
    ] as const) {
      const http = await send(`/api/agent/v1/${tool}`, args, {
        environment,
        identity: { via: "app", subject: OTHER },
      });
      const viaMcp = await callTool(`kogane.${tool}`, args, { environment });
      expect(http.status, tool).toBeGreaterThanOrEqual(400);
      expect(viaMcp.isError, tool).toBe(true);
      expect(viaMcp.structuredContent, tool).toEqual(await http.json());
    }
  });
});
