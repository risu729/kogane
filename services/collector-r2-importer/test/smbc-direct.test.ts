import { describe, expect, test } from "bun:test";
import { encode as encodeLegacy } from "iconv-lite";
import {
  importSmbcDirectRun,
  parseSmbcDirectManifest,
  SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
} from "../src/smbc-direct";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = "raw/smbc-direct/2026/09/05/" + RUN_ID + "/";
const MANIFEST_KEY = PREFIX + "manifest.json";
const TOKEN = "collector-r2-smbc-direct." + "s".repeat(32);
const FINGERPRINT_KEY = "ab".repeat(32);
const RAW_MEDIA_TYPE = "application/json;charset=Shift_JIS";
const JSON_MEDIA_TYPE = "application/json; charset=utf-8";
const BALANCE_KEYS = [
  "ajaxGaikaAccountBalance",
  "ajaxGaikaFutsuAccountBalance",
  "ajaxGaikaFutsuStartFlag",
  "ajaxGaikaStartFlag",
  "ajaxHighCouponBalanceEUR",
  "ajaxHighCouponBalanceUSD",
  "ajaxHighCouponStartFlag",
  "ajaxJuLoanAccountBalanceNcsstyFlag",
  "ajaxJuLoanBonusMonRepaymentAmount",
  "ajaxJuLoanBonusMonthRepayment",
  "ajaxJuLoanKouZaBalance",
  "ajaxJuLoanRepaymentAmount",
  "ajaxJuLoanRepaymentKbn",
  "ajaxPremiumYenAccountBalance",
  "ajaxPremiumYenStartFlag",
  "ajaxRyudoAccountBalance",
  "ajaxRyudoAccountPayableBalance",
  "ajaxRyudoStartFlag",
  "ajaxSaikenAccountBalance",
  "ajaxSaikenStartFlag",
  "ajaxSavingAccountBalance",
  "ajaxSavingStartFlag",
  "ajaxToshinAccountBalance",
  "ajaxToshinCurrency",
  "ajaxToshinStartFlag",
  "ajaxYenTeikiAccountBalance",
  "ajaxYenTeikiStartFlag",
  "ajaxZaikeAccountBalance",
  "ajaxZaikeStartFlag",
] as const;

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256?: string;
}

interface TestArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  range?: { start: string; end: string };
  transactionCount?: number;
}

