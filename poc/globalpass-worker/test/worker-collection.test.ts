import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CollectionManifest } from "../src/model";

let container: { startAndWaitForPorts(): Promise<void>; fetch(request: Request): Promise<Response>; destroy(): Promise<void> };
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => container }));
const { default: worker } = await import("../src/worker");
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function fixtureHtml(): string {
  return '<!DOCTYPE html><html><head></head><body><h1>ご利用明細</h1>' +
    '<input type="hidden" name="cc" value="01006">' +
    '<input type="hidden" name="engUseFlg" value="0">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    ["private-state1", "private-state2", "private-state3", ""].map(value =>
      `<input type="hidden" name="nablarch_hidden" value="${value}">`).join("") +
    '<input type="hidden" name="nablarch_submit" value="1">'.repeat(4) +
    '<form></form>'.repeat(5) + '</body></html>';
}
const metadata = { type: "metadata", availableMonths: ["2099-02", "2099-01"], selectedMonths: ["2099-02", "2099-01"], browserVersion: "synthetic" };
const artifact = { type: "artifact", month: "2099-02", html: fixtureHtml() };

async function run(records: unknown[], options: { httpStatus?: number; teardownError?: boolean; centralDeferred?: boolean; loggerThrows?: boolean } = {}) {
  const logs: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    spies.push(spyOn(console, level).mockImplementation((line) => {
      if (options.loggerThrows) throw new Error("logger unavailable");
      logs.push(String(line));
    }));
  }
  let destroyed = 0;
  let sentBody: Record<string, string> = {};
  let manifest: CollectionManifest | undefined;
  const stored = new Map<string, unknown>();
  container = {
    async startAndWaitForPorts() {},
    async fetch(request) {
      sentBody = await request.json();
      return new Response(records.map(record => JSON.stringify(record)).join("\n") + "\n", { status: options.httpStatus ?? 200 });
    },
    async destroy() { destroyed++; if (options.teardownError) throw new Error("private-teardown"); },
  };
  const env = {
    ADMIN_TRIGGER_TOKEN: "synthetic-admin-token-".repeat(3),
    GLOBALPASS_ID: "private-user", GLOBALPASS_PASSWORD: "private-password", RELAY_TOKEN: "private-relay-token",
    RELAY_PUBLIC_URL: "wss://relay.test/tcp?network=tamia", COLLECTOR_CONTAINER: {},
    SNAPSHOTS: { async put(key: string, body: unknown) {
      stored.set(key, body);
      if (key.endsWith("/manifest.json")) manifest = JSON.parse(String(body));
    } },
    RAW_EVIDENCE_IMPORTER: { async fetch(request: Request) {
      const { manifestKey } = await request.json() as { manifestKey: string };
      return Response.json({ source: "prestia-globalpass", manifestKey, artifactCount: stored.size,
        ...(options.centralDeferred ? { status: "deferred", reason: "worker_invocation_limit", nextOffset: 0 } :
          { status: "sealed", centralRunId: 1, sealed: true, finalChunkAllObjectsReused: false }) },
        { status: options.centralDeferred ? 202 : 200 });
    } },
  };
  const response = await worker.fetch(new Request("https://collector.test/trigger", {
    method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TRIGGER_TOKEN}` },
  }) as Request<unknown, IncomingRequestCfProperties>, env as unknown as Env, {} as ExecutionContext);
  return { response, result: await response.json() as Record<string, unknown>, manifest, logs, destroyed, sentBody, stored };
}

describe("GLOBAL PASS diagnostics preserve the current collection contract", () => {
  test("retains sanitized partial evidence and a deferred central result", async () => {
    const r = await run([metadata, artifact, { type: "error", operation: "browser-collection", errorType: "Error", errorCode: "browser_collection_failed" }], { centralDeferred: true });
    expect(r.response.status).toBe(502);
    expect(r.manifest?.schemaVersion).toBe("globalpass-browser-poc-v2");
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.artifacts).toHaveLength(1);
    expect(r.manifest?.failures.map(f => f.errorCode)).toEqual(["browser_collection_failed", "selected_month_missing"]);
    expect(r.result.central).toMatchObject({ status: "deferred", reason: "worker_invocation_limit", nextOffset: 0 });
    expect(new TextDecoder().decode([...r.stored.values()][0] as Uint8Array)).not.toContain("private-state");
    expect(new URL(r.sentBody.relayUrl!).searchParams.get("runId")).toBe(r.manifest!.runId);
    expect(new URL(r.sentBody.relayUrl!).searchParams.get("network")).toBe("tamia");
    expect(r.logs.join("\n")).not.toContain("private-");
    expect(r.destroyed).toBe(1);
  });
  test("HTTP failure is logged inside request stage and still stores a failed manifest", async () => {
    const r = await run([], { httpStatus: 503 });
    expect(r.manifest?.status).toBe("failed");
    expect(r.manifest?.artifacts).toHaveLength(0);
    expect(r.manifest?.failures[0]?.errorCode).toBe("browser_collection_failed");
    const events = r.logs.map(line => JSON.parse(line));
    expect(events.some(e => e.stage === "container-request" && e.outcome === "failed" && e.httpStatus === 503)).toBe(true);
    expect(events.some(e => e.stage === "container-request" && e.outcome === "success")).toBe(false);
    expect(r.destroyed).toBe(1);
  });
  test("rejects duplicate metadata without losing the first artifact", async () => {
    const r = await run([metadata, artifact, metadata]);
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.artifacts).toHaveLength(1);
    expect(r.manifest?.failures[0]?.errorCode).toBe("container_contract_invalid");
  });
  test("throwing loggers and failed teardown cannot change successful capture", async () => {
    const r = await run([metadata, artifact, { ...artifact, month: "2099-01" }], { loggerThrows: true, teardownError: true });
    expect(r.response.status).toBe(200);
    expect(r.manifest?.status).toBe("success");
    expect(r.manifest?.captureComplete).toBe(true);
    expect(r.manifest?.paginationStatus).toBe("unproven");
    expect(r.destroyed).toBe(1);
  });
});
