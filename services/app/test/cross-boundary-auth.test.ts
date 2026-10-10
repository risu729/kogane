// Independent integrated authorization audit; synthetic local D1 only.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  OperationCall,
  createPlan,
  d1CommandStore,
  parseGrants,
  type OperationName,
} from "../../../packages/application/src/index";
import { callDelegatedOpsTool, type OpsToolName } from "../src/ops-tools";
import { resolveMcpDelegation } from "../src/delegation";
import { seedRegistry } from "./fixtures";
import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read";
import { d1Executor } from "../../../packages/read-model/src/d1";
import type { DelegatedDecisionTool } from "../src/delegated-decision-tools";
import worker from "../src/worker";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import { changeCommandRoute } from "../../processor/src/change-commands";

const OWNER = "cross-auth-owner";
const OTHER = "cross-auth-other";
const key = (owner = OWNER) => `mcp-client:${owner}`;
const scopes = { sources: ["sony-bank", "other-test"], accounts: "*", scheduleSources: [] };
const grant = {
  scopes,
  capabilities: ["summary.read"],
  budget: { maxRows: 50, maxProposalTargets: 2, maxExplainDepth: 2 },
};
const entry = (owner = OWNER) => ({
  delegatedBy: owner,
  role: "maintainer",
  capabilities: ["operations.collection.request", "operations.session.refresh"],
  scopes,
  issuedAt: new Date(Date.now() - 60000).toISOString(),
  notAfter: new Date(Date.now() + 3600000).toISOString(),
  budget: { writesPerDay: 100 },
});
function config(owner = OWNER) {
  return {
    ...env,
    OPS_API_ENABLED: "true",
    SESSION_REFRESH_POLICY: "",
    OPERATOR_SUBJECTS: JSON.stringify([OWNER, OTHER]),
    AGENT_API_GRANTS: JSON.stringify({ [key(owner)]: grant }),
    MCP_DELEGATIONS: JSON.stringify({ [key(owner)]: entry(owner) }),
  } as Env;
}
async function invoke(name: OpsToolName, body: unknown, configuration: Env, owner = OWNER) {
  const resolution = await resolveMcpDelegation(
    configuration,
    { kind: "mcp-client", principal: key(owner) },
    new Date().toISOString(),
  );
  const audit = new OperationCall(name.slice(7) as OperationName, {
    path: "mcp",
    subject: owner,
    principal: key(owner),
    principalKind: "agent",
    correlationId: crypto.randomUUID(),
  });
  return callDelegatedOpsTool(name, body, configuration, resolution, audit);
}
const content = (result: { body: unknown }) => result.body as Record<string, any>;
const count = async () =>
  env.DB.prepare(
    "SELECT count(*) n FROM ops_requests WHERE principal LIKE 'mcp-client:cross-auth-%'",
  ).first<number>("n");
beforeAll(seedRegistry);
afterEach(() => vi.unstubAllGlobals());

it("scope shrink after provider prepare and read-grant shrink on exact replay both deny before another effect", async () => {
  const configuration = config();
  const request = {
    source: "sony-bank",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "cross-auth-shrink",
  };
  const preparation = await invoke(
    "kogane.ops.collection.request",
    { ...request, step: "prepare" },
    configuration,
  );
  expect(preparation.status).toBe(200);
  const digest = content(preparation).confirmation.digest;
  const declaration = JSON.parse(configuration.MCP_DELEGATIONS);
  const narrowed = {
    ...configuration,
    MCP_DELEGATIONS: JSON.stringify({
      [key()]: { ...declaration[key()], scopes: { ...scopes, sources: ["other-test"] } },
    }),
  } as Env;
  const before = await count();
  const denied = await invoke(
    "kogane.ops.collection.request",
    { ...request, step: "confirm", confirmationDigest: digest },
    narrowed,
  );
  expect(content(denied)).toEqual({ error: "target_missing", refs: ["source"] });
  expect(await count()).toBe(before);
  const accepted = await invoke(
    "kogane.ops.collection.request",
    { ...request, step: "confirm", confirmationDigest: digest },
    configuration,
  );
  expect(accepted.status).toBe(202);
  const smallerRead = {
    ...configuration,
    AGENT_API_GRANTS: JSON.stringify({
      [key()]: { ...grant, scopes: { ...scopes, sources: ["other-test"] } },
    }),
  } as Env;
  const revoked = await invoke(
    "kogane.ops.collection.request",
    { ...request, step: "confirm", confirmationDigest: digest },
    smallerRead,
  );
  expect(content(revoked)).toEqual({ error: "delegation_misconfigured" });
  expect(await count()).toBe(before! + 1);
});

