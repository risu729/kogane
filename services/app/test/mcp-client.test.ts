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
//     is the agent-only principal `mcp-client:<sub>`: it reads and proposes
//     with the whole-store grant (ADR 0084, nothing configures it), is never
//     re-classified as the operator by `principalFor`, `opsContext` or
//     `callOpsTool`, and is refused on every non-agent route;
//   * the operator's own application and its routes are unchanged;
//   * tools/list, tools/call and the refusals a client sees. How a narrower
//     grant hides what it cannot see (matrix 5, 6) is the shared services',
//     tested in packages/application (query, explain-propose, context).
//   * the UI's query route, the HTTP agent route and MCP (both eras) return
//     one result object with the same gap reasons.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  AGENT_TOOL_NAMES,
  PURCHASES_TOOL_NAME,
  RECONSTRUCTED_STATE_TOOL_NAME,
} from "../src/agent-service";
import { principalFor } from "../src/grants";
import { HttpError } from "../src/http";
import { REPORTED_STATE_TOOL_NAME } from "../src/read-tools";
import { opsContext } from "../src/ops-api";
import { callOpsTool } from "../src/ops-tools";
import { GRANT_LIMITS, QUERY_GRANT_CAPABILITIES } from "../../../packages/application/src/index";
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

const OPS_ENABLED = { OPS_API_ENABLED: "true", COMMANDS_ENABLED: "true" };
/** Every capability of the whole-store grant each proved caller gets (ADR 0084). */
const FULL = [...QUERY_GRANT_CAPABILITIES];
/**
 * What this deployment publishes on `/mcp` to every MCP client: the agent
 * tools, every read tool the whole-store grant answers, the purchase
 * explanation (CORE 0047 is applied here; the retired `EVENTS_V2_ENABLED`
 * name is not read), and, because this store has the reported state's views,
 * the reconstructed state's read.
 */
const PUBLISHED = [
  ...AGENT_TOOL_NAMES,
  "kogane.instruments.history",
  REPORTED_STATE_TOOL_NAME,
  "kogane.instruments.coverage",
  "kogane.accounts.candidates",
  "kogane.card-settlements.unmatched",
  "kogane.economic-readiness.read",
  "kogane.card-settlements.read",
  "kogane.card-settlements.statements",
  "kogane.card-settlements.ownership",
  "kogane.audit.search",
  "kogane.audit.get",
  "kogane.identity.read",
  PURCHASES_TOOL_NAME,
  RECONSTRUCTED_STATE_TOOL_NAME,
];

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let strangerKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let artifactId = 0;
const sourceAccounts: string[] = [];
/** The first artifact of each seeded source, for adding parse runs later. */
const artifactOf: Record<string, number> = {};

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
    artifactOf[source] = run.artifacts[0].id;
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
  | {
      via: "app" | "mcp" | "both" | "other";
      subject: string;
      /** Another Access team's issuer. */
      foreignIssuer?: boolean;
      expired?: boolean;
    }
  | { via: "app" | "mcp"; serviceToken: string }
  | { forged: true }
  | null;

const AUDIENCES = {
  app: APP_AUD,
  mcp: MCP_AUD,
  both: [APP_AUD, MCP_AUD],
  other: "fixture-other-audience",
} as const;

