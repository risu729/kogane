// The operations API over the real Worker, the real migrations and a
// synthetic store (unified plan 02 §4-5, U06). Nothing here is a real account,
// source credential, amount or token.
//
// What these checks pin, with the acceptance ids they cover:
//   * the API does not exist until `OPS_API_ENABLED` is on, and with the flag
//     off these paths answer exactly what they answer today;
//   * an accepted request is a stored record, never a finished job: the stage
//     progress of a fresh operation is `pending` everywhere, so absence is
//     reported as absence rather than as a successful empty result (the shape
//     G3-01 asks for, applied to an operation);
//   * HTTP and MCP write one identical operation record for one request
//     (G3-05), and re-sending it returns the same operation rather than
//     starting a second collection (G3-06, G3-14);
//   * an error carries a safe code and safe field paths, never the value that
//     was rejected (G3-08);
//   * a source whose policy needs a person answers `waiting_for_human` and
//     retries no login (G3-11);
//   * SQL, bucket keys and external URLs are refused by the schema, not
//     executed (G3-13).
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import demo from "../src/demo-worker";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";
import { OPS_TOOL_NAMES } from "../src/ops-tools";
import { d1CommandStore, recordOperationStage } from "../../../packages/application/src/index";

const OPS = "/api/ops/v1";
const OPERATOR = "ops-operator";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