interface TestManifest {
  schemaVersion: string;
  source: string;
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  requestedRange: { start: string; end: string };
  completedChunks: number;
  totalChunks: number;
  transactionCount: number;
  artifacts: TestArtifact[];
  failureCodes: string[];
  logoutSucceeded: boolean | null;
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
      checksums: stored.nativeSha256
        ? { sha256: hexBytes(stored.nativeSha256).buffer }
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
  readonly terminalReports = new Map<string, string>();

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const requestBody = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body: requestBody });
    expect(request.headers.get("authorization")).toBe("Bearer " + TOKEN);
    if (request.method === "PUT") {
      const body = new Uint8Array(await request.arrayBuffer());
      const reused = this.uploaded.has(path);
      this.uploaded.set(path, body);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (/\/units$/u.test(path)) return Response.json({ unitId: 10 }, { status: 201 });
    if (/\/inventories$/u.test(path)) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (/\/artifacts$/u.test(path)) {
      const submitted = JSON.parse(requestBody) as Record<string, unknown>;
      const { http, storage, file, email, ...fields } = submitted;
      return Response.json({
        descriptorSha256: await digest(utf8(canonicalJson({
          ...fields,
          origins: {
            http: http ?? null,
            storage: storage ?? null,
            file: file ?? null,
            email: email ?? null,
          },
        }))),
      }, { status: 201 });
    }
    if (/\/reports$/u.test(path)) {
      const previous = this.terminalReports.get(path);
      if (previous !== undefined && previous !== requestBody) {
        return Response.json({ error: "immutable_report_conflict" }, { status: 409 });
      }
      this.terminalReports.set(path, requestBody);
      return Response.json({ ok: true }, { status: previous === undefined ? 201 : 200 });
    }
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("SMBC Direct R2 importer", () => {
  test("preserves a complete source run and links transformed payloads to raw inputs", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 2);
    const central = new FakeCentral();
    const result = await importRun(bucket, central);
    expect(result).toMatchObject({
      source: "smbc-direct",
      status: "sealed",
      artifactCount: manifest.artifacts.length + 1,
      sealed: true,
      finalChunkAllObjectsReused: false,
    });
    const create = JSON.parse(
      central.requests.find((request) => request.path === "/v1/runs")!.body,
    );
    expect(create).toEqual({
      producerId: "collector-r2-importer",
      sourceId: "smbc-bank",
      externalIdNamespace: "smbc-direct-backfill-worker-poc-v1",
      externalSessionId: RUN_ID,
      sourceRunKey: "account-history-smbc-direct-r2-v1",
    });
    const descriptors = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    const normalized = descriptors.find((value) =>
      value.artifactKey === "transactions/20260101-20260131.normalized.json"
    )!;
    expect(normalized).toMatchObject({
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      lineageDisposition: "linked",
      relations: [{
        parentArtifactKey: "transactions/20260101-20260131.raw.json.sjis",
        relation: "input",
      }],
    });
    expect(descriptors.find((value) => value.artifactKey === "manifest.json"))
      .toMatchObject({ artifactRole: "collector_manifest", fetchUnitId: null });
    const unitReport = JSON.parse(
      central.requests.find((request) => request.path === "/v1/units/10/reports")!.body,
    );
    expect(unitReport).toMatchObject({
      declaredArtifactCount: manifest.artifacts.length,
      artifactCountScope: "direct",
    });
    expect(JSON.stringify(descriptors)).not.toContain(PREFIX);
    expect(JSON.stringify(descriptors)).not.toContain("1234");
  });

  test("defers a full historical run before creating central state", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 6);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toEqual({
      source: "smbc-direct",
      manifestKey: MANIFEST_KEY,
      status: "deferred",
      reason: "worker_invocation_limit",
      artifactCount: manifest.artifacts.length + 1,
      nextOffset: 0,
    });
    expect(central.requests).toHaveLength(0);
  });

  test("resumes in bounded ten-object chunks and replays idempotently", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 6);
    const central = new FakeCentral();
    const first = await importRun(bucket, central, { immediate: false });
    expect(first).toMatchObject({
      status: "deferred",
      nextOffset: SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
    });
    expect(central.requests.filter((request) => request.method === "PUT")).toHaveLength(10);
    const second = await importRun(bucket, central, {
      immediate: false,
      offset: SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
    });
    expect(second).toMatchObject({ status: "sealed", sealed: true });
    const uploadedCount = central.uploaded.size;
    await importRun(bucket, central, { immediate: false });
    const replay = await importRun(bucket, central, {
      immediate: false,
      offset: SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
    });
    expect(replay).toMatchObject({
      status: "sealed",
      finalChunkAllObjectsReused: true,
    });
    expect(central.uploaded.size).toBe(uploadedCount);
    expect(manifest.artifacts.length + 1).toBe(15);
  });

  test("replays immutable terminal reports across importer deployments", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket, 6);
    const central = new FakeCentral();
    await importRun(bucket, central, { immediate: false, importerVersion: "deploy-a" });
    await expect(importRun(bucket, central, {
      immediate: false,
      offset: SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
      importerVersion: "deploy-a",
    })).resolves.toMatchObject({ status: "sealed" });

    await importRun(bucket, central, { immediate: false, importerVersion: "deploy-b" });
    await expect(importRun(bucket, central, {
      immediate: false,
      offset: SMBC_DIRECT_TRANSFER_CHUNK_SIZE,
      importerVersion: "deploy-b",
    })).resolves.toMatchObject({ status: "sealed", finalChunkAllObjectsReused: true });

    expect(central.terminalReports.size).toBe(2);
    const runReport = JSON.parse(central.terminalReports.get("/v1/runs/1/reports")!);
    expect(runReport.producerVersion).toBe("smbc-direct-r2-v1");
  });

  test("accepts the collector's exact partial complement with one raw orphan", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 3);
    const omitted = manifest.artifacts.pop()!;
    bucket.objects.delete(omitted.key);
    manifest.completedChunks = 2;
    manifest.transactionCount = 2;
    manifest.status = "partial";
    manifest.failureCodes = ["transactions_body_missing"];
    manifest.logoutSucceeded = true;
    await replaceManifest(bucket, manifest);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      status: "sealed",
      artifactCount: manifest.artifacts.length + 1,
    });
  });

  test("rejects a missing pair, an unexplained object, and normalized drift", async () => {
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 2);
      const missing = manifest.artifacts.find((artifact) =>
        artifact.dataset === "transactions-normalized"
      )!;
      bucket.objects.delete(missing.key);
      manifest.artifacts = manifest.artifacts.filter((artifact) => artifact !== missing);
      await replaceManifest(bucket, manifest);
      await expectRejected(bucket, "manifest_failure_complement_mismatch");
    }
    {
      const bucket = new FakeBucket();
      await storeSuccessRun(bucket, 2);
      bucket.objects.set(PREFIX + "unexpected.json", stored(utf8("{}"), {}, JSON_MEDIA_TYPE));
      await expectRejected(bucket, "prefix_inventory_mismatch");
    }
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 2);
      const normalized = manifest.artifacts.find((artifact) =>
        artifact.dataset === "transactions-normalized"
      )!;
      const value = JSON.parse(
        new TextDecoder().decode(bucket.objects.get(normalized.key)!.body),
      ) as { depositsTotal: number };
      value.depositsTotal += 1;
      await replaceArtifact(bucket, manifest, normalized, utf8(JSON.stringify(value)));
      await expectRejected(bucket, "transactions_payload_mismatch");
    }
  });

  test("rejects a transaction artifact unless the balance pair is complete", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 1);
    for (const artifact of manifest.artifacts.filter((candidate) =>
      candidate.dataset.startsWith("balance-") || candidate.dataset === "transactions-normalized"
    )) {
      bucket.objects.delete(artifact.key);
    }
    manifest.artifacts = manifest.artifacts.filter((artifact) =>
      artifact.dataset === "transactions-raw"
    );
    manifest.completedChunks = 0;
    manifest.transactionCount = 0;
    manifest.status = "failed";
    manifest.failureCodes = ["transactions_body_missing"];
    manifest.logoutSucceeded = false;
    await replaceManifest(bucket, manifest);
    await expectRejected(bucket, "manifest_balance_complement_mismatch");
  });

  test("closes raw transaction counts and observed provider flags", async () => {
    for (const [field, value, code] of [
      ["accntHstCount", "2", "transactions_raw_count_mismatch"],
      ["shoukaiServerStopFlag", "1", "transactions_raw_stop_flag_invalid"],
    ] as const) {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      const raw = manifest.artifacts.find((artifact) => artifact.dataset === "transactions-raw")!;
      const payload = rawTransactionPayload(bucket, raw);
      (payload.response as Record<string, unknown>)[field] = value;
      await replaceArtifact(bucket, manifest, raw, shiftJis(JSON.stringify(payload)));
      await expectRejected(bucket, code);
    }

    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 1);
    const raw = manifest.artifacts.find((artifact) => artifact.dataset === "transactions-raw")!;
    const payload = rawTransactionPayload(bucket, raw);
    const rows = (payload.response as { meisai: Array<Record<string, unknown>> }).meisai;
    rows[0]!.depositWithdrawTypeFlag = "9";
    await replaceArtifact(bucket, manifest, raw, shiftJis(JSON.stringify(payload)));
    await expectRejected(bucket, "transactions_raw_direction_invalid");
  });

  test("rejects collector failure codes outside the observed fixed vocabulary", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 1);
    manifest.status = "partial";
    manifest.failureCodes = ["arbitrary_safe_code"];
    await replaceManifest(bucket, manifest);
    await expectRejected(bucket, "manifest_failure_codes_invalid");
  });

  test("rejects unaligned, terminal, and direct-mode transfer offsets before central writes", async () => {
    for (const options of [
      { immediate: false, offset: 1 },
      { immediate: false, offset: 10 },
      { immediate: true, offset: 10 },
    ]) {
      const bucket = new FakeBucket();
      await storeSuccessRun(bucket, options.offset === 10 ? 3 : 1);
      const central = new FakeCentral();
      await expect(importRun(bucket, central, options)).rejects.toMatchObject({
        code: "transfer_offset_invalid",
      });
      expect(central.requests).toHaveLength(0);
    }
  });

  test("requires declared, custom, native and recomputed hashes to agree", async () => {
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      const artifact = manifest.artifacts[0]!;
      bucket.objects.get(artifact.key)!.customMetadata.sha256 = "0".repeat(64);
      await expectRejected(bucket, "artifact_metadata_mismatch");
    }
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      const artifact = manifest.artifacts[0]!;
      bucket.objects.get(artifact.key)!.nativeSha256 = "0".repeat(64);
      await expectRejected(bucket, "native_sha256_mismatch");
    }
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      const artifact = manifest.artifacts[0]!;
      const body = bucket.objects.get(artifact.key)!.body;
      body[0] = (body[0] ?? 0) ^ 1;
      await expectRejected(bucket, "artifact_checksum_mismatch");
    }
  });

  test("rejects running manifests and unknown provider fields", async () => {
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      manifest.status = "running";
      manifest.completedAt = null;
      manifest.logoutSucceeded = null;
      await replaceManifest(bucket, manifest);
      await expectRejected(bucket, "manifest_not_terminal");
    }
    {
      const bucket = new FakeBucket();
      const manifest = await storeSuccessRun(bucket, 1);
      const raw = manifest.artifacts.find((artifact) => artifact.dataset === "transactions-raw")!;
      const value = JSON.parse(
        new TextDecoder("shift_jis").decode(bucket.objects.get(raw.key)!.body),
      ) as Record<string, unknown>;
      value.credential = "must-not-pass";
      await replaceArtifact(bucket, manifest, raw, shiftJis(JSON.stringify(value)));
      await expectRejected(bucket, "transactions_raw_shape_invalid");
    }
  });

  test("manifest parser rejects path identity and unknown fields", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeSuccessRun(bucket, 1);
    const value = { ...manifest, extra: true };
    expect(() => parseSmbcDirectManifest(utf8(JSON.stringify(value)), MANIFEST_KEY))
      .toThrow("manifest_shape_invalid");
    expect(() => parseSmbcDirectManifest(
      utf8(JSON.stringify({ ...manifest, runId: crypto.randomUUID() })),
      MANIFEST_KEY,
    )).toThrow("manifest_identity_mismatch");
  });
});

