// ADR 0081 point 2: one input with several refusals gets the same code and
// the same refs on the page's path (`/api/command/v1/approve`, `.../commit`)
// and over MCP (`kogane.command.approve`, `kogane.command.commit`), at the
// tool's `prepare` and at its `confirm`. The tool's pre-check is
// `previewApproval` / `previewCommit` in packages/application, which run the
// very checks `approve` and `commit` run, in their order.
//
// Real App Worker, real CORE migrations and the Processor's real command
// route over the same store. Every identity is invented. Plans and approvals
// are immutable, so expiry is the clock's: plans and approvals are made at
// minute 0 (a plan lasts 15 minutes, an approval 10), a confirmation is
// prepared at minute 9 (it lasts 10), and the answers come at minute 9, 11
// (the approvals expired) or 16 (the plans expired too).
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

const OWNER = "owner-precheck-parity-synthetic";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://precheck-parity.cloudflareaccess.com";
const OPERATOR: Principal = {
  id: OWNER,
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let rpc = 0;
let serial = 0;
let start = 0;
/** Sets the clock to `minutes` after the test's start. */
const at = (minutes: number) => vi.setSystemTime(start + minutes * 60_000);

const pipeline = {
  fetch: vi.fn(async (request: Request) => {
    const response = await changeCommandRoute(
      env as Parameters<typeof changeCommandRoute>[0],
      request,
      new URL(request.url).pathname,
    );
    if (!response) throw new Error("unexpected pipeline route");
    return response;
  }),
};

async function send(path: string, init: RequestInit, audience: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(
    "cf-access-jwt-assertion",
    await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(OWNER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey),
  );
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

const sql = (statement: string, ...binds: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...binds)
    .run();
const planStatus = async (planId: string) =>
  env.DB.prepare("SELECT status FROM change_plans WHERE plan_id=?")
    .bind(planId)
    .first<string>("status");

/** Plans, approves and commits as the operator through the application services. */
async function decideDirectly(kind: string, payload: unknown) {
  const store = d1CommandStore(env.DB);
  const now = new Date().toISOString();
  const planned = await createPlan(
    kind as never,
    payload,
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
  const committed = await commit(store, {
    operationId: `op-${planned.plan.planId.slice(-16)}`,
    principal: OPERATOR,
    planId: planned.plan.planId,
    approvalId: approved.approval.approvalId,
    planners: changeMutationPlanners(env.DB),
    now,
  });
  expect(committed).toMatchObject({ ok: true, replayed: false });
}

/**
 * A synthetic identifier on a rule mapping that the operator assigned, so
 * an override release has something to release. `end` releases it (its
 * mapping revision does not move); `move` assigns it elsewhere (it moves).
 */
async function subject() {
  const identifier = `precheck-parity-${++serial}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments VALUES ('${identifier}-rule','security','Synthetic rule listing','provider-local'),
        ('${identifier}-target','security','Synthetic target listing','identified'),
        ('${identifier}-other','security','Synthetic other listing','identified')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_identifiers VALUES ('${identifier}','synthetic-code','fixture','SYN-${serial}','{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES ('${identifier}-mapping','${identifier}',1,'${identifier}-rule','rule','synthetic rule mapping',1,'2099-01-01','Synthetic rule listing','provider-local')`,
    ),
  ]);
  const assign = (target: string) =>
    decideDirectly("identity.assign", {
      subject: "instrument",
      referenceId: identifier,
      targetId: `${identifier}-${target}`,
      reason: `synthetic assignment to ${target}`,
    });
  await assign("target");
  return {
    ref: `instrument_mapping:${identifier}`,
    release: (reason: string) => ({
      kind: "identity.release-override",
      payload: { subject: "instrument", referenceId: identifier, reason },
    }),
    end: () =>
      decideDirectly("identity.release-override", {
        subject: "instrument",
        referenceId: identifier,
        reason: "synthetic release that ends the override",
      }),
    move: () => assign("other"),
  };
}

interface Plan {
  planId: string;
  planDigest: string;
}

/** One path's own plan, approval and confirmation digests, and its answer's ids. */
interface Lane {
  plan: Plan;
  approvalId: string;
  args: Record<string, unknown>;
  digest: string;
}