it("changing only the declaration budget invalidates an old prepare and completed confirmation replay", async () => {
  const configuration = config();
  const request = { source: "sony-bank", idempotencyKey: "cross-auth-declaration" };
  const preparation = await invoke(
    "kogane.ops.session.refresh",
    { ...request, step: "prepare" },
    configuration,
  );
  const digest = content(preparation).confirmation.digest;
  const declaration = JSON.parse(configuration.MCP_DELEGATIONS);
  const changed = {
    ...configuration,
    MCP_DELEGATIONS: JSON.stringify({
      [key()]: { ...declaration[key()], budget: { writesPerDay: 99 } },
    }),
  } as Env;
  const before = await count();
  const rejected = await invoke(
    "kogane.ops.session.refresh",
    { ...request, step: "confirm", confirmationDigest: digest },
    changed,
  );
  expect(content(rejected)).toEqual({ error: "confirmation_invalid" });
  expect(await count()).toBe(before);
  const accepted = await invoke(
    "kogane.ops.session.refresh",
    { ...request, step: "confirm", confirmationDigest: digest },
    configuration,
  );
  expect(accepted.status).toBe(202);
  const replay = await invoke(
    "kogane.ops.session.refresh",
    { ...request, step: "confirm", confirmationDigest: digest },
    changed,
  );
  expect(content(replay)).toEqual({ error: "confirmation_invalid" });
  expect(await count()).toBe(before! + 1);
});

it("provider key namespace separates operation and principal and conflicts across source for the same operation", async () => {
  const configuration = config();
  const request = {
    source: "sony-bank",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "cross-auth-shared-key",
  };
  async function apply(
    name: "kogane.ops.collection.request" | "kogane.ops.session.refresh",
    wire: unknown,
    cfg: Env,
    owner = OWNER,
  ) {
    const prepared = await invoke(name, { ...(wire as object), step: "prepare" }, cfg, owner);
    expect(prepared.status).toBe(200);
    return invoke(
      name,
      {
        ...(wire as object),
        step: "confirm",
        confirmationDigest: content(prepared).confirmation.digest,
      },
      cfg,
      owner,
    );
  }
  const before = await count();
  const collection = await apply("kogane.ops.collection.request", request, configuration);
  expect(collection.status).toBe(202);
  const changed = await apply(
    "kogane.ops.collection.request",
    { ...request, source: "other-test" },
    configuration,
  );
  expect(content(changed)).toEqual({ error: "idempotency_conflict" });
  const session = await apply(
    "kogane.ops.session.refresh",
    { source: request.source, idempotencyKey: request.idempotencyKey },
    configuration,
  );
  expect(session.status).toBe(202);
  const other = await apply("kogane.ops.collection.request", request, config(OTHER), OTHER);
  expect(other.status).toBe(202);
  const ids = [collection, session, other].map((x) => content(x).operationId);
  expect(new Set(ids).size).toBe(3);
  expect(await count()).toBe(before! + 3);
});