async function storeSuccessRun(bucket: FakeBucket, monthCount: number): Promise<TestManifest> {
  const ranges = monthRanges(monthCount);
  const artifacts: TestArtifact[] = [];
  await addArtifact(bucket, artifacts, {
    dataset: "balance-raw",
    key: PREFIX + "balance.raw.json.sjis",
    mediaType: RAW_MEDIA_TYPE,
    body: rawBalance(),
  });
  await addArtifact(bucket, artifacts, {
    dataset: "balance-normalized",
    key: PREFIX + "balance.normalized.json",
    mediaType: JSON_MEDIA_TYPE,
    body: utf8(JSON.stringify({
      observedAt: "2026-09-05T00:00:00.000Z",
      currency: "JPY",
      amount: 1234,
    })),
  });
  for (const [index, range] of ranges.entries()) {
    const rawKey = PREFIX + "transactions/" + compact(range.start) + "-" +
      compact(range.end) + ".raw.json.sjis";
    const normalizedKey = PREFIX + "transactions/" + compact(range.start) + "-" +
      compact(range.end) + ".normalized.json";
    await addArtifact(bucket, artifacts, {
      dataset: "transactions-raw",
      key: rawKey,
      mediaType: RAW_MEDIA_TYPE,
      range,
      transactionCount: 1,
      body: rawTransactions(range, index),
    });
    await addArtifact(bucket, artifacts, {
      dataset: "transactions-normalized",
      key: normalizedKey,
      mediaType: JSON_MEDIA_TYPE,
      range,
      transactionCount: 1,
      body: normalizedTransactions(range, index),
    });
  }
  const manifest: TestManifest = {
    schemaVersion: "smbc-direct-backfill-worker-poc-v1",
    source: "smbc-direct",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:10:00.000Z",
    status: "success",
    requestedRange: { start: ranges[0]!.start, end: ranges.at(-1)!.end },
    completedChunks: ranges.length,
    totalChunks: ranges.length,
    transactionCount: ranges.length,
    artifacts,
    failureCodes: [],
    logoutSucceeded: true,
  };
  await replaceManifest(bucket, manifest);
  return manifest;
}

