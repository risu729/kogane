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
  test("an unset retired target variable still writes only to DATA", async () => {
    const { response, result, data, importerCalls, staged } = await trigger(undefined);
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toEqual([]);
    expect(staged).toEqual([]);
    expect(data.putKeys.length).toBeGreaterThan(0);
  });

  test("shared mode writes one copy: DATA only, no staging, no central upload", async () => {
    const { response, result, data, importerCalls, staged } = await trigger("shared");
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toEqual([]);
    // Plan 00: the original is stored once. Nothing structural depends on a
    // staging object for this source, so shared mode never writes one.
    expect(staged).toEqual([]);
    const read = await readTerminal(data, "prestia-globalpass", String(result.runId));
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("success");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(data.putKeys.at(-1)).toBe(terminalKey("prestia-globalpass", String(result.runId)));
    // Both months are in the terminal even though no staging put happened.
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "activity-2099-01.html",
      "activity-2099-02.html",
      "manifest.json",
    ]);
    // The manifest key the caller sees is the collector manifest's own
    // content-addressed object in DATA.
    const manifestArtifact = read.manifest.artifacts.find(
      (entry) => entry.artifactKey === "manifest.json",
    );
    expect(manifestArtifact?.storageRef.key).toBe(String(result.manifestKey));
    expect(String(result.manifestKey).startsWith("objects/")).toBe(true);
    const everything = [...data.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    expect(everything).not.toContain("private-state1");
    expect(everything).not.toContain("private-password");
    expect(everything).not.toContain("private-relay-token");
  });
});

// Parity with the legacy path: every page a shared-mode terminal names passes
// the importer's own sanitizer unchanged, so the bytes in DATA are the bytes
// `kogane-collector-r2-importer` would have sent centrally for the same run.
const { sanitizeGlobalPassHtml } = await import("../../collector-r2-importer/src/global-pass");

describe("sanitization parity with the legacy importer", () => {
  test("every stored page is byte-identical to what the importer sends centrally", async () => {
    const { result, data } = await trigger("shared");
    const read = await readTerminal(data, "prestia-globalpass", String(result.runId));
    if (read.outcome !== "found") throw new Error("unreachable");
    const pages = read.manifest.artifacts.filter(
      (entry) => entry.role === "sanitized_provider_capture",
    );
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const stored = await data.get(page.storageRef.key);
      const bytes = new Uint8Array(await stored!.arrayBuffer());
      // The importer validates a v2 page and returns it byte-for-byte or
      // refuses it; identical bytes here mean the shared path stored exactly
      // the legacy central bytes.
      const legacy = sanitizeGlobalPassHtml(bytes, GLOBALPASS_SCHEMA_VERSION);
      expect([...legacy]).toEqual([...bytes]);
      expect(page.sha256).toBe(await digestOf(legacy));
    }
  });
});

async function digestOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
