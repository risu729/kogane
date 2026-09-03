import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun } from "../src/raw-evidence";

function fakeFetcher(handler: (request: Request) => Response): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init)),
  } as Fetcher;
}

describe("raw evidence importer binding", () => {
  test("imports one durable outbox run through the internal service", async () => {
    const importer = fakeFetcher((request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sbi-vc-trade/import-run");
      expect(request.method).toBe("POST");
      return Response.json({
        source: "sbi-vc-trade",
        manifestKey: "raw/sbi-vc-trade/2026/09/03/run/manifest.json",
        centralRunId: 24,
        artifactCount: 7,
        sealed: true,
        allObjectsReused: false,
      });
    });
    const result = await importStoredRun(
      importer,
      "raw/sbi-vc-trade/2026/09/03/run/manifest.json",
    );
    expect(result.centralRunId).toBe(24);
    expect(result.sealed).toBe(true);
  });

  test("passes only the cursor and one-object backfill limit", async () => {
    const importer = fakeFetcher((request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sbi-vc-trade/backfill-page");
      return Response.json({
        source: "sbi-vc-trade",
        scannedObjectCount: 1,
        importedManifestCount: 1,
        skippedManifestCount: 0,
        failedManifestCount: 0,
        nextCursor: "next",
        truncated: true,
      });
    });
    const result = await backfillStoredRuns(importer, { cursor: "cursor", limit: 1 });
    expect(result.importedManifestCount).toBe(1);
    expect(result.nextCursor).toBe("next");
  });

  test("surfaces only the importer's stable error code", async () => {
    const importer = fakeFetcher(() =>
      Response.json({ error: "manifest_failure_complement_mismatch" }, { status: 409 })
    );
    await expect(importStoredRun(importer, "raw/sbi-vc/manifest.json"))
      .rejects.toThrow("HTTP 409: manifest_failure_complement_mismatch");
  });
});
