import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { describe, expect, spyOn, test } from "bun:test";
import { runSharedCollection } from "../src/worker";

async function trigger(manifestWriteFails = false) {
  const unavailable = () => {
    throw new Error("logger unavailable");
  };
  const spies = [
    spyOn(console, "log").mockImplementation(unavailable),
    spyOn(console, "error").mockImplementation(unavailable),
  ];
  const data = new FakeR2Bucket();
  data.faults = {
    beforePut: () => {
      if (manifestWriteFails) throw new Error("storage unavailable");
    },
  };
  let imports = 0;
  try {
    const response = await runSharedCollection(
      {
        COLLECTOR_SCHEMA_VERSION: "sony-bank-worker-poc-v2",
        // Missing credential deliberately fails before any provider request.
        DATA: data,
        RAW_EVIDENCE_IMPORTER: {
          fetch: async () => {
            imports++;
            return Response.json({
              status: "sealed",
              source: "sony-bank",
              centralRunId: 1,
              sealed: true,
            });
          },
        },
      } as unknown as Env,
      { from: "2099-01-01", to: "2099-01-02" },
    );
    return {
      response,
      result: response as { status?: string; error?: string },
      storedManifest: [...data.entries.values()]
        .map((entry) => new TextDecoder().decode(entry.bytes))
        .join("\n"),
      imports,
    };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

describe("Sony logging remains best effort", () => {
  test("logger errors preserve collection failure and allow manifest storage/import", async () => {
    const { response, result, storedManifest, imports } = await trigger();
    expect(response.status).not.toBe("success");
    expect(result.status).toBe("failed");
    expect(imports).toBe(0);
    expect(JSON.parse(storedManifest).safeErrorCode).toBe("collector_failed");
    expect(storedManifest).not.toContain("logger");
  });

  test("logger errors cannot replace the manifest write failure", async () => {
    const { response, result, imports } = await trigger(true);
    expect(response.status).not.toBe("success");
    expect(result.status).toBe("failed");
    expect(imports).toBe(0);
  });
});
