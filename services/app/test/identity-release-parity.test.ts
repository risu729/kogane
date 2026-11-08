// ADR 0081 point 2: an override release with nothing left to release gets the
// same refusal code on the page's path (`/api/command/v1/*`) and over MCP
// (`kogane.command.approve` and `.commit`), at approve and at commit, and a
// release whose override another release ends between its commit's reads and
// its batch gets the same `stale_context` on both. Both adapters forward to
// the Processor's one command route, which runs `approve` and `commit` in
// packages/application; the MCP decision tools re-simulate the plan first.
//
// Real App Worker, real CORE migrations and the Processor's real command
// route over the same store. Every identity is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type Principal,
} from "../../../packages/application/src/index";
import { changeCommandRoute, changeMutationPlanners } from "../../processor/src/change-commands";
import worker from "../src/worker";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "owner-release-parity-synthetic";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://release-parity.cloudflareaccess.com";
const OPERATOR: Principal = {
  id: OWNER,
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let rpc = 0;
/**
 * Runs once, between the Processor's reads and its batch, on the next
 * command request only: another release commits there.
 */
let raceNext: (() => Promise<unknown>) | null = null;

/** A D1 binding whose first batch first lets `racer` commit, as the processor tests race. */
function racedBeforeBatch(db: D1Database, racer: () => Promise<unknown>): D1Database {
  let raced = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch" && !raced)
        return async (statements: D1PreparedStatement[]) => {
          raced = true;
          await racer();
          return target.batch(statements);
        };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const pipeline = {
  fetch: vi.fn(async (request: Request) => {
    const racer = raceNext;
    raceNext = null;
    const routed = racer ? ({ ...env, DB: racedBeforeBatch(env.DB, racer) } as typeof env) : env;
    const response = await changeCommandRoute(
      routed as Parameters<typeof changeCommandRoute>[0],
      request,
      new URL(request.url).pathname,
    );
    if (!response) throw new Error("unexpected pipeline route");
    return response;
  }),
};

async function assertion(audience: string): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function send(path: string, init: RequestInit, audience: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await assertion(audience));
  return worker.fetch(new Request(`https://fixture.test${path}`, { ...init, headers }), {
    ...env,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    COMMANDS_ENABLED: "true",
    PIPELINE: pipeline,
  } as Env);
}

interface Answer {
  failed: boolean;
  body: any;
}

/** The page's path: the operator's browser session on `/api/command/v1/*`. */
async function http(operation: string, body: unknown): Promise<Answer> {
  const response = await send(
    `/api/command/v1/${operation}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    APP_AUD,
  );
  return { failed: response.status >= 400, body: await response.json() };
}

/** The MCP path: a `tools/call` from the MCP Access application's identity. */
async function mcp(name: string, args: unknown): Promise<Answer> {
  const response = await send(
    "/mcp",
    {
      method: "POST",
      headers: { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpc,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    MCP_AUD,
  );
  expect(response.status).toBe(200);
  const message = (await response.json()) as {
    result: { structuredContent: unknown; isError?: boolean };
  };
  return { failed: message.result.isError === true, body: message.result.structuredContent };
}

const count = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const counts = async () =>
  Promise.all(["approvals", "operation_receipts", "decision_revisions"].map(count));
const planStatus = async (planId: string) =>
  env.DB.prepare("SELECT status FROM change_plans WHERE plan_id=?")
    .bind(planId)
    .first<string>("status");
const usesLeft = async (approvalId: string) =>
  env.DB.prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
    .bind(approvalId)
    .first<number>("uses_remaining");

const release = (identifier: string, reason: string) => ({
  kind: "identity.release-override",
  payload: { subject: "instrument", referenceId: identifier, reason },
});

/** A synthetic identifier on a rule mapping, which the operator then assigns. */
async function protectedIdentifier(name: string): Promise<string> {
  const identifier = `release-parity-${name}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments VALUES ('${identifier}-rule','security','Synthetic rule listing','provider-local'),
        ('${identifier}-target','security','Synthetic target listing','identified')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_identifiers VALUES ('${identifier}','synthetic-code','fixture','SYN-${name}','{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES ('${identifier}-mapping','${identifier}',1,'${identifier}-rule','rule','synthetic rule mapping',1,'2099-01-01','Synthetic rule listing','provider-local')`,
    ),
  ]);
  const assigned = await decideDirectly({
    kind: "identity.assign",
    payload: {
      subject: "instrument",
      referenceId: identifier,
      targetId: `${identifier}-target`,
      reason: "synthetic manual assignment",
    },
  });
  expect(assigned).toMatchObject({ ok: true, replayed: false });
  return identifier;
}

