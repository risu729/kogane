// Independent integration audit: signed synthetic MCP, actual native schedule/D1 writer.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/worker";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import { delegatedScheduleRoute } from "../../processor/src/delegated-schedules";
import { updateSchedule } from "../../processor/src/schedule-store";
import { OperationCall, type DelegatedJobPayload } from "../../../packages/application/src/index";

const OWNER = "jobs-cross-auth-owner",
  OTHER = "jobs-cross-auth-other";
const principal = (subject = OWNER) => `mcp-client:${subject}`;
const ISSUER = "https://jobs-cross-auth.cloudflareaccess.com";
const scopes = { sources: ["sony-bank"], accounts: "*", scheduleSources: "*" };
const grant = {
  scopes,
  capabilities: ["summary.read"],
  budget: { maxRows: 50, maxProposalTargets: 2, maxExplainDepth: 2 },
};
const interval = {
  issuedAt: new Date(Date.now() - 60000).toISOString(),
  notAfter: new Date(Date.now() + 3600000).toISOString(),
};
const entry = (subject = OWNER) => ({
  delegatedBy: subject,
  role: "maintainer",
  capabilities: ["schedules.job.update", "operations.collection.request"],
  scopes,
  ...interval,
  budget: { writesPerDay: 100 },
});
let signing: Awaited<ReturnType<typeof generateKeyPair>>, jwks: { keys: unknown[] };
let calls = 0,
  alarms = 0;
let alarm: string | null = null;
let native: Parameters<typeof delegatedScheduleRoute>[1];
beforeAll(async () => {
  signing = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [
      { ...(await exportJWK(signing.publicKey)), kid: "jobs-cross-auth", alg: "RS256", use: "sig" },
    ],
  };
  native = {
    ...env,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({
        reconcile: async () => {
          alarms++;
          return alarm;
        },
        alarmTime: async () => alarm,
      }),
    },
  } as unknown as Parameters<typeof delegatedScheduleRoute>[1];
});
afterEach(() => vi.unstubAllGlobals());
function config(subject = OWNER): Record<string, unknown> {
  return {
    ...env,
    SCHEDULES_ENABLED: "true",
    OPS_API_ENABLED: "true",
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: "jobs-cross-browser",
    ACCESS_MCP_AUDIENCE: "jobs-cross-mcp",
    OPERATOR_SUBJECTS: JSON.stringify([OWNER, OTHER]),
    AGENT_API_GRANTS: JSON.stringify({ [principal(subject)]: grant }),
    MCP_DELEGATIONS: JSON.stringify({ [principal(subject)]: entry(subject) }),
    PIPELINE: {
      fetch: async (request: Request) => {
        calls++;
        const response = await delegatedScheduleRoute(request, native, new URL(request.url));
        if (!response) throw Error("unexpected private route");
        return response;
      },
    },
  };
}
type ToolBody = Record<string, unknown> & { confirmation?: { digest: string } };
let rpcId = 0;
async function invoke(
  name: string,
  args: unknown,
  configuration: Record<string, unknown>,
  subject = OWNER,
) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === ISSUER + "/cdn-cgi/access/certs") return Response.json(jwks);
    throw Error("unexpected external request in synthetic audit");
  });
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "jobs-cross-auth" })
    .setIssuer(ISSUER)
    .setAudience("jobs-cross-mcp")
    .setSubject(subject)
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
        params: { name, arguments: args },
      }),
    }),
    configuration as unknown as Env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { structuredContent: ToolBody; isError?: boolean } })
    .result;
}
interface JobRow {
  id: string;
  source: string | null;
  revision: number;
  enabled: number;
  timezone: DelegatedJobPayload["timezone"];
  pattern_json: string;
}
async function row(jobId: string) {
  return (await env.DB.prepare("SELECT * FROM collection_schedules WHERE id=?")
    .bind(jobId)
    .first<JobRow>())!;
}
async function payload(
  jobId: string,
  key: string,
): Promise<DelegatedJobPayload & { idempotencyKey: string }> {
  const before = await row(jobId);
  return {
    jobId,
    source: before.source,
    revision: before.revision,
    enabled: false,
    timezone: before.timezone,
    pattern: JSON.parse(before.pattern_json),
    idempotencyKey: key,
  };
}
const jobCall = (args: unknown, cfg: Record<string, unknown>, subject = OWNER) =>
  invoke("kogane.schedules.job.update", args, cfg, subject);