async function planOverHttp(change: { kind: string; payload: unknown }): Promise<Plan> {
  const planned = await http("plan", change);
  expect(planned.failed).toBe(false);
  return planned.body.plan as Plan;
}

async function approveOverHttp(plan: Plan): Promise<string> {
  const approval = await http("approve", {
    planId: plan.planId,
    planDigest: plan.planDigest,
    scope: [],
  });
  expect(approval.failed).toBe(false);
  return approval.body.approval.approvalId as string;
}

async function prepare(name: string, args: Record<string, unknown>): Promise<string> {
  const prepared = await mcp(name, { ...args, step: "prepare" });
  expect(prepared.failed).toBe(false);
  return prepared.body.confirmation.digest as string;
}

async function approveOverMcp(plan: Plan, key: string): Promise<string> {
  const args = {
    planId: plan.planId,
    planDigest: plan.planDigest,
    scope: [],
    idempotencyKey: `${key}-approve`,
  };
  const approval = await mcp("kogane.command.approve", {
    ...args,
    step: "confirm",
    confirmationDigest: await prepare("kogane.command.approve", args),
  });
  expect(approval.failed).toBe(false);
  return approval.body.approval.approvalId as string;
}

/**
 * Three plans of one change (each its own reason), one per answer compared:
 * the page's `approve`, the tool's `prepare`, and the tool's `confirm` of a
 * digest prepared while the plan was still approvable.
 */
async function approveLanes(change: (reason: string) => { kind: string; payload: unknown }) {
  const key = `approve-${++serial}`;
  const page = await planOverHttp(change(`synthetic page approve ${key}`));
  const prepared = await planOverHttp(change(`synthetic tool prepare ${key}`));
  const confirmed = await planOverHttp(change(`synthetic tool confirm ${key}`));
  const args = (plan: Plan, suffix: string) => ({
    planId: plan.planId,
    planDigest: plan.planDigest,
    scope: [],
    idempotencyKey: `${key}-${suffix}`,
  });
  at(9);
  const digest = await prepare("kogane.command.approve", args(confirmed, "confirm"));
  return {
    page: { plan: page, approvalId: "", args: args(page, "page"), digest: "" },
    prepare: { plan: prepared, approvalId: "", args: args(prepared, "prepare"), digest: "" },
    confirm: { plan: confirmed, approvalId: "", args: args(confirmed, "confirm"), digest },
  } satisfies Record<string, Lane>;
}

/**
 * Three approved plans of one change: the page's `commit` with the
 * operator's approval, and the tool's `prepare` and `confirm` with the MCP
 * client's own approval, the latter's digest prepared while it could commit.
 */
async function commitLanes(change: (reason: string) => { kind: string; payload: unknown }) {
  const key = `commit-${++serial}`;
  const page = await planOverHttp(change(`synthetic page commit ${key}`));
  const prepared = await planOverHttp(change(`synthetic tool prepare ${key}`));
  const confirmed = await planOverHttp(change(`synthetic tool confirm ${key}`));
  const pageApproval = await approveOverHttp(page);
  const preparedApproval = await approveOverMcp(prepared, `${key}-prepare`);
  const confirmedApproval = await approveOverMcp(confirmed, `${key}-confirm`);
  const args = (plan: Plan, approvalId: string, suffix: string) => ({
    planId: plan.planId,
    approvalId,
    operationId: `${key}-${suffix}`,
  });
  at(9);
  const digest = await prepare(
    "kogane.command.commit",
    args(confirmed, confirmedApproval, "confirm"),
  );
  return {
    page: {
      plan: page,
      approvalId: pageApproval,
      args: args(page, pageApproval, "page"),
      digest: "",
    },
    prepare: {
      plan: prepared,
      approvalId: preparedApproval,
      args: args(prepared, preparedApproval, "prepare"),
      digest: "",
    },
    confirm: {
      plan: confirmed,
      approvalId: confirmedApproval,
      args: args(confirmed, confirmedApproval, "confirm"),
      digest,
    },
  } satisfies Record<string, Lane>;
}

type Lanes = Awaited<ReturnType<typeof commitLanes>>;

