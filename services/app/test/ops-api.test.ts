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
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { validOperationRecord } from "../../../packages/observation-shared/src/operation-contract";
import { PURCHASES_TOOL_NAME } from "../src/agent-service";
import { MCP_TOOLS, RECONSTRUCTED_STATE_MCP_TOOLS } from "../src/mcp";
import { OPS_MCP_TOOLS, OPS_TOOL_NAMES } from "../src/ops-tools";
import { importSchema } from "../src/ops-api";
import { CollectionKeyError, RUN_ID, terminalKey } from "../../../packages/collection/src/keys";
import {
  claimCollectorStart,
  d1CommandStore,
  operationListArms,
  operationListSql,
  projectionRequirementWrite,
  recordCollectorOutcome,
  recordOperationStage,
  trackCollectorPublication,
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
 * The flag on and the two operators named. `OPERATOR_SUBJECTS` has to be explicit: the command
 * path's grant lists are allow-lists, so an authenticated subject that neither
 * names is refused with `subject_not_granted` rather than graded the operator
 * (docs/ops-api.md, "Authorization").
 */
const ENABLED = {
  OPS_API_ENABLED: "true",
  OPERATOR_SUBJECTS: JSON.stringify([OPERATOR, SECOND_OPERATOR]),
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
    headers?: Record<string, string>;
  } = {},
) {
  const jwt = await token(options.subject, path === "/mcp" ? MCP_AUDIENCE : undefined);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "cf-access-jwt-assertion": jwt,
      // What an MCP client sends on every POST (Streamable HTTP).
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
      ...options.headers,
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
    // The record the browser's 依頼の経過 page accepts (operation-contract.ts).
    expect(validOperationRecord(receipt, first.json.operationId)).toBe(true);
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
    expect(validOperationRecord(receipt, operationId)).toBe(true);
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

  it("keeps one operation per principal, and either principal reads the other's (ADR 0086)", async () => {
    const mine = await ops("/collections", { ...COLLECTION, idempotencyKey: "shared-key" });
    const theirs = await call(`${OPS}/collections`, {
      body: { ...COLLECTION, idempotencyKey: "shared-key" },
      subject: SECOND_OPERATOR,
      environment: ENABLED,
    });
    const other = (await theirs.json()) as Record<string, any>;
    expect(other.operationId).not.toBe(mine.json.operationId);
    // Reads are whole-store (owner, 2026-11-08 04:21 UTC): each principal
    // reads the other's operation exactly as its own principal does.
    const read = await call(`${OPS}/operations/${other.operationId}`, { environment: ENABLED });
    expect(read.status).toBe(200);
    const byOwner = await call(`${OPS}/operations/${other.operationId}`, {
      subject: SECOND_OPERATOR,
      environment: ENABLED,
    });
    expect(await read.json()).toEqual(await byOwner.json());
    const back = await call(`${OPS}/operations/${mine.json.operationId}`, {
      subject: SECOND_OPERATOR,
      environment: ENABLED,
    });
    expect(back.status).toBe(200);
    expect((await back.json()).operationId).toBe(mine.json.operationId);
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

  // An import names a run by the segment its terminal key carries
  // (`runs/<source>/<runId>/terminal.json`). A run id that grammar refuses can
  // never register, so accepting it would answer 202 for work that cannot
  // happen: it is refused here, with the same closed code as any other bad
  // field, and nothing is stored.
  it("refuses an import run id the bucket key grammar cannot address", async () => {
    const imports = () =>
      env.DB.prepare("SELECT count(*) AS n FROM ops_requests WHERE kind='import'").first<number>(
        "n",
      );
    const before = await imports();
    for (const runId of ["synthetic:run", "synthetic-run:2", "a/b", "run id", "-lead"]) {
      const outcome = await ops("/imports", { source: "sony-bank", runId });
      expect(outcome.status, runId).toBe(400);
      expect(outcome.json, runId).toMatchObject({ error: "invalid_request", refs: ["runId"] });
      expect(JSON.stringify(outcome.json)).not.toContain(runId);
    }
    expect(await imports()).toBe(before);
  });

  it("accepts exactly the run ids the terminal key accepts", () => {
    const samples = [
      "a",
      "A",
      "0",
      "run-1",
      "run.2026_01-a",
      "synthetic:run",
      "a:b",
      "a/b",
      ".",
      "..",
      ".hidden",
      "-lead",
      "_lead",
      "run id",
      "run\u0000",
      "ラン",
      "",
      "a".repeat(128),
      "a".repeat(129),
      "a".repeat(200),
      "a".repeat(201),
    ];
    for (const runId of samples) {
      let keyAccepts = true;
      try {
        terminalKey("sony-bank", runId);
      } catch (error) {
        expect(error).toBeInstanceOf(CollectionKeyError);
        keyAccepts = false;
      }
      expect(importSchema.safeParse({ source: "sony-bank", runId }).success, runId).toBe(
        keyAccepts,
      );
    }
  });

  // The MCP tool publishes the same grammar it validates with, so a client
  // that honours the listed pattern never sends a run id the App refuses.
  it("publishes the terminal key's run grammar on the MCP import tool", () => {
    const tool = OPS_MCP_TOOLS.find(({ name }) => name === "kogane.ops.import.request");
    expect(tool?.inputSchema).toMatchObject({
      properties: { runId: { type: "string", pattern: RUN_ID.source } },
    });
  });

  it("refuses a body larger than the bound before it reaches a schema", async () => {
    const response = await call(`${OPS}/projections`, {
      body: { reason: "x".repeat(20_000) },
      environment: ENABLED,
    });
    expect(response.status).toBe(413);
  });

  it("bounds the body in bytes, not in UTF-16 code units", async () => {
    // 6,000 kana are about 18 KB of UTF-8 but 6,000 code units.
    const response = await call(`${OPS}/projections`, {
      body: { reason: "あ".repeat(6_000) },
      environment: ENABLED,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request_too_large" });
  });

  // A page on another site must not drive a signed-in browser's Access
  // session into an operation (ADR 0078): the same own-origin rule as every
  // agent path, before a grant is graded or a body is read.
  it("refuses a request from another origin before it is graded or stored", async () => {
    const stored = () =>
      env.DB.prepare("SELECT count(*) AS n FROM ops_requests").first<number>("n");
    const before = await stored();
    for (const origin of ["https://elsewhere.invalid", "null", "http://fixture.test"]) {
      for (const [path, body] of [
        ["/collections", COLLECTION],
        ["/projections", { reason: "cross-site" }],
        ["/sessions/sony-bank/refresh", {}],
      ] as const) {
        const response = await call(`${OPS}${path}`, {
          body,
          environment: ENABLED,
          headers: { origin },
        });
        expect(response.status, `${origin} ${path}`).toBe(403);
        expect((await response.json()).error).toBe("origin_not_allowed");
      }
    }
    expect(await stored()).toBe(before);
    // The Worker's own origin, and a client that sends none (curl), are unaffected.
    const own = await call(`${OPS}/collections`, {
      body: { ...COLLECTION, idempotencyKey: "own-origin" },
      environment: ENABLED,
      headers: { origin: "https://fixture.test" },
    });
    expect(own.status).toBe(202);
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
    expect(validOperationRecord(receipt, operationId)).toBe(true);
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

describe("operations over /mcp: every MCP client, as itself (ADR 0047, ADR 0084)", () => {
  // Through the MCP Access application every caller is `mcp-client:<sub>`,
  // the operator included. Every such principal is published the operations
  // as itself (ADR 0084); none is ever graded as the operator, and the
  // operator lists grade the browser's routes only.
  const THROUGH_MCP = ENABLED;
  const opsRows = async () =>
    env.DB.prepare("SELECT count(*) AS n FROM ops_requests").first<number>("n");
  const opsOf = (names: string[]) => names.filter((name) => name.startsWith("kogane.ops."));

  it("publishes the operations tools to every MCP principal, and only with the flag on", async () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toHaveLength(6);
    const names = async (environment: Record<string, unknown>, subject = OPERATOR) =>
      (await mcp("tools/list", {}, environment, subject)).result.tools.map(
        (tool: any) => tool.name,
      ) as string[];
    expect(opsOf(await names({ ...THROUGH_MCP, OPS_API_ENABLED: "" }))).toEqual([]);
    for (const subject of [OPERATOR, AGENT, STRANGER])
      expect(opsOf(await names(THROUGH_MCP, subject)), subject).toEqual(OPS_TOOL_NAMES);
    // The read tools are the same whatever the flag says.
    const reads = (list: string[]) => list.filter((name) => !name.startsWith("kogane.ops."));
    expect(reads(await names(THROUGH_MCP))).toEqual(
      reads(await names({ ...THROUGH_MCP, OPS_API_ENABLED: "" })),
    );
    for (const name of [...MCP_TOOLS.map((tool) => tool.name), PURCHASES_TOOL_NAME])
      expect(await names(THROUGH_MCP)).toContain(name);
    for (const tool of RECONSTRUCTED_STATE_MCP_TOOLS)
      expect(await names(THROUGH_MCP)).toContain(tool.name);
    // The definitions are generated from the routes' schemas.
    expect(OPS_TOOL_NAMES).toEqual([
      "kogane.ops.collection.request",
      "kogane.ops.import.request",
      "kogane.ops.replay.request",
      "kogane.ops.projection.request",
      "kogane.ops.session.refresh",
      "kogane.ops.operation.get",
      "kogane.ops.operation.list",
    ]);
  });

  it("records an operation by a subject the UI does not list under its own MCP principal", async () => {
    const before = await opsRows();
    const called = await mcp(
      "tools/call",
      {
        name: "kogane.ops.import.request",
        arguments: { source: "sony-bank", runId: "run-over-mcp", idempotencyKey: "stranger-mcp" },
      },
      THROUGH_MCP,
      STRANGER,
    );
    expect(called.result.isError).not.toBe(true);
    expect(await opsRows()).toBe((before ?? 0) + 1);
    expect(
      await env.DB.prepare("SELECT principal FROM ops_requests WHERE idempotency_key=?")
        .bind("stranger-mcp")
        .first<string>("principal"),
    ).toBe(`mcp-client:${STRANGER}`);
    // The stranger is still nobody on the browser's operations routes.
    const overHttp = await call(`${OPS}/projections`, {
      body: { reason: "stranger over http" },
      subject: STRANGER,
      environment: ENABLED,
    });
    expect(overHttp.status).toBe(403);
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

  it("gives every MCP principal the service's own refusals", async () => {
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
    const agentLists = { ...THROUGH_MCP, AGENT_GRANTS: JSON.stringify([AGENT]) };
    const before = await opsRows();
    for (const [subject, name, args, error] of [
      [
        OPERATOR,
        "kogane.ops.collection.request",
        {
          ...COLLECTION,
          source: "not-a-source",
          idempotencyKey: "bogus-source-key",
          step: "prepare",
        },
        "target_missing",
      ],
      [
        OPERATOR,
        "kogane.ops.session.refresh",
        { source: "sony-bank", extra: "no" },
        "invalid_request",
      ],
      [
        AGENT,
        "kogane.ops.session.refresh",
        { source: "sony-bank", extra: "no" },
        "invalid_request",
      ],
      [
        STRANGER,
        "kogane.ops.collection.request",
        {
          ...COLLECTION,
          source: "not-a-source",
          idempotencyKey: "stranger-bogus-source-key",
          step: "prepare",
        },
        "target_missing",
      ],
    ] as const) {
      const called = await mcp("tools/call", { name, arguments: args }, agentLists, subject);
      expect(called.result.isError, name).toBe(true);
      expect(called.result.structuredContent.error, `${subject} ${name}`).toBe(error);
      expect(JSON.stringify(called.result.structuredContent)).not.toContain("not-a-source");
    }
    expect(await opsRows()).toBe(before);
  });

  // The operator lists grade the browser's routes only: a broken list is a
  // misconfiguration there, and changes nothing over MCP.
  it("answers MCP alike whatever the operator lists say, while HTTP refuses a broken list", async () => {
    const broken = { AGENT_GRANTS: JSON.stringify({ [AGENT]: 1 }) };
    const missing = (environment: Record<string, unknown>) =>
      mcp(
        "tools/call",
        { name: "kogane.ops.operation.get", arguments: { operationId: `op_${"0".repeat(64)}` } },
        environment,
      );
    const healthy = await missing(THROUGH_MCP);
    const misconfigured = await missing({ ...THROUGH_MCP, ...broken });
    expect(misconfigured.result.structuredContent).toEqual(healthy.result.structuredContent);
    const overHttp = await call(`${OPS}/projections`, {
      body: { reason: "misconfigured" },
      environment: { ...ENABLED, ...broken },
    });
    expect(overHttp.status).toBe(503);
    expect((await overHttp.json()).error).toBe("grants_misconfigured");
  });

  it("follows a published collection to the READ projection alike on HTTP and MCP (ADR 0048)", async () => {
    // One request per transport, each under its own principal.
    const overHttp = await ops("/collections", { ...COLLECTION, idempotencyKey: "projected-http" });
    const request = { ...COLLECTION, idempotencyKey: "projected-mcp" };
    const prepared = await mcp(
      "tools/call",
      { name: "kogane.ops.collection.request", arguments: { ...request, step: "prepare" } },
      THROUGH_MCP,
    );
    const confirmed = await mcp(
      "tools/call",
      {
        name: "kogane.ops.collection.request",
        arguments: {
          ...request,
          step: "confirm",
          confirmationDigest: prepared.result.structuredContent.confirmation.digest,
        },
      },
      THROUGH_MCP,
    );
    expect(confirmed.result.isError).not.toBe(true);
    const ids = [
      overHttp.json.operationId as string,
      confirmed.result.structuredContent.operationId as string,
    ];
    // What the Processor records up to publication, through the same services:
    // the published batch stores the CORE revision READ has to reach.
    const store = d1CommandStore(env.DB);
    const publishedAt = "2026-09-07T00:20:00.000Z";
    for (const operationId of ids) {
      const stored = (await row(operationId)) as Record<string, any>;
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
        outcome: { kind: "collected", runIds: ["synthetic-projected-run"] },
      });
      for (const stage of ["registered", "parsed", "adopted"] as const)
        await recordOperationStage({
          store,
          operationId,
          stage,
          state: "completed",
          now: publishedAt,
          evidenceRef: "r_1",
        });
      await store.batch([
        {
          sql: `UPDATE ops_collector_dispatches SET state='published',published_at=?2,
            finished_at=?2,updated_at=?2 WHERE operation_id=?1 AND state='collected'`,
          binds: [operationId, publishedAt],
        },
        projectionRequirementWrite(operationId, publishedAt),
      ]);
    }
    const revision = (await env.DB.prepare(
      "SELECT source_revision, core_epoch FROM core_source_revision WHERE id=1",
    ).first<{ source_revision: number; core_epoch: string }>())!;
    const follow = async () => {
      const http = await call(`${OPS}/operations/${ids[0]}`, { environment: ENABLED });
      expect(http.status).toBe(200);
      const viaMcp = await mcp(
        "tools/call",
        { name: "kogane.ops.operation.get", arguments: { operationId: ids[1] } },
        THROUGH_MCP,
      );
      expect(viaMcp.result.isError).not.toBe(true);
      const receipts = [
        (await http.json()) as Record<string, any>,
        viaMcp.result.structuredContent,
      ];
      // Every derived `projected` state is a record the 依頼の経過 page accepts.
      receipts.forEach((receipt, index) =>
        expect(validOperationRecord(receipt, ids[index])).toBe(true),
      );
      return receipts;
    };
    const projected = (receipt: Record<string, any>) => ({
      status: receipt.status,
      projected: receipt.stages.find((stage: any) => stage.stage === "projected"),
    });
    // Nothing is published in READ yet: unavailable, never completed.
    for (const receipt of await follow())
      expect(projected(receipt)).toMatchObject({
        status: "running",
        projected: { state: "pending", evidenceRef: null, failureCode: "read_model_unavailable" },
      });
    // A snapshot verified one revision before publication is behind.
    const snapshotId = "d".repeat(64);
    const at = "2026-09-07T00:30:00.000Z";
    await env.READ.batch([
      env.READ.prepare(
        `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version)
         VALUES(1,'instance-ops-projected',?1,'read-baseline-v1')`,
      ).bind(at),
      env.READ.prepare(
        `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,
           build_digest,contract_version,read_instance_id,source_revision,visibility_revision,
           core_epoch,status,row_count,output_digest,input_manifest_json,projection_release,
           created_at,completed_at)
         VALUES(?1,?1,1,?1,?1,'read-baseline-v1','instance-ops-projected',?2,1,?3,'complete',0,?1,
           '{}','balance-projection-v1',?4,?4)`,
      ).bind(snapshotId, revision.source_revision - 1, revision.core_epoch, at),
      env.READ.prepare(
        `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
           core_epoch,read_instance_id,output_digest,switched_at)
         VALUES(1,?1,?2,1,?3,'instance-ops-projected',?1,?4)`,
      ).bind(snapshotId, revision.source_revision - 1, revision.core_epoch, at),
    ]);
    for (const receipt of await follow())
      expect(projected(receipt)).toMatchObject({
        status: "running",
        projected: { state: "pending", failureCode: "projection_behind" },
      });
    // Verified at the revision publication stored: projected, and the request complete.
    await env.READ.prepare("UPDATE balance_snapshot_pointer SET source_revision=?1 WHERE id=1")
      .bind(revision.source_revision)
      .run();
    const [http, viaMcp] = await follow();
    expect(projected(http!)).toEqual({
      status: "completed",
      projected: {
        stage: "projected",
        state: "completed",
        evidenceRef: `read-snapshot:${snapshotId}`,
        failureCode: null,
        attempts: 0,
        updatedAt: publishedAt,
      },
    });
    expect(projected(viaMcp)).toEqual(projected(http!));
    expect(viaMcp.stages).toEqual(http!.stages);
    // A re-send answers with the status a read does.
    const resent = await ops("/collections", { ...COLLECTION, idempotencyKey: "projected-http" });
    expect(resent).toEqual({
      status: 202,
      json: { operationId: ids[0], status: "completed" },
    });
  });

  it("reads late publication on the same operation equally over HTTP and MCP without changing its receipt", async () => {
    const accepted = await ops("/collections", {
      ...COLLECTION,
      idempotencyKey: "late-publication",
    });
    const operationId = accepted.json.operationId as string;
    const stored = (await row(operationId)) as Record<string, any>;
    const store = d1CommandStore(env.DB);
    const collectedAt = "2026-09-07T00:06:00.000Z";
    const finishedAt = "2026-09-09T00:07:00.000Z";
    expect(
      await claimCollectorStart({
        store,
        operationId,
        action: "collect",
        acceptedAt: stored.created_at,
        expiresAt: new Date(Date.parse(stored.created_at) + 24 * 3_600_000).toISOString(),
        now: collectedAt,
        binding: { connectionId: "sony-bank", terminalSource: "sony-bank" },
      }),
    ).toBe(true);
    await recordCollectorOutcome({
      store,
      operationId,
      now: collectedAt,
      nowMs: Date.parse(collectedAt),
      outcome: { kind: "collected", runIds: ["synthetic-late-original"] },
    });
    await trackCollectorPublication({
      store,
      operationId,
      now: finishedAt,
      nowMs: Date.parse(finishedAt),
      checkIntervalMs: 300_000,
    });
    const read = async () => {
      const http = await call(`${OPS}/operations/${operationId}`, { environment: ENABLED });
      const viaMcp = await mcp(
        "tools/call",
        {
          name: "kogane.ops.operation.get",
          arguments: { operationId },
        },
        THROUGH_MCP,
      );
      expect(http.status).toBe(200);
      expect(viaMcp.result.isError).not.toBe(true);
      const receipt = (await http.json()) as Record<string, any>;
      expect(viaMcp.result.structuredContent).toEqual(receipt);
      expect(validOperationRecord(receipt, operationId)).toBe(true);
      return receipt;
    };
    const originalRow = await row(operationId);
    const before = await read();
    expect(before.execution.currentResult.state).toBe("publication_not_observed");
    const fetch = await seedRun({ source: "sony-bank", count: 1 });
    await env.DB.prepare(`INSERT INTO collection_runs(source,run_id,terminal_key,terminal_digest,
      registration_contract_version,provider_outcome,coverage_status,first_seen_at)
      VALUES('sony-bank','synthetic-late-original','runs/synthetic/terminal.json',?1,
      'terminal-registration-v2','success','complete',?2)`)
      .bind("d".repeat(64), finishedAt)
      .run();
    await env.DB.prepare(`UPDATE collection_runs SET fetch_run_id=?1,registered_at=?2
      WHERE source='sony-bank' AND run_id='synthetic-late-original'`)
      .bind(fetch.id, finishedAt)
      .run();
    await env.DB.prepare(`UPDATE observation_work_items SET processed_at_ms=1,outcome='jobs_created'
      WHERE fetch_run_id=? AND kind='sealed_run'`)
      .bind(fetch.id)
      .run();
    const parse =
      await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,
      parsed_at,status,warnings_json) VALUES(?,'ops-fixture','1.0.0','2026-09-09','ok','[]')`)
        .bind(fetch.artifacts[0]!.id)
        .run();
    await publishParse(Number(parse.meta.last_row_id), "2026-09-09T00:10:00Z");
    const after = await read();
    expect(after.execution.currentResult.state).toBe("published");
    expect(after.execution.currentResult.publishedAt).toBeNull();
    expect(after.execution.currentResult.readReadiness).toBe("unproven");
    expect(after.status).toBe("failed");
    expect(after.failureCode).toBe("publication_not_observed");
    expect(after.stages).toEqual(before.stages);
    expect(after.execution.finishedAt).toBe(before.execution.finishedAt);
    expect(await row(operationId)).toEqual(originalRow);
  });

  it("shows the operator's browser receipt to its MCP principal as the route does (ADR 0086)", async () => {
    const accepted = await ops("/imports", {
      source: "sony-bank",
      runId: "run-read-through-http",
    });
    const overHttp = await call(`${OPS}/operations/${accepted.json.operationId}`, {
      environment: ENABLED,
    });
    expect(overHttp.status).toBe(200);
    const receipt = (await overHttp.json()) as Record<string, unknown>;
    expect(validOperationRecord(receipt, accepted.json.operationId)).toBe(true);
    expect(receipt).toMatchObject({
      operationId: accepted.json.operationId,
      status: "accepted",
    });
    const get = (operationId: string) =>
      mcp(
        "tools/call",
        { name: "kogane.ops.operation.get", arguments: { operationId } },
        THROUGH_MCP,
      );
    const read = await get(accepted.json.operationId);
    expect(read.result.isError).not.toBe(true);
    expect(read.result.structuredContent).toEqual(receipt);
    const missing = await get(`op_${"0".repeat(64)}`);
    expect(missing.result.isError).toBe(true);
  });
});

describe("the operator lists every principal's operations (ADR 0086)", () => {
  /** Two operators, so the list is shown to be no one principal's. */
  const LISTER = "ops-list-operator";
  const LISTER_PEER = "ops-list-peer";
  const LISTING = {
    ...ENABLED,
    OPERATOR_SUBJECTS: JSON.stringify([LISTER, LISTER_PEER]),
  };
  /** Free text an operator may store with a rebuild; the list never shows it. */
  const REASON = "synthetic rebuild reason";

  async function request(path: string, body: unknown, subject = LISTER) {
    const response = await call(`${OPS}${path}`, { body, subject, environment: LISTING });
    expect(response.status).toBe(202);
    return ((await response.json()) as { operationId: string }).operationId;
  }

  async function list(query = "", subject = LISTER, environment: Record<string, unknown> = {}) {
    const response = await call(`${OPS}/operations${query}`, {
      subject,
      environment: { ...LISTING, ...environment },
    });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  }

  async function seed() {
    return {
      collection: await request("/collections", { ...COLLECTION, idempotencyKey: "list-1" }),
      imported: await request("/imports", { source: "sony-bank", runId: "run-list-import" }),
      projection: await request("/projections", { reason: REASON, idempotencyKey: "list-2" }),
      peer: await request("/projections", { reason: REASON }, LISTER_PEER),
    };
  }

  const idsOf = (page: Record<string, any>): string[] =>
    page["operations"].map((entry: { operationId: string }) => entry.operationId);

  /** Every stored request of the shape, of every principal, in the list's order. */
  async function storedIds(where = "1", ...binds: unknown[]): Promise<string[]> {
    return (
      await env.DB.prepare(
        `SELECT operation_id FROM ops_requests WHERE ${where} ORDER BY created_at DESC,operation_id DESC`,
      )
        .bind(...binds)
        .all<{ operation_id: string }>()
    ).results.map((entry) => entry.operation_id);
  }

  it("answers every principal's requests newest first, as summaries without payload text", async () => {
    const ids = await seed();
    const own = await list("?limit=50");
    expect(own.status).toBe(200);
    expect(own.json["schemaVersion"]).toBe("kogane-operation-list-v1");
    const stored = await storedIds();
    expect(idsOf(own.json)).toEqual(stored.slice(0, 50));
    expect(own.json["nextCursor"]).toBe(stored.length > 50 ? stored[49] : null);
    // The peer's request is listed with the caller's: reads are whole-store
    // (owner, 2026-11-08 04:21 UTC).
    for (const id of [ids.collection, ids.imported, ids.projection, ids.peer])
      expect(idsOf(own.json)).toContain(id);
    const projection = own.json["operations"].find(
      (entry: { operationId: string }) => entry.operationId === ids.projection,
    );
    expect(Object.keys(projection).sort()).toEqual([
      "acceptedAt",
      "dispatch",
      "failureCode",
      "kind",
      "operationId",
      "source",
      "status",
      "updatedAt",
    ]);
    expect(projection).toMatchObject({ kind: "projection", status: "accepted", source: null });
    // The stored request is not read: a rebuild's reason is the operator's text.
    expect(JSON.stringify(own.json)).not.toContain(REASON);
    // The peer is shown the same page.
    expect((await list("?limit=50", LISTER_PEER)).json).toEqual(own.json);
  });

  it("pages by cursor and filters by kind and status, each a closed value", async () => {
    await seed();
    const all = await storedIds();
    expect(all.length).toBeGreaterThanOrEqual(4);
    const first = await list("?limit=2");
    expect(idsOf(first.json)).toEqual(all.slice(0, 2));
    expect(first.json["nextCursor"]).toBe(all[1]);
    // The next page is the same whichever operator asks for it.
    const second = await list(`?limit=2&cursor=${first.json["nextCursor"]}`, LISTER_PEER);
    expect(idsOf(second.json)).toEqual(all.slice(2, 4));
    expect(second.json["nextCursor"]).toBe(all.length > 4 ? all[3] : null);
    const imports = await list("?kind=import&limit=50");
    expect(idsOf(imports.json)).toEqual((await storedIds("kind='import'")).slice(0, 50));
    expect(idsOf(imports.json).length).toBeGreaterThan(0);
    const projections = await list("?status=accepted&kind=projection&limit=50");
    expect(idsOf(projections.json)).toEqual(
      (await storedIds("status='accepted' AND kind='projection'")).slice(0, 50),
    );
    const completed = await list("?status=completed&limit=50");
    expect(idsOf(completed.json)).toEqual((await storedIds("status='completed'")).slice(0, 50));
  });

  it("refuses a query outside its closed keys and values, naming the key and never the value", async () => {
    const cases: [string, string[] | undefined][] = [
      ["?purge=1", undefined],
      ["?kind=import&kind=replay", ["kind"]],
      ["?kind=DROP%20TABLE", ["kind"]],
      ["?kind=", ["kind"]],
      ["?status=done", ["status"]],
      ["?limit=0", ["limit"]],
      ["?limit=51", ["limit"]],
      ["?limit=05", ["limit"]],
      ["?cursor=not-an-operation", ["cursor"]],
    ];
    for (const [query, refs] of cases) {
      const refused = await list(query);
      expect(refused.status, query).toBe(400);
      expect(refused.json["error"], query).toBe("invalid_query");
      expect(refused.json["refs"], query).toEqual(refs);
      expect(JSON.stringify(refused.json), query).not.toMatch(/purge|DROP|done|not-an-operation/u);
    }
    // A cursor of another principal pages on; one of no operation is refused.
    const peer = await request("/projections", { reason: REASON }, LISTER_PEER);
    expect((await list(`?cursor=${peer}`)).status).toBe(200);
    const refused = await list(`?cursor=op_${"0".repeat(64)}`);
    expect(refused.status).toBe(404);
    expect(refused.json).toMatchObject({ error: "receipt_not_found", refs: ["cursor"] });
  });

  it("refuses an agent and a stranger on the route, and is absent while the flag is off", async () => {
    const agent = await list("", AGENT, { AGENT_GRANTS: JSON.stringify([AGENT]) });
    expect(agent.status).toBe(403);
    expect(agent.json["error"]).toBe("approval_required");
    const stranger = await list("", STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.json["error"]).toBe("subject_not_granted");
    const off = await list("", LISTER, { OPS_API_ENABLED: "" });
    expect(off.status).toBe(404);
    expect(off.json["error"]).toBe("not_found");
    const post = await call(`${OPS}/operations`, {
      body: {},
      subject: LISTER,
      environment: LISTING,
    });
    expect(post.status).toBe(404);
  });

  it("records each read as a count in the audit log, never an operation of the page", async () => {
    await seed();
    const recorded = async () =>
      (
        await env.DB.prepare(
          "SELECT result,target_ref,diff_json FROM audit_records WHERE operation='ops.operation.list' AND principal=? ORDER BY recorded_at,audit_id",
        )
          .bind(LISTER)
          .all<Record<string, unknown>>()
      ).results;
    const before = (await recorded()).length;
    expect((await list("?limit=1")).status).toBe(200);
    const records = (await recorded()).slice(before);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ result: "read", target_ref: null });
    expect(JSON.parse(records[0]!["diff_json"] as string)).toEqual({
      kind: "read",
      rows: 1,
      truncated: true,
    });
  });

  it("reads ops_requests through ops_requests_open without table statistics", async () => {
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'",
      ).first("n"),
    ).toBe(0);
    const shapes = [
      { kind: null, status: null },
      { kind: "collection", status: null },
      { kind: null, status: "running" },
      { kind: "replay", status: "failed" },
    ] as const;
    for (const shape of shapes)
      for (const after of [false, true]) {
        const arms = operationListArms(shape);
        const binds: unknown[] = [21];
        for (const [status, kind] of arms) binds.push(status, kind);
        if (after) binds.push("2026-09-11T00:00:00Z", `op_${"0".repeat(64)}`);
        const plan = (
          await env.DB.prepare(`EXPLAIN QUERY PLAN ${operationListSql(arms.length, after)}`)
            .bind(...binds)
            .all<{ detail: string }>()
        ).results.map((entry) => entry.detail);
        const reads = plan.filter((line) => /\bops_requests\b/u.test(line));
        // No filter is all thirty (status, kind) pairs: D1 accepts the nested compound.
        expect(reads).toHaveLength(arms.length);
        const range = after ? " AND created_at<?)" : ")";
        for (const line of reads)
          expect(line).toBe(
            `SEARCH ops_requests USING INDEX ops_requests_open (status=? AND kind=?${range}`,
          );
      }
  });
});
