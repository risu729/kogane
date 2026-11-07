// ADR 0081 for the six operations requests: each is served on `/mcp` to an
// MCP client acting as itself (ADR 0063, ADR 0084) by the same service as its HTTP route, so the
// two transports give the same answer and store the same request for the
// same input. Real Worker, official MCP transport; identities, configuration
// and data are synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { OPS_TOOL_NAMES } from "../src/ops-tools";
import { seedRegistry } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "owner-ops-parity-synthetic";
const DELEGATE = `mcp-client:${OWNER}`;
const ISSUER = "https://ops-parity-test.cloudflareaccess.com";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
// Since ADR 0084 every MCP client holds every operation over the whole store;
// nothing configures it, and the operator list grades only the HTTP routes.
const configuration = () => ({
  OPS_API_ENABLED: "true",
  SESSION_REFRESH_POLICY: "",
  OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
});

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let rpc = 0;
beforeAll(async () => {
  await seedRegistry();
  await env.DB.prepare(
    `INSERT INTO parser_releases(release_id,parser_name,semantic_version,code_digest,
      input_contract_version,output_contract_version,metadata_extractor_release,
      dependency_digests_json,registered_at)
      VALUES('ops-parity-release','ops-parity','1.0.0','digest','in','out','meta','{}','2026-09-07')`,
  ).run();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${ISSUER}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks));
      throw new Error("unexpected external request");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function send(path: string, body: unknown, vars: Record<string, unknown>) {
  const mcp = path === "/mcp";
  const headers: Record<string, string> = mcp
    ? { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" }
    : { "content-type": "application/json" };
  headers["cf-access-jwt-assertion"] = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(mcp ? MCP_AUD : APP_AUD)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...env,
      ACCESS_ISSUER: ISSUER,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      ...vars,
    } as Env,
  );
}

async function listed(vars: Record<string, unknown>): Promise<string[]> {
  const response = await send("/mcp", { jsonrpc: "2.0", id: ++rpc, method: "tools/list" }, vars);
  const message = (await response.json()) as { result: { tools: { name: string }[] } };
  return message.result.tools.map((tool) => tool.name).filter((name) => name.includes(".ops."));
}

async function tool(name: string, args: unknown, vars = configuration()) {
  const response = await send(
    "/mcp",
    { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } },
    vars,
  );
  expect(response.status).toBe(200);
  const message = (await response.json()) as {
    result: { structuredContent: Record<string, unknown>; isError?: boolean };
  };
  return message.result;
}

