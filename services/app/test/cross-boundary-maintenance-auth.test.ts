// Independent integration audit: signed synthetic MCP, actual native schedule/D1 writer.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/worker";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import { delegatedMaintenanceRoute } from "../../processor/src/delegated-maintenance";

const OWNER = "maintenance-cross-auth-owner",
  OTHER = "maintenance-cross-auth-other";
const principal = (subject = OWNER) => `mcp-client:${subject}`;
const ISSUER = "https://maintenance-cross-auth.cloudflareaccess.com";
const scopes = { sources: ["sony-bank"], accounts: "*", scheduleSources: ["vpass"] };
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
  capabilities: ["schedules.maintenance.update", "schedules.survey.decide"],
  scopes,
  ...interval,
  budget: { writesPerDay: 100 },
});
let signing: Awaited<ReturnType<typeof generateKeyPair>>, jwks: { keys: unknown[] };
let calls = 0,
  alarms = 0;
let alarm: string | null = null;
let native: Parameters<typeof delegatedMaintenanceRoute>[1];
beforeAll(async () => {
  signing = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [
      {
        ...(await exportJWK(signing.publicKey)),
        kid: "maintenance-cross-auth",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  await env.DB.prepare("UPDATE provider_maintenance_references SET reference_url=?")
    .bind("https://maintenance-auth.synthetic.test/notices")
    .run();
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
  } as unknown as Parameters<typeof delegatedMaintenanceRoute>[1];
});
afterEach(() => vi.unstubAllGlobals());
function config(subject = OWNER): Record<string, unknown> {
  return {
    ...env,
    SCHEDULES_ENABLED: "true",
    OPS_API_ENABLED: "true",
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: "maintenance-cross-browser",
    ACCESS_MCP_AUDIENCE: "maintenance-cross-mcp",
    OPERATOR_SUBJECTS: JSON.stringify([OWNER, OTHER]),
    AGENT_API_GRANTS: JSON.stringify({ [principal(subject)]: grant }),
    MCP_DELEGATIONS: JSON.stringify({ [principal(subject)]: entry(subject) }),
    PIPELINE: {
      fetch: async (request: Request) => {
        calls++;
        const response = await delegatedMaintenanceRoute(request, native, new URL(request.url));
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
    .setProtectedHeader({ alg: "RS256", kid: "maintenance-cross-auth" })
    .setIssuer(ISSUER)
    .setAudience("maintenance-cross-mcp")
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
  if (response.status !== 200)
    return {
      isError: true,
      transportStatus: response.status,
      structuredContent: (await response.json()) as ToolBody,
    };
  return ((await response.json()) as { result: { structuredContent: ToolBody; isError?: boolean } })
    .result;
}

const TOOL = "kogane.schedules.maintenance.update";
const payload = () => ({
  source: "vpass",
  revision: 0,
  timezone: "Asia/Tokyo",
  enabled: false,
  scope: "collection",
  pattern: {
    kind: "once",
    from: new Date(Date.now() + 86400000).toISOString(),
    to: new Date(Date.now() + 86460000).toISOString(),
  },
  referenceUrl: "https://maintenance-auth.synthetic.test/notices",
  verifiedAt: new Date(Date.now() - 60000).toISOString(),
  reason: "correction",
  idempotencyKey: crypto.randomUUID(),
});
test("signed MCP uses schedule scope; current auth is mandatory before reading a completed receipt", async () => {
  const cfg = config();
  const input = { ...payload(), step: "apply" };
  const saved = await invoke(TOOL, input, cfg);
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent.saved).toBe(true);
  const after = { calls, alarms };
  const replay = await invoke(TOOL, input, cfg);
  expect(replay.isError).not.toBe(true);
  expect(replay.structuredContent).toEqual({
    ...saved.structuredContent,
    replayed: true,
    reconciliation: null,
  });
  expect({ calls, alarms }).toEqual(after);
  const expired = {
    ...entry(),
    issuedAt: new Date(Date.now() - 7200000).toISOString(),
    notAfter: new Date(Date.now() - 3600000).toISOString(),
  };
  for (const [change, error] of [
    [{ MCP_DELEGATIONS: "" }, "delegation_not_configured"],
    [{ MCP_DELEGATIONS: JSON.stringify({ [principal()]: expired }) }, "delegation_expired"],
    [{ OPERATOR_SUBJECTS: "[]" }, "delegation_misconfigured"],
    [
      {
        MCP_DELEGATIONS: JSON.stringify({
          [principal()]: {
            ...entry(),
            role: "reviewer",
            capabilities: [],
            scopes: { ...scopes, sources: "*" },
          },
        }),
        AGENT_API_GRANTS: JSON.stringify({
          [principal()]: { ...grant, scopes: { ...scopes, sources: "*" } },
        }),
      },
      "delegation_capability_denied",
    ],
    [
      {
        MCP_DELEGATIONS: JSON.stringify({
          [principal()]: { ...entry(), scopes: { ...scopes, scheduleSources: [] } },
        }),
      },
      "source_not_granted",
    ],
    [
      {
        AGENT_API_GRANTS: JSON.stringify({
          [principal()]: { ...grant, scopes: { ...scopes, scheduleSources: [] } },
        }),
      },
      "delegation_misconfigured",
    ],
  ] as const) {
    const denied = await invoke(TOOL, input, { ...cfg, ...change });
    expect([denied.isError, denied.structuredContent.error]).toEqual([true, error]);
  }
  const removed = await invoke(TOOL, input, { ...cfg, AGENT_API_GRANTS: "" });
  expect(removed.isError).toBe(true);
  expect(removed.structuredContent.error).toBeDefined();
  const other = await invoke(
    TOOL,
    input,
    {
      ...cfg,
      AGENT_API_GRANTS: JSON.stringify({ [principal()]: grant, [principal(OTHER)]: grant }),
    },
    OTHER,
  );
  expect(other.structuredContent.error).toBe("delegation_not_configured");
  expect({ calls, alarms }).toEqual(after);
});
test("signed R2 retry checks scope before receipt and never permits delegated survey acceptance", async () => {
  const cfg = config(),
    input = payload();
  const prepared = await invoke(TOOL, { ...input, step: "prepare" }, cfg);
  expect(prepared.isError).not.toBe(true);
  const confirm = {
    ...input,
    step: "confirm",
    confirmationDigest: prepared.structuredContent.confirmation!.digest,
  };
  const saved = await invoke(TOOL, confirm, cfg);
  expect(saved.isError).not.toBe(true);
  const after = { calls, alarms };
  expect((await invoke(TOOL, confirm, cfg)).structuredContent).toEqual({
    ...saved.structuredContent,
    replayed: true,
    reconciliation: null,
  });
  const narrowed = {
    ...cfg,
    MCP_DELEGATIONS: JSON.stringify({
      [principal()]: { ...entry(), scopes: { ...scopes, scheduleSources: [] } },
    }),
  };
  expect((await invoke(TOOL, confirm, narrowed)).structuredContent.error).toBe(
    "source_not_granted",
  );
  const capabilities = await invoke("kogane.capabilities", {}, cfg);
  const delegation = capabilities.structuredContent.delegation as {
    capabilities: { capability: string; available: boolean }[];
  };
  expect(
    delegation.capabilities.find((x) => x.capability === "schedules.maintenance.update")?.available,
  ).toBe(true);
  expect(
    delegation.capabilities.find((x) => x.capability === "schedules.survey.decide")?.available,
  ).toBe(false);
  expect({ calls, alarms }).toEqual(after);
});
