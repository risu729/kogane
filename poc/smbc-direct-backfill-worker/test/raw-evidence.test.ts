import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun } from "../src/raw-evidence";

const MANIFEST =
  "raw/smbc-direct/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";

describe("SMBC Direct raw evidence client", () => {
  test("validates sealed and deferred importer responses", async () => {
    const sealed = importer({
      source: "smbc-direct",
      manifestKey: MANIFEST,
      status: "sealed",
      centralRunId: 7,
      artifactCount: 189,
      sealed: true,
      finalChunkAllObjectsReused: false,
    });
    await expect(importStoredRun(sealed, MANIFEST)).resolves.toMatchObject({
      status: "sealed",
      centralRunId: 7,
    });
    const deferred = importer({
      source: "smbc-direct",
      manifestKey: MANIFEST,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: 189,
      nextOffset: 0,
    }, 202);
    await expect(importStoredRun(deferred, MANIFEST)).resolves.toMatchObject({
      status: "deferred",
      nextOffset: 0,
    });
  });

  test("validates a bounded staged backfill response", async () => {
    const cursor = "smbc-direct-v1." + "a".repeat(600);
    const service = importer({
      source: "smbc-direct",
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 1,
      failedManifestCount: 0,
      nextCursor: cursor,
      truncated: true,
      result: {
        source: "smbc-direct",
        manifestKey: MANIFEST,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: 189,
        nextOffset: 20,
      },
    });
    await expect(backfillStoredRuns(service, "prior")).resolves.toMatchObject({
      deferredManifestCount: 1,
      nextCursor: cursor,
      truncated: true,
    });
  });

  test("rejects unbounded or structurally inconsistent responses", async () => {
    await expect(importStoredRun(importer({
      source: "smbc-direct",
      manifestKey: MANIFEST,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: 189,
      nextOffset: 189,
    }), MANIFEST)).rejects.toThrow("raw_evidence_importer_invalid_response");
    await expect(backfillStoredRuns(importer({
      source: "smbc-direct",
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: "a".repeat(12_001),
      truncated: true,
    }))).rejects.toThrow("raw_evidence_importer_");
  });
});

function importer(value: unknown, status = 200): Fetcher {
  return {
    fetch: async () => Response.json(value, { status }),
  } as unknown as Fetcher;
}
