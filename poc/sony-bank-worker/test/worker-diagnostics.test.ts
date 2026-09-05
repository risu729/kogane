import { describe, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";

async function trigger(manifestWriteFails = false) {
  const unavailable = () => { throw new Error("logger unavailable"); };
  const spies = [spyOn(console, "log").mockImplementation(unavailable), spyOn(console, "error").mockImplementation(unavailable)];
  let storedManifest = "";
  let imports = 0;
  try {
    const response = await worker.fetch(new Request("https://worker.invalid/trigger", {
      method: "POST", headers: { authorization: "Bearer synthetic-admin" },
    }) as Request<unknown, IncomingRequestCfProperties>, {
      ADMIN_TRIGGER_TOKEN: "synthetic-admin", COLLECTOR_SCHEMA_VERSION: "sony-bank-worker-poc-v2",
      // Missing credential deliberately fails before any provider request.
      SNAPSHOTS: { put: async (key: string, bytes: Uint8Array, options: R2PutOptions) => {
        if (manifestWriteFails) throw new Error("storage unavailable");
        storedManifest = new TextDecoder().decode(bytes);
        return { key, size: bytes.byteLength, checksums: { sha256: (options.sha256 as Uint8Array).slice().buffer } };
      } },
      RAW_EVIDENCE_IMPORTER: { fetch: async () => {
        imports++;
        return Response.json({ status: "sealed", source: "sony-bank", centralRunId: 1, sealed: true });
      } },
    } as unknown as Env);
    return { response, result: await response.json() as { status?: string; error?: string }, storedManifest, imports };
  } finally { spies.forEach((spy) => spy.mockRestore()); }
}

describe("Sony logging remains best effort", () => {
  test("logger errors preserve collection failure and allow manifest storage/import", async () => {
    const { response, result, storedManifest, imports } = await trigger();
    expect(response.status).toBe(502);
    expect(result.status).toBe("failed");
    expect(imports).toBe(1);
    expect(JSON.parse(storedManifest).failures[0].message).toContain("stage=credential");
    expect(storedManifest).not.toContain("logger");
  });

  test("logger errors cannot replace the manifest write failure", async () => {
    const { response, result, imports } = await trigger(true);
    expect(response.status).toBe(400);
    expect(result.error).toBe("manifest_write_failed");
    expect(imports).toBe(0);
  });
});