/** Plans, approves and commits as the operator through the application services. */
async function decideDirectly(change: { kind: string; payload: unknown }) {
  const store = d1CommandStore(env.DB);
  const now = new Date().toISOString();
  const planned = await createPlan(
    change.kind as never,
    change.payload,
    { actor: OPERATOR, baseContextId: "identity-current-v1", now, ttlSeconds: 900 },
    store,
  );
  if (!planned.ok) throw new Error(planned.error);
  const approved = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor: OPERATOR,
    scope: [],
    ttlSeconds: 600,
    now,
  });
  if (!approved.ok) throw new Error(approved.error);
  return commit(store, {
    operationId: `op-${planned.plan.planId.slice(-16)}`,
    principal: OPERATOR,
    planId: planned.plan.planId,
    approvalId: approved.approval.approvalId,
    planners: changeMutationPlanners(env.DB),
    now,
  });
}

/** A release planned over the page's path; with `approved`, also approved there. */
async function httpRelease(identifier: string, reason: string, approved: boolean) {
  const planned = await http("plan", release(identifier, reason));
  expect(planned.failed).toBe(false);
  const plan = planned.body.plan as { planId: string; planDigest: string };
  if (!approved) return { plan, approvalId: "" };
  const approval = await http("approve", {
    planId: plan.planId,
    planDigest: plan.planDigest,
    scope: [],
  });
  expect(approval.failed).toBe(false);
  return { plan, approvalId: approval.body.approval.approvalId as string };
}

/**
 * A release planned over MCP; with `approved`, also approved there, and its
 * commit prepared, so the confirmation digest is one issued while the
 * override stood.
 */
async function mcpRelease(identifier: string, reason: string, approved: boolean) {
  const key = `${identifier}-${reason.replaceAll(" ", "-")}`;
  const planned = await mcp("kogane.command.plan", {
    ...release(identifier, reason),
    idempotencyKey: `${key}-plan`,
  });
  expect(planned.failed).toBe(false);
  const plan = planned.body.plan as { planId: string; planDigest: string };
  if (!approved) return { plan, approvalId: "", commitArgs: null, commitDigest: "" };
  const approveArgs = {
    planId: plan.planId,
    planDigest: plan.planDigest,
    scope: [],
    idempotencyKey: `${key}-approve`,
  };
  const prepared = await mcp("kogane.command.approve", { ...approveArgs, step: "prepare" });
  expect(prepared.failed).toBe(false);
  const approval = await mcp("kogane.command.approve", {
    ...approveArgs,
    step: "confirm",
    confirmationDigest: prepared.body.confirmation.digest,
  });
  expect(approval.failed).toBe(false);
  const approvalId = approval.body.approval.approvalId as string;
  const commitArgs = { planId: plan.planId, approvalId, operationId: `${key}-commit` };
  const commitPrepared = await mcp("kogane.command.commit", { ...commitArgs, step: "prepare" });
  expect(commitPrepared.failed).toBe(false);
  return {
    plan,
    approvalId,
    commitArgs,
    commitDigest: commitPrepared.body.confirmation.digest as string,
  };
}