/** The flag on, and a grant that lets the same subject reach `/mcp`. */
const ENABLED = {
  OPS_API_ENABLED: "true",
  AGENT_API_GRANTS: JSON.stringify({
    [OPERATOR]: {
      scopes: { sources: "*", accounts: "*" },
      capabilities: ["summary.read"],
      budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 3 },
    },
  }),
};

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  // A registered transformation identity (0028): the replay route accepts a
  // release the registry knows and nothing else.
  await env.DB.prepare(
    `INSERT INTO parser_releases(release_id,parser_name,semantic_version,code_digest,
      input_contract_version,output_contract_version,metadata_extractor_release,
      dependency_digests_json,registered_at)
      VALUES('ops-fixture-release','ops-fixture','1.0.0','digest','in','out','meta','{}','2026-09-07')`,
  ).run();
});
beforeEach(() => {
  issuer = `https://ops-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function token(subject = OPERATOR) {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    subject?: string;
    environment?: Record<string, unknown>;
    target?: typeof worker | typeof demo;
  } = {},
) {
  const jwt = await token(options.subject);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "cf-access-jwt-assertion": jwt },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const handler = options.target ?? worker;
  return handler.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ...options.environment,
  } as Env);
}

async function ops(path: string, body: unknown, environment: Record<string, unknown> = {}) {
  const response = await call(`${OPS}${path}`, {
    body,
    environment: { ...ENABLED, ...environment },
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

async function mcp(
  method: string,
  params: Record<string, unknown> = {},
  environment: Record<string, unknown> = {},
) {
  const response = await call("/mcp", {
    body: { jsonrpc: "2.0", id: 1, method, params },
    environment: { ...ENABLED, ...environment },
  });
  return (await response.json()) as Record<string, any>;
}

const row = async (operationId: string) =>
  env.DB.prepare("SELECT * FROM ops_requests WHERE operation_id=?").bind(operationId).first();
const rowCount = async (kind: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM ops_requests WHERE kind=?")
    .bind(kind)
    .first<number>("n");

const COLLECTION = {
  source: "sony-bank",
  requestedScope: { from: "2026-01-01", to: "2026-01-31" },
};

describe("the operations API does not exist until its flag is on", () => {
  it("answers these paths exactly as it does today while OPS_API_ENABLED is off", async () => {
    // The GET-only boundary is untouched: a POST to an unrouted path is 405
    // and an unrouted GET is 404, and the operations paths are unrouted.
    const post = await call(`${OPS}/collections`, { body: COLLECTION });
    expect(post.status).toBe(405);
    expect(await post.json()).toMatchObject({ error: "method_not_allowed" });
    const unrouted = await call("/api/nothing-here", { body: {} });
    expect(unrouted.status).toBe(post.status);
    const read = await call(`${OPS}/operations/op_${"0".repeat(64)}`);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: "not_found" });
    // And an explicit "off" is what the flag set to anything but "true" means.
    for (const value of ["", "1", "TRUE", "yes"])
      expect(
        (
          await call(`${OPS}/collections`, {
            body: COLLECTION,
            environment: { OPS_API_ENABLED: value },
          })
        ).status,
      ).toBe(405);
  });

  it("advertises opsApi on /api/meta so a client discovers the routes", async () => {
    const off = await call("/api/meta");
    expect((await off.json()).capabilities.opsApi).toBe(false);
    const on = await call("/api/meta", { environment: ENABLED });
    expect((await on.json()).capabilities.opsApi).toBe(true);
  });

  it("never serves an operations path from the synthetic demo Worker", async () => {
    const post = await call(`${OPS}/collections`, {
      body: COLLECTION,
      environment: ENABLED,
      target: demo,
    });
    expect(post.status).toBe(405);
    expect(await rowCount("collection")).toBe(0);
  });
});

describe("collection requests are accepted, not executed (G3-06, G3-14)", () => {
  it("stores one record and answers 202 accepted", async () => {
    const first = await ops("/collections", COLLECTION);
    expect(first.status).toBe(202);
    expect(first.json).toEqual({
      operationId: expect.stringMatching(/^op_[0-9a-f]{64}$/u),
      status: "accepted",
    });
    const stored = (await row(first.json.operationId)) as Record<string, any>;
    expect(stored).toMatchObject({
      kind: "collection",
      principal: OPERATOR,
      source_id: "sony-bank",
      status: "accepted",
      // Recorded for the Processor cron, never sent from this Worker.
      dispatch_state: "dispatch_pending",
      dispatch_attempts: 0,
      target_ref: null,
      failure_code: null,
    });
    expect(JSON.parse(stored.request_json)).toEqual(COLLECTION);
    expect(stored.payload_digest).toMatch(/^[0-9a-f]{64}$/u);

    // Accepted is not done: every stage of the kind reports pending, and the
    // answer never claims a provider was contacted.
    const read = await call(`${OPS}/operations/${first.json.operationId}`, {
      environment: ENABLED,
    });
    expect(read.status).toBe(200);
    const receipt = (await read.json()) as Record<string, any>;
    expect(receipt.schemaVersion).toBe("kogane-operation-v1");
    expect(receipt.stages.map((stage: any) => [stage.stage, stage.state])).toEqual([
      ["persisted", "pending"],
      ["registered", "pending"],
      ["parsed", "pending"],
      ["adopted", "pending"],
      ["projected", "pending"],
    ]);
    expect(receipt.failureCode).toBeNull();
  });

  it("returns the same operation for a re-send instead of collecting twice", async () => {
    const body = { ...COLLECTION, idempotencyKey: "nightly-2026-01" };
    const first = await ops("/collections", body);
    const again = await ops("/collections", body);
    expect(again.status).toBe(202);
    expect(again.json).toEqual(first.json);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM ops_requests WHERE idempotency_key=?")
        .bind("nightly-2026-01")
        .first<number>("n"),
    ).toBe(1);
  });

  it("refuses the same key with a different payload rather than silently dropping one", async () => {
    const key = "conflicting-key";
    await ops("/collections", { ...COLLECTION, idempotencyKey: key });
    const conflict = await ops("/collections", {
      source: "sony-bank",
      requestedScope: { from: "2026-02-01", to: "2026-02-28" },
      idempotencyKey: key,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe("idempotency_conflict");
    expect(JSON.stringify(conflict.json)).not.toContain("2026-02-01");
  });

  it("keeps one operation per principal: another subject's request is its own", async () => {
    const mine = await ops("/collections", { ...COLLECTION, idempotencyKey: "shared-key" });
    const theirs = await call(`${OPS}/collections`, {
      body: { ...COLLECTION, idempotencyKey: "shared-key" },
      subject: "second-operator",
      environment: ENABLED,
    });
    const other = (await theirs.json()) as Record<string, any>;
    expect(other.operationId).not.toBe(mine.json.operationId);
    // And neither principal can read the other's operation.
    const read = await call(`${OPS}/operations/${other.operationId}`, { environment: ENABLED });
    expect(read.status).toBe(404);
    expect((await read.json()).error).toBe("receipt_not_found");
  });
});

describe("the schema is the boundary (G3-08, G3-13)", () => {
  it("refuses arbitrary SQL, storage keys and external URLs by shape", async () => {
    const refusals = [
      [
        "/collections",
        { source: "sony-bank'; DROP TABLE sources;--", requestedScope: COLLECTION.requestedScope },
      ],
      [
        "/collections",
        { source: "sony-bank", requestedScope: { from: "2026-01-31", to: "2026-01-01" } },
      ],
      [
        "/collections",
        { source: "sony-bank", requestedScope: { from: "2026-02-30", to: "2026-03-01" } },
      ],
      ["/collections", { ...COLLECTION, table: "fetch_artifacts" }],
      ["/imports", { source: "sony-bank", runId: "objects/ab/../../secrets" }],
      ["/imports", { source: "sony-bank", runId: "run-1", sql: "select 1" }],
      [
        "/replays",
        {
          scope: { source: "sony-bank", from: null, to: null },
          parserRelease: "https://evil.invalid/p",
        },
      ],
      ["/projections", { reason: "" }],
      ["/projections", { reason: "why\u0000not" }],
    ] as const;
    for (const [path, body] of refusals) {
      const outcome = await ops(path, body);
      expect([400, 409], `${path} ${JSON.stringify(body)}`).toContain(outcome.status);
      expect(outcome.json.error).toBe("invalid_request");
      // The refusal names the field, never the value that was refused.
      const rendered = JSON.stringify(outcome.json);
      for (const secret of ["DROP TABLE", "secrets", "evil.invalid", "select 1"])
        expect(rendered).not.toContain(secret);
    }
    // Nothing above reached the store, and the table it named still exists.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM sources").first<number>("n"),
    ).toBeGreaterThan(0);
  });

  it("refuses a source the registry does not declare", async () => {
    const outcome = await ops("/collections", { ...COLLECTION, source: "not-a-source" });
    expect(outcome.status).toBe(400);
    expect(outcome.json).toMatchObject({ error: "target_missing", refs: ["source:not-a-source"] });
  });

  it("refuses a parser release the registry does not know", async () => {
    const outcome = await ops("/replays", {
      scope: { source: "sony-bank", from: null, to: null },
      parserRelease: "never-registered",
    });
    expect(outcome.json).toMatchObject({ error: "target_missing" });
  });

  it("refuses a body larger than the bound before it reaches a schema", async () => {
    const response = await call(`${OPS}/projections`, {
      body: { reason: "x".repeat(20_000) },
      environment: ENABLED,
    });
    expect(response.status).toBe(413);
  });

  it("refuses a query string on an operations route", async () => {
    const response = await call(`${OPS}/collections?source=sony-bank`, {
      body: COLLECTION,
      environment: ENABLED,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_query");
  });

  it("keeps an agent out: requesting work is not a capability an agent holds", async () => {
    const response = await call(`${OPS}/collections`, {
      body: COLLECTION,
      environment: { ...ENABLED, AGENT_GRANTS: JSON.stringify([OPERATOR]) },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("approval_required");
  });
});

describe("the other four operations", () => {
  it("stores a re-registration request against a persisted run", async () => {
    const outcome = await ops("/imports", { source: "other-test", runId: "run-2026-01-01-a" });
    expect(outcome.status).toBe(202);
    expect((await row(outcome.json.operationId)) as any).toMatchObject({
      kind: "import",
      source_id: "other-test",
      status: "accepted",
      dispatch_state: "dispatch_pending",
    });
  });

  it("stores a replay in the existing replay-plan tables, once per operation", async () => {
    const body = {
      scope: { source: "sony-bank", from: "2026-01-01", to: "2026-01-31" },
      parserRelease: "ops-fixture-release",
      idempotencyKey: "replay-one",
    };
    const first = await ops("/replays", body);
    expect(first.status).toBe(202);
    const plans = await env.DB.prepare(
      "SELECT * FROM observation_replay_plans WHERE operation_id=?",
    )
      .bind(first.json.operationId)
      .all<Record<string, any>>();
    expect(plans.results).toHaveLength(1);
    expect(plans.results[0]).toMatchObject({
      source_id: "sony-bank",
      parser_name: "ops-fixture",
      parser_version: "1.0.0",
      target_release: "ops-fixture-release",
      fetched_from: "2026-01-01",
      fetched_to: "2026-01-31",
      // Planned, not running: the Processor starts it, and the artifact
      // high-water is fixed now so later evidence never grows this replay.
      status: "planned",
      jobs_created: 0,
    });
    // A re-send is the same operation and does not plan the replay twice.
    await ops("/replays", body);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM observation_replay_plans WHERE operation_id=?",
      )
        .bind(first.json.operationId)
        .first<number>("n"),
    ).toBe(1);
  });

  it("stores a rebuild request with its reason", async () => {
    const outcome = await ops("/projections", { reason: "read model rebuilt after a fixture" });
    expect(outcome.status).toBe(202);
    const stored = (await row(outcome.json.operationId)) as Record<string, any>;
    expect(stored).toMatchObject({ kind: "projection", source_id: null, status: "accepted" });
    expect(JSON.parse(stored.request_json)).toEqual({
      reason: "read model rebuilt after a fixture",
    });
  });

  it("answers waiting_for_human for a source whose policy needs a person (G3-11)", async () => {
    const response = await call(`${OPS}/sessions/sony-bank/refresh`, {
      body: {},
      environment: ENABLED,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("waiting_for_human");
    const stored = (await row(body.operationId)) as Record<string, any>;
    // Nothing is dispatched, so nothing retries a login.
    expect(stored).toMatchObject({
      kind: "session-refresh",
      status: "waiting_for_human",
      dispatch_state: "not_required",
      dispatch_attempts: 0,
    });
    // The answer carries an id and a state; never a credential or a session.
    expect(Object.keys(body).sort()).toEqual(["operationId", "status"]);
  });

  it("dispatches a refresh only where the deployment declares it unattended", async () => {
    const response = await call(`${OPS}/sessions/other-test/refresh`, {
      body: {},
      environment: {
        ...ENABLED,
        SESSION_REFRESH_POLICY: JSON.stringify({ "other-test": "unattended" }),
      },
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("accepted");
    expect((await row(body.operationId)) as any).toMatchObject({
      dispatch_state: "dispatch_pending",
    });
    // A malformed policy grants nothing: the safe direction is to ask a person.
    const malformed = await call(`${OPS}/sessions/other-test/refresh`, {
      body: { idempotencyKey: "malformed-policy" },
      environment: { ...ENABLED, SESSION_REFRESH_POLICY: "not json" },
    });
    expect(((await malformed.json()) as Record<string, any>).status).toBe("waiting_for_human");
  });

  it("refuses a source that is not a source id in the path", async () => {
    const response = await call(`${OPS}/sessions/Sony%20Bank/refresh`, {
      body: {},
      environment: ENABLED,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
  });
});

describe("stage progress is evidence, not a guess", () => {
  it("reports a recorded stage and completes only when every stage of the kind is done", async () => {
    const accepted = await ops("/projections", { reason: "stage progress fixture" });
    const operationId = accepted.json.operationId as string;
    const store = d1CommandStore(env.DB);
    await recordOperationStage({
      store,
      operationId,
      stage: "projected",
      state: "retryable",
      failureCode: "snapshot_incomplete",
      now: "2026-09-07T00:00:00Z",
    });
    let receipt = (await (
      await call(`${OPS}/operations/${operationId}`, { environment: ENABLED })
    ).json()) as Record<string, any>;
    expect(receipt.stages).toEqual([
      {
        stage: "projected",
        state: "retryable",
        evidenceRef: null,
        failureCode: "snapshot_incomplete",
        attempts: 1,
        updatedAt: "2026-09-07T00:00:00Z",
      },
    ]);
    // A retryable stage is not completion: the operation is still accepted.
    expect(receipt.status).toBe("accepted");
    await recordOperationStage({
      store,
      operationId,
      stage: "projected",
      state: "completed",
      evidenceRef: "snapshot:fixture",
      now: "2026-09-07T01:00:00Z",
    });
    receipt = (await (
      await call(`${OPS}/operations/${operationId}`, { environment: ENABLED })
    ).json()) as Record<string, any>;
    expect(receipt.status).toBe("completed");
    expect(receipt.stages[0]).toMatchObject({
      state: "completed",
      evidenceRef: "snapshot:fixture",
      attempts: 2,
    });
  });

  it("refuses an operation id that is not one", async () => {
    const response = await call(`${OPS}/operations/not-an-operation`, { environment: ENABLED });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
  });
});

describe("HTTP and MCP are one API (G3-05)", () => {
  it("lists the operations tools only while the flag is on", async () => {
    const off = await mcp("tools/list", {}, { OPS_API_ENABLED: "" });
    expect(
      off.result.tools
        .map((tool: any) => tool.name)
        .filter((name: string) => name.startsWith("kogane.ops.")),
    ).toEqual([]);
    const called = await mcp(
      "tools/call",
      { name: "kogane.ops.collection.request", arguments: COLLECTION },
      { OPS_API_ENABLED: "" },
    );
    expect(called.error.message).toBe("unknown_tool");

    const on = await mcp("tools/list");
    const names = on.result.tools.map((tool: any) => tool.name);
    expect(names.slice(-OPS_TOOL_NAMES.length)).toEqual([...OPS_TOOL_NAMES]);
    for (const tool of on.result.tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema).toContain('"additionalProperties":false');
      expect(schema).not.toMatch(/"(url|uri|sql|table|host|endpoint|orderBy)"\s*:/u);
    }
  });

  it("writes one record for one request, whichever transport carries it", async () => {
    const body = { ...COLLECTION, idempotencyKey: "parity-same-key" };
    const overHttp = await ops("/collections", body);
    const overMcp = await mcp("tools/call", {
      name: "kogane.ops.collection.request",
      arguments: body,
    });
    // The same principal and the same key is the same operation: MCP does not
    // start a second collection for a request HTTP already accepted.
    expect(overMcp.result.isError).toBe(false);
    expect(overMcp.result.structuredContent).toEqual(overHttp.json);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM ops_requests WHERE idempotency_key=?")
        .bind("parity-same-key")
        .first<number>("n"),
    ).toBe(1);

    // And two requests that differ only by their key produce records that are
    // identical in every field that describes what was asked for.
    const httpOnly = await ops("/collections", { ...COLLECTION, idempotencyKey: "parity-http" });
    const mcpOnly = await mcp("tools/call", {
      name: "kogane.ops.collection.request",
      arguments: { ...COLLECTION, idempotencyKey: "parity-mcp" },
    });
    const describing = (record: Record<string, any>) => ({
      kind: record.kind,
      principal: record.principal,
      payload_digest: record.payload_digest,
      source_id: record.source_id,
      request_json: record.request_json,
      status: record.status,
      dispatch_state: record.dispatch_state,
    });
    expect(describing((await row(httpOnly.json.operationId)) as Record<string, any>)).toEqual(
      describing((await row(mcpOnly.result.structuredContent.operationId)) as Record<string, any>),
    );
  });

  it("refuses the same requests the routes refuse, with the same codes", async () => {
    const refused = await mcp("tools/call", {
      name: "kogane.ops.collection.request",
      arguments: { ...COLLECTION, source: "not-a-source" },
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent).toEqual({
      error: "target_missing",
      refs: ["source:not-a-source"],
    });
    const invalid = await mcp("tools/call", {
      name: "kogane.ops.session.refresh",
      arguments: { source: "sony-bank", extra: "no" },
    });
    expect(invalid.result.structuredContent).toMatchObject({ error: "invalid_request" });
    // An agent is refused on this transport too.
    const agent = await mcp(
      "tools/call",
      { name: "kogane.ops.projection.request", arguments: { reason: "agent attempt" } },
      { AGENT_GRANTS: JSON.stringify([OPERATOR]) },
    );
    expect(agent.result.structuredContent).toEqual({ error: "approval_required" });
  });

  it("reads an operation through the tool of the same name", async () => {
    const accepted = await ops("/imports", {
      source: "sony-bank",
      runId: "run-read-through-mcp",
    });
    const read = await mcp("tools/call", {
      name: "kogane.ops.operation.get",
      arguments: { operationId: accepted.json.operationId },
    });
    const overHttp = await call(`${OPS}/operations/${accepted.json.operationId}`, {
      environment: ENABLED,
    });
    expect(read.result.structuredContent).toEqual(await overHttp.json());
  });
});
