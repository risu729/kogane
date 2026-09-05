import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun, type RawEvidenceImporter } from "../src/raw-evidence";

describe("GLOBAL PASS raw evidence service binding", () => {
  test("imports one exact manifest through the private binding", async () => {
    const manifestKey =
      "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";
    let observedUrl = "";
    let observedBody: unknown;
    const importer = {
      async fetch(request: Request) {
        observedUrl = request.url;
        observedBody = await request.json();
        return Response.json({
          source: "prestia-globalpass",
          manifestKey,
          status: "sealed",
          centralRunId: 7,
          artifactCount: 3,
          sealed: true,
          finalChunkAllObjectsReused: false,
        });
      },
    } satisfies RawEvidenceImporter;
    const result = await importStoredRun(importer, manifestKey);
    expect(result.status).toBe("sealed");
    expect(new URL(observedUrl).pathname).toBe("/v1/prestia-globalpass/import-run");
    expect(observedBody).toEqual({ manifestKey });
  });

  test("accepts an immediate large-run deferral without inventing a central run", async () => {
    const manifestKey =
      "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";
    const importer = {
      async fetch() {
        return Response.json(
          {
            source: "prestia-globalpass",
            manifestKey,
            status: "deferred",
            reason: "worker_invocation_limit",
            artifactCount: 16,
            nextOffset: 0,
          },
          { status: 202 },
        );
      },
    } satisfies RawEvidenceImporter;
    await expect(importStoredRun(importer, manifestKey)).resolves.toEqual({
      source: "prestia-globalpass",
      manifestKey,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: 16,
      nextOffset: 0,
    });
  });

  test("fixes every backfill request to one manifest", async () => {
    let observedBody: unknown;
    const importer = {
      async fetch(request: Request) {
        observedBody = await request.json();
        return Response.json({
          source: "prestia-globalpass",
          scannedObjectCount: 1,
          importedManifestCount: 0,
          skippedManifestCount: 1,
          deferredManifestCount: 0,
          failedManifestCount: 0,
          nextCursor: null,
          truncated: false,
        });
      },
    } satisfies RawEvidenceImporter;
    await backfillStoredRuns(importer, "cursor-1");
    expect(observedBody).toEqual({ cursor: "cursor-1", limit: 1 });
  });

  test("rejects unknown response fields and a mismatched manifest", async () => {
    const importer = {
      async fetch() {
        return Response.json({
          source: "prestia-globalpass",
          manifestKey:
            "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174999/manifest.json",
          status: "sealed",
          centralRunId: 7,
          artifactCount: 3,
          sealed: true,
          finalChunkAllObjectsReused: false,
          extra: true,
        });
      },
    } satisfies RawEvidenceImporter;
    await expect(
      importStoredRun(
        importer,
        "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
      ),
    ).rejects.toThrow("raw_evidence_importer_invalid_response");
  });

  test("rejects internally inconsistent backfill outcomes", async () => {
    const importer = {
      async fetch() {
        return Response.json({
          source: "prestia-globalpass",
          scannedObjectCount: 1,
          importedManifestCount: 1,
          skippedManifestCount: 0,
          deferredManifestCount: 0,
          failedManifestCount: 0,
          nextCursor: null,
          truncated: false,
        });
      },
    } satisfies RawEvidenceImporter;
    await expect(backfillStoredRuns(importer)).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });

  test("accepts a zero-scan deferred continuation with an opaque offset cursor", async () => {
    const manifestKey =
      "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";
    const importer = {
      async fetch() {
        return Response.json({
          source: "prestia-globalpass",
          scannedObjectCount: 0,
          importedManifestCount: 0,
          skippedManifestCount: 0,
          deferredManifestCount: 1,
          failedManifestCount: 0,
          nextCursor: `global-pass-v1.${"a".repeat(600)}`,
          truncated: true,
          result: {
            source: "prestia-globalpass",
            manifestKey,
            status: "deferred",
            reason: "worker_invocation_limit",
            artifactCount: 16,
            nextOffset: 10,
          },
        });
      },
    } satisfies RawEvidenceImporter;
    await expect(
      backfillStoredRuns(importer, `global-pass-v1.${"b".repeat(600)}`),
    ).resolves.toMatchObject({ deferredManifestCount: 1, scannedObjectCount: 0 });
  });
});
