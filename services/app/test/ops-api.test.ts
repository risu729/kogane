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
//   * HTTP writes one operation record for one request (G3-05), and
//     re-sending it returns the same operation rather than starting a second
//     collection (G3-06, G3-14); `/mcp` is agent-only (ADR 0047), so it
//     publishes none of the operations and refuses every one of them, even for
//     the operator's own identity, without writing a row;
//   * an error carries a safe code and safe field paths, never the value that
//     was rejected (G3-08);
//   * a source whose policy needs a person answers `waiting_for_human` and
//     retries no login (G3-11);
//   * SQL, bucket keys and external URLs are refused by the schema, not
//     executed (G3-13).
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import demo from "./snapshot-worker";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";
import { PURCHASES_TOOL_NAME } from "../src/agent-service";
import { MCP_TOOLS, RECONSTRUCTED_STATE_MCP_TOOLS } from "../src/mcp";
import { OPS_TOOL_NAMES } from "../src/ops-tools";
import {
  claimCollectorStart,
  d1CommandStore,
  recordCollectorOutcome,
  recordOperationStage,
} from "../../../packages/application/src/index";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OPS = "/api/ops/v1";
const OPERATOR = "ops-operator";
/** A second operator, so "one operation per principal" has two of them. */
const SECOND_OPERATOR = "second-operator";
/** A subject the deployment grades an agent: it may propose, never accept. */
const AGENT = "ops-agent";
/** A verified subject in neither list: authenticated, granted nothing. */
const STRANGER = "ops-stranger";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

/**
 * The flag on, the two operators named, and a read grant that lets the same
 * subject reach `/mcp`. `OPERATOR_SUBJECTS` has to be explicit: the command
 * path's grant lists are allow-lists, so an authenticated subject that neither
 * names is refused with `subject_not_granted` rather than graded the operator
 * (docs/ops-api.md, "Authorization").
 */