async function route(path: string, body?: unknown) {
  const response = await send(`/api/ops/v1${path}`, body, configuration());
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** What one stored request says, without who asked and when. */
async function stored(operationId: unknown) {
  const row = await env.DB.prepare(
    "SELECT kind,source_id,status,dispatch_state,request_json FROM ops_requests WHERE operation_id=?",
  )
    .bind(operationId)
    .first();
  expect(row, String(operationId)).not.toBeNull();
  return row;
}

/**
 * A receipt without the fields that name its own operation or its time. The
 * execution's `expiresAt` is counted from the moment the request was accepted,
 * so the HTTP and MCP requests, made a few calls apart, differ by a second
 * whenever they straddle one: it is compared as its lifetime after acceptance
 * (or null), which is the same on both transports.
 */
function receipt(body: Record<string, unknown>) {
  const { operationId: _id, acceptedAt, updatedAt: _updated, ...rest } = body;
  const execution = rest["execution"];
  if (typeof execution === "object" && execution !== null) {
    const { expiresAt, ...timeless } = execution as Record<string, unknown>;
    const lifetimeMs =
      expiresAt === null ? null : Date.parse(String(expiresAt)) - Date.parse(String(acceptedAt));
    return { ...rest, execution: { ...timeless, lifetimeMs } };
  }
  return rest;
}

/** The record of one delegated call that wrote its effect. */
async function delegatedRecord(operation: string, idempotencyKey: string) {
  return env.DB.prepare(
    "SELECT principal_kind,path,subject,operation FROM audit_records WHERE principal=? AND operation=? AND idempotency_key=? AND result='accepted'",
  )
    .bind(DELEGATE, operation, idempotencyKey)
    .all();
}

describe("operations requests over MCP, as the MCP client (ADR 0081, ADR 0084)", () => {
  it("publishes all six tools to every MCP client, whatever the operator list says (ADR 0084)", async () => {
    expect((await listed(configuration())).sort()).toEqual([...OPS_TOOL_NAMES].sort());
    expect((await listed({ ...configuration(), OPERATOR_SUBJECTS: "[]" })).sort()).toEqual(
      [...OPS_TOOL_NAMES].sort(),
    );
  });

  it("answers and stores what the HTTP route does for the same replay, rebuild and re-registration", async () => {
    const cases = [
      {
        name: "kogane.ops.replay.request",
        operation: "ops.replay.request",
        path: "/replays",
        input: {
          scope: { source: "sony-bank", from: "2026-01-01", to: "2026-01-31" },
          parserRelease: "ops-parity-release",
        },
      },
      {
        name: "kogane.ops.projection.request",
        operation: "ops.projection.request",
        path: "/projections",
        input: { reason: "synthetic rebuild for transport parity" },
      },
      {
        name: "kogane.ops.import.request",
        operation: "ops.import.request",
        path: "/imports",
        input: { source: "other-test", runId: "run-2026-01-01-a" },
      },
    ] as const;
    for (const { name, operation, path, input } of cases) {
      const key = `parity-${path.slice(1)}`;
      const overHttp = await route(path, { ...input, idempotencyKey: `${key}-http` });
      expect(overHttp.status, path).toBe(202);
      const overMcp = await tool(name, { ...input, idempotencyKey: `${key}-mcp` });
      expect(overMcp.isError, name).not.toBe(true);
      // One service, one answer: the same receipt and the same stored request.
      expect(receipt(overMcp.structuredContent), name).toEqual(receipt(overHttp.body));
      expect(await stored(overMcp.structuredContent["operationId"]), name).toEqual(
        await stored(overHttp.body["operationId"]),
      );
      expect((await delegatedRecord(operation, `${key}-mcp`)).results, name).toEqual([
        { principal_kind: "delegated", path: "mcp", subject: OWNER, operation },
      ]);
      // Following the operation reads the same receipt on both transports.
      const followedOverHttp = await route(`/operations/${String(overHttp.body["operationId"])}`);
      const followedOverMcp = await tool("kogane.ops.operation.get", {
        operationId: overMcp.structuredContent["operationId"],
      });
      expect(followedOverMcp.isError, name).not.toBe(true);
      expect(receipt(followedOverMcp.structuredContent), name).toEqual(
        receipt(followedOverHttp.body),
      );
    }
  });

  it("answers and stores what the HTTP route does for a collection and a session refresh after confirmation", async () => {
    const cases = [
      {
        name: "kogane.ops.collection.request",
        operation: "ops.collection.request",
        path: "/collections",
        input: { source: "sony-bank", requestedScope: { from: "2026-10-01", to: "2026-10-02" } },
        route: "/collections",
      },
      {
        name: "kogane.ops.session.refresh",
        operation: "ops.session.refresh",
        path: "/sessions",
        input: { source: "sony-bank" },
        route: "/sessions/sony-bank/refresh",
      },
    ] as const;
    for (const { name, operation, path, input, route: httpPath } of cases) {
      const key = `parity-${path.slice(1)}`;
      const httpInput =
        name === "kogane.ops.session.refresh"
          ? { idempotencyKey: `${key}-http` }
          : { ...input, idempotencyKey: `${key}-http` };
      const overHttp = await route(httpPath, httpInput);
      expect(overHttp.status, httpPath).toBe(202);
      const request = { ...input, idempotencyKey: `${key}-mcp` };
      // A provider-facing request is accepted only after prepare and exact confirmation.
      const unconfirmed = await tool(name, { ...request, step: "confirm" });
      expect(unconfirmed.structuredContent, name).toEqual({ error: "confirmation_required" });
      const prepared = await tool(name, { ...request, step: "prepare" });
      expect(prepared.isError, name).not.toBe(true);
      const confirmation = prepared.structuredContent["confirmation"] as { digest: string };
      const overMcp = await tool(name, {
        ...request,
        step: "confirm",
        confirmationDigest: confirmation.digest,
      });
      expect(overMcp.isError, name).not.toBe(true);
      expect(receipt(overMcp.structuredContent), name).toEqual(receipt(overHttp.body));
      expect(await stored(overMcp.structuredContent["operationId"]), name).toEqual(
        await stored(overHttp.body["operationId"]),
      );
      expect((await delegatedRecord(operation, `${key}-mcp`)).results, name).toEqual([
        { principal_kind: "delegated", path: "mcp", subject: OWNER, operation },
      ]);
      const followedOverHttp = await route(`/operations/${String(overHttp.body["operationId"])}`);
      const followedOverMcp = await tool("kogane.ops.operation.get", {
        operationId: overMcp.structuredContent["operationId"],
      });
      expect(followedOverMcp.isError, name).not.toBe(true);
      expect(receipt(followedOverMcp.structuredContent), name).toEqual(
        receipt(followedOverHttp.body),
      );
    }
  });
});
