import { describe, expect, test } from "bun:test";
import { backfillStoredRuns } from "../src/raw-evidence";

describe("MoneyForward raw-evidence bridge", () => {
  test("sends one bounded page and accepts a key-free deferred result", async () => {
    let received: unknown;
    const importer = {
      fetch: async (request: Request) => {
        expect(new URL(request.url).pathname).toBe("/v1/moneyforward/backfill-page");
        received = await request.json();
        return Response.json({
          source: "moneyforward-me",
          scannedObjectCount: 1,
          importedManifestCount: 0,
          skippedManifestCount: 0,
          deferredManifestCount: 1,
          failedManifestCount: 0,
          nextCursor: "moneyforward-scan-v1.opaque.signature",
          truncated: true,
          result: {
            source: "moneyforward-me",
            status: "deferred",
            reason: "worker_invocation_limit",
            artifactCount: 54,
            nextOffset: 5,
          },
        });
      },
    };
    const result = await backfillStoredRuns(importer as unknown as Fetcher, "previous");
    expect(received).toEqual({ cursor: "previous", limit: 1 });
    expect(result).toMatchObject({ deferredManifestCount: 1, truncated: true });
  });

  test("rejects source identifiers and contradictory outcomes", async () => {
    const importer = response({
      source: "moneyforward-me",
      scannedObjectCount: 1,
      importedManifestCount: 1,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
      result: {
        source: "moneyforward-me",
        status: "sealed",
        centralRunId: 1,
        artifactCount: 54,
        sealed: true,
        finalChunkAllObjectsReused: false,
        manifestKey: "must-not-cross-the-collector-boundary",
      },
    });
    await expect(backfillStoredRuns(importer)).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });

  test("rejects overlong cursors and unknown fields", async () => {
    const importer = response({
      source: "moneyforward-me",
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: "x".repeat(12_001),
      truncated: true,
      unexpected: true,
    });
    await expect(backfillStoredRuns(importer)).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });

  test("accepts a key-free empty page when its cursor advances", async () => {
    const importer = response({
      source: "moneyforward-me",
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: "moneyforward-scan-v1.opaque.signature",
      truncated: true,
    });
    await expect(backfillStoredRuns(importer)).resolves.toMatchObject({
      scannedObjectCount: 0,
      truncated: true,
    });
  });
});

function response(value: unknown): Fetcher {
  return { fetch: async () => Response.json(value) } as unknown as Fetcher;
}
