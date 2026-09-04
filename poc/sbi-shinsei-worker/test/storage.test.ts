import { describe, expect, test } from "bun:test";
import { runPrefix, storeArtifact, storeManifest } from "../src/storage";
import type { CollectionManifest } from "../src/types";

interface PutCall {
  key: string;
  options: R2PutOptions;
}

describe("SBI Shinsei raw storage", () => {
  test("uses a source/date/run isolated prefix", () => {
    expect(runPrefix(
      "2026-08-31T01:02:03.000Z",
      "00000000-0000-4000-8000-000000000000",
    )).toBe(
      "raw/sbi-shinsei/2026/08/31/00000000-0000-4000-8000-000000000000",
    );
  });

  test("stores source-bound artifacts and the manifest immutably", async () => {
    const calls: PutCall[] = [];
    const bucket = {
      put: async (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView,
        options: R2PutOptions,
      ) => {
        calls.push({ key, options });
        const bytes = typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const sha256 = options.sha256 as Uint8Array;
        return {
          key,
          size: bytes.byteLength,
          checksums: { sha256: sha256.slice().buffer },
        } as unknown as R2Object;
      },
    } as unknown as R2Bucket;
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const prefix = runPrefix("2026-09-04T00:00:00.000Z", runId);
    const artifact = await storeArtifact({
      bucket,
      prefix,
      runId,
      artifact: {
        dataset: "exchange-rate",
        filename: "raw-exchange-rate.json",
        mediaType: "application/json",
        body: '{"fixture":true}',
      },
    });
    expect(calls[0]!.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(calls[0]!.options.customMetadata).toEqual({
      source: "sbi-shinsei",
      runId,
      dataset: "exchange-rate",
      sha256: artifact.sha256,
    });

    const manifest: CollectionManifest = {
      schemaVersion: "sbi-shinsei-worker-poc-v1",
      source: "sbi-shinsei",
      runId,
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: "2026-09-04T00:00:01.000Z",
      status: "success",
      liveReadsEnabled: true,
      artifacts: [artifact],
      failures: [],
    };
    await storeManifest({ bucket, prefix, manifest });
    expect(calls.map((call) => call.key)).toEqual([
      `${prefix}/raw-exchange-rate.json`,
      `${prefix}/manifest.json`,
    ]);
    expect(calls[1]!.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(calls[1]!.options.customMetadata).toMatchObject({
      source: "sbi-shinsei",
      runId,
      status: "success",
    });
  });
});