beforeAll(async () => {
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
afterEach(() => {
  raceNext = null;
  vi.unstubAllGlobals();
});

describe("an override release with nothing left to release, on the page's path and MCP (ADR 0081)", () => {
  it("is refused with the same code at approve and at commit, writing nothing", async () => {
    const identifier = await protectedIdentifier("ended");
    const subjectRef = `instrument_mapping:${identifier}`;
    // Planned (and, for the commit, approved) on each path while the
    // override stands; the expected revision does not move when it ends.
    const approveOverHttp = await httpRelease(identifier, "synthetic page approve", false);
    const approveOverMcp = await mcpRelease(identifier, "synthetic tool approve", false);
    const commitOverHttp = await httpRelease(identifier, "synthetic page commit", true);
    const commitOverMcp = await mcpRelease(identifier, "synthetic tool commit", true);
    expect(
      await decideDirectly(release(identifier, "synthetic release that ends the override")),
    ).toMatchObject({ ok: true, replayed: false });
    const before = await counts();

    const approvedHttp = await http("approve", {
      planId: approveOverHttp.plan.planId,
      planDigest: approveOverHttp.plan.planDigest,
      scope: [],
    });
    const approvedMcp = await mcp("kogane.command.approve", {
      planId: approveOverMcp.plan.planId,
      planDigest: approveOverMcp.plan.planDigest,
      scope: [],
      idempotencyKey: `${identifier}-late-approve`,
      step: "prepare",
    });
    expect(approvedHttp).toEqual({
      failed: true,
      body: { error: "target_missing", refs: [subjectRef] },
    });
    // The tool's own re-simulation answers before the Processor is called,
    // with the code alone.
    expect(approvedMcp).toEqual({ failed: true, body: { error: approvedHttp.body.error } });

    const committedHttp = await http("commit", {
      planId: commitOverHttp.plan.planId,
      approvalId: commitOverHttp.approvalId,
      operationId: `${identifier}-page-commit`,
    });
    const confirmedMcp = await mcp("kogane.command.commit", {
      ...commitOverMcp.commitArgs,
      step: "confirm",
      confirmationDigest: commitOverMcp.commitDigest,
    });
    const preparedMcp = await mcp("kogane.command.commit", {
      ...commitOverMcp.commitArgs,
      step: "prepare",
    });
    expect(committedHttp).toEqual({
      failed: true,
      body: { error: "target_missing", refs: [subjectRef] },
    });
    expect(confirmedMcp).toEqual({ failed: true, body: { error: committedHttp.body.error } });
    expect(preparedMcp).toEqual(confirmedMcp);

    // No approval, receipt or decision; each plan as open as it was, each
    // approval unspent.
    expect(await counts()).toEqual(before);
    expect(await planStatus(approveOverHttp.plan.planId)).toBe("planned");
    expect(await planStatus(approveOverMcp.plan.planId)).toBe("planned");
    expect(await planStatus(commitOverHttp.plan.planId)).toBe("approved");
    expect(await planStatus(commitOverMcp.plan.planId)).toBe("approved");
    expect(await usesLeft(commitOverHttp.approvalId)).toBe(1);
    expect(await usesLeft(commitOverMcp.approvalId)).toBe(1);

    // A new plan of the subject is refused alike, by the Processor on both paths.
    const replannedHttp = await http("plan", release(identifier, "synthetic page replan"));
    const replannedMcp = await mcp("kogane.command.plan", {
      ...release(identifier, "synthetic tool replan"),
      idempotencyKey: `${identifier}-replan`,
    });
    expect(replannedHttp).toEqual({
      failed: true,
      body: { error: "target_missing", refs: [subjectRef] },
    });
    expect(replannedMcp).toEqual(replannedHttp);
  });

  it("answers `stale_context` on both paths when the override ends between the commit's reads and its batch", async () => {
    const answers: Answer[] = [];
    for (const path of ["page", "tool"] as const) {
      const identifier = await protectedIdentifier(`raced-${path}`);
      const loser =
        path === "page"
          ? await httpRelease(identifier, "synthetic raced release", true)
          : await mcpRelease(identifier, "synthetic raced release", true);
      const before = await counts();
      // The Processor's commit reads a protected subject; another release
      // commits before its batch.
      raceNext = async () =>
        expect(
          await decideDirectly(release(identifier, "synthetic winning release")),
        ).toMatchObject({ ok: true, replayed: false });
      const answer =
        path === "page"
          ? await http("commit", {
              planId: loser.plan.planId,
              approvalId: loser.approvalId,
              operationId: `${identifier}-page-commit`,
            })
          : await mcp("kogane.command.commit", {
              ...(loser as Awaited<ReturnType<typeof mcpRelease>>).commitArgs,
              step: "confirm",
              confirmationDigest: (loser as Awaited<ReturnType<typeof mcpRelease>>).commitDigest,
            });
      expect(raceNext).toBeNull();
      // Only the winner's approval, receipt and decision were written.
      expect(await counts()).toEqual(before.map((n) => n + 1));
      expect(await planStatus(loser.plan.planId)).toBe("approved");
      expect(await usesLeft(loser.approvalId)).toBe(1);
      answers.push(answer);
      expect(answer).toEqual({
        failed: true,
        body: { error: "stale_context", refs: [loser.plan.planId] },
      });
    }
    // The Processor's own answer on both paths, refs included.
    expect(answers[1]!.body.error).toBe(answers[0]!.body.error);
  });
});
