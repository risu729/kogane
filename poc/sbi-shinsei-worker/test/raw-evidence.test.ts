import { describe, expect, test } from "bun:test";
import {
  backfillRawEvidence,
  importRawEvidence,
  RawEvidenceImportError,
} from "../src/raw-evidence";

const MANIFEST_KEY =
  "raw/sbi-shinsei/2026/09/04/123e4567-e89b-42d3-a456-426614174000/manifest.json";

describe("SBI Shinsei raw evidence Service Binding", () => {
  test("imports one manifest and requires the exact sealed acknowledgement", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const importer = fetcher(async (request) => {
      requests.push({
        url: request.url,
        method: request.method,
        body: JSON.parse(await request.clone().text()),
      });
      return Response.json({
        source: "sbi-shinsei",
        manifestKey: MANIFEST_KEY,
        centralRunId: 1,
        artifactCount: 6,
        sealed: true,
        allObjectsReused: false,
      });
    });
    await importRawEvidence({ importer, manifestKey: MANIFEST_KEY });
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/sbi-shinsei/import-run");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.body).toEqual({ manifestKey: MANIFEST_KEY });

    for (const body of [
      { source: "sbi-shinsei", manifestKey: MANIFEST_KEY, sealed: false },
      { source: "sbi-shinsei-bank", manifestKey: MANIFEST_KEY, sealed: true },
      { source: "sbi-shinsei", manifestKey: `${MANIFEST_KEY}.other`, sealed: true },
    ]) {
      await expect(importRawEvidence({
        importer: fetcher(async () => Response.json(body)),
        manifestKey: MANIFEST_KEY,
      })).rejects.toBeInstanceOf(RawEvidenceImportError);
    }
  });

  test("forwards a single bounded backfill page without exposing a public importer", async () => {
    let request: { url: string; body: unknown } | undefined;
    const result = await backfillRawEvidence({
      importer: fetcher(async (value) => {
        request = {
          url: value.url,
          body: JSON.parse(await value.clone().text()),
        };
        return Response.json({
          source: "sbi-shinsei",
          scannedObjectCount: 1,
          importedManifestCount: 0,
          skippedManifestCount: 1,
          failedManifestCount: 0,
          nextCursor: "next",
          truncated: true,
        });
      }),
      cursor: "prior",
      limit: 1,
    });
    expect(result).toMatchObject({ source: "sbi-shinsei", truncated: true });
    expect(new URL(request!.url).pathname).toBe("/v1/sbi-shinsei/backfill-page");
    expect(request!.body).toEqual({ cursor: "prior", limit: 1 });
  });

  test("rejects importer failures, malformed JSON, and oversized responses", async () => {
    for (const response of [
      new Response('{"error":"fixture"}', { status: 409 }),
      new Response("not-json", { status: 200 }),
      new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
      new Response("{}", { status: 200, headers: { "content-length": "invalid" } }),
    ]) {
      await expect(backfillRawEvidence({
        importer: fetcher(async () => response.clone()),
      })).rejects.toBeInstanceOf(RawEvidenceImportError);
    }
  });
});

function fetcher(handler: (request: Request) => Promise<Response>): Fetcher {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init) as unknown as Request),
  } as Fetcher;
}
