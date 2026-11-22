// What `/mcp` answers for a tool set that is off (docs/agent-api.md, "Contract
// for tools on `/mcp`"). Every set that is off is left out of `tools/list`.
// The schedule reads, the lease release, the maintenance revision (with the
// flag off) and the operations set are also not dispatched, so a call to one
// of their names is `unknown_tool`. The delegated command, decision,
// schedule-job and survey-decision tools are dispatched whatever the switches
// say, so a call reaches the adapter, answers its own refusal with `isError`
// and is recorded once as `refused`; the Processor is never reached. This file
// pins answers; it does not decide them. Synthetic identities and
// configuration only.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const APP_AUDIENCE = "fixture-audience";
const MCP_AUDIENCE = "fixture-mcp-audience";
const COMMAND_TOOLS = [
  "kogane.command.plan",
  "kogane.command.simulate",
  "kogane.command.operation.get",
  "kogane.command.approve",
  "kogane.command.commit",
];
const OPS_TOOLS = [
  "kogane.ops.collection.request",
  "kogane.ops.import.request",
  "kogane.ops.replay.request",
  "kogane.ops.projection.request",
  "kogane.ops.session.refresh",
  "kogane.ops.operation.get",
  "kogane.ops.operation.list",
];
/** Dispatched only while `SCHEDULES_ENABLED` is on. */
const SCHEDULE_GATED_TOOLS = [
  "kogane.schedules.maintenance.read",
  "kogane.schedules.maintenance.update",
  "kogane.schedules.lease.release",
  "kogane.schedules.survey.read",
  "kogane.schedules.read",
];
/** Dispatched whatever the switches say; the adapter refuses. */
const SCHEDULE_ADAPTER_TOOLS = ["kogane.schedules.job.update", "kogane.schedules.survey.decide"];

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let subject: string;
let sequence = 0;
let id = 0;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://off-tool-sets-${++sequence}.cloudflareaccess.com`;
  subject = `synthetic-off-tool-sets-${sequence}`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A Processor binding that must never be reached by an answer below. */
function untouchedPipeline() {
  return {
    fetch: vi.fn(async () => {
      throw new Error("the Processor was called for a tool set that is off");
    }),
  };
}

async function rpc(method: string, params: unknown, configuration: Record<string, unknown>) {
  const jwt = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(MCP_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const response = await worker.fetch(
    new Request("https://fixture.test/mcp", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": jwt,
        "mcp-protocol-version": "2025-11-25",
        ...MCP_CLIENT_HEADERS,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: APP_AUDIENCE,
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
      COMMANDS_ENABLED: "",
      OPS_API_ENABLED: "",
      SCHEDULES_ENABLED: "",
      PIPELINE: undefined,
      ...configuration,
    } as Env,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: { tools?: { name: string }[]; isError?: boolean; structuredContent?: unknown };
    error?: { code: number; message: string };
  };
}

async function listed(configuration: Record<string, unknown>): Promise<string[]> {
  const message = await rpc("tools/list", {}, configuration);
  return message.result!.tools!.map((tool) => tool.name);
}

async function expectRefused(
  name: string,
  configuration: Record<string, unknown>,
  error: string,
): Promise<void> {
  const message = await rpc("tools/call", { name, arguments: {} }, configuration);
  expect(message.error, name).toBeUndefined();
  expect(message.result?.isError, name).toBe(true);
  expect(message.result?.structuredContent, name).toEqual({ error });
}

/** The audit records of this test's caller: one `refused` per refused call, none for `unknown_tool`. */
async function recorded(): Promise<{ operation: string; result: string }[]> {
  const rows = await env.DB.prepare(
    "SELECT operation, result FROM audit_records WHERE principal = ? ORDER BY recorded_at, audit_id",
  )
    .bind(`mcp-client:${subject}`)
    .all<{ operation: string; result: string }>();
  return rows.results;
}
const refusedAs = (names: string[]) =>
  names.map((name) => ({ operation: name.slice("kogane.".length), result: "refused" }));

async function expectUnknown(name: string, configuration: Record<string, unknown>) {
  const message = await rpc("tools/call", { name, arguments: {} }, configuration);
  expect(message.result, name).toBeUndefined();
  expect(message.error, name).toEqual({ code: -32602, message: "unknown_tool" });
}

describe("a tool set that is off on /mcp", () => {
  it("COMMANDS_ENABLED off: the command and decision tools are not listed, and a call answers commands_disabled", async () => {
    const pipeline = untouchedPipeline();
    const configuration = { PIPELINE: pipeline };
    const names = await listed(configuration);
    for (const name of COMMAND_TOOLS) expect(names).not.toContain(name);
    for (const name of COMMAND_TOOLS) await expectRefused(name, configuration, "commands_disabled");
    expect(pipeline.fetch).not.toHaveBeenCalled();
    expect(await recorded()).toEqual(expect.arrayContaining(refusedAs(COMMAND_TOOLS)));
    expect(await recorded()).toHaveLength(COMMAND_TOOLS.length);
  });

  it("no Processor binding: the command and decision tools are not listed, and a call answers command_executor_unavailable", async () => {
    const configuration = { COMMANDS_ENABLED: "true" };
    const names = await listed(configuration);
    for (const name of COMMAND_TOOLS) expect(names).not.toContain(name);
    for (const name of COMMAND_TOOLS)
      await expectRefused(name, configuration, "command_executor_unavailable");
  });

  it("SCHEDULES_ENABLED off: no schedule tool is listed; the job and survey decisions answer schedules_disabled, the others unknown_tool", async () => {
    const pipeline = untouchedPipeline();
    const configuration = { PIPELINE: pipeline };
    const names = await listed(configuration);
    for (const name of [...SCHEDULE_GATED_TOOLS, ...SCHEDULE_ADAPTER_TOOLS])
      expect(names).not.toContain(name);
    for (const name of SCHEDULE_ADAPTER_TOOLS)
      await expectRefused(name, configuration, "schedules_disabled");
    for (const name of SCHEDULE_GATED_TOOLS) await expectUnknown(name, configuration);
    expect(pipeline.fetch).not.toHaveBeenCalled();
    expect(await recorded()).toEqual(expect.arrayContaining(refusedAs(SCHEDULE_ADAPTER_TOOLS)));
    expect(await recorded()).toHaveLength(SCHEDULE_ADAPTER_TOOLS.length);
  });

  it("no Processor binding with SCHEDULES_ENABLED on: the three schedule writes are not listed and answer schedules_disabled; the reads and the lease release are listed", async () => {
    const configuration = { SCHEDULES_ENABLED: "true" };
    const names = await listed(configuration);
    const writes = [...SCHEDULE_ADAPTER_TOOLS, "kogane.schedules.maintenance.update"];
    for (const name of writes) expect(names).not.toContain(name);
    for (const name of SCHEDULE_GATED_TOOLS.filter((name) => !writes.includes(name)))
      expect(names).toContain(name);
    for (const name of writes) await expectRefused(name, configuration, "schedules_disabled");
  });

  it("OPS_API_ENABLED off: the operations tools are not listed, and a call answers unknown_tool", async () => {
    const configuration = { COMMANDS_ENABLED: "true", SCHEDULES_ENABLED: "true" };
    const names = await listed(configuration);
    for (const name of OPS_TOOLS) expect(names).not.toContain(name);
    for (const name of OPS_TOOLS) await expectUnknown(name, configuration);
  });
});
