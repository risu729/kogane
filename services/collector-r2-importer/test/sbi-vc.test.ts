import { describe, expect, test } from "bun:test";
import { importSbiVcRun, parseSbiVcManifest } from "../src/sbi-vc";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-vc-trade/2026/09/03/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-sbi-vc.${"v".repeat(32)}`;
const FINGERPRINT_KEY = "cd".repeat(32);

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.body.byteLength,
      customMetadata: stored.customMetadata,
      httpMetadata: { contentType: stored.contentType },
      checksums: {},
      arrayBuffer: async () => stored.body.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Map<string, Uint8Array>();
  nextUnitId = 10;
  nextDescriptor = 1;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const requestBody = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body: requestBody });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const body = new Uint8Array(await request.arrayBuffer());
      expect(request.headers.get("x-kogane-byte-size")).toBe(String(body.byteLength));
      const reused = this.uploaded.has(path);
      this.uploaded.set(path, body);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (/\/units$/u.test(path)) {
      return Response.json({ unitId: this.nextUnitId++ }, { status: 201 });
    }
    if (/\/artifacts$/u.test(path)) {
      const value = this.nextDescriptor++;
      return Response.json({
        descriptorSha256: value.toString(16).padStart(64, "0"),
      }, { status: 201 });
    }
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("SBI VC Trade staged-run importer", () => {
  test("validates the complete run, preserves exact bytes, and replays idempotently", async () => {
    const bucket = new FakeBucket();
    const bodies = new Map<string, Uint8Array>();
    const manifest = await storeRun(bucket, [
      staticArtifact("cash-balances"),
      staticArtifact("account-margin"),
      staticArtifact("position-summary"),
      staticArtifact("executions-recent-page-0001"),
      pageArtifact("executions-historical-page-0001", 1, 1),
      pageArtifact("cashflows-historical-page-0001", 0, 0),
    ], [], bodies);
    const legacyArtifact = bucket.objects.get(manifest.artifacts[0]!.key)!;
    delete legacyArtifact.customMetadata.source;
    delete legacyArtifact.customMetadata.runId;
    const central = new FakeCentral();
    const first = await importRun(bucket, central);
    expect(first).toMatchObject({
      source: "sbi-vc-trade",
      artifactCount: 7,
      sealed: true,
      allObjectsReused: false,
    });
    for (const artifact of manifest.artifacts) {
      const upload = central.uploaded.get(`/v1/runs/1/objects/${artifact.sha256}`);
      expect(upload).toEqual(bodies.get(artifact.dataset));
    }

    const replay = await importRun(bucket, central);
    expect(replay.allObjectsReused).toBe(true);
    expect(central.uploaded.size).toBe(7);
    const runRequests = central.requests.filter((request) => request.path === "/v1/runs");
    expect(runRequests).toHaveLength(2);
    expect(JSON.parse(runRequests[0]!.body)).toMatchObject({
      producerId: "collector-r2-importer",
      sourceId: "sbi-vc-trade",
      externalIdNamespace: "sbi-vc-trade-worker-poc-v1",
      externalSessionId: RUN_ID,
      sourceRunKey: "full-snapshot-sbi-vc-r2-v1",
    });
  });

  test("accepts a partial prefix only when the R2 failure names the exact next dataset", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [
      staticArtifact("cash-balances"),
      staticArtifact("account-margin"),
      staticArtifact("position-summary"),
      staticArtifact("executions-recent-page-0001"),
      pageArtifact("executions-historical-page-0001", 1, 1),
    ], [{ operation: "r2_cashflows-historical-page-0001", errorCode: "r2_put_failed" }]);
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({
      artifactCount: 6,
      sealed: true,
    });

    const manifest = JSON.parse(decode(bucket.objects.get(MANIFEST_KEY)!.body));
    manifest.failures[0].operation = "r2_cashflows-historical-page-0002";
    replaceManifest(bucket, manifest);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).rejects.toMatchObject({
      status: 400,
      code: "manifest_failure_complement_mismatch",
    });
    expect(central.requests).toHaveLength(0);
  });

  test("rejects a page after a terminal page before creating central state", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [
      staticArtifact("cash-balances"),
      staticArtifact("account-margin"),
      staticArtifact("position-summary"),
      staticArtifact("executions-recent-page-0001"),
      pageArtifact("executions-historical-page-0001", 1, 1),
      pageArtifact("executions-historical-page-0002", 0, 1),
      pageArtifact("cashflows-historical-page-0001", 0, 0),
    ], []);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).rejects.toMatchObject({
      status: 400,
      code: "manifest_page_after_terminal",
    });
    expect(central.requests).toHaveLength(0);
  });

  test("catalogues the final response that caused a collect pagination failure", async () => {
    for (const pages of [
      [pageArtifact("executions-historical-page-0001", 30, 31),
        pageArtifact("executions-historical-page-0002", 1, 32)],
      [pageArtifact("executions-historical-page-0001", 1, 31)],
    ]) {
      const bucket = new FakeBucket();
      await storeRun(bucket, [
        staticArtifact("cash-balances"),
        staticArtifact("account-margin"),
        staticArtifact("position-summary"),
        staticArtifact("executions-recent-page-0001"),
        ...pages,
      ], [{
        operation: "collect",
        errorCode: pages.length === 1
          ? "executions_historical_pagination_length_mismatch"
          : "executions_historical_pagination_total_changed",
      }]);
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).resolves.toMatchObject({
        sealed: true,
        artifactCount: pages.length + 5,
      });
      expect(central.requests.some((request) => request.path.endsWith("/seal"))).toBe(true);
    }
  });

  test("does not waive semantic validation for a non-pagination collect failure", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [
      staticArtifact("cash-balances"),
      staticArtifact("account-margin"),
      staticArtifact("position-summary"),
      staticArtifact("executions-recent-page-0001"),
      pageArtifact("executions-historical-page-0001", 1, 31),
    ], [{ operation: "collect", errorCode: "collector_http_503" }]);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).rejects.toMatchObject({
      status: 400,
      code: "manifest_page_length_mismatch",
    });
    expect(central.requests).toHaveLength(0);
  });

  test("rejects unexpected prefix objects and exact custom metadata mismatches", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [], [{ operation: "load_session", errorCode: "missing_session_seed" }]);
    bucket.objects.set(`${PREFIX}unexpected.json`, stored(encode("{}"), {
      dataset: "unexpected",
      sha256: "0".repeat(64),
    }));
    const firstCentral = new FakeCentral();
    await expect(importRun(bucket, firstCentral)).rejects.toMatchObject({
      status: 409,
      code: "prefix_inventory_mismatch",
    });
    expect(firstCentral.requests).toHaveLength(0);

    bucket.objects.delete(`${PREFIX}unexpected.json`);
    bucket.objects.get(MANIFEST_KEY)!.customMetadata.extra = "not-allowed";
    const secondCentral = new FakeCentral();
    await expect(importRun(bucket, secondCentral)).rejects.toMatchObject({
      status: 409,
      code: "manifest_metadata_mismatch",
    });
    expect(secondCentral.requests).toHaveLength(0);
  });

  test("defers a valid large partial prefix before creating central state", async () => {
    const bucket = new FakeBucket();
    const entries = [
      staticArtifact("cash-balances"),
      staticArtifact("account-margin"),
      staticArtifact("position-summary"),
      staticArtifact("executions-recent-page-0001"),
      ...Array.from({ length: 100 }, (_, index) =>
        pageArtifact(
          `executions-historical-page-${String(index + 1).padStart(4, "0")}`,
          30,
          3_001,
        )),
    ];
    await storeRun(bucket, entries, [{ operation: "collect", errorCode: "unexpected_error" }]);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).rejects.toMatchObject({
      status: 409,
      code: "sync_import_worker_chain_limit",
    });
    expect(central.requests).toHaveLength(0);
  });

  test("rejects a checksum mismatch before central state is created", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [
      staticArtifact("cash-balances"),
    ], [{ operation: "collect", errorCode: "collector_http_503" }]);
    const artifact = [...bucket.objects.values()][0]!;
    artifact.body[0] = artifact.body[0]! ^ 1;
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).rejects.toMatchObject({
      status: 409,
      code: "artifact_checksum_mismatch",
    });
    expect(central.requests).toHaveLength(0);
  });

  test("parser rejects non-contiguous datasets and unknown manifest fields", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [
      staticArtifact("cash-balances"),
      staticArtifact("position-summary"),
    ], [{ operation: "collect", errorCode: "collector_http_503" }]);
    expect(() => parseSbiVcManifest(
      bucket.objects.get(MANIFEST_KEY)!.body,
      MANIFEST_KEY,
    )).toThrow("manifest_dataset_order_invalid");

    const manifest = JSON.parse(decode(bucket.objects.get(MANIFEST_KEY)!.body));
    manifest.extra = true;
    expect(() => parseSbiVcManifest(encode(JSON.stringify(manifest)), MANIFEST_KEY))
      .toThrow("manifest_unknown_field");
  });

  test("does not accept an SBI Securities credential for the SBI VC route", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [], [{ operation: "load_session", errorCode: "missing_session_seed" }]);
    await expect(importSbiVcRun({
      bucket: bucket as unknown as R2Bucket,
      centralService: new FakeCentral() as unknown as Fetcher,
      centralToken: `collector-r2-sbi.${"s".repeat(32)}`,
      fingerprintKey: FINGERPRINT_KEY,
      importerVersion: "test-v1",
      manifestKey: MANIFEST_KEY,
    })).rejects.toThrow("central_auth_configuration_invalid");
  });
});

function staticArtifact(dataset: string) {
  return {
    dataset,
    body: dataset === "executions-recent-page-0001"
      ? { list: [{ synthetic: true }], totalSize: "1" }
      : { synthetic: true, dataset },
  };
}

function pageArtifact(dataset: string, listLength: number, totalSize: number) {
  return {
    dataset,
    body: {
      list: Array.from({ length: listLength }, (_, index) => ({ synthetic: index })),
      totalSize: String(totalSize),
    },
  };
}

async function storeRun(
  bucket: FakeBucket,
  entries: Array<{ dataset: string; body: unknown }>,
  failures: Array<{ operation: string; errorCode: string }>,
  bodies = new Map<string, Uint8Array>(),
) {
  const artifacts = [];
  for (const entry of entries) {
    const body = encode(`{\"meta\":{\"status\":\"OK\"},\"body\":${JSON.stringify(entry.body)}}\n`);
    const sha256 = await digest(body);
    const key = `${PREFIX}${entry.dataset}.json`;
    bodies.set(entry.dataset, body);
    bucket.objects.set(key, stored(body, {
      source: "sbi-vc-trade",
      runId: RUN_ID,
      dataset: entry.dataset,
      sha256,
    }));
    artifacts.push({ dataset: entry.dataset, key, sha256, bytes: body.byteLength });
  }
  const manifest = {
    schemaVersion: "sbi-vc-trade-worker-poc-v1",
    source: "sbi-vc-trade",
    runId: RUN_ID,
    startedAt: "2026-09-03T00:00:00.000Z",
    completedAt: "2026-09-03T00:01:00.000Z",
    status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
    artifacts,
    failures,
  };
  replaceManifest(bucket, manifest);
  return manifest;
}

function replaceManifest(bucket: FakeBucket, manifest: Record<string, unknown>) {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(MANIFEST_KEY, stored(body, {
    source: "sbi-vc-trade",
    runId: RUN_ID,
    status: String(manifest.status),
  }));
}

function stored(body: Uint8Array, customMetadata: Record<string, string>): StoredObject {
  return { body, customMetadata, contentType: "application/json" };
}

function importRun(bucket: FakeBucket, central: FakeCentral) {
  return importSbiVcRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "test-v1",
    manifestKey: MANIFEST_KEY,
  });
}

async function digest(body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