it("R1 exact import replay does not return a denied-source receipt after scope shrink", async () => {
  const configuration = config();
  const request = {
    source: "sony-bank",
    runId: "synthetic-run-cross-auth",
    idempotencyKey: "cross-auth-r1",
  };
  const accepted = await invoke("kogane.ops.import.request", request, configuration);
  expect(accepted.status).toBe(202);
  const declaration = JSON.parse(configuration.MCP_DELEGATIONS);
  const narrowed = {
    ...configuration,
    MCP_DELEGATIONS: JSON.stringify({
      [key()]: { ...declaration[key()], scopes: { ...scopes, sources: ["other-test"] } },
    }),
  } as Env;
  const before = await count();
  const replay = await invoke("kogane.ops.import.request", request, narrowed);
  const receipt = await invoke(
    "kogane.ops.operation.get",
    { operationId: content(accepted).operationId },
    narrowed,
  );
  const missing = await invoke(
    "kogane.ops.operation.get",
    { operationId: `op_${"0".repeat(64)}` },
    narrowed,
  );
  expect(content(replay)).toEqual({ error: "target_missing", refs: ["source"] });
  expect(content(receipt)).toEqual(content(missing));
  expect(JSON.stringify(receipt.body)).not.toContain(content(accepted).operationId);
  expect(await count()).toBe(before);
});

