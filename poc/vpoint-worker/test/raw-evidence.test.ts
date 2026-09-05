import { describe, expect, test } from "bun:test";
import { backfillStoredRuns, importStoredRun } from "../src/raw-evidence";

const MANIFEST_KEY =
  "raw/v-point/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";

describe("V Point raw-evidence client", () => {
  test("validates the exact import response", async () => {
    const fetcher = fakeFetcher({
      source: "v-point",
      manifestKey: MANIFEST_KEY,
      centralRunId: 4,
      artifactCount: 10,
      sealed: true,
      allObjectsReused: false,
    });
    await expect(importStoredRun(fetcher, MANIFEST_KEY)).resolves.toMatchObject({ sealed: true });
    expect(fetcher.requests[0]).toMatchObject({ path: "/v1/v-point/import-run", body: { manifestKey: MANIFEST_KEY } });
  });

  test("validates a bounded one-object backfill response", async () => {
    const fetcher = fakeFetcher({
      source: "v-point",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: "opaque-next",
      truncated: true,
    });
    await expect(backfillStoredRuns(fetcher, "opaque-prior")).resolves.toMatchObject({ truncated: true });
    expect(fetcher.requests[0]).toMatchObject({
      path: "/v1/v-point/backfill-page",
      body: { cursor: "opaque-prior", limit: 1 },
    });
  });

  test("rejects unknown response fields and oversized bodies", async () => {
    await expect(importStoredRun(fakeFetcher({
      source: "v-point", manifestKey: MANIFEST_KEY, centralRunId: 1,
      artifactCount: 1, sealed: true, allObjectsReused: false, unexpected: true,
    }), MANIFEST_KEY)).rejects.toThrow("raw_evidence_importer_invalid_response");
    const oversized = {
      fetch: async () => new Response("x".repeat(9 * 1024)),
    } as unknown as Fetcher;
    await expect(importStoredRun(oversized, MANIFEST_KEY))
      .rejects.toThrow("raw_evidence_importer_response_too_large");
  });
});

function fakeFetcher(value: unknown): Fetcher & { requests: Array<{ path: string; body: unknown }> } {
  const requests: Array<{ path: string; body: unknown }> = [];
  return {
    requests,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json(value);
    },
  } as unknown as Fetcher & { requests: Array<{ path: string; body: unknown }> };
}
