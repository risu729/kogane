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
import {
  AGENT_TOOL_NAMES,
  PURCHASES_TOOL_NAME,
  RECONSTRUCTED_STATE_TOOL_NAME,
} from "../src/agent-service";
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
/**
 * What this deployment publishes on `/mcp` to every grant: the agent tools,
 * the purchase explanation (CORE 0047 is applied here; the retired
 * `EVENTS_V2_ENABLED` name is not read), and, because this store has the
 * reported state's views, the reconstructed state's read.
 */
const PUBLISHED = [...AGENT_TOOL_NAMES, PURCHASES_TOOL_NAME, RECONSTRUCTED_STATE_TOOL_NAME];
/** A valid reconstructed-state request for an account the store does not hold. */
const RECONSTRUCTED = { account: "acct-mcp-synthetic", from: "2026-03-01", to: "2026-03-31" };

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

    expect(await listTools({ environment })).toEqual(PUBLISHED);
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
    expect(tools.map((tool) => tool.name)).toEqual(PUBLISHED);
    // The retired name neither adds a tool nor hides the purchase explanation.
    expect(
      await listTools({
        environment: {
          ...grants({ [AGENT]: grant(["summary.read"]) }),
          EVENTS_V2_ENABLED: "0",
        },
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
  const browser = { via: "app" as const, subject: OWNER };

  it("is graded by its own entry on /mcp, never by the operator's", async () => {
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
    // The whole-store read tools need records.read, which only the operator's
    // bare-subject entry holds.
    for (const [name, args] of [
      [RECONSTRUCTED_STATE_TOOL_NAME, RECONSTRUCTED],
      ["kogane.instruments.candidates", {}],
      [PURCHASES_TOOL_NAME, {}],
    ] as const) {
      const refused = await callTool(name, args, { environment: HOSTILE });
      expect(refused.isError, name).toBe(true);
      expect(refused.structuredContent, name).toMatchObject({ code: "unauthorized" });
    }
    const before = await relationCount();
    const proposed = await callTool("kogane.reconcile.propose", proposal(), {
      environment: HOSTILE,
    });
    expect(proposed.structuredContent).toMatchObject({ code: "unauthorized" });
    expect(await relationCount()).toBe(before);
  });

  it("keeps the operator's rights on the browser's own routes", async () => {
    // The HTTP agent route reads the bare subject's grant, as before.
    const http = await send(
      "/api/agent/v1/capabilities",
      {},
      {
        environment: HOSTILE,
        identity: browser,
      },
    );
    expect(await http.json()).toMatchObject({
      principal: OWNER,
      capabilities: [...READS, "interpretation.propose"],
    });
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

  it("never offers an operations tool on /mcp, and refuses one from the caller object", async () => {
    expect(await listTools({ environment: HOSTILE })).toEqual(PUBLISHED);
    const before = await opsRowCount();
    for (const [name, args] of [
      ["kogane.ops.collection.request", COLLECTION],
      ["kogane.ops.projection.request", { reason: "attempt over mcp" }],
      ["kogane.ops.operation.get", { operationId: "op_synthetic" }],
    ] as const) {
      const called = await callTool(name, args, { environment: HOSTILE });
      expect(called.isError, name).toBe(true);
      expect(called.structuredContent, name).toEqual({ error: "actor_not_supported" });
    }
    expect(await opsRowCount()).toBe(before);
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
      expect(outcome).toEqual({ status: 403, body: { error: "actor_not_supported" } });
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
    const environment = {
      ...HOSTILE,
      ...grants({ [AGENT]: grant(["summary.read", "interpretation.propose"]) }),
    };
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
    const environment = grants({ [AGENT]: grant([...READS, "interpretation.propose"]) });
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
    ...grants({ [OWNER]: grant(READS), [AGENT]: grant(READS) }),
  };

  it("refuses an MCP-application token on every ordinary route", async () => {
    const routes: [string, string, unknown][] = [
      ["POST", "/api/command/v1/plan", {}],
      ["POST", "/api/command/v1/approve", {}],
      ["POST", "/api/command/v1/commit", {}],
      ["GET", "/api/v2/reconciliation/card-settlements", undefined],
      ["GET", "/api/v2/reconciliation/card-settlements/ownership", undefined],
      ["GET", "/api/v2/card-purchases", undefined],
      ["GET", "/api/v2/reported-state", undefined],
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

describe("the grant fails closed (matrix 4)", () => {
  it("refuses an absent, malformed or revoked grant", async () => {
    const tables: [Record<string, string>, string][] = [
      [{}, "no AGENT_API_GRANTS"],
      [{ AGENT_API_GRANTS: "" }, "the committed empty table"],
      [{ AGENT_API_GRANTS: "{" }, "unparsable"],
      [{ AGENT_API_GRANTS: JSON.stringify([AGENT]) }, "a list, not a table"],
      [
        {
          AGENT_API_GRANTS: JSON.stringify({
            [AGENT]: { ...grant(READS), capabilities: ["interpretation.accept"] },
          }),
        },
        "a capability outside the vocabulary",
      ],
      [{ ...grants({ [OWNER]: grant(READS) }) }, "only the bare subject's entry"],
      [
        { ...grants({ [OTHER]: grant(READS), [`mcp-client:${OTHER}`]: grant(READS) }) },
        "revoked: another person only",
      ],
    ];
    for (const [vars, label] of tables) {
      for (const message of [
        { method: "tools/list", params: {} },
        { method: "tools/call", params: { name: "kogane.capabilities", arguments: {} } },
      ]) {
        const response = await rpc(message.method, message.params, {
          environment: { AGENT_API_GRANTS: undefined, ...vars },
        });
        expect(response.status, `${label} ${message.method}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: "agent_api_not_configured" });
      }
    }
  });
});

describe("a tool that is not published cannot be called (matrix 8)", () => {
  it("answers unknown_tool, or the caller's refusal, and runs nothing", async () => {
    const environment = grants({ [AGENT]: grant([...READS, "interpretation.propose"]) });
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
      expect(await listTools({ environment })).toEqual(PUBLISHED);
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
      // The reconstructed state's read needs records.read over the whole store.
      const reconstructed = await callTool(RECONSTRUCTED_STATE_TOOL_NAME, RECONSTRUCTED, {
        environment,
      });
      if (capabilities.includes("records.read")) {
        // Past the grant: the request is read, and the account is unknown here.
        expect(reconstructed.structuredContent).toMatchObject({
          code: "evidence_restricted",
          refs: ["refusal:unknown_account", "account"],
        });
      } else {
        expect(reconstructed.isError).toBe(true);
        expect(reconstructed.structuredContent).toMatchObject({
          code: "unauthorized",
          refs: ["refusal:capability_missing", "capability:records.read"],
        });
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
      ...grants({ [AGENT]: grant(READS), [OTHER]: grant(READS) }),
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
    const environment = grants({ [AGENT]: grant(["summary.read"]) });
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

describe("scope covers every byte of every answer (matrix 5, 6)", () => {
  // `other-test` is granted; `sony-bank` and its account `mcp-account-a` are not.
  const DENIED = ["sony-bank", "mcp-account-a", "sa_mcp_sony-bank"];
  const narrow = grant([...READS, "interpretation.propose"], {
    sources: ["other-test"],
    accounts: "*",
  });

  it("honours an account scope on reads and proposals", async () => {
    const environment = grants({
      [AGENT]: grant([...READS, "interpretation.propose"], {
        sources: "*",
        accounts: ["mcp-account-b"],
      }),
    });
    const rows = await callTool("kogane.financial.query", { intent: "activity" }, { environment });
    expect(rows.isError).toBe(false);
    expect(JSON.stringify(rows.structuredContent)).not.toContain("mcp-account-a");
    const filtered = await callTool(
      "kogane.financial.query",
      { intent: "activity", filters: { account: "mcp-account-a" } },
      { environment },
    );
    expect(filtered.structuredContent).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:account"],
    });
    const before = await relationCount();
    const proposed = await callTool(
      "kogane.reconcile.propose",
      proposal(0, "a proposal across the account scope"),
      { environment },
    );
    expect(proposed.structuredContent).toMatchObject({ code: "incomplete_evidence" });
    expect(await relationCount()).toBe(before);
  });

  it("never names a source or an account outside the grant, anywhere in an answer", async () => {
    const environment = { ...grants({ [AGENT]: narrow }), EVENTS_V2_ENABLED: "true" };
    const rows = await callTool("kogane.financial.query", { intent: "activity" }, { environment });
    const inScopeRef = (
      rows.structuredContent["result"]["data"]["rows"] as { observationRef: string }[]
    )[0]!.observationRef;
    const calls: [string, unknown][] = [
      ["kogane.capabilities", {}],
      ["kogane.context.open", {}],
      ["kogane.context.open", { query: { intent: "activity" } }],
      ["kogane.financial.query", { intent: "coverage" }],
      ["kogane.financial.query", { intent: "holdings" }],
      ["kogane.financial.query", { intent: "activity" }],
      ["kogane.financial.query", { intent: "reported-state" }],
      ["kogane.explain", { ref: "source:other-test" }],
      ["kogane.explain", { ref: inScopeRef }],
      ["kogane.explain", { ref: "observation:transaction:999999" }],
      ["kogane.purchases.explain", {}],
      ["kogane.instruments.candidates", {}],
      ["kogane.instruments.candidates", { view: "separated" }],
      [RECONSTRUCTED_STATE_TOOL_NAME, RECONSTRUCTED],
    ];
    for (const [name, args] of calls) {
      const outcome = await callTool(name, args, { environment });
      const whole = JSON.stringify(outcome);
      for (const denied of DENIED)
        expect(whole, `${name} ${JSON.stringify(args)}`).not.toContain(denied);
    }
    const opened = await callTool("kogane.context.open", {}, { environment });
    expect(opened.structuredContent["context"]["sourceSelectionManifestRef"]).toBe(
      "sources:other-test",
    );
    // tools/list and initialize carry no source at all.
    const listed = JSON.stringify(await result(await rpc("tools/list", {}, { environment })));
    for (const denied of DENIED) expect(listed).not.toContain(denied);
  });

  it("keeps a scoped context unchanged when only a source outside the grant moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const environment = grants({ [AGENT]: narrow, [`mcp-client:${OTHER}`]: grant(READS) });
    const contextFor = async (identity: Identity) =>
      (await callTool("kogane.context.open", {}, { environment, identity })).structuredContent[
        "context"
      ] as Record<string, string>;
    const scoped = async () => contextFor({ via: "mcp", subject: OWNER });
    const whole = async () => contextFor({ via: "mcp", subject: OTHER });
    const publish = async (source: string, parser: string) => {
      const parse = await env.DB.prepare(`INSERT INTO parse_runs
        (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
        VALUES (?,?,'9','2026-09-08','ok','[]') RETURNING id`)
        .bind(artifactOf[source], parser)
        .first<{ id: number }>();
      await publishParse(parse!.id);
    };

    const scopedBefore = await scoped();
    const wholeBefore = await whole();
    // A new publication by a new parser build, in the source outside the grant.
    await publish("sony-bank", "out-of-scope-parser");
    const scopedAfter = await scoped();
    const wholeAfter = await whole();
    expect(scopedAfter).toEqual(scopedBefore);
    // The whole-store context does see it: the digests are not simply constant.
    expect(wholeAfter["publicationRef"]).not.toBe(wholeBefore["publicationRef"]);
    expect(wholeAfter["parserBuildManifestRef"]).not.toBe(wholeBefore["parserBuildManifestRef"]);
    // And the scoped context moves with its own source.
    await publish("other-test", "in-scope-parser");
    const scopedMoved = await scoped();
    expect(scopedMoved["publicationRef"]).not.toBe(scopedBefore["publicationRef"]);
    expect(scopedMoved["parserBuildManifestRef"]).not.toBe(scopedBefore["parserBuildManifestRef"]);
    expect(scopedMoved["contextId"]).not.toBe(scopedBefore["contextId"]);
  });
});