const digest = (value: { structuredContent: ToolBody; isError?: boolean }) => {
  expect(value.isError).not.toBe(true);
  expect(value.structuredContent.confirmation).toBeDefined();
  return value.structuredContent.confirmation!.digest;
};

test("source-less global job replay keeps its original receipt after native change, reobserves no alarm and still requires current wildcard authority", async () => {
  const cfg = config(),
    body = await payload("processor-tick", "jobs-cross-global");
  expect(body.source).toBeNull();
  const prepared = await jobCall({ ...body, step: "prepare" }, cfg);
  const confirm = { ...body, step: "confirm", confirmationDigest: digest(prepared) };
  const saved = await jobCall(confirm, cfg);
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent).toMatchObject({
    saved: true,
    jobId: body.jobId,
    revision: body.revision + 1,
    reservation: "disabled",
    actualAlarmAt: null,
    replayed: false,
  });
  const originalAudit = await env.DB.prepare(
    "SELECT principal,subject,scope_source,scope_namespace FROM audit_records WHERE principal=? AND idempotency_key=? AND result='applied'",
  )
    .bind(principal(), body.idempotencyKey)
    .first();
  expect(originalAudit).toEqual({
    principal: principal(),
    subject: OWNER,
    scope_source: null,
    scope_namespace: null,
  });
  const human = new OperationCall("schedules.job.update", {
    path: "ui",
    subject: "jobs-cross-human",
    principal: "jobs-cross-human",
    principalKind: "human",
    correlationId: crypto.randomUUID(),
  });
  alarm = "2099-02-01T00:00:00.000Z";
  await updateSchedule(
    native,
    body.jobId,
    { revision: body.revision + 1, enabled: true, timezone: body.timezone, pattern: body.pattern },
    "jobs-cross-human",
    human,
  );
  const current = await row(body.jobId),
    relayCount = calls,
    alarmCount = alarms;
  const retry = await jobCall(confirm, cfg);
  expect(retry.isError).not.toBe(true);
  expect(retry.structuredContent).toEqual({
    ...saved.structuredContent,
    replayed: true,
    reservation: null,
    actualAlarmAt: null,
  });
  expect(await row(body.jobId)).toEqual(current);
  expect(calls).toBe(relayCount);
  expect(alarms).toBe(alarmCount);
  const another = await jobCall(confirm, config(OTHER), OTHER);
  expect(another.structuredContent).toEqual({ error: "confirmation_invalid" });
  const removed = await jobCall(confirm, { ...cfg, MCP_DELEGATIONS: "" });
  expect(removed.structuredContent).toEqual({ error: "delegation_not_configured" });
  const noCapability = await jobCall(confirm, {
    ...cfg,
    MCP_DELEGATIONS: JSON.stringify({ [principal()]: { ...entry(), capabilities: [] } }),
  });
  expect(noCapability.structuredContent).toEqual({ error: "capability_not_delegated" });
  const listed = await jobCall(confirm, {
    ...cfg,
    MCP_DELEGATIONS: JSON.stringify({
      [principal()]: { ...entry(), scopes: { ...scopes, scheduleSources: ["vpass"] } },
    }),
  });
  expect(listed.structuredContent).toEqual({ error: "capability_not_delegated" });
  const narrowedRead = await jobCall(confirm, {
    ...cfg,
    AGENT_API_GRANTS: JSON.stringify({
      [principal()]: { ...grant, scopes: { ...scopes, scheduleSources: ["vpass"] } },
    }),
  });
  expect(narrowedRead.structuredContent).toEqual({ error: "delegation_misconfigured" });
  expect(await row(body.jobId)).toEqual(current);
  expect(calls).toBe(relayCount);
});