it("a real delegated identity assignment and audit-linked reversal retain immutable delegated origin in history", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO instruments VALUES ('cross-auth-original','security','Synthetic original','identified')",
    ),
    env.DB.prepare(
      "INSERT INTO instruments VALUES ('cross-auth-adopted','security','Synthetic adopted','identified')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_identifiers VALUES ('cross-auth-identifier','synthetic-code','fixture','AUTH-ORIGIN','{}')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_mappings VALUES ('cross-auth-initial','cross-auth-identifier',1,'cross-auth-original','rule','synthetic base',1,'2099-01-01','Synthetic original','identified')",
    ),
  ]);
  const configuration = config();
  const declarations = JSON.parse(configuration.MCP_DELEGATIONS);
  configuration.MCP_DELEGATIONS = JSON.stringify({
    [key()]: {
      ...declarations[key()],
      role: "operator-delegate",
      scopes: { sources: "*", accounts: "*", scheduleSources: [] },
    },
  });
  configuration.AGENT_API_GRANTS = JSON.stringify({
    [key()]: {
      ...grant,
      scopes: { sources: "*", accounts: "*", scheduleSources: [] },
      capabilities: ["records.read"],
      budget: { ...grant.budget, maxRows: 200 },
    },
  });
  configuration.COMMANDS_ENABLED = "true";
  let capturedApproval: Request | undefined;
  let loseFirstCommit = true;
  let lostCorrelation: string | undefined;
  configuration.PIPELINE = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/approve")) capturedApproval = request.clone();
      const response = await changeCommandRoute(
        env as Parameters<typeof changeCommandRoute>[0],
        request,
        new URL(request.url).pathname,
      );
      if (!response) throw new Error("unexpected synthetic pipeline route");
      if (
        loseFirstCommit &&
        new URL(request.url).pathname.endsWith("/commit") &&
        response.status === 200
      ) {
        loseFirstCommit = false;
        lostCorrelation = request.headers.get("x-kogane-correlation-id")!;
        throw new Error("synthetic lost response after native commit");
      }
      return response;
    },
  } as unknown as Fetcher;
  const ownerActor = {
    id: OWNER,
    kind: "human" as const,
    verification: "server" as const,
    capabilities: ["interpretation.propose", "interpretation.accept"] as const,
  };
  const store = d1CommandStore(env.DB);
  async function plan(
    kind: "identity.assign" | "identity.release-override",
    baseContextId = "identity-current-v1",
  ) {
    return createPlan(
      kind,
      {
        subject: "instrument",
        referenceId: "cross-auth-identifier",
        ...(kind === "identity.assign" ? { targetId: "cross-auth-adopted" } : {}),
        reason: "synthetic independent authorization lifecycle",
      },
      { actor: ownerActor, baseContextId, now: new Date().toISOString(), ttlSeconds: 900 },
      store,
    );
  }
  const temporal = await plan(
    "identity.assign",
    "instrument-temporal:synthetic-as-recorded-selection",
  );
  expect(temporal).toMatchObject({ ok: false, error: "unsupported_semantics" });
  const original = await plan("identity.assign");
  if (!original.ok) throw new Error(original.error);
  const issuer = "https://cross-auth-synthetic.cloudflareaccess.com";
  configuration.ACCESS_ISSUER = issuer;
  configuration.ACCESS_AUDIENCE = "cross-auth-browser";
  configuration.ACCESS_MCP_AUDIENCE = "cross-auth-mcp";
  const signing = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [
      { ...(await exportJWK(signing.publicKey)), kid: "cross-auth", alg: "RS256", use: "sig" },
    ],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === issuer + "/cdn-cgi/access/certs") return Response.json(jwks);
    throw new Error("unexpected external request in local auth audit");
  });
  let rpcId = 0;
  async function decide(name: DelegatedDecisionTool | "kogane.instruments.history", body: unknown) {
    const token = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "cross-auth" })
      .setIssuer(issuer)
      .setAudience(configuration.ACCESS_MCP_AUDIENCE!)
      .setSubject(OWNER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signing.privateKey);
    const response = await worker.fetch(
      new Request("https://fixture.test/mcp", {
        method: "POST",
        headers: {
          ...MCP_CLIENT_HEADERS,
          "mcp-protocol-version": "2025-11-25",
          "cf-access-jwt-assertion": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name, arguments: body },
        }),
      }),
      configuration,
    );
    if (response.status !== 200) return { status: response.status, body: await response.json() };
    const message = (await response.json()) as {
      result: { structuredContent: unknown; isError?: boolean };
    };
    expect(message.result.isError).not.toBe(true);
    return { status: 200, body: message.result.structuredContent };
  }
  async function confirmed(name: DelegatedDecisionTool, body: object) {
    const prep = await decide(name, { ...body, step: "prepare" });
    expect(prep.status).toBe(200);
    return decide(name, {
      ...body,
      step: "confirm",
      confirmationDigest: content(prep).confirmation.digest,
    });
  }
  async function adopt(p: typeof original.plan, operationId: string, revertsAuditId?: string) {
    const approved = await confirmed("kogane.command.approve", {
      planId: p.planId,
      planDigest: p.planDigest,
      scope: [],
      idempotencyKey: operationId + "-approval",
    });
    expect(approved.status).toBe(200);
    const approval = content(approved).approval;
    const commitBody = {
      planId: p.planId,
      approvalId: approval.approvalId,
      operationId,
      ...(revertsAuditId ? { revertsAuditId } : {}),
    };
    const prep = await decide("kogane.command.commit", { ...commitBody, step: "prepare" });
    expect(prep.status).toBe(200);
    const confirm = {
      ...commitBody,
      step: "confirm",
      confirmationDigest: content(prep).confirmation.digest,
    };
    let applied = await decide("kogane.command.commit", confirm);
    if (operationId === "cross-auth-identity-assign") {
      expect(applied.status).toBe(500);
      expect(content(applied)).toMatchObject({ error: "internal_error" });
      const outcomes = await env.DB.prepare(
        "SELECT result,result_code,principal_kind FROM audit_records WHERE correlation_id=?",
      )
        .bind(lostCorrelation)
        .all();
      expect(outcomes.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ result: "applied", principal_kind: "delegated" }),
          expect.objectContaining({
            result: "failed",
            result_code: "upstream_unavailable",
            principal_kind: "delegated",
          }),
        ]),
      );
      const native = await env.DB.prepare(
        "SELECT principal FROM operation_receipts WHERE operation_id=?",
      )
        .bind(operationId)
        .first();
      expect(native).toEqual({ principal: key() });
      applied = await decide("kogane.command.commit", confirm);
      expect(content(applied).replayed).toBe(true);
      expect(
        await env.DB.prepare(
          "SELECT count(*) n FROM audit_records WHERE operation='command.commit' AND idempotency_key=? AND result='applied'",
        )
          .bind(operationId)
          .first<number>("n"),
      ).toBe(1);
      expect(
        await env.DB.prepare("SELECT count(*) n FROM decision_operations WHERE operation_id=?")
          .bind(operationId)
          .first<number>("n"),
      ).toBe(1);
    }
    expect(applied.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
        .bind(approval.approvalId)
        .first<number>("uses_remaining"),
    ).toBe(0);
    return content(applied).receipt;
  }
  const receipt = await adopt(original.plan, "cross-auth-identity-assign");
  const historyGrant = parseGrants(configuration.AGENT_API_GRANTS).get(key())!;
  const read = () =>
    readInstrumentHistoryForGrant({
      grant: historyGrant,
      sql: d1Executor(env.DB),
      identifierId: "cross-auth-identifier",
    });
  const history = await read();
  expect(history.ok).toBe(true);
  const mcpHistory = await decide("kogane.instruments.history", {
    identifierId: "cross-auth-identifier",
  });
  if (history.ok) expect(mcpHistory.body).toEqual(history.history);
  if (!history.ok) throw new Error(history.error.code);
  const adopted = history.history.entries.find(
    (e) => e.entry === "mapping" && e.instrumentId === "cross-auth-adopted",
  )!;
  expect(adopted.decisionOrigin).toBe("delegated");
  expect(adopted.method).toBe("manual");
  expect(
    history.history.entries.find((e) => e.recordId === receipt.decisionRevisionId)?.decisionOrigin,
  ).toBe("delegated");
  expect(JSON.stringify(history.history)).not.toContain(OWNER);
  const actor = await env.DB.prepare(
    "SELECT actor_id,actor_verification FROM decision_operations WHERE operation_id=?",
  )
    .bind("cross-auth-identity-assign")
    .first();
  expect(actor).toMatchObject({ actor_id: key(), actor_verification: "server" });
  // The Processor family guard independently rejects a valid identity prepare carried as relation-only.
  const headers = new Headers(capturedApproval!.headers);
  const execution = JSON.parse(headers.get("x-kogane-delegated-execution")!);
  headers.set(
    "x-kogane-delegated-execution",
    JSON.stringify({ ...execution, commandFamilies: ["relation"] }),
  );
  const denied = await changeCommandRoute(
    env as Parameters<typeof changeCommandRoute>[0],
    new Request(capturedApproval!.url, {
      method: "POST",
      headers,
      body: await capturedApproval!.text(),
    }),
    "/command/v1/approve",
  );
  expect(denied!.status).toBe(403);
  expect(await denied!.json()).toEqual({ error: "capability_not_delegated" });
  const appliedAudit = await env.DB.prepare(
    "SELECT audit_id FROM audit_records WHERE principal=? AND idempotency_key=? AND operation='command.commit' AND result='applied'",
  )
    .bind(key(), "cross-auth-identity-assign")
    .first<{ audit_id: string }>();
  const reverse = await plan("identity.release-override");
  if (!reverse.ok) throw new Error(reverse.error);
  const releaseReceipt = await adopt(
    reverse.plan,
    "cross-auth-identity-release",
    appliedAudit!.audit_id,
  );
  const after = await read();
  if (!after.ok) throw new Error(after.error.code);
  const mcpAfter = await decide("kogane.instruments.history", {
    identifierId: "cross-auth-identifier",
  });
  expect(mcpAfter.body).toEqual(after.history);
  expect(after.history.entries.find((e) => e.recordId === adopted.recordId)).toEqual(adopted);
  expect(
    after.history.entries.find((e) => e.recordId === releaseReceipt.decisionRevisionId)
      ?.decisionOrigin,
  ).toBe("delegated");
});

