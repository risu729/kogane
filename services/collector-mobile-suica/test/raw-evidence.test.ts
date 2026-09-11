import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun } from "../src/raw-evidence";

describe("raw evidence service binding", () => {
  test("imports one manifest through the internal service binding", async () => {
    let observedUrl = "";
    let observedBody: unknown;
    const importer = {
      async fetch(request: Request) {
        observedUrl = request.url;
        observedBody = await request.json();
        return Response.json({
          source: "mobile-suica",
          manifestKey: "raw/mobile-suica/run/manifest.json",
          status: "sealed",
          centralRunId: 7,
          artifactCount: 4,
          sealed: true,
          finalChunkAllObjectsReused: false,
        });
      },
    } as Fetcher;
    const result = await importStoredRun(importer, "raw/mobile-suica/run/manifest.json");
    expect(result.status).toBe("sealed");
    expect(new URL(observedUrl).pathname).toBe("/v1/mobile-suica/import-run");
    expect(observedBody).toEqual({ manifestKey: "raw/mobile-suica/run/manifest.json" });
  });

  test("fixes every backfill request to one manifest", async () => {
    let body: unknown;
    const importer = {
      async fetch(request: Request) {
        body = await request.json();
        return Response.json({
          source: "mobile-suica",
          scannedObjectCount: 1,
          importedManifestCount: 1,
          skippedManifestCount: 0,
          deferredManifestCount: 0,
          failedManifestCount: 0,
          nextCursor: null,
          truncated: false,
        });
      },
    } as Fetcher;
    await backfillStoredRuns(importer, "cursor-1");
    expect(body).toEqual({ cursor: "cursor-1", limit: 1 });
  });

  test("rejects an import response with unknown or conflicting fields", async () => {
    const importer = {
      async fetch(_request: Request) {
        return Response.json({
          source: "mobile-suica",
          manifestKey: "raw/mobile-suica/other/manifest.json",
          status: "sealed",
          centralRunId: 7,
          artifactCount: 4,
          sealed: true,
          finalChunkAllObjectsReused: false,
          unexpected: true,
        });
      },
    } as Fetcher;
    await expect(importStoredRun(importer, "raw/mobile-suica/run/manifest.json")).rejects.toThrow(
      "raw_evidence_importer_invalid_response",
    );
  });
});
