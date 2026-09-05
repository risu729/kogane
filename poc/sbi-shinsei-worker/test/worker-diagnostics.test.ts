import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

let handoff = "";
let destroyFails = false;
let relayUrl = "";
let fetchFails = false;
let destroyCalls = 0;
let responseStatus = 200;
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({
    startAndWaitForPorts: async () => {},
    fetch: async (request: Request) => {
      relayUrl = (await request.json() as { relayUrl: string }).relayUrl;
      if (fetchFails) throw new Error("Bearer synthetic-secret");
      return new Response(handoff, { status: responseStatus });
    },
    destroy: async () => { destroyCalls++; if (destroyFails) throw new Error("Bearer synthetic-secret"); },
  }),
}));
const { default: worker } = await import("../src/worker");
afterEach(() => { destroyFails = false; fetchFails = false; destroyCalls = 0; responseStatus = 200; });

async function trigger(loggingFails = false) {
  const logs: Record<string, unknown>[] = [];
  const capture = (value: string) => { if (loggingFails) throw new Error("logger unavailable"); logs.push(JSON.parse(value)); };
  const spies = [spyOn(console, "error").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "log").mockImplementation(capture)];
  const stored: Array<{ key: string; body: Uint8Array }> = [];
  try {
    const response = await worker.fetch(new Request("https://worker.invalid/trigger", { method: "POST", headers: { authorization: "Bearer synthetic-admin" } }) as Request<unknown, IncomingRequestCfProperties>, {
      ADMIN_TRIGGER_TOKEN: "synthetic-admin", SBI_SHINSEI_CREDENTIAL_JSON: JSON.stringify({ branchNumber: "012", accountNumber: "0345678", powerDirectPassword: "synthetic-secret" }),
      RELAY_TOKEN: "synthetic-relay", RELAY_PUBLIC_URL: "wss://worker.invalid/tcp", COLLECTOR_SCHEMA_VERSION: "sbi-shinsei-worker-poc-v1",
      COLLECTOR_CONTAINER: {},
      SNAPSHOTS: { put: async (key: string, value: string | Uint8Array, options: R2PutOptions) => {
        const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
        stored.push({ key, body });
        return { key, size: body.byteLength, checksums: { sha256: (options.sha256 as Uint8Array).slice().buffer } };
      } },
      RAW_EVIDENCE_IMPORTER: { fetch: async (request: Request) => Response.json({ source: "sbi-shinsei", manifestKey: (await request.json() as { manifestKey: string }).manifestKey, sealed: true }) },
    } as unknown as Env, {} as ExecutionContext);
    return { response, result: await response.json() as { runId: string; status: string }, logs, stored };
  } finally { spies.forEach((spy) => spy.mockRestore()); }
}

describe("Shinsei Worker failure logging", () => {
  test("logs the failed stage before teardown and correlates its relay without exposing credentials", async () => {
    handoff = JSON.stringify({ ok: false, stage: "security-connect-timeout", authenticationAttempted: true });
    const { response, result, logs, stored } = await trigger();
    expect(response.status).toBe(503);
    const failed = logs.findIndex((entry) => entry.event === "sbi-shinsei-collection-failure");
    const teardown = logs.findIndex((entry) => entry.event === "sbi-shinsei-container-teardown-start");
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(failed).toBeLessThan(teardown);
    expect(logs[failed]).toMatchObject({ runId: result.runId, phase: "collection", diagnostics: { stage: "security-connect-timeout", authenticationAttempted: true } });
    expect(new URL(relayUrl).searchParams.get("runId")).toBe(result.runId);
    expect(JSON.stringify(logs)).not.toContain("synthetic-secret");
    const manifest = JSON.parse(new TextDecoder().decode(stored.at(-1)!.body));
    expect(manifest.failures[0].message).toContain("stage=security-connect-timeout");
    expect(manifest.failures[0].diagnostics).toBeUndefined();
  });

  test("a container transport error is attributed to container-request", async () => {
    fetchFails = true;
    const { logs } = await trigger();
    expect(logs.find((entry) => entry.event === "sbi-shinsei-collection-failure")).toMatchObject({ diagnostics: { stage: "container-request" } });
    expect(JSON.stringify(logs)).not.toContain("synthetic-secret");
  });

  test("a rejected container HTTP response is not logged as a successful request", async () => {
    responseStatus = 503;
    const { response, logs } = await trigger();
    expect(response.status).toBe(503);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sbi-shinsei-stage", stage: "container-request", outcome: "failed" }));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "sbi-shinsei-stage", stage: "container-request", outcome: "success" }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "sbi-shinsei-collection-failure", diagnostics: { stage: "container-request", httpStatus: 503 } }));
  });

  test("a validated prefix with a failed later read logs partial collection and terminal outcomes", async () => {
    const fixtures = await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json();
    handoff = JSON.stringify({ ok: true, responses: { topBalances: JSON.stringify(fixtures.topBalances), balanceSummary: JSON.stringify(fixtures.balanceSummary) }, failure: { dataset: "exchange-rate", stage: "exchange-rate-http-503" } });
    const { response, result, logs } = await trigger();
    expect(response.status).toBe(200);
    expect(result.status).toBe("partial");
    expect(logs).toContainEqual(expect.objectContaining({ event: "sbi-shinsei-stage", stage: "collection", outcome: "partial" }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "sbi-shinsei-stage", stage: "terminal", outcome: "partial" }));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "sbi-shinsei-stage", stage: "collection", outcome: "success" }));
  });

  test("teardown errors stay separate and do not turn a successful collection into a failure", async () => {
    const fixtures = await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json();
    handoff = JSON.stringify({ ok: true, responses: { topBalances: JSON.stringify(fixtures.topBalances), balanceSummary: JSON.stringify(fixtures.balanceSummary), exchangeRate: JSON.stringify(fixtures.exchangeRate), yenDeposit: JSON.stringify(fixtures.yenDeposit) } });
    destroyFails = true;
    const { response, result, logs } = await trigger();
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(logs.some((entry) => entry.event === "sbi-shinsei-collection-failure")).toBe(false);
    expect(logs.find((entry) => entry.event === "sbi-shinsei-container-destroy-failed")).toMatchObject({ runId: result.runId, phase: "teardown" });
    expect(JSON.stringify(logs)).not.toContain("synthetic-secret");
  });
});

describe("Shinsei logging remains best effort", () => {
  test("logger errors preserve the collection failure, manifest and teardown", async () => {
    handoff = JSON.stringify({ ok: false, stage: "security-connect-timeout", authenticationAttempted: true });
    const { response, result, stored } = await trigger(true);
    expect(response.status).toBe(503);
    expect(result.status).toBe("failed");
    expect(destroyCalls).toBe(1);
    const manifest = JSON.parse(new TextDecoder().decode(stored.at(-1)!.body));
    expect(manifest.failures[0].message).toContain("stage=security-connect-timeout");
    expect(manifest.failures[0].message).not.toContain("logger");
  });

  test("logger and teardown errors preserve successful collection and storage", async () => {
    const fixtures = await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json();
    handoff = JSON.stringify({ ok: true, responses: { topBalances: JSON.stringify(fixtures.topBalances), balanceSummary: JSON.stringify(fixtures.balanceSummary), exchangeRate: JSON.stringify(fixtures.exchangeRate), yenDeposit: JSON.stringify(fixtures.yenDeposit) } });
    destroyFails = true;
    const { response, result, stored } = await trigger(true);
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(destroyCalls).toBe(1);
    expect(stored).toHaveLength(6);
  });
});