async function assertion(identity: Exclude<Identity, null>): Promise<string> {
  const claims: Record<string, unknown> = { type: "app" };
  if ("serviceToken" in identity) claims["common_name"] = identity.serviceToken;
  const via = "via" in identity ? identity.via : "mcp";
  const foreign = "foreignIssuer" in identity && identity.foreignIssuer === true;
  const expired = "expired" in identity && identity.expired === true;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(foreign ? "https://another-team.cloudflareaccess.com" : issuer)
    .setAudience([...[AUDIENCES[via]].flat()])
    .setSubject("subject" in identity ? identity.subject : "")
    .setIssuedAt(expired ? now - 900 : now)
    .setExpirationTime(expired ? now - 600 : now + 300)
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
    const environment = {};
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

    expect(await listTools({ environment })).toEqual(PUBLISHED);
    const capabilities = await callTool("kogane.capabilities", {}, { environment });
    expect(capabilities.isError).toBe(false);
    expect(capabilities.structuredContent).toMatchObject({
      principal: AGENT,
      capabilities: FULL,
      writes: { proposals: true, adoption: false, externalActions: false },
    });
    expect(capabilities.content).toEqual([
      { type: "text", text: JSON.stringify(capabilities.structuredContent) },
    ]);
  });

  it("negotiates the revision the client asks for when the SDK speaks it", async () => {
    const environment = {};
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
    const environment = {};
    const discovered = await result(await modern("server/discover", {}, { environment }));
    expect(discovered["supportedVersions"]).toContain(MODERN);
    expect(discovered["capabilities"]).toMatchObject({ tools: {} });
    const listed = await result(await modern("tools/list", {}, { environment }));
    expect((listed["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual(PUBLISHED);
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
    const environment = {};
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
    const environment = {};
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
      environment,
      headers: { origin: "null" },
    });
    expect(viaHttp.status).toBe(403);
    expect(await viaHttp.json()).toMatchObject({ error: "origin_not_allowed" });
    expect(await relationCount()).toBe(before);
    const same = await rpc("tools/list", {}, { environment, headers: { origin: ORIGIN } });
    expect(same.status).toBe(200);
  });

  it("runs no tool call it cannot answer, and leaves malformed traffic to the SDK's refusals", async () => {
    const environment = {};
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
          environment: { EVENTS_V2_ENABLED: "true" },
        },
      ),
    );
    const tools = listed["tools"] as {
      name: string;
      description: string;
      inputSchema: Record<string, any>;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual(PUBLISHED);
    // The retired name neither adds a tool nor hides the purchase explanation.
    expect(
      await listTools({
        environment: { EVENTS_V2_ENABLED: "0" },
      }),
    ).toEqual(PUBLISHED);
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

describe("the same person: operator in the browser, agent-only through MCP (matrix 1)", () => {
  // The hardest configuration: the same person is the operator, and the
  // agent-only name is even listed on the command path. Through the MCP
  // application they are still only `mcp-client:<sub>`.
  const HOSTILE = {
    ...OPS_ENABLED,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    AGENT_GRANTS: JSON.stringify([AGENT]),
  };
  const browser = { via: "app" as const, subject: OWNER };

  it("reads and proposes on /mcp as itself, never as the operator", async () => {
    const report = await callTool("kogane.capabilities", {}, { environment: HOSTILE });
    expect(report.structuredContent).toMatchObject({
      principal: AGENT,
      capabilities: FULL,
      writes: { proposals: true, adoption: false, externalActions: false },
    });
    const activity = await callTool(
      "kogane.financial.query",
      { intent: "activity" },
      { environment: HOSTILE },
    );
    expect(activity.isError).toBe(false);
    for (const [name, args] of [
      ["kogane.instruments.candidates", {}],
      [PURCHASES_TOOL_NAME, {}],
    ] as const) {
      const served = await callTool(name, args, { environment: HOSTILE });
      expect(served.isError, name).toBe(false);
    }
  });

  it("keeps the operator's rights on the browser's own routes", async () => {
    // The HTTP agent route answers the bare subject, with the same whole-store grant.
    const http = await send(
      "/api/agent/v1/capabilities",
      {},
      {
        environment: HOSTILE,
        identity: browser,
      },
    );
    expect(await http.json()).toMatchObject({ principal: OWNER, capabilities: FULL });
    // The operations route still accepts the operator's request.
    const before = await opsRowCount();
    const accepted = await send("/api/ops/v1/collections", COLLECTION, {
      environment: HOSTILE,
      identity: browser,
    });
    expect(accepted.status).toBe(202);
    expect(await opsRowCount()).toBe(before + 1);
    // And the browser routes answer.
    for (const path of ["/api/v2/query?intent=coverage", "/api/meta"]) {
      const read = await send(path, undefined, { environment: HOSTILE, identity: browser });
      expect(read.status, path).toBe(200);
    }
  });

  // ADR 0084: every MCP client is offered the operations tools as itself,
  // never as the operator, whatever the command lists say.
  const OPS_TOOLS = [
    "kogane.ops.collection.request",
    "kogane.ops.import.request",
    "kogane.ops.replay.request",
    "kogane.ops.projection.request",
    "kogane.ops.session.refresh",
    "kogane.ops.operation.get",
  ];
  it("offers the operations tools to every MCP client, whatever the command lists say", async () => {
    for (const environment of [
      HOSTILE,
      { ...HOSTILE, OPERATOR_SUBJECTS: "[]" },
      { ...HOSTILE, OPERATOR_SUBJECTS: "{" },
    ]) {
      const listed = await listTools({ environment });
      expect(listed.filter((name) => name.startsWith("kogane.ops."))).toEqual(OPS_TOOLS);
    }
    const stranger = { ...HOSTILE, OPERATOR_SUBJECTS: "[]" };
    const read = await callTool(
      "kogane.ops.operation.get",
      { operationId: "op_synthetic" },
      { environment: stranger, identity: { via: "mcp", subject: OTHER } },
    );
    expect(read.structuredContent).not.toEqual({ error: "delegation_not_configured" });
  });

  it("is refused by every grader downstream, whatever the lists say", async () => {
    const lists: Record<string, string>[] = [
      { OPERATOR_SUBJECTS: JSON.stringify([AGENT]) },
      { OPERATOR_SUBJECTS: JSON.stringify([OWNER]), AGENT_GRANTS: JSON.stringify([AGENT]) },
      {},
    ];
    for (const vars of lists) {
      const deployment = { ...env, ...OPS_ENABLED, ...vars } as Env;
      // `callOpsTool` receives the caller object and refuses it before any grader.
      const before = await opsRowCount();
      const outcome = await callOpsTool("kogane.ops.collection.request", COLLECTION, deployment, {
        kind: "mcp-client",
        principal: AGENT,
      });
      expect(outcome).toEqual({ status: 403, body: { error: "delegation_not_configured" } });
      expect(await opsRowCount()).toBe(before);
      // Even the agent-only name as a bare string is never graded.
      expect(() => principalFor(vars, AGENT), JSON.stringify(vars)).toThrow(
        new HttpError(403, "actor_not_supported"),
      );
      expect(() => opsContext(deployment, AGENT)).toThrow(
        new HttpError(403, "actor_not_supported"),
      );
    }
  });

  it("records the agent-only principal as a proposal's actor, whatever the request claims (matrix 7)", async () => {
    const environment = HOSTILE;
    // A body that names an actor is refused by the closed schema, and writes nothing.
    const before = await relationCount();
    const claimed = await callTool(
      "kogane.reconcile.propose",
      { ...proposal(0, "a proposal that claims an actor"), actor: OWNER },
      { environment },
    );
    expect(claimed.structuredContent).toMatchObject({ code: "unsupported_semantics" });
    expect(await relationCount()).toBe(before);
    // A header that names one is ignored.
    const outcome = await callTool(
      "kogane.reconcile.propose",
      proposal(0, "a proposal whose actor is pinned"),
      { environment, headers: { "x-kogane-verified-actor": OWNER } },
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

  it("changes no adopted answer through a proposal (matrix 7, AT68)", async () => {
    const environment = {};
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const answers = async () => {
      const collected: unknown[] = [];
      for (const intent of ["coverage", "reported-state", "activity", "holdings"]) {
        const outcome = await callTool("kogane.financial.query", { intent }, { environment });
        collected.push(outcome.structuredContent["result"]["data"]);
      }
      return collected;
    };
    const before = await answers();
    const proposed = await callTool(
      "kogane.reconcile.propose",
      proposal(0, "a proposal that must not change adopted state"),
      { environment },
    );
    expect(proposed.structuredContent).toMatchObject({ status: "proposed", adopted: false });
    expect(await answers()).toEqual(before);
  });
});

describe("a token minted for MCP reaches no other route, and /mcp takes no other token (matrix 2, 3)", () => {
  const environment = {
    ...OPS_ENABLED,
    SCHEDULES_ENABLED: "true",
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
  };

  it("refuses an MCP-application token on every ordinary route", async () => {
    const routes: [string, string, unknown][] = [
      ["POST", "/api/command/v1/plan", {}],
      ["POST", "/api/command/v1/approve", {}],
      ["POST", "/api/command/v1/commit", {}],
      ["GET", "/api/v2/reconciliation/card-settlements", undefined],
      ["GET", "/api/v2/reconciliation/card-settlements/ownership", undefined],
      ["GET", "/api/v2/reconciliation/card-settlements/statements", undefined],
      ["GET", "/api/v2/card-purchases", undefined],
      ["GET", "/api/v2/reported-state", undefined],
      ["GET", "/api/v2/reported-holdings-change?from=2026-03-01&to=2026-03-31", undefined],
      ["GET", "/api/collection-quality", undefined],
      ["POST", "/api/ops/v1/collections", COLLECTION],
      ["GET", "/api/ops/v1/operations/op_synthetic", undefined],
      ["GET", "/api/ops/v1/health", undefined],
      ["GET", "/api/ops/v1/schedules", undefined],
      ["POST", "/api/ops/v1/schedules/bootstrap", undefined],
      ["GET", "/api/overview", undefined],
      ["GET", "/api/meta", undefined],
      ["GET", "/api/identity/accounts?offset=0", undefined],
      ["GET", "/api/identity/instrument-candidates", undefined],
      [
        "GET",
        "/api/v2/reconstructed-state?account=acct-x&from=2026-03-01&to=2026-03-31",
        undefined,
      ],
      ["GET", "/api/v2/query?intent=coverage", undefined],
      ["GET", `/api/evidence/v1/runs/r_1/artifacts/a_${String(artifactId)}/raw`, undefined],
      ["POST", "/api/agent/v1/capabilities", {}],
      ["GET", "/", undefined],
    ];
    for (const identity of [
      { via: "mcp" as const, subject: OWNER },
      { via: "both" as const, subject: OWNER },
    ]) {
      for (const [method, path, body] of routes) {
        const response = await send(path, body, { method, environment, identity });
        expect(response.status, `${identity.via} ${method} ${path}`).toBe(401);
        expect(await response.json()).toMatchObject({ error: "authentication_required" });
      }
    }
    // The same routes with the browser's own token answer as before.
    const operator = await send("/api/v2/query?intent=coverage", undefined, {
      environment,
      identity: { via: "app", subject: OWNER },
    });
    expect(operator.status).toBe(200);
  });

  it("accepts only an assertion for the MCP application at /mcp", async () => {
    const token = "0123456789abcdef0123456789abcdef.access";
    const refused: [Identity, string][] = [
      [{ via: "app", subject: OWNER }, "the browser application's audience"],
      [{ via: "both", subject: OWNER }, "both audiences"],
      [{ via: "other", subject: OWNER }, "another application's audience"],
      [{ via: "mcp", subject: OWNER, foreignIssuer: true }, "another issuer"],
      [{ via: "mcp", subject: OWNER, expired: true }, "an expired assertion"],
      [{ forged: true }, "a signature by another key"],
      [{ via: "mcp", serviceToken: token }, "a service token through the MCP application"],
      [{ via: "app", serviceToken: token }, "a service token through the browser application"],
      [{ via: "mcp", subject: AGENT }, "a subject in the agent-only namespace"],
      [null, "no assertion"],
    ];
    for (const [identity, label] of refused) {
      const response = await rpc("tools/list", {}, { environment, identity });
      expect(response.status, label).toBe(401);
      expect(await response.json()).toMatchObject({ error: "authentication_required" });
    }
    // A forged header on a request without a valid assertion changes nothing.
    const spoofed = await rpc(
      "tools/list",
      {},
      {
        environment,
        identity: null,
        headers: {
          "x-kogane-verified-actor": OWNER,
          "cf-access-authenticated-user-email": "x@example.invalid",
        },
      },
    );
    expect(spoofed.status).toBe(401);
    expect((await rpc("tools/list", {}, { environment })).status).toBe(200);
  });

  it("fails closed on the MCP audience configuration", async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      // No MCP application configured: /mcp accepts nothing.
      [{ ACCESS_MCP_AUDIENCE: "" }, 401, "authentication_required"],
      [{ ACCESS_MCP_AUDIENCE: undefined }, 401, "authentication_required"],
      // The MCP application may not share the browser application's audience.
      [{ ACCESS_MCP_AUDIENCE: APP_AUD }, 503, "auth_not_configured"],
      [{ ACCESS_MCP_AUDIENCE: ` ${MCP_AUD}` }, 503, "auth_not_configured"],
      [{ ACCESS_MCP_AUDIENCE: "x".repeat(257) }, 503, "auth_not_configured"],
    ];
    for (const [vars, status, code] of cases) {
      const response = await rpc("tools/list", {}, { environment: { ...environment, ...vars } });
      expect(response.status, JSON.stringify(vars)).toBe(status);
      expect(await response.json()).toMatchObject({ error: code });
    }
    // A misconfigured MCP audience never takes the browser application down.
    const ui = await send("/api/v2/query?intent=coverage", undefined, {
      environment: { ...environment, ACCESS_MCP_AUDIENCE: APP_AUD },
      identity: { via: "app", subject: OWNER },
    });
    expect(ui.status).toBe(200);
  });

  it("refuses a browser subject that claims the agent-only namespace on the HTTP agent routes", async () => {
    const response = await send(
      "/api/agent/v1/capabilities",
      {},
      {
        environment,
        identity: { via: "app", subject: AGENT },
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "actor_not_supported" });
  });
});

describe("no table grants an MCP client (matrix 4, ADR 0084)", () => {
  it("serves the same tools whatever a leftover AGENT_API_GRANTS says", async () => {
    for (const leftover of [
      "",
      "{",
      JSON.stringify([AGENT]),
      JSON.stringify({ [`mcp-client:${OTHER}`]: { capabilities: [] } }),
    ]) {
      expect(await listTools({ environment: { AGENT_API_GRANTS: leftover } }), leftover).toEqual(
        PUBLISHED,
      );
      const report = await callTool(
        "kogane.capabilities",
        {},
        { environment: { AGENT_API_GRANTS: leftover } },
      );
      expect(report.structuredContent["capabilities"], leftover).toEqual(FULL);
    }
  });
});

describe("a tool that is not published cannot be called (matrix 8)", () => {
  it("answers unknown_tool, or the caller's refusal, and runs nothing", async () => {
    const environment = {};
    const before = { relations: await relationCount(), ops: await opsRowCount() };
    for (const name of [
      "kogane.change.commit",
      "kogane.change.approve",
      "kogane.ops.collection.request",
      "tools/call",
      "",
    ]) {
      const response = await rpc("tools/call", { name, arguments: {} }, { environment });
      const message = (await response.json()) as { error?: { code: number; message: string } };
      expect(message.error, name).toMatchObject({ code: -32602 });
    }
    // CORE 0047 is applied, so the purchase explanation is published and
    // callable with the flag unset and with the retired name off.
    for (const retired of [undefined, "0", "true"]) {
      const withFlag =
        retired === undefined ? environment : { ...environment, EVENTS_V2_ENABLED: retired };
      expect(await listTools({ environment: withFlag }), String(retired)).toContain(
        PURCHASES_TOOL_NAME,
      );
      const explained = await callTool(PURCHASES_TOOL_NAME, {}, { environment: withFlag });
      expect(explained.isError, String(retired)).toBe(false);
    }
    expect({ relations: await relationCount(), ops: await opsRowCount() }).toEqual(before);
  });
});

describe("refusals a client sees", () => {
  it("raw evidence: the whole-store grant reaches a raw locator", async () => {
    const rows = await callTool("kogane.financial.query", { intent: "activity" });
    const ref = (
      rows.structuredContent["result"]["data"]["rows"] as { observationRef: string }[]
    )[0]!.observationRef;
    const open = await callTool("kogane.explain", { ref });
    expect(open.structuredContent["restricted"] ?? []).toEqual([]);
    expect(
      (open.structuredContent["nodes"] as { kind: string }[]).some(
        (node) => node.kind === "raw-locator",
      ),
    ).toBe(true);
  });

  it("budget: a proposal beyond the published targets is refused and writes nothing", async () => {
    const before = await relationCount();
    const wide = await callTool(
      "kogane.reconcile.propose",
      proposal(GRANT_LIMITS.maxProposalTargets),
    );
    expect(wide.isError).toBe(true);
    expect(await relationCount()).toBe(before);
  });
});

describe("the UI, HTTP and MCP return one result (AT72)", () => {
  it("returns the same object and the same gap reasons on every path and era", async () => {
    // Every answer is evaluated at one instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    // The same perimeter and read capabilities the browser reader holds.
    const environment = {};
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
    for (const [tool, args] of [
      ["financial.query", { intent: "net-worth" }],
      ["financial.query", { intent: "activity", limit: GRANT_LIMITS.maxRows + 1 }],
      ["explain", { ref: "observation:transaction:999999" }],
      ["reconcile.propose", { ...proposal(), evidenceRefs: ["observation:transaction:999999"] }],
    ] as const) {
      // The browser session as the operator holds the MCP client's grant.
      const http = await send(`/api/agent/v1/${tool}`, args, {
        identity: { via: "app", subject: OTHER },
        environment: { OPERATOR_SUBJECTS: JSON.stringify([OTHER]) },
      });
      const viaMcp = await callTool(`kogane.${tool}`, args);
      expect(http.status, tool).toBeGreaterThanOrEqual(400);
      expect(viaMcp.isError, tool).toBe(true);
      expect(viaMcp.structuredContent, tool).toEqual(await http.json());
    }
  });
});

describe("an internal failure leaves only a closed code (G3-08)", () => {
  /** A store that fails with a message that must never reach a client. */
  const DETAIL = "synthetic-internal-detail";
  const failing = (): D1Database =>
    new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return () => {
            throw new Error(`D1_ERROR: ${DETAIL}`);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  it("answers a tool's or the tool list's exception as the Worker does on every route", async () => {
    const environment = {
      EVENTS_V2_ENABLED: "true",
      DB: failing(),
    };
    const log = vi.spyOn(console, "log");
    const answers: [string, Response][] = [
      [
        "2025-11-25 tools/call",
        await rpc("tools/call", { name: "kogane.context.open", arguments: {} }, { environment }),
      ],
      [
        "2026-07-28 tools/call",
        await modern("tools/call", { name: "kogane.context.open", arguments: {} }, { environment }),
      ],
      // The tool list asks the store whether purchases are served.
      ["2025-11-25 tools/list", await rpc("tools/list", {}, { environment })],
      ["2026-07-28 tools/list", await modern("tools/list", {}, { environment })],
      [
        "HTTP agent route",
        await send(
          "/api/agent/v1/context.open",
          {},
          {
            environment,
            identity: { via: "app", subject: OTHER },
          },
        ),
      ],
    ];
    for (const [label, response] of answers) {
      expect(response.status, label).toBe(500);
      const text = await response.text();
      expect(text, label).not.toContain(DETAIL);
      expect(JSON.parse(text), label).toEqual({
        error: "internal_error",
        requestId: expect.any(String),
      });
    }
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, any>);
    expect(lines.map((line) => [line["route"], line["status"], line["errorCode"]])).toEqual([
      ["mcp", 500, "internal_error"],
      ["mcp", 500, "internal_error"],
      ["mcp", 500, "internal_error"],
      ["mcp", 500, "internal_error"],
      ["agent_context_open", 500, "internal_error"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(DETAIL);
  });

  it("writes nothing to the log but the request line, in either era", async () => {
    const environment = {};
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    await callTool("kogane.capabilities", {}, { environment });
    await result(
      await modern("tools/call", { name: "kogane.capabilities", arguments: {} }, { environment }),
    );
    await result(await modern("tools/list", {}, { environment }));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(
      log.mock.calls.map(([line]) => (JSON.parse(String(line)) as { event: string }).event),
    ).toEqual(["evidence_request", "evidence_request", "evidence_request"]);
  });
});
