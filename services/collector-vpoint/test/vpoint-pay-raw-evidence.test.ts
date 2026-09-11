import { describe, expect, test } from "bun:test";
import {
  backfillStoredVPointPayEmails,
  importStoredVPointPayEmail,
} from "../src/vpoint-pay-raw-evidence";

describe("V Point Pay email raw-evidence client", () => {
  test("validates the exact pair import response", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const importer = fetcher(async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json({
        source: "v-point-pay-email",
        status: "sealed",
        centralRunId: 42,
        artifactCount: 2,
        sealed: true,
        allObjectsReused: false,
      });
    });
    await expect(
      importStoredVPointPayEmail(
        importer,
        `raw/v-point-pay-email/2026/08/31/${"a".repeat(64)}.json`,
      ),
    ).resolves.toMatchObject({ status: "sealed", artifactCount: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/v-point-pay-email/import-run");
  });

  test("accepts a bounded aggregate backfill response without source keys", async () => {
    const importer = fetcher(async () =>
      Response.json({
        source: "v-point-pay-email",
        scannedObjectCount: 1,
        importedPairCount: 0,
        skippedObjectCount: 1,
        failedPairCount: 0,
        nextCursor: "vpoint-pay-email-v1.payload.signature",
        truncated: true,
      }),
    );
    await expect(backfillStoredVPointPayEmails(importer)).resolves.toEqual({
      source: "v-point-pay-email",
      scannedObjectCount: 1,
      importedPairCount: 0,
      skippedObjectCount: 1,
      failedPairCount: 0,
      nextCursor: "vpoint-pay-email-v1.payload.signature",
      truncated: true,
    });
  });

  test("rejects unknown fields, inconsistent outcomes, and oversized bodies", async () => {
    const unknown = fetcher(async () =>
      Response.json({
        source: "v-point-pay-email",
        status: "sealed",
        centralRunId: 1,
        artifactCount: 2,
        sealed: true,
        allObjectsReused: false,
        normalizedKey: "must-not-cross-boundary",
      }),
    );
    await expect(importStoredVPointPayEmail(unknown, "ignored")).rejects.toThrow(
      "vpoint_pay_email_importer_invalid_response",
    );

    const inconsistent = fetcher(async () =>
      Response.json({
        source: "v-point-pay-email",
        scannedObjectCount: 1,
        importedPairCount: 1,
        skippedObjectCount: 0,
        failedPairCount: 0,
        nextCursor: null,
        truncated: false,
      }),
    );
    await expect(backfillStoredVPointPayEmails(inconsistent)).rejects.toThrow(
      "vpoint_pay_email_importer_invalid_response",
    );

    const oversized = fetcher(
      async () =>
        new Response(
          JSON.stringify({
            padding: "x".repeat(9 * 1024),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await expect(backfillStoredVPointPayEmails(oversized)).rejects.toThrow(
      "vpoint_pay_email_importer_response_too_large",
    );
  });
});

function fetcher(implementation: (request: Request) => Promise<Response>): Fetcher {
  return { fetch: implementation } as Fetcher;
}