test("source-bound job attenuation is independent from financial source scope; changed source and other principal cannot consume its prepare", async () => {
  const cfg = config();
  cfg.MCP_DELEGATIONS = JSON.stringify({
    [principal()]: { ...entry(), scopes: { ...scopes, scheduleSources: ["vpass"] } },
  });
  const body = await payload("vpass", "jobs-cross-separated-scopes"),
    prepared = await jobCall({ ...body, step: "prepare" }, cfg);
  const confirm = { ...body, step: "confirm", confirmationDigest: digest(prepared) };
  const before = await row("vpass"),
    relayCount = calls;
  const sourceLie = await jobCall({ ...confirm, source: "sony-bank" }, cfg);
  expect(sourceLie.structuredContent).toEqual({ error: "capability_not_delegated" });
  const otherCfg = config(OTHER);
  otherCfg.MCP_DELEGATIONS = JSON.stringify({
    [principal(OTHER)]: { ...entry(OTHER), scopes: { ...scopes, scheduleSources: ["vpass"] } },
  });
  const other = await jobCall(confirm, otherCfg, OTHER);
  expect(other.structuredContent).toEqual({ error: "confirmation_invalid" });
  const attenuated = await jobCall(confirm, {
    ...cfg,
    MCP_DELEGATIONS: JSON.stringify({
      [principal()]: { ...entry(), scopes: { ...scopes, scheduleSources: [] } },
    }),
  });
  expect(attenuated.structuredContent).toEqual({ error: "capability_not_delegated" });
  expect(await row("vpass")).toEqual(before);
  expect(calls).toBe(relayCount);
  const saved = await jobCall(confirm, cfg);
  expect(saved.isError).not.toBe(true);
  expect((await row("vpass")).revision).toBe(body.revision + 1);
  // R1 import remains governed by the financial source axis, even while settings use vpass.
  const imported = await invoke(
    "kogane.ops.import.request",
    { source: "sony-bank", runId: "synthetic-jobs-cross-run", idempotencyKey: "jobs-cross-import" },
    cfg,
  );
  expect(imported.isError).not.toBe(true);
  const deniedImport = await invoke(
    "kogane.ops.import.request",
    {
      source: "vpass",
      runId: "synthetic-jobs-cross-run",
      idempotencyKey: "jobs-cross-import-denied",
    },
    cfg,
  );
  expect(deniedImport.structuredContent).toEqual({ error: "target_missing", refs: ["source"] });
  // Provider request persistence also keeps the financial axis despite narrower settings scope.
  const collection = {
    source: "sony-bank",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "jobs-cross-collection",
  };
  const preview = await invoke(
    "kogane.ops.collection.request",
    { ...collection, step: "prepare" },
    cfg,
  );
  const accepted = await invoke(
    "kogane.ops.collection.request",
    { ...collection, step: "confirm", confirmationDigest: digest(preview) },
    cfg,
  );
  expect(accepted.isError).not.toBe(true);
  const collectionAudit = await env.DB.prepare(
    "SELECT count(*) n FROM audit_records WHERE principal=? AND operation='ops.collection.request' AND idempotency_key=? AND result='accepted'",
  )
    .bind(principal(), collection.idempotencyKey)
    .first<number>("n");
  expect(collectionAudit).toBe(1);
  const deniedCollection = await invoke(
    "kogane.ops.collection.request",
    {
      ...collection,
      source: "vpass",
      step: "prepare",
      idempotencyKey: "jobs-cross-collection-denied",
    },
    cfg,
  );
  expect(deniedCollection.structuredContent).toEqual({ error: "target_missing", refs: ["source"] });
});
