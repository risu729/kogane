import { describe, expect, test } from "bun:test";
import worker, { classifySbiVcBackfillError } from "../src/worker";
import { ImportError } from "../src/error";
import { backfillStoredRuns } from "../../../poc/mobile-suica-worker/src/raw-evidence";

describe("collector R2 importer routes", () => {
  test("the Mobile Suica backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/mobile-suica/2026/09/05/run/sf-history.json" }],
          truncated: true,
          cursor: "next",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/mobile-suica/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/mobile-suica/", limit: 1, cursor: "prior" }]);
    expect(await response.json()).toMatchObject({
      source: "mobile-suica",
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      nextCursor: "next",
      truncated: true,
    });
  });

  test("the Mobile Suica backfill route rejects limits above one", async () => {
    const bucket = { list: async () => { throw new Error("must_not_list"); } } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/mobile-suica/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "backfill_limit_must_be_one" });
  });
  test("the Sony backfill page scans one non-manifest object without central writes", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sony-bank/2026/09/03/run/gross-balance.json" }],
          truncated: false,
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sony-bank/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/sony-bank/", limit: 1 }]);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      source: "sony-bank",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
  });

  test("the Sony backfill route rejects invalid limits and cursors before listing R2", async () => {
    const bucket = {
      list: async () => {
        throw new Error("list_must_not_be_called");
      },
    } as unknown as R2Bucket;
    for (const body of [{ limit: 2 }, { cursor: "not-a-sony-cursor", limit: 1 }]) {
      const response = await worker.fetch(
        new Request("https://importer.internal/v1/sony-bank/backfill-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }) as Parameters<typeof worker.fetch>[0],
        environment({} as R2Bucket, bucket),
      );
      expect(response.status).toBe(400);
    }
  });

  test("the SBI VC backfill page lists at most one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sbi-vc-trade/2026/09/03/run/cash-balances.json" }],
          truncated: true,
          cursor: "next-cursor",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-vc-trade/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      prefix: "raw/sbi-vc-trade/",
      limit: 1,
      cursor: "prior",
    }]);
    expect(await response.json()).toMatchObject({
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      nextCursor: "next-cursor",
      truncated: true,
    });
  });

  test("the SBI VC backfill route rejects any requested limit above one", async () => {
    const bucket = {
      list: async () => {
        throw new Error("list_must_not_be_called");
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-vc-trade/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(bucket),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body).toEqual({ error: "backfill_limit_must_be_one" });
  });

  test("the SBI Shinsei backfill page lists exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sbi-shinsei/2026/09/03/run/raw-exchange-rate.json" }],
          truncated: true,
          cursor: "next-cursor",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-shinsei/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      prefix: "raw/sbi-shinsei/",
      limit: 1,
      cursor: "prior",
    }]);
    expect(await response.json()).toMatchObject({
      source: "sbi-shinsei",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      failedManifestCount: 0,
      nextCursor: "next-cursor",
      truncated: true,
    });
  });

  test("the Mobile Suica backfill response passes the collector contract validator", async () => {
    const bucket = {
      list: async () => ({
        objects: [{ key: "raw/mobile-suica/2026/09/05/run/sf-history.json" }],
        truncated: false,
      }) as unknown as R2Objects,
    } as unknown as R2Bucket;
    const env = environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket);
    const importer = {
      fetch: (request: Request) => worker.fetch(
        request as Parameters<typeof worker.fetch>[0],
        env,
      ),
    } as Fetcher;
    await expect(backfillStoredRuns(importer)).resolves.toEqual({
      source: "mobile-suica",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
  });

  test("classifies the synchronous chain limit as deferred, not failed", () => {
    expect(classifySbiVcBackfillError(
      new ImportError(409, "sync_import_worker_chain_limit"),
    )).toEqual({
      deferred: true,
      code: "sync_import_worker_chain_limit",
    });
    expect(classifySbiVcBackfillError(
      new ImportError(409, "artifact_checksum_mismatch"),
    )).toEqual({
      deferred: false,
      code: "artifact_checksum_mismatch",
    });
  });
});

function environment(
  bucket: R2Bucket,
  sonyBucket: R2Bucket = {} as R2Bucket,
  sbiShinseiBucket: R2Bucket = {} as R2Bucket,
  mobileSuicaBucket: R2Bucket = {} as R2Bucket,
): Env {
  return {
    SBI_SNAPSHOTS: {} as R2Bucket,
    SBI_VC_SNAPSHOTS: bucket,
    SONY_SNAPSHOTS: sonyBucket,
    SBI_SHINSEI_SNAPSHOTS: sbiShinseiBucket,
    MOBILE_SUICA_SNAPSHOTS: mobileSuicaBucket,
    RAW_EVIDENCE: {} as Fetcher,
    IMPORTER_VERSION: "collector-r2-importer-v6",
    RAW_EVIDENCE_TOKEN: `collector-r2-sbi.${"s".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_VC: `collector-r2-sbi-vc.${"v".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SONY: `collector-r2-sony-bank.${"o".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_SHINSEI: `collector-r2-sbi-shinsei.${"n".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_MOBILE_SUICA: `collector-r2-mobile-suica.${"m".repeat(32)}`,
    ORIGIN_FINGERPRINT_KEY: "ab".repeat(32),
  };
}
