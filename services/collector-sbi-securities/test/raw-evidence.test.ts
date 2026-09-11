import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun } from "../src/raw-evidence";

function fakeFetcher(handler: (request: Request) => Response): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init)),
  } as Fetcher;
}

describe("raw evidence importer binding", () => {
  test("imports one stored run through the internal service", async () => {
    const importer = fakeFetcher((request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sbi-securities/import-run");
      return Response.json({
        source: "sbi-securities",
        manifestKey: "raw/sbi-securities/2026/09/03/run/manifest.json",
        centralRunId: 42,
        artifactCount: 8,
        sealed: true,
        allObjectsReused: false,
      });
    });
    const result = await importStoredRun(
      importer,
      "raw/sbi-securities/2026/09/03/run/manifest.json",
    );
    expect(result.centralRunId).toBe(42);
    expect(result.sealed).toBe(true);
  });

  test("passes bounded backfill options", async () => {
    const importer = fakeFetcher((request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sbi-securities/backfill-page");
      return Response.json({
        source: "sbi-securities",
        scannedObjectCount: 1,
        importedManifestCount: 1,
        skippedManifestCount: 0,
        failedManifestCount: 0,
        nextCursor: "next",
        truncated: true,
      });
    });
    const result = await backfillStoredRuns(importer, {
      cursor: "cursor",
      limit: 1,
    });
    expect(result.importedManifestCount).toBe(1);
    expect(result.nextCursor).toBe("next");
  });

  test("surfaces only the importer error code", async () => {
    const importer = fakeFetcher(() =>
      Response.json({ error: "manifest_hash_mismatch" }, { status: 409 }),
    );
    await expect(importStoredRun(importer, "raw/sbi/manifest.json")).rejects.toThrow(
      "HTTP 409: manifest_hash_mismatch",
    );
  });
});
