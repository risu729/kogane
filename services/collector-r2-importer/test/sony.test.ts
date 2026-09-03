import { describe, expect, test } from "bun:test";
import {
  importSonyRun,
  parseSonyManifest,
  SONY_TRANSFER_CHUNK_SIZE,
} from "../src/sony";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sony-bank/2026/09/03/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-sony-bank.${"o".repeat(32)}`;
const FINGERPRINT_KEY = "ef".repeat(32);
const WINDOW = { from: "2025-09-04", to: "2026-09-03" };
const WALLET_MONTHS = ["202608", "202607"];
const CURRENCIES = [
  "usd", "eur", "gbp", "aud", "nzd", "cad", "chf", "hkd", "zar", "sek",
] as const;

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256?: string;
}

interface Entry {
  dataset: string;
  body: Uint8Array;
  mediaType: string;
}

interface Failure {
  operation: string;
  errorType: string;
  message: string;
}

interface ManifestArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

interface TestManifest {
  schemaVersion: string;
  source: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  window: { from: string; to: string };
  transactionCount: number;
  artifacts: ManifestArtifact[];
  failures: Failure[];
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const nativeSha256 = stored.nativeSha256;
    return {
      key,
      size: stored.body.byteLength,
      customMetadata: stored.customMetadata,
      httpMetadata: { contentType: stored.contentType },
      checksums: nativeSha256
        ? { sha256: hexBytes(nativeSha256).buffer }
        : {},
      arrayBuffer: async () => ownedArrayBuffer(stored.body),
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
    if (/\/units$/u.test(path)) return Response.json({ unitId: 10 }, { status: 201 });
    if (/\/inventories$/u.test(path)) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (/\/artifacts$/u.test(path)) {
      return Response.json({ descriptorSha256: await digest(encode(canonicalJson(JSON.parse(requestBody)))) }, { status: 201 });
    }
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("Sony Bank staged-run importer", () => {
  test("preserves all success artifacts and resumes in ten-object chunks before sealing", async () => {
    const bucket = new FakeBucket();
    const { manifest, bodies } = await storeCompleteRun(bucket);
    const central = new FakeCentral();

    const first = await importRun(bucket, central, { immediate: false });
    expect(first).toEqual({
      source: "sony-bank",
      manifestKey: MANIFEST_KEY,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: manifest.artifacts.length + 1,
      nextOffset: SONY_TRANSFER_CHUNK_SIZE,
    });
    expect(central.requests.filter((request) => request.method === "PUT")).toHaveLength(10);
    expect(central.requests.filter((request) => /\/seal$/u.test(request.path))).toHaveLength(0);

    const second = await importRun(bucket, central, {
      immediate: false,
      offset: SONY_TRANSFER_CHUNK_SIZE,
    });
    expect(second).toMatchObject({
      source: "sony-bank",
      status: "sealed",
      artifactCount: manifest.artifacts.length + 1,
      sealed: true,
      allObjectsReused: false,
    });
    expect(central.requests.filter((request) => /\/seal$/u.test(request.path))).toHaveLength(1);

    for (const artifact of manifest.artifacts) {
      expect(central.uploaded.get(`/v1/runs/1/objects/${artifact.sha256}`))
        .toEqual(bodies.get(artifact.dataset));
    }
    const manifestBody = bucket.objects.get(MANIFEST_KEY)!.body;
    const manifestSha256 = await digest(manifestBody);
    expect(central.uploaded.get(`/v1/runs/1/objects/${manifestSha256}`)).toEqual(manifestBody);

    const inventoryRequests = central.requests.filter((request) => /\/items$/u.test(request.path));
    expect(inventoryRequests.map((request) =>
      (JSON.parse(request.body) as { items: unknown[] }).items.length
    )).toEqual([10, manifest.artifacts.length + 1 - 10]);
    const createRun = JSON.parse(central.requests.find((request) => request.path === "/v1/runs")!.body);
    expect(createRun).toEqual({
      producerId: "collector-r2-importer",
      sourceId: "sony-bank",
      externalIdNamespace: "sony-bank-worker-poc-v2",
      externalSessionId: RUN_ID,
      sourceRunKey: "full-snapshot-sony-bank-r2-v1",
    });
  });

  test("replays every chunk idempotently and reports all objects reused on the sealing chunk", async () => {
    const bucket = new FakeBucket();
    const { manifest } = await storeCompleteRun(bucket);
    const central = new FakeCentral();
    await importAllChunks(bucket, central, manifest.artifacts.length + 1);
    const uploadedCount = central.uploaded.size;

    const replay = await importAllChunks(bucket, central, manifest.artifacts.length + 1);
    expect(replay).toMatchObject({ status: "sealed", allObjectsReused: true });
    expect(central.uploaded.size).toBe(uploadedCount);
  });

  test("defers a normal Sony run immediately without creating central state", async () => {
    const bucket = new FakeBucket();
    const { manifest } = await storeCompleteRun(bucket);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toEqual({
      source: "sony-bank",
      manifestKey: MANIFEST_KEY,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: manifest.artifacts.length + 1,
      nextOffset: 0,
    });
    expect(manifest.artifacts.length + 1).toBeGreaterThan(11);
    expect(central.requests).toHaveLength(0);
  });

  test("defers an inventory above the central hard limit before reading its data objects", async () => {
    const bucket = new FakeBucket();
    const artifacts = [
      {
        dataset: "gross-balance",
        key: `${PREFIX}gross-balance.json`,
        mediaType: "application/json",
        sha256: "0".repeat(64),
        bytes: 1,
      },
      ...Array.from({ length: 9_999 }, (_, index) => {
        const dataset = `yen-history-page-${String(index + 1).padStart(4, "0")}`;
        return {
          dataset,
          key: `${PREFIX}${dataset}.json`,
          mediaType: "application/json",
          sha256: (index + 1).toString(16).padStart(64, "0"),
          bytes: 1,
        };
      }),
    ];
    await replaceManifest(bucket, {
      schemaVersion: "sony-bank-worker-poc-v2",
      source: "sony-bank",
      runId: RUN_ID,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:01:00.000Z",
      status: "success",
      window: { ...WINDOW },
      transactionCount: 4,
      artifacts,
      failures: [],
    });
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toEqual({
      source: "sony-bank",
      manifestKey: MANIFEST_KEY,
      status: "deferred",
      reason: "central_inventory_limit",
      artifactCount: 10_001,
      nextOffset: 0,
    });
    expect(bucket.objects.size).toBe(1);
    expect(central.requests).toHaveLength(0);
  });

  test("seals a terminal collect failure containing only its manifest", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [], [{
      operation: "collect",
      errorType: "CollectorHttpError",
      message: "provider request failed",
    }], { transactionCount: 0 });
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      status: "sealed",
      artifactCount: 1,
      sealed: true,
    });
    expect(central.uploaded.size).toBe(1);
    const unitReport = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path));
    expect(JSON.parse(unitReport!.body)).toMatchObject({
      producerStatus: "failed",
      safeFailureCode: "collector-request-failed",
      declaredArtifactCount: 0,
    });
  });

  test("accepts a partial run only when the R2 failures are the exact ordered complement", async () => {
    const bucket = new FakeBucket();
    const missing = new Set(["foreign-history-usd-csv"]);
    const { entries } = completeEntries();
    await storeRun(
      bucket,
      entries.filter((entry) => !missing.has(entry.dataset)),
      [{ operation: "r2:foreign-history-usd-csv", errorType: "Error", message: "R2 write failed" }],
    );
    await expect(importRun(bucket, new FakeCentral(), { immediate: false }))
      .resolves.toMatchObject({ status: "deferred", nextOffset: 10 });

    const manifest = readManifest(bucket);
    manifest.failures[0]!.operation = "r2:foreign-history-eur-csv";
    await replaceManifest(bucket, manifest);
    await expectRejected(bucket, "manifest_foreign_csv_condition_mismatch");
  });

  test("rejects partial runs whose missing pages or complete WALLET set cannot be proven", async () => {
    const { entries } = completeEntries();
    const pageBucket = new FakeBucket();
    await storeRun(
      pageBucket,
      entries.filter((entry) => entry.dataset !== "foreign-history-usd-page-0001"),
      [{
        operation: "r2:foreign-history-usd-page-0001",
        errorType: "Error",
        message: "R2 write failed",
      }],
    );
    await expectRejected(pageBucket, "manifest_unverifiable_partial");

    const walletDatasets = new Set(WALLET_MONTHS.map((month) => `wallet-history-${month}`));
    const walletBucket = new FakeBucket();
    await storeRun(
      walletBucket,
      entries.filter((entry) => !walletDatasets.has(entry.dataset)),
      WALLET_MONTHS.map((month) => ({
        operation: `r2:wallet-history-${month}`,
        errorType: "Error",
        message: "R2 write failed",
      })),
    );
    await expectRejected(walletBucket, "manifest_unverifiable_partial");
  });

  test("rejects prefix and exact metadata mismatches before central state", async () => {
    const prefixBucket = new FakeBucket();
    await storeCompleteRun(prefixBucket);
    prefixBucket.objects.set(`${PREFIX}unexpected.json`, stored(encode("{}"), {
      dataset: "unexpected",
      sha256: "0".repeat(64),
    }, "application/json"));
    await expectRejected(prefixBucket, "prefix_inventory_mismatch");

    const metadataBucket = new FakeBucket();
    const { manifest } = await storeCompleteRun(metadataBucket);
    metadataBucket.objects.get(manifest.artifacts[0]!.key)!.customMetadata.extra = "not-allowed";
    await expectRejected(metadataBucket, "artifact_metadata_mismatch");
  });

  test("accepts only the exact legacy or source-bound artifact metadata shape", async () => {
    const bucket = new FakeBucket();
    const { manifest } = await storeCompleteRun(bucket);
    const first = bucket.objects.get(manifest.artifacts[0]!.key)!;
    first.customMetadata = {
      source: "sony-bank",
      runId: RUN_ID,
      dataset: manifest.artifacts[0]!.dataset,
      sha256: manifest.artifacts[0]!.sha256,
    };
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ status: "deferred" });
  });

  test("rejects content, checksum, and media mismatches before central state", async () => {
    const hashBucket = new FakeBucket();
    const { manifest: hashManifest } = await storeCompleteRun(hashBucket);
    const corrupted = hashBucket.objects.get(hashManifest.artifacts[0]!.key)!;
    corrupted.body[0] = corrupted.body[0]! ^ 1;
    await expectRejected(hashBucket, "artifact_checksum_mismatch");

    const nativeBucket = new FakeBucket();
    const { manifest: nativeManifest } = await storeCompleteRun(nativeBucket);
    nativeBucket.objects.get(nativeManifest.artifacts[0]!.key)!.nativeSha256 = "0".repeat(64);
    await expectRejected(nativeBucket, "artifact_native_checksum_mismatch");

    const mediaBucket = new FakeBucket();
    const { manifest: mediaManifest } = await storeCompleteRun(mediaBucket);
    mediaBucket.objects.get(mediaManifest.artifacts[0]!.key)!.contentType = "text/plain";
    await expectRejected(mediaBucket, "artifact_content_type_mismatch");
  });

  test("rejects secret-bearing JSON and unsanitized wallet HTML", async () => {
    const jsonBucket = new FakeBucket();
    await storeCompleteRun(jsonBucket);
    await replaceArtifact(jsonBucket, "gross-balance", jsonBody({ loginPwd: "fixture-secret" }));
    await expectRejected(jsonBucket, "artifact_secret_field_present");

    const walletBucket = new FakeBucket();
    await storeCompleteRun(walletBucket);
    await replaceArtifact(walletBucket, "wallet-history-202608", encode(
      `${walletHtml(WALLET_MONTHS)}<input type="hidden" name="csrf" value="fixture-secret">`,
    ));
    await expectRejected(walletBucket, "wallet_html_not_sanitized");

    const failureBucket = new FakeBucket();
    await storeRun(failureBucket, [], [{
      operation: "collect",
      errorType: "Error",
      message: "password=fixture-secret",
    }], { transactionCount: 0 });
    expect(() => parseSonyManifest(failureBucket.objects.get(MANIFEST_KEY)!.body, MANIFEST_KEY))
      .toThrow("manifest_failure_message_invalid");
  });

  test("rejects inconsistent pagination totals and row counts", async () => {
    const totalBucket = new FakeBucket();
    await storeCompleteRun(totalBucket);
    await replaceArtifact(totalBucket, "yen-history-page-0002", pageBody(1, 5));
    await expectRejected(totalBucket, "artifact_page_total_mismatch");

    const countBucket = new FakeBucket();
    await storeCompleteRun(countBucket);
    await replaceArtifact(countBucket, "yen-history-page-0001", pageBody(3, 7));
    await replaceArtifact(countBucket, "yen-history-page-0002", pageBody(1, 7));
    const countManifest = readManifest(countBucket);
    countManifest.transactionCount = 7;
    await replaceManifest(countBucket, countManifest);
    await expectRejected(countBucket, "artifact_page_count_mismatch");
  });

  test("rejects invalid windows and manifest dataset ordering", async () => {
    const windowBucket = new FakeBucket();
    await storeCompleteRun(windowBucket);
    const windowManifest = readManifest(windowBucket);
    windowManifest.window = { from: "2025-09-02", to: "2026-09-03" };
    await replaceManifest(windowBucket, windowManifest);
    await expectRejected(windowBucket, "manifest_window_invalid");

    const orderBucket = new FakeBucket();
    await storeCompleteRun(orderBucket);
    const orderManifest = readManifest(orderBucket);
    [orderManifest.artifacts[0], orderManifest.artifacts[1]] = [
      orderManifest.artifacts[1]!, orderManifest.artifacts[0]!,
    ];
    await replaceManifest(orderBucket, orderManifest);
    await expectRejected(orderBucket, "manifest_dataset_order_invalid");
  });

  test("rejects summary and foreign CSV condition mismatches", async () => {
    const summaryBucket = new FakeBucket();
    await storeCompleteRun(summaryBucket);
    await replaceArtifact(summaryBucket, "collection-summary", summaryBody({ walletMonthCount: 1 }));
    await expectRejected(summaryBucket, "summary_manifest_mismatch");

    const csvBucket = new FakeBucket();
    const { entries } = completeEntries();
    await storeRun(csvBucket, entries.filter((entry) => entry.dataset !== "foreign-history-usd-csv"));
    await expectRejected(csvBucket, "manifest_foreign_csv_condition_mismatch");
  });

  test("rejects wallet selector sets that do not match the captured months", async () => {
    const bucket = new FakeBucket();
    await storeCompleteRun(bucket);
    await replaceArtifact(bucket, "wallet-history-202608", encode(walletHtml(["202608"])));
    await expectRejected(bucket, "wallet_selector_mismatch");
  });

  test("rejects a WALLET artifact whose selected month differs from its filename", async () => {
    const bucket = new FakeBucket();
    await storeCompleteRun(bucket);
    await replaceArtifact(
      bucket,
      "wallet-history-202607",
      encode(walletHtml(WALLET_MONTHS, "202608")),
    );
    await expectRejected(bucket, "wallet_selected_month_mismatch");
  });

  test("accepts one through fifteen wallet months and rejects either boundary outside that range", async () => {
    const oneMonthBucket = new FakeBucket();
    const oneMonthEntries = completeEntries(["202608"]).entries;
    await storeRun(oneMonthBucket, oneMonthEntries);
    await expect(importRun(oneMonthBucket, new FakeCentral()))
      .resolves.toMatchObject({ status: "deferred", reason: "worker_invocation_limit" });

    const fifteenMonths = [
      "202608", "202607", "202606", "202605", "202604", "202603", "202602", "202601",
      "202512", "202511", "202510", "202509", "202508", "202507", "202506",
    ];
    const fifteenMonthBucket = new FakeBucket();
    await storeRun(fifteenMonthBucket, completeEntries(fifteenMonths).entries);
    await expect(importRun(fifteenMonthBucket, new FakeCentral()))
      .resolves.toMatchObject({ status: "deferred", reason: "worker_invocation_limit" });

    const zeroMonthBucket = new FakeBucket();
    await storeRun(zeroMonthBucket, completeEntries([]).entries);
    await expectRejected(zeroMonthBucket, "manifest_wallet_months_invalid");

    const sixteenMonthBucket = new FakeBucket();
    await storeRun(sixteenMonthBucket, completeEntries([...fifteenMonths, "202505"]).entries);
    await expectRejected(sixteenMonthBucket, "wallet_selector_invalid");
  });

  test("does not accept another collector credential for the Sony route", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, [], [{
      operation: "collect",
      errorType: "Error",
      message: "provider request failed",
    }], { transactionCount: 0 });
    await expect(importSonyRun({
      bucket: bucket as unknown as R2Bucket,
      centralService: new FakeCentral() as unknown as Fetcher,
      centralToken: `collector-r2-sbi.${"s".repeat(32)}`,
      fingerprintKey: FINGERPRINT_KEY,
      importerVersion: "test-v1",
      manifestKey: MANIFEST_KEY,
    })).rejects.toThrow("central_auth_configuration_invalid");
  });
});

function completeEntries(walletMonths = WALLET_MONTHS): { entries: Entry[]; bodies: Map<string, Uint8Array> } {
  const entries: Entry[] = [
    entry("gross-balance", jsonBody({ balance: "fixture" })),
    entry("yen-history-page-0001", pageBody(3, 4)),
    entry("yen-history-page-0002", pageBody(1, 4)),
    entry("yen-history-csv", encode("date,amount\n2026-09-03,1\n"), "text/csv"),
  ];
  for (const currency of CURRENCIES) {
    const count = currency === "usd" ? 2 : 0;
    entries.push(entry(`foreign-history-${currency}-page-0001`, pageBody(count, count)));
    if (count > 0) {
      entries.push(entry(
        `foreign-history-${currency}-csv`,
        encode("date,amount\n2026-09-03,1\n"),
        "application/octet-stream",
      ));
    }
  }
  for (const month of walletMonths) {
    entries.push(entry(
      `wallet-history-${month}`,
      encode(walletHtml(walletMonths, month)),
      "text/html; charset=UTF-8",
    ));
  }
  entries.push(entry("collection-summary", summaryBody({ walletMonthCount: walletMonths.length })));
  return { entries, bodies: new Map(entries.map((value) => [value.dataset, value.body])) };
}

async function storeCompleteRun(bucket: FakeBucket) {
  const { entries, bodies } = completeEntries();
  const manifest = await storeRun(bucket, entries);
  return { manifest, bodies, entries };
}

async function storeRun(
  bucket: FakeBucket,
  entries: Entry[],
  failures: Failure[] = [],
  options: { transactionCount?: number } = {},
): Promise<TestManifest> {
  const artifacts: ManifestArtifact[] = [];
  for (const value of entries) {
    const sha256 = await digest(value.body);
    const key = `${PREFIX}${filenameFor(value.dataset)}`;
    bucket.objects.set(key, stored(value.body, { dataset: value.dataset, sha256 }, value.mediaType));
    artifacts.push({
      dataset: value.dataset,
      key,
      mediaType: value.mediaType,
      sha256,
      bytes: value.body.byteLength,
    });
  }
  const manifest: TestManifest = {
    schemaVersion: "sony-bank-worker-poc-v2",
    source: "sony-bank",
    runId: RUN_ID,
    startedAt: "2026-09-03T00:00:00.000Z",
    completedAt: "2026-09-03T00:01:00.000Z",
    status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
    window: { ...WINDOW },
    transactionCount: options.transactionCount ?? 4,
    artifacts,
    failures,
  };
  await replaceManifest(bucket, manifest);
  return manifest;
}

async function replaceArtifact(bucket: FakeBucket, dataset: string, body: Uint8Array): Promise<void> {
  const manifest = readManifest(bucket);
  const artifact = manifest.artifacts.find((value) => value.dataset === dataset);
  if (!artifact) throw new Error(`missing fixture artifact ${dataset}`);
  const sha256 = await digest(body);
  const previous = bucket.objects.get(artifact.key)!;
  bucket.objects.set(artifact.key, stored(body, { dataset, sha256 }, previous.contentType));
  artifact.sha256 = sha256;
  artifact.bytes = body.byteLength;
  await replaceManifest(bucket, manifest);
}

async function replaceManifest(bucket: FakeBucket, manifest: TestManifest): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  const sha256 = await digest(body);
  bucket.objects.set(MANIFEST_KEY, stored(body, {
    source: "sony-bank",
    status: manifest.status,
    runId: RUN_ID,
    sha256,
  }, "application/json"));
}

function readManifest(bucket: FakeBucket): TestManifest {
  return JSON.parse(decode(bucket.objects.get(MANIFEST_KEY)!.body)) as TestManifest;
}

function entry(dataset: string, body: Uint8Array, mediaType = "application/json"): Entry {
  return { dataset, body, mediaType };
}

function pageBody(rowCount: number, countCnt: number): Uint8Array {
  return jsonBody({
    transactionHistInfo: Array.from({ length: rowCount }, (_, index) => ({ fixture: index })),
    countCnt,
  });
}

function summaryBody(overrides: Record<string, unknown> = {}): Uint8Array {
  return jsonBody({
    schemaVersion: "sony-bank-collection-summary-v2",
    window: { ...WINDOW },
    transactionCount: 4,
    pageCount: 2,
    foreignCurrencyCount: 10,
    foreignTransactionCount: 2,
    foreignPageCount: 10,
    walletMonthCount: 2,
    cookieNames: ["SESSION"],
    ...overrides,
  });
}

function walletHtml(months: string[], selectedMonth = months[0]): string {
  return `<html><select name="W131301.referenceDate">${months.map((month) =>
    `<option value="${month}01"${month === selectedMonth ? " selected" : ""}>${month}</option>`
  ).join("")}</select></html>`;
}

function jsonBody(value: unknown): Uint8Array {
  return encode(`${JSON.stringify(value)}\n`);
}

function filenameFor(dataset: string): string {
  if (dataset === "yen-history-csv") return "yen-history.csv";
  const foreignCsv = /^foreign-history-([a-z]{3})-csv$/u.exec(dataset);
  if (foreignCsv) return `foreign-history-${foreignCsv[1]}.csv`;
  const wallet = /^wallet-history-(\d{4})(\d{2})$/u.exec(dataset);
  if (wallet) return `wallet-history-${wallet[1]}-${wallet[2]}.html`;
  return `${dataset}.json`;
}

function stored(
  body: Uint8Array,
  customMetadata: Record<string, string>,
  contentType: string,
): StoredObject {
  return { body, customMetadata, contentType };
}

function importRun(
  bucket: FakeBucket,
  central: FakeCentral,
  options: { offset?: number; immediate?: boolean } = {},
) {
  return importSonyRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "test-v1",
    manifestKey: MANIFEST_KEY,
    ...options,
  });
}

async function importAllChunks(bucket: FakeBucket, central: FakeCentral, total: number) {
  let offset = 0;
  while (offset < total) {
    const result = await importRun(bucket, central, { immediate: false, offset });
    if (result.status === "sealed") return result;
    expect(result.nextOffset).toBe(offset + SONY_TRANSFER_CHUNK_SIZE);
    offset = result.nextOffset;
  }
  throw new Error("fixture did not seal");
}

async function expectRejected(bucket: FakeBucket, code: string): Promise<void> {
  const central = new FakeCentral();
  await expect(importRun(bucket, central, { immediate: false })).rejects.toMatchObject({ code });
  expect(central.requests).toHaveLength(0);
}

async function digest(body: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(body)));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
