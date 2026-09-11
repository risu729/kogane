import { describe, expect, test } from "bun:test";
import { backfillStoredRuns } from "../src/raw-evidence";

describe("MyJCB raw-evidence bridge", () => {
  test("sends one bounded backfill page through the service binding", async () => {
    let received: Record<string, unknown> | undefined;
    const importer = {
      fetch: async (request: Request) => {
        expect(new URL(request.url).pathname).toBe("/v1/myjcb/backfill-page");
        received = (await request.json()) as Record<string, unknown>;
        return Response.json({
          source: "myjcb",
          scannedObjectCount: 1,
          importedManifestCount: 0,
          skippedManifestCount: 0,
          deferredManifestCount: 1,
          failedManifestCount: 0,
          nextCursor: "myjcb-v1.opaque",
          truncated: true,
          result: {
            source: "myjcb",
            manifestKey: "raw/myjcb/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
            status: "deferred",
            reason: "worker_invocation_limit",
            artifactCount: 8,
            nextOffset: 5,
            continuation: "myjcb-transfer-v1.payload.signature",
          },
        });
      },
    };
    const result = await backfillStoredRuns(importer as unknown as Fetcher, "previous");
    expect(received).toEqual({ cursor: "previous", limit: 1 });
    expect(result).toMatchObject({ deferredManifestCount: 1, truncated: true });
  });

  test("rejects contradictory result counts", async () => {
    const importer = response({
      source: "myjcb",
      scannedObjectCount: 1,
      importedManifestCount: 1,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
    await expect(backfillStoredRuns(importer)).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });

  test("rejects unknown fields and overlong cursors", async () => {
    const importer = response({
      source: "myjcb",
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: "x".repeat(16_001),
      truncated: true,
      unexpected: true,
    });
    await expect(backfillStoredRuns(importer)).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });
});

function response(value: unknown): Fetcher {
  return {
    fetch: async () => Response.json(value),
    connect: () => {
      throw new Error("unused");
    },
  } as unknown as Fetcher;
}
