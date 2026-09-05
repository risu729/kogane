import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  backfillStoredRuns,
  continueStoredRecord,
  importStoredRecord,
  type VpassImportJob,
} from "../src/raw-evidence";

const RECORD_KEY = "vpass/2026/09/05/2026-09-05T00-00-00-000Z/card-001/manifest.json";

describe("Vpass raw-evidence service binding", () => {
  test("accepts a bounded staged response without exposing it to the caller", async () => {
    const fetcher = jsonFetcher(
      {
        source: "vpass",
        recordKey: RECORD_KEY,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: 6,
        nextOffset: 5,
        continuation: "vpass-transfer-v1.fixture.signature",
      },
      202,
    );
    await expect(importStoredRecord(fetcher, RECORD_KEY)).resolves.toEqual({
      status: "deferred",
      continuation: "vpass-transfer-v1.fixture.signature",
    });
  });

  test("durably requeues every deferred continuation until the Service Binding seals", async () => {
    const sent: VpassImportJob[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        source: "vpass",
        recordKey: RECORD_KEY,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: 6,
        nextOffset: 5,
        continuation: "vpass-transfer-v1.fixture.signature",
      },
      {
        source: "vpass",
        recordKey: RECORD_KEY,
        status: "sealed",
        centralRunId: 1,
        artifactCount: 6,
        sealed: true,
        finalChunkAllObjectsReused: false,
      },
    ];
    const importer = {
      fetch: async (request: Request) => {
        requests.push((await request.json()) as Record<string, unknown>);
        return Response.json(responses.shift(), { status: responses.length === 1 ? 202 : 201 });
      },
    } as unknown as Fetcher;
    const queue = {
      send: async (job: VpassImportJob) => {
        sent.push(job);
        return {} as QueueSendResponse;
      },
    } as unknown as Queue<VpassImportJob>;

    await expect(
      continueStoredRecord(importer, queue, {
        v: 1,
        recordKey: RECORD_KEY,
      }),
    ).resolves.toBe("requeued");
    expect(sent).toEqual([
      {
        v: 1,
        recordKey: RECORD_KEY,
        continuation: "vpass-transfer-v1.fixture.signature",
      },
    ]);
    await expect(continueStoredRecord(importer, queue, sent.shift())).resolves.toBe("sealed");
    expect(sent).toEqual([]);
    expect(requests).toEqual([
      { recordKey: RECORD_KEY },
      { recordKey: RECORD_KEY, continuation: "vpass-transfer-v1.fixture.signature" },
    ]);
  });

  test("does not acknowledge a failed importer call as sealed or requeue malformed state", async () => {
    let sends = 0;
    const queue = {
      send: async () => {
        sends += 1;
        return {} as QueueSendResponse;
      },
    } as unknown as Queue<VpassImportJob>;
    await expect(
      continueStoredRecord(jsonFetcher({ error: "source_validation_failed" }, 409), queue, {
        v: 1,
        recordKey: RECORD_KEY,
      }),
    ).rejects.toThrow("raw_evidence_importer_request_failed");
    await expect(
      continueStoredRecord(jsonFetcher({}, 200), queue, {
        v: 1,
        recordKey: `${RECORD_KEY}.invalid`,
      }),
    ).rejects.toThrow("raw_evidence_import_job_invalid");
    expect(sends).toBe(0);
  });

  test("configures a single-message consumer with a dead-letter queue", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(config.queues).toEqual({
      producers: [
        {
          binding: "RAW_EVIDENCE_QUEUE",
          queue: "kogane-vpass-raw-evidence-import",
        },
      ],
      consumers: [
        {
          queue: "kogane-vpass-raw-evidence-import",
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 10,
          dead_letter_queue: "kogane-vpass-raw-evidence-import-dlq",
        },
      ],
    });
  });

  test("validates and narrows backfill output", async () => {
    const fetcher = jsonFetcher({
      source: "vpass",
      scannedObjectCount: 0,
      importedRecordCount: 1,
      skippedRecordCount: 0,
      deferredRecordCount: 0,
      failedRecordCount: 0,
      nextCursor: "vpass-scan-v1.fixture.signature",
      truncated: true,
      result: {
        source: "vpass",
        recordKey: RECORD_KEY,
        status: "sealed",
        centralRunId: 1,
        artifactCount: 6,
        sealed: true,
        finalChunkAllObjectsReused: true,
      },
    });
    const result = await backfillStoredRuns(fetcher);
    expect(result).toEqual({
      source: "vpass",
      scannedObjectCount: 0,
      importedRecordCount: 1,
      skippedRecordCount: 0,
      deferredRecordCount: 0,
      failedRecordCount: 0,
      nextCursor: "vpass-scan-v1.fixture.signature",
      truncated: true,
    });
  });

  test("rejects an inconsistent or oversized importer response", async () => {
    await expect(
      backfillStoredRuns(
        jsonFetcher({
          source: "vpass",
          scannedObjectCount: 1,
          importedRecordCount: 1,
          skippedRecordCount: 0,
          deferredRecordCount: 0,
          failedRecordCount: 0,
          nextCursor: null,
          truncated: false,
        }),
      ),
    ).rejects.toThrow("raw_evidence_importer_invalid_response");
    const oversized = {
      fetch: async () =>
        new Response("x".repeat(70 * 1024), {
          headers: { "content-type": "application/json" },
        }),
    } as unknown as Fetcher;
    await expect(backfillStoredRuns(oversized)).rejects.toThrow(
      "raw_evidence_importer_response_too_large",
    );
  });
});

function jsonFetcher(value: unknown, status = 200): Fetcher {
  return {
    fetch: async () => Response.json(value, { status }),
    connect: () => {
      throw new Error("unused");
    },
  } as unknown as Fetcher;
}