it("real MCP provider confirmation after declaration scope shrink is refused and audited without a native request", async () => {
  const configuration = config();
  const issuer = "https://cross-auth-provider.cloudflareaccess.com";
  configuration.ACCESS_ISSUER = issuer;
  configuration.ACCESS_AUDIENCE = "cross-auth-provider-browser";
  configuration.ACCESS_MCP_AUDIENCE = "cross-auth-provider-mcp";
  const signing = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [
      { ...(await exportJWK(signing.publicKey)), kid: "provider-auth", alg: "RS256", use: "sig" },
    ],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === issuer + "/cdn-cgi/access/certs") return Response.json(jwks);
    throw new Error("unexpected external request");
  });
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "provider-auth" })
    .setIssuer(issuer)
    .setAudience(configuration.ACCESS_MCP_AUDIENCE!)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signing.privateKey);
  let id = 0;
  async function send(body: object, cfg = configuration) {
    const response = await worker.fetch(
      new Request("https://fixture.test/mcp", {
        method: "POST",
        headers: {
          ...MCP_CLIENT_HEADERS,
          "mcp-protocol-version": "2025-11-25",
          "cf-access-jwt-assertion": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: "kogane.ops.collection.request", arguments: body },
        }),
      }),
      cfg,
    );
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        result: { structuredContent: Record<string, any>; isError?: boolean };
      }
    ).result;
  }
  const request = {
    source: "sony-bank",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "cross-auth-real-provider-scope",
  };
  const prepared = await send({ ...request, step: "prepare" });
  expect(prepared.isError).not.toBe(true);
  const declarations = JSON.parse(configuration.MCP_DELEGATIONS);
  const narrowed = {
    ...configuration,
    MCP_DELEGATIONS: JSON.stringify({
      [key()]: {
        ...declarations[key()],
        scopes: { ...scopes, sources: ["other-test"] },
      },
    }),
  } as Env;
  const before = await count();
  const auditCount = await env.DB.prepare(
    "SELECT count(*) n FROM audit_records WHERE principal=? AND operation='ops.collection.request' AND result='refused' AND result_code='target_missing'",
  )
    .bind(key())
    .first<number>("n");
  const refused = await send(
    {
      ...request,
      step: "confirm",
      confirmationDigest: prepared.structuredContent.confirmation.digest,
    },
    narrowed,
  );
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent).toEqual({ error: "target_missing", refs: ["source"] });
  expect(await count()).toBe(before);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM audit_records WHERE principal=? AND operation='ops.collection.request' AND result='refused' AND result_code='target_missing'",
    )
      .bind(key())
      .first<number>("n"),
  ).toBe(auditCount! + 1);
  expect(
    await env.DB.prepare(
      "SELECT operation_id FROM ops_requests WHERE principal=? AND idempotency_key=?",
    )
      .bind(key(), request.idempotencyKey)
      .first(),
  ).toBeNull();
});

