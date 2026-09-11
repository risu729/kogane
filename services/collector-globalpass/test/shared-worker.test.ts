// U09 (G1-15): the GLOBAL PASS Worker writes a finished run where
// COLLECTION_TARGET says, end to end with the container mocked away.
//
// The fixture is the same synthetic variant-B activity page the collection
// suite builds, so the real sanitizer runs before anything is planned. No
// provider is contacted and no real statement appears anywhere.
import { describe, expect, mock, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal, terminalKey } from "../../../packages/collection/src/index";
import { GLOBALPASS_SCHEMA_VERSION } from "../src/model";

let container: {
  startAndWaitForPorts(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => container,
}));
const { default: worker } = await import("../src/worker");

function fixtureHtml(): string {
  return (
    "<!DOCTYPE html><html><head></head><body><h1>ご利用明細</h1>" +
    '<input type="hidden" name="cc" value="01006">' +
    '<input type="hidden" name="engUseFlg" value="0">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    ["private-state1", "private-state2", "private-state3", ""]
      .map((value) => `<input type="hidden" name="nablarch_hidden" value="${value}">`)
      .join("") +
    '<input type="hidden" name="nablarch_submit" value="1">'.repeat(4) +
    "<form></form>".repeat(5) +
    "</body></html>"
  );
}

async function trigger(target: string | undefined) {
  const records = [
    {
      type: "metadata",
      availableMonths: ["2099-02", "2099-01"],
      selectedMonths: ["2099-02", "2099-01"],
      browserVersion: "synthetic",
    },
    { type: "artifact", month: "2099-02", html: fixtureHtml() },
    { type: "artifact", month: "2099-01", html: fixtureHtml() },
  ];
  container = {
    async startAndWaitForPorts() {},
    async fetch() {
      return new Response(records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
        status: 200,
      });
    },
    async destroy() {},
  };
  const data = new FakeR2Bucket();
  const importerCalls: string[] = [];
  const staged: string[] = [];
  const spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  try {
    const env = {
      ADMIN_TRIGGER_TOKEN: "synthetic-admin-token-".repeat(3),
      GLOBALPASS_ID: "private-user",
      GLOBALPASS_PASSWORD: "private-password",
      RELAY_TOKEN: "private-relay-token",
      RELAY_PUBLIC_URL: "wss://relay.test/tcp?network=tamia",
      COLLECTOR_SCHEMA_VERSION: GLOBALPASS_SCHEMA_VERSION,
      ...(target === undefined ? {} : { COLLECTION_TARGET: target }),
      COLLECTOR_CONTAINER: {},
      DATA: data,
      SNAPSHOTS: {
        async put(key: string) {
          staged.push(key);
        },
      },
      RAW_EVIDENCE_IMPORTER: {
        async fetch(request: Request) {
          const { manifestKey } = (await request.json()) as { manifestKey: string };
          importerCalls.push(manifestKey);
          return Response.json({
            source: "prestia-globalpass",
            manifestKey,
            status: "sealed",
            centralRunId: 1,
            artifactCount: 3,
            sealed: true,
            finalChunkAllObjectsReused: false,
          });
        },
      },
    };
    const response = await worker.fetch(
      new Request("https://collector.test/trigger", {
        method: "POST",
        headers: { authorization: `Bearer ${env.ADMIN_TRIGGER_TOKEN}` },
      }) as Request<unknown, IncomingRequestCfProperties>,
      env as unknown as Env,
      {} as ExecutionContext,
    );
    return {
      response,
      result: (await response.json()) as Record<string, unknown>,
      data,
      importerCalls,
      staged,
    };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("G1-15 the collector writes the run where COLLECTION_TARGET says", () => {
  test("legacy mode still uploads to the importer and writes nothing to DATA", async () => {
    const { response, result, data, importerCalls, staged } = await trigger(undefined);
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toHaveLength(1);
    expect(staged.length).toBeGreaterThan(0);
    expect(data.putKeys).toEqual([]);
  });

  test("shared mode writes the terminal to DATA and skips the central upload", async () => {
    const { response, result, data, importerCalls, staged } = await trigger("shared");
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toEqual([]);
    // The per-source staging bucket is still the collector's own outbox.
    expect(staged.length).toBeGreaterThan(0);
    const read = await readTerminal(data, "prestia-globalpass", String(result.runId));
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("success");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(data.putKeys.at(-1)).toBe(terminalKey("prestia-globalpass", String(result.runId)));
    const everything = [...data.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    expect(everything).not.toContain("private-state1");
    expect(everything).not.toContain("private-password");
    expect(everything).not.toContain("private-relay-token");
  });
});
