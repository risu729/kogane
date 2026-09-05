import { describe, expect, test } from "bun:test";
import { storeArtifact, storeManifest } from "../src/storage";
import type { CollectionManifest } from "../src/types";

interface PutCall {
  key: string;
  options: R2PutOptions;
}

describe("Sony Bank immutable R2 storage", () => {
  test("binds new artifacts to their source and run and writes the manifest last", async () => {
    const calls: PutCall[] = [];
    const bucket = {
      put: async (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView,
        options: R2PutOptions,
      ) => {
        calls.push({ key, options });
        const bytes =
          typeof value === "string"
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
    const prefix = `raw/sony-bank/2026/09/04/${runId}`;
    const artifact = await storeArtifact({
      bucket,
      prefix,
      runId,
      artifact: {
        dataset: "gross-balance",
        filename: "gross-balance.json",
        mediaType: "application/json",
        body: '{"fixture":true}',
      },
    });
    expect(calls[0]!.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(calls[0]!.options.customMetadata).toEqual({
      source: "sony-bank",
      runId,
      dataset: "gross-balance",
      sha256: artifact.sha256,
    });

    const manifest: CollectionManifest = {
      schemaVersion: "sony-bank-worker-poc-v2",
      source: "sony-bank",
      runId,
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: "2026-09-04T00:00:01.000Z",
      status: "success",
      window: { from: "2026-09-01", to: "2026-09-04" },
      transactionCount: 0,
      artifacts: [artifact],
      failures: [],
    };
    await storeManifest({ bucket, prefix, manifest });
    expect(calls.map((call) => call.key)).toEqual([
      `${prefix}/gross-balance.json`,
      `${prefix}/manifest.json`,
    ]);
    expect(calls[1]!.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(calls[1]!.options.customMetadata).toMatchObject({
      source: "sony-bank",
      runId,
      status: "success",
    });
  });
});
