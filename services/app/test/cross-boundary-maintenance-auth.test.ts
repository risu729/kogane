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
function config(): Record<string, unknown> {
  return {
    ...env,
    SCHEDULES_ENABLED: "true",
    OPS_API_ENABLED: "true",
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: "maintenance-cross-browser",
    ACCESS_MCP_AUDIENCE: "maintenance-cross-mcp",
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
test("signed MCP replays a completed receipt whatever the operator lists say, and only to its own principal", async () => {
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
  // The operator lists grade the UI only (ADR 0084).
  for (const change of [
    { OPERATOR_SUBJECTS: JSON.stringify([OTHER]) },
    { OPERATOR_SUBJECTS: "[]" },
    { OPERATOR_SUBJECTS: "{" },
  ]) {
    const again = await invoke(TOOL, input, { ...cfg, ...change });
    expect(again.structuredContent).toEqual(replay.structuredContent);
  }
  expect({ calls, alarms }).toEqual(after);
  // Another MCP client never gets this principal's receipt: its key is its own,
  // so the same request is a new call of its own, relayed and judged anew.
  const other = await invoke(TOOL, input, cfg, OTHER);
  expect(other.structuredContent.replayed).not.toBe(true);
  expect(calls).toBe(after.calls + 1);
});
test("signed R2 retry replays its receipt and never permits delegated survey acceptance", async () => {
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