/** The answer with this lane's own plan and approval ids named, so lanes compare. */
function named(answer: Answer, lane: Lane): Answer {
  if (!answer.failed || !Array.isArray(answer.body?.refs)) return answer;
  return {
    failed: true,
    body: {
      ...answer.body,
      refs: (answer.body.refs as string[]).map((ref) =>
        ref === lane.plan.planId ? "<plan>" : ref === lane.approvalId ? "<approval>" : ref,
      ),
    },
  };
}

/** The three answers for one operation, each with its lane's ids named. */
async function answers(operation: "approve" | "commit", lanes: Lanes) {
  const tool = `kogane.command.${operation}`;
  const page = await http(operation, lanes.page.args);
  const prepared = await mcp(tool, { ...lanes.prepare.args, step: "prepare" });
  const confirmed = await mcp(tool, {
    ...lanes.confirm.args,
    step: "confirm",
    confirmationDigest: lanes.confirm.digest,
  });
  return {
    page: named(page, lanes.page),
    prepare: named(prepared, lanes.prepare),
    confirm: named(confirmed, lanes.confirm),
  };
}

const approvals = (lanes: Lanes) =>
  [lanes.page, lanes.prepare, lanes.confirm].map((l) => l.approvalId);
const inList = (values: string[]) => values.map(() => "?").join(",");
const spendApprovals = (ids: string[]) =>
  sql(`UPDATE approvals SET uses_remaining=0 WHERE approval_id IN (${inList(ids)})`, ...ids);

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: start });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("approve: one pre-check on the page's path and over MCP (ADR 0081)", () => {
  it("an ended release with an expired plan is `plan_expired` with the plan on every path", async () => {
    const s = await subject();
    const lanes = await approveLanes(s.release);
    await s.end();
    at(16);
    const got = await answers("approve", lanes);
    const expected = { failed: true, body: { error: "plan_expired", refs: ["<plan>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("an ended release is `target_missing` with the subject on every path", async () => {
    const s = await subject();
    const lanes = await approveLanes(s.release);
    await s.end();
    const got = await answers("approve", lanes);
    const expected = { failed: true, body: { error: "target_missing", refs: [s.ref] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("a moved plan is `stale_context` with the plan and the moved ref, and the lifecycle marks it", async () => {
    const s = await subject();
    const lanes = await approveLanes(s.release);
    await s.move();
    const got = await answers("approve", lanes);
    const expected = { failed: true, body: { error: "stale_context", refs: ["<plan>", s.ref] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
    // `approve` marks a moved plan stale; a `prepare` writes nothing.
    expect(await planStatus(lanes.page.plan.planId)).toBe("stale");
    expect(await planStatus(lanes.confirm.plan.planId)).toBe("stale");
    expect(await planStatus(lanes.prepare.plan.planId)).toBe("planned");
  });

  it("a moved and expired plan is `plan_expired` with the plan on every path", async () => {
    const s = await subject();
    const lanes = await approveLanes(s.release);
    await s.move();
    at(16);
    const got = await answers("approve", lanes);
    const expected = { failed: true, body: { error: "plan_expired", refs: ["<plan>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("a digest that is not the plan's on an expired plan is `stale_context` before `plan_expired`", async () => {
    const s = await subject();
    const page = await planOverHttp(s.release("synthetic page approve"));
    const tool = await planOverHttp(s.release("synthetic tool prepare"));
    at(16);
    const other = "f".repeat(64);
    const viaPage = await http("approve", { planId: page.planId, planDigest: other, scope: [] });
    const viaTool = await mcp("kogane.command.approve", {
      planId: tool.planId,
      planDigest: other,
      scope: [],
      idempotencyKey: `digest-${serial}`,
      step: "prepare",
    });
    const lane = (plan: Plan): Lane => ({ plan, approvalId: "", args: {}, digest: "" });
    const expected = { failed: true, body: { error: "stale_context", refs: ["<plan>"] } };
    expect(named(viaPage, lane(page))).toEqual(expected);
    expect(named(viaTool, lane(tool))).toEqual(expected);
  });
});

describe("commit: one pre-check on the page's path and over MCP (ADR 0081)", () => {
  it("an ended release with an expired approval is `approval_expired` with the approval on every path", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.end();
    at(11);
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "approval_expired", refs: ["<approval>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("an ended release with a spent approval is `approval_exhausted` with the approval on every path", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.end();
    await spendApprovals(approvals(lanes));
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "approval_exhausted", refs: ["<approval>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("an ended release is `target_missing` with the subject on every path", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.end();
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "target_missing", refs: [s.ref] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("a moved plan with an expired approval is `approval_expired` before `stale_context`", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.move();
    at(11);
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "approval_expired", refs: ["<approval>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("a moved and expired plan is `plan_expired` with the plan on every path", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.move();
    at(16);
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "plan_expired", refs: ["<plan>"] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
  });

  it("a moved plan is `stale_context` with the plan and the moved ref, and the lifecycle marks it", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    await s.move();
    const got = await answers("commit", lanes);
    const expected = { failed: true, body: { error: "stale_context", refs: ["<plan>", s.ref] } };
    expect(got).toEqual({ page: expected, prepare: expected, confirm: expected });
    expect(await planStatus(lanes.page.plan.planId)).toBe("stale");
    expect(await planStatus(lanes.confirm.plan.planId)).toBe("stale");
    expect(await planStatus(lanes.prepare.plan.planId)).toBe("approved");
  });

  it("an approval of another plan on an ended release is `stale_context` before `target_missing`", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    const other = await commitLanes(s.release);
    await s.end();
    // Each lane names the approval of the same path's other plan.
    for (const name of ["page", "prepare", "confirm"] as const)
      lanes[name].args.approvalId = other[name].approvalId;
    const page = await http("commit", lanes.page.args);
    const prepared = await mcp("kogane.command.commit", { ...lanes.prepare.args, step: "prepare" });
    const expected = { failed: true, body: { error: "stale_context", refs: ["<plan>"] } };
    expect(named(page, lanes.page)).toEqual(expected);
    expect(named(prepared, lanes.prepare)).toEqual(expected);
  });

  it("an approval another principal holds is `approval_required` on both paths", async () => {
    const s = await subject();
    const lanes = await commitLanes(s.release);
    // The operator commits the MCP client's approved plan with its approval,
    // and the MCP client the operator's.
    const page = await http("commit", {
      planId: lanes.prepare.plan.planId,
      approvalId: lanes.prepare.approvalId,
      operationId: `${lanes.page.args.operationId}-other`,
    });
    const prepared = await mcp("kogane.command.commit", {
      planId: lanes.page.plan.planId,
      approvalId: lanes.page.approvalId,
      operationId: `${lanes.prepare.args.operationId}-other`,
      step: "prepare",
    });
    expect(page).toEqual({ failed: true, body: { error: "approval_required" } });
    expect(prepared).toEqual(page);
  });

  it("a completed operation answers with its receipt as a replay on both paths", async () => {
    // One subject per path: a committed release leaves nothing to release.
    const pageLanes = await commitLanes((await subject()).release);
    const toolLanes = await commitLanes((await subject()).release);
    const lanes = { page: pageLanes.page, confirm: toolLanes.confirm };
    const page = await http("commit", lanes.page.args);
    const confirmed = await mcp("kogane.command.commit", {
      ...lanes.confirm.args,
      step: "confirm",
      confirmationDigest: lanes.confirm.digest,
    });
    expect(page).toMatchObject({ failed: false, body: { replayed: false } });
    expect(confirmed).toMatchObject({ failed: false, body: { replayed: false } });
    // The same operation again: the page's commit and the tool's prepare.
    const again = await http("commit", lanes.page.args);
    const preparedAgain = await mcp("kogane.command.commit", {
      ...lanes.confirm.args,
      step: "prepare",
    });
    expect(again).toEqual({ failed: false, body: { ...page.body, replayed: true } });
    expect(preparedAgain).toEqual({ failed: false, body: { ...confirmed.body, replayed: true } });
    // Both replays are recorded as replays of the operation, and the
    // prepare issued no confirmation.
    const recorded = await env.DB.prepare(
      `SELECT path,result,refs_json FROM audit_records
        WHERE operation='command.commit' AND target_ref=? AND result IN ('replayed','prepared')
        ORDER BY recorded_at`,
    )
      .bind(`plan:${lanes.confirm.plan.planId}`)
      .all();
    expect(recorded.results).toEqual([
      { path: "mcp", result: "prepared", refs_json: "[]" },
      {
        path: "mcp",
        result: "replayed",
        refs_json: JSON.stringify([`operation:${lanes.confirm.args.operationId}`]),
      },
    ]);
  });
});