async function addArtifact(
  bucket: FakeBucket,
  artifacts: TestArtifact[],
  input: {
    dataset: string;
    key: string;
    mediaType: string;
    body: Uint8Array;
    range?: { start: string; end: string };
    transactionCount?: number;
  },
): Promise<void> {
  const sha256 = await digest(input.body);
  bucket.objects.set(input.key, stored(input.body, { sha256 }, input.mediaType));
  artifacts.push({
    dataset: input.dataset,
    key: input.key,
    mediaType: input.mediaType,
    bytes: input.body.byteLength,
    sha256,
    ...(input.range ? { range: input.range } : {}),
    ...(input.transactionCount === undefined ? {} : { transactionCount: input.transactionCount }),
  });
}

async function replaceArtifact(
  bucket: FakeBucket,
  manifest: TestManifest,
  artifact: TestArtifact,
  body: Uint8Array,
): Promise<void> {
  const sha256 = await digest(body);
  bucket.objects.set(artifact.key, stored(body, { sha256 }, artifact.mediaType));
  artifact.bytes = body.byteLength;
  artifact.sha256 = sha256;
  await replaceManifest(bucket, manifest);
}

async function replaceManifest(bucket: FakeBucket, manifest: TestManifest): Promise<void> {
  const body = utf8(JSON.stringify(manifest));
  const sha256 = await digest(body);
  bucket.objects.set(MANIFEST_KEY, stored(body, { sha256 }, JSON_MEDIA_TYPE));
}