it("completed collection confirmation retry returns its native receipt after source becomes inactive", async () => {
  const configuration = config();
  const request = {
    source: "other-test",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "cross-auth-replay-inactive",
  };
  const prepared = await invoke(
    "kogane.ops.collection.request",
    { ...request, step: "prepare" },
    configuration,
  );
  expect(prepared.status).toBe(200);
  const confirm = {
    ...request,
    step: "confirm",
    confirmationDigest: content(prepared).confirmation.digest,
  };
  const accepted = await invoke("kogane.ops.collection.request", confirm, configuration);
  expect(accepted.status).toBe(202);
  const before = await count();
  await env.DB.prepare("UPDATE sources SET active=0 WHERE id='other-test'").run();
  try {
    const retry = await invoke("kogane.ops.collection.request", confirm, configuration);
    expect.soft(retry.status).toBe(202);
    expect.soft(retry.body).toEqual(accepted.body);
    expect(await count()).toBe(before);
  } finally {
    await env.DB.prepare("UPDATE sources SET active=1 WHERE id='other-test'").run();
  }
});

it("completed session confirmation retry returns immutable accepted status after current policy changes", async () => {
  const configuration = config();
  const request = { source: "other-test", idempotencyKey: "cross-auth-replay-policy" };
  const prepared = await invoke(
    "kogane.ops.session.refresh",
    { ...request, step: "prepare" },
    configuration,
  );
  expect(prepared.status).toBe(200);
  const confirm = {
    ...request,
    step: "confirm",
    confirmationDigest: content(prepared).confirmation.digest,
  };
  const accepted = await invoke("kogane.ops.session.refresh", confirm, configuration);
  expect(accepted.status).toBe(202);
  const before = await count();
  const retry = await invoke("kogane.ops.session.refresh", confirm, {
    ...configuration,
    SESSION_REFRESH_POLICY: JSON.stringify({ "other-test": "unattended" }),
  } as Env);
  expect.soft(retry.status).toBe(202);
  expect.soft(retry.body).toEqual(accepted.body);
  expect(await count()).toBe(before);
});