const ENABLED = {
  OPS_API_ENABLED: "true",
  OPERATOR_SUBJECTS: JSON.stringify([OPERATOR, SECOND_OPERATOR]),
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

/** The MCP Access application's audience (ADR 0047); `/mcp` accepts nothing else. */
const MCP_AUDIENCE = "fixture-mcp-audience";

async function token(subject = OPERATOR, audience = "fixture-audience") {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
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
  const jwt = await token(options.subject, path === "/mcp" ? MCP_AUDIENCE : undefined);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "cf-access-jwt-assertion": jwt,
      // What an MCP client sends on every POST (Streamable HTTP).
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const handler = options.target ?? worker;
  return handler.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
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
  subject: string = OPERATOR,
) {
  const response = await call("/mcp", {
    body: { jsonrpc: "2.0", id: 1, method, params },
    environment: { ...ENABLED, ...environment },
    subject,
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

  it("keeps a closed route set while the flag is on: no other path, no other verb", async () => {
    const unknown = await call(`${OPS}/purge`, { body: {}, environment: ENABLED });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "not_found" });
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const verb = await call(`${OPS}/collections`, { method, environment: ENABLED });
      expect(verb.status, method).toBe(405);
      expect(await verb.json()).toMatchObject({ error: "method_not_allowed" });
    }
    expect(await rowCount("collection")).toBe(0);
  });

  it("advertises opsApi on /api/meta so a client discovers the routes", async () => {
    const off = await call("/api/meta");
    expect((await off.json()).capabilities.opsApi).toBe(false);
    const on = await call("/api/meta", { environment: ENABLED });
    expect((await on.json()).capabilities.opsApi).toBe(true);
  });

  it("never serves an operations path from the test snapshot adapter", async () => {
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
  it("stores one record and answers 202 accepted; nothing done is reported as pending, not as success (G3-01)", async () => {
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
    // No executor has looked at it: the execution is `accepted`, with no
    // connection, no start and no run (ADR 0048).
    expect(receipt.execution).toEqual({
      action: "collect",
      state: "accepted",
      connectionId: null,
      reasonCode: null,
      scope: "collector_default",
      waits: 0,
      expiresAt: new Date(Date.parse(receipt.acceptedAt) + 24 * 3_600_000).toISOString(),
      startedAt: null,
      collectedAt: null,
      publishedAt: null,
      finishedAt: null,
      runs: [],
    });
  });

  it("follows the collector execution from the request id to the runs it reported (ADR 0048)", async () => {
    const accepted = await ops("/collections", { ...COLLECTION, idempotencyKey: "trail-read" });
    const operationId = accepted.json.operationId as string;
    const stored = (await row(operationId)) as Record<string, any>;
    // What the Processor's dispatch lane records, through the same services.
    const store = d1CommandStore(env.DB);
    const context = {
      store,
      operationId,
      action: "collect" as const,
      acceptedAt: stored.created_at as string,
      expiresAt: new Date(Date.parse(stored.created_at) + 24 * 3_600_000).toISOString(),
      now: "2026-09-07T00:05:00.000Z",
    };
    const binding = { connectionId: "sony-bank", terminalSource: "sony-bank" };
    expect(await claimCollectorStart({ ...context, binding })).toBe(true);
    await recordCollectorOutcome({
      store,
      operationId,
      now: "2026-09-07T00:06:00.000Z",
      nowMs: Date.parse("2026-09-07T00:06:00.000Z"),
      outcome: { kind: "collected", runIds: ["synthetic-trail-run"] },
    });
    const read = await call(`${OPS}/operations/${operationId}`, { environment: ENABLED });
    expect(read.status).toBe(200);
    const receipt = (await read.json()) as Record<string, any>;
    expect(receipt.status).toBe("running");
    expect(receipt.targetRef).toBe("collector:sony-bank");
    expect(receipt.stages[0]).toMatchObject({ stage: "persisted", state: "completed" });
    expect(receipt.execution).toMatchObject({
      state: "collected",
      connectionId: "sony-bank",
      startedAt: "2026-09-07T00:05:00.000Z",
      collectedAt: "2026-09-07T00:06:00.000Z",
      publishedAt: null,
      // The terminal has not been registered yet: not reached, not success.
      runs: [{ runId: "synthetic-trail-run", state: "not_registered", evidenceRunId: null }],
    });
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
      subject: SECOND_OPERATOR,
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
    // The refusal names the field, never the id the caller sent (G3-08).
    expect(outcome.json).toMatchObject({ error: "target_missing", refs: ["source"] });
    expect(JSON.stringify(outcome.json)).not.toContain("not-a-source");
  });

  it("refuses a parser release the registry does not know", async () => {
    const outcome = await ops("/replays", {
      scope: { source: "sony-bank", from: null, to: null },
      parserRelease: "never-registered",
    });
    expect(outcome.json).toMatchObject({ error: "target_missing", refs: ["parserRelease"] });
    expect(JSON.stringify(outcome.json)).not.toContain("never-registered");
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
      subject: AGENT,
      environment: { ...ENABLED, AGENT_GRANTS: JSON.stringify([AGENT]) },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("approval_required");
  });

  // The operator role is granted, never inferred. A subject the deployment
  // never named is authenticated and nothing else: it used to be graded the
  // human operator and could accept every one of these operations.
  it("keeps an unnamed subject out with a safe code, not with the operator role", async () => {
    for (const environment of [ENABLED, { ...ENABLED, OPERATOR_SUBJECTS: "" }]) {
      const response = await call(`${OPS}/collections`, {
        body: COLLECTION,
        subject: STRANGER,
        environment,
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("subject_not_granted");
    }
    // A read is refused the same way: nothing confirms that an id exists.
    const read = await call(`${OPS}/operations/op_${"0".repeat(64)}`, {
      subject: STRANGER,
      environment: ENABLED,
    });
    expect(read.status).toBe(403);
    expect((await read.json()).error).toBe("subject_not_granted");
  });

  // Whatever the two lists are wrong about, every operations route answers the
  // same way: nobody is graded, so nothing is accepted.
  it("refuses everyone while the grant lists cannot be read", async () => {
    const broken: Record<string, string>[] = [
      { OPERATOR_SUBJECTS: "{" },
      { OPERATOR_SUBJECTS: JSON.stringify({ [OPERATOR]: true }) },
      { OPERATOR_SUBJECTS: JSON.stringify([OPERATOR, 7]) },
      { AGENT_GRANTS: "not json" },
      { AGENT_GRANTS: JSON.stringify({ [AGENT]: { capabilities: [] } }) },
      { AGENT_GRANTS: JSON.stringify([AGENT, null]) },
      { AGENT_GRANTS: JSON.stringify([OPERATOR]) },
    ];
    const before = await rowCount("collection");
    for (const vars of broken) {
      for (const subject of [OPERATOR, AGENT, STRANGER]) {
        const response = await call(`${OPS}/collections`, {
          body: COLLECTION,
          subject,
          environment: { ...ENABLED, ...vars },
        });
        expect(response.status, `${JSON.stringify(vars)} ${subject}`).toBe(503);
        expect((await response.json()).error).toBe("grants_misconfigured");
      }
    }
    // A refusal accepts nothing: no operation record was written by any of them.
    expect(await rowCount("collection")).toBe(before);
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

describe("operations are HTTP only: /mcp is agent-only (G3-05, ADR 0047)", () => {
  // Through the MCP Access application every caller is `mcp-client:<sub>`,
  // the operator included. Give that name a read grant so `/mcp` answers at
  // all; the operations must still be absent and refused.
  const THROUGH_MCP = {
    ...ENABLED,
    AGENT_API_GRANTS: JSON.stringify({
      [`mcp-client:${OPERATOR}`]: {
        scopes: { sources: "*", accounts: "*" },
        capabilities: ["summary.read"],
        budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 3 },
      },
    }),
  };
  const opsRows = async () =>
    env.DB.prepare("SELECT count(*) AS n FROM ops_requests").first<number>("n");

  it("publishes no operations tool to the operator's own MCP client, flag on or off", async () => {
    const six = MCP_TOOLS.map((tool) => tool.name);
    expect(six).toHaveLength(6);
    // CORE 0047 and the reported-state views are present, so both reads are
    // published beside the six, whatever the operations flag. Operations
    // tools are not: `/mcp` is agent-only (ADR 0047).
    const reads = [
      ...six,
      PURCHASES_TOOL_NAME,
      ...RECONSTRUCTED_STATE_MCP_TOOLS.map((tool) => tool.name),
    ];
    for (const flag of ["", "true"]) {
      const listed = await mcp("tools/list", {}, { ...THROUGH_MCP, OPS_API_ENABLED: flag });
      expect(
        listed.result.tools.map((tool: any) => tool.name),
        flag,
      ).toEqual(reads);
    }
    // The definitions still exist, generated from the routes' schemas.
    expect(OPS_TOOL_NAMES).toEqual([
      "kogane.ops.collection.request",
      "kogane.ops.import.request",
      "kogane.ops.replay.request",
      "kogane.ops.projection.request",
      "kogane.ops.session.refresh",
      "kogane.ops.operation.get",
    ]);
  });

  it("refuses every operation over MCP without writing a row, and serves it over HTTP", async () => {
    const before = await opsRows();
    const accepted = await ops("/imports", { source: "sony-bank", runId: "run-read-over-http" });
    const calls: [string, Record<string, unknown>][] = [
      ["kogane.ops.collection.request", { ...COLLECTION, idempotencyKey: "over-mcp" }],
      ["kogane.ops.import.request", { source: "sony-bank", runId: "run-over-mcp" }],
      ["kogane.ops.replay.request", { source: "sony-bank" }],
      ["kogane.ops.projection.request", { reason: "over mcp" }],
      ["kogane.ops.session.refresh", { source: "sony-bank" }],
      ["kogane.ops.operation.get", { operationId: accepted.json.operationId }],
    ];
    for (const [name, args] of calls) {
      const called = await mcp("tools/call", { name, arguments: args }, THROUGH_MCP);
      expect(called.result.isError, name).toBe(true);
      expect(called.result.structuredContent, name).toEqual({ error: "actor_not_supported" });
    }
    // Only the HTTP import above was written.
    expect(await opsRows()).toBe((before ?? 0) + 1);
    // The operator keeps the operations over HTTP, with the browser application.
    const overHttp = await ops("/collections", { ...COLLECTION, idempotencyKey: "over-http" });
    expect(overHttp.status).toBe(202);
  });

  it("refuses a token minted for the browser application on /mcp", async () => {
    const response = await worker.fetch(
      new Request("https://fixture.test/mcp", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": await token(OPERATOR), ...MCP_CLIENT_HEADERS },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      {
        ...env,
        ...THROUGH_MCP,
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: "fixture-audience",
        ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
      } as Env,
    );
    expect(response.status).toBe(401);
  });

  it("grades route refusals over HTTP and stops before them over MCP", async () => {
    const refused = await ops("/collections", { ...COLLECTION, source: "not-a-source" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: "target_missing", refs: ["source"] });
    expect(JSON.stringify(refused.json)).not.toContain("not-a-source");
    const invalid = await call(`${OPS}/sessions/sony-bank/refresh`, {
      body: { extra: "no" },
      environment: ENABLED,
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_request");
    const readable = JSON.stringify({
      [AGENT]: {
        scopes: { sources: "*", accounts: "*" },
        capabilities: ["summary.read"],
        budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 3 },
      },
      [STRANGER]: {
        scopes: { sources: "*", accounts: "*" },
        capabilities: ["summary.read"],
        budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 3 },
      },
    });
    const agent = await call(`${OPS}/projections`, {
      body: { reason: "agent attempt" },
      subject: AGENT,
      environment: {
        ...ENABLED,
        AGENT_GRANTS: JSON.stringify([AGENT]),
        AGENT_API_GRANTS: readable,
      },
    });
    expect(agent.status).toBe(403);
    expect((await agent.json()).error).toBe("approval_required");
    const stranger = await call(`${OPS}/projections`, {
      body: { reason: "stranger attempt" },
      subject: STRANGER,
      environment: { ...ENABLED, AGENT_API_GRANTS: readable },
    });
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).error).toBe("subject_not_granted");
    // The same payloads over `/mcp` never reach those graders: the caller
    // object is refused first, including when the MCP client has a read grant.
    const mcpGrants = JSON.stringify({
      [`mcp-client:${OPERATOR}`]: JSON.parse(readable)[AGENT],
      [`mcp-client:${AGENT}`]: JSON.parse(readable)[AGENT],
      [`mcp-client:${STRANGER}`]: JSON.parse(readable)[STRANGER],
    });
    for (const [subject, name, args] of [
      [OPERATOR, "kogane.ops.collection.request", { ...COLLECTION, source: "not-a-source" }],
      [OPERATOR, "kogane.ops.session.refresh", { source: "sony-bank", extra: "no" }],
      [AGENT, "kogane.ops.projection.request", { reason: "agent attempt" }],
      [STRANGER, "kogane.ops.projection.request", { reason: "stranger attempt" }],
    ] as const) {
      const called = await mcp(
        "tools/call",
        { name, arguments: args },
        { ...ENABLED, AGENT_API_GRANTS: mcpGrants },
        subject,
      );
      expect(called.result.isError, name).toBe(true);
      expect(called.result.structuredContent, `${subject} ${name}`).toEqual({
        error: "actor_not_supported",
      });
    }
  });

  // One resolver on HTTP. An MCP client is refused from the caller object
  // before that resolver runs, so a broken grant list cannot make the two
  // transports agree on `grants_misconfigured`.
  it("keeps the read tools listed and refuses operations while the grant lists cannot be read", async () => {
    const broken = { AGENT_GRANTS: JSON.stringify({ [AGENT]: 1 }) };
    const listed = await mcp("tools/list", {}, { ...THROUGH_MCP, ...broken });
    expect((listed.result.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      ...MCP_TOOLS.map((tool) => tool.name),
      PURCHASES_TOOL_NAME,
      ...RECONSTRUCTED_STATE_MCP_TOOLS.map((tool) => tool.name),
    ]);
    const called = await mcp(
      "tools/call",
      { name: "kogane.ops.projection.request", arguments: { reason: "misconfigured" } },
      { ...THROUGH_MCP, ...broken },
    );
    expect(called.result.isError).toBe(true);
    expect(called.result.structuredContent).toEqual({ error: "actor_not_supported" });
    const overHttp = await call(`${OPS}/projections`, {
      body: { reason: "misconfigured" },
      environment: { ...ENABLED, ...broken },
    });
    expect(overHttp.status).toBe(503);
    expect((await overHttp.json()).error).toBe("grants_misconfigured");
  });

  it("reads an operation over HTTP and refuses that read over MCP", async () => {
    const accepted = await ops("/imports", {
      source: "sony-bank",
      runId: "run-read-through-http",
    });
    const overHttp = await call(`${OPS}/operations/${accepted.json.operationId}`, {
      environment: ENABLED,
    });
    expect(overHttp.status).toBe(200);
    const receipt = (await overHttp.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      operationId: accepted.json.operationId,
      status: "accepted",
    });
    const read = await mcp(
      "tools/call",
      {
        name: "kogane.ops.operation.get",
        arguments: { operationId: accepted.json.operationId },
      },
      THROUGH_MCP,
    );
    expect(read.result.isError).toBe(true);
    expect(read.result.structuredContent).toEqual({ error: "actor_not_supported" });
    expect(read.result.structuredContent).not.toEqual(receipt);
  });
});