function rawBalance(): Uint8Array {
  const response = Object.fromEntries(BALANCE_KEYS.map((key) => [key, ""]));
  response.ajaxSavingAccountBalance = "￥1,234";
  return shiftJis(JSON.stringify({ success: true, response }));
}

function rawTransactions(range: { start: string; end: string }, index: number): Uint8Array {
  const date = range.start;
  const displayDate = Number(date.slice(5, 7)) + "月" + Number(date.slice(8, 10)) + "日";
  return shiftJis(JSON.stringify({
    success: true,
    response: {
      accntHstCount: "1",
      currentDate: compact(range.end),
      mEndYmd: japaneseDate(range.end),
      mStartYmd: japaneseDate(range.start),
      meisai: [{
        amount: "100",
        comment: "テスト",
        depositWithdrawTypeFlag: index % 2 === 0 ? "1" : "2",
        detailIndex: "0",
        dispDate: displayDate,
        meisaiColorDisp: "",
        meisaiId: "fixture-" + index,
        meisaiMemoDisp: "",
        torihikigobalance: "1,000",
      }],
      nyukinGoukei: index % 2 === 0 ? "0" : "100",
      shoukaiServerStopFlag: "0",
      syukkinGoukei: index % 2 === 0 ? "100" : "0",
    },
  }));
}

function rawTransactionPayload(
  bucket: FakeBucket,
  artifact: TestArtifact,
): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder("shift_jis").decode(bucket.objects.get(artifact.key)!.body),
  ) as Record<string, unknown>;
}

function normalizedTransactions(
  range: { start: string; end: string },
  index: number,
): Uint8Array {
  return utf8(JSON.stringify({
    range,
    depositsTotal: index % 2 === 0 ? 0 : 100,
    withdrawalsTotal: index % 2 === 0 ? 100 : 0,
    transactions: [{
      id: "fixture-" + index,
      date: range.start + "T00:00:00+09:00",
      amount: 100,
      balanceAfter: 1000,
      description: "テスト",
      direction: index % 2 === 0 ? "debit" : "credit",
    }],
  }));
}

function monthRanges(count: number): Array<{ start: string; end: string }> {
  return Array.from({ length: count }, (_, index) => {
    const startDate = new Date(Date.UTC(2026, index, 1));
    const next = new Date(Date.UTC(2026, index + 1, 1));
    return {
      start: startDate.toISOString().slice(0, 10),
      end: new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10),
    };
  });
}

function importRun(
  bucket: FakeBucket,
  central: FakeCentral,
  options: { offset?: number; immediate?: boolean; importerVersion?: string } = {},
) {
  const { importerVersion = "test-v1", ...runOptions } = options;
  return importSmbcDirectRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion,
    manifestKey: MANIFEST_KEY,
    ...runOptions,
  });
}

async function expectRejected(bucket: FakeBucket, code: string): Promise<void> {
  const central = new FakeCentral();
  await expect(importRun(bucket, central, { immediate: false })).rejects.toMatchObject({ code });
  expect(central.requests).toHaveLength(0);
}

function stored(
  body: Uint8Array,
  customMetadata: Record<string, string>,
  contentType: string,
): StoredObject {
  return { body, customMetadata, contentType };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function shiftJis(value: string): Uint8Array {
  return new Uint8Array(encodeLegacy(value, "shift_jis"));
}

function compact(value: string): string {
  return value.replaceAll("-", "");
}

function japaneseDate(value: string): string {
  return `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...result].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}
