import { describe, expect, test } from "bun:test";
import { decode as iconvDecode, encode } from "iconv-lite";

const decode = (input: Uint8Array, encoding = "utf-8"): string => iconvDecode(input, encoding);
import {
  importMobileSuicaRun,
  parseHistoryRows,
  parseMobileSuicaManifest,
  sanitizeHistoryHtml,
} from "../src/mobile-suica";
import { sanitizeHistoryHtml as sanitizeCollectorHistoryHtml } from "../../../poc/mobile-suica-worker/src/sanitize";
import { storeManifest as storeCollectorManifest } from "../../../poc/mobile-suica-worker/src/storage";
import type { CollectionManifest } from "../../../poc/mobile-suica-worker/src/types";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/mobile-suica/2026/09/05/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-mobile-suica.${"m".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);
const SENTINEL = "__KOGANE_REDACTED_BASE_VARIABLE__";

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256?: string;
}

interface TestManifest {
  schemaVersion: string;
  source: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  asOfDateJst: string;
  capturedSessionAt: string;
  transactionCount: number;
  pageCount: number;
  complete?: boolean;
  artifacts: Array<{ dataset: string; key: string; mediaType: string; sha256: string; bytes: number }>;
  failures: Array<Record<string, unknown>>;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: string | Uint8Array,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {},
  ): Promise<void> {
    const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.objects.set(key, stored(
      body,
      options.customMetadata ?? {},
      options.httpMetadata?.contentType ?? "application/octet-stream",
    ));
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.body.byteLength,
      customMetadata: value.customMetadata,
      httpMetadata: { contentType: value.contentType },
      checksums: value.nativeSha256 ? { sha256: hexBytes(value.nativeSha256).buffer } : {},
      arrayBuffer: async () => ownedArrayBuffer(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    return {
      objects: [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? ""))
        .sort().map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Map<string, Uint8Array>();
  private pageGroupDeclared = false;
  private pageGroupArtifactCount = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const reused = this.uploaded.has(path);
      this.uploaded.set(path, bytes);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) return Response.json({ unitId: 10 }, { status: 201 });
    if (path.endsWith("/page-groups")) {
      this.pageGroupDeclared = true;
      return Response.json({ pageGroupId: 20 }, { status: 201 });
    }
    if (path.endsWith("/artifacts")) {
      const descriptor = JSON.parse(body) as Record<string, unknown>;
      if (descriptor.pageGroupId === 20) this.pageGroupArtifactCount += 1;
      return Response.json({ descriptorSha256: "1".repeat(64) }, { status: 201 });
    }
    if (path.endsWith("/seal")) {
      if (this.pageGroupDeclared && this.pageGroupArtifactCount !== 1) {
        return Response.json({ error: "page_group_artifact_count_mismatch" }, { status: 409 });
      }
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("Mobile Suica R2 importer", () => {
  test("sanitizes one legacy CP932 hidden value deterministically", () => {
    const source = historyHtml("opaque-session-value", 1);
    const first = sanitizeHistoryHtml(source, "mobile-suica-worker-poc-v1");
    const second = sanitizeHistoryHtml(source, "mobile-suica-worker-poc-v1");
    expect(first).toEqual(second);
    expect(decode(first, "shift_jis")).toContain(`value="${SENTINEL}"`);
    expect(decode(first, "shift_jis")).not.toContain("opaque-session-value");
    expect(decode(first, "shift_jis")).toContain("物販");
  });

  test("rejects absent, duplicate, empty, and pre-redacted legacy baseVariable", () => {
    const cases = [
      encode("<html><input name=\"other\" value=\"x\"></html>", "shift_jis"),
      encode(`<input type="hidden" name="baseVariable" value="x"><input type="hidden" name="baseVariable" value="y">`, "shift_jis"),
      encode("<input type=\"hidden\" name=\"baseVariable\" value=\"\">", "shift_jis"),
      historyHtml(SENTINEL, 1),
    ];
    for (const value of cases) {
      expect(() => sanitizeHistoryHtml(new Uint8Array(value), "mobile-suica-worker-poc-v1")).toThrow();
    }
  });

  test("rejects duplicate baseVariable attributes and incomplete legacy redaction", () => {
    const invalidV1 = [
      `<input type="hidden" name="baseVariable" value="first-secret" value="second-secret">`,
      `<input type="hidden" type="text" name="baseVariable" value="first-secret">`,
      `<input type="hidden" name="baseVariable" name="other" value="first-secret">`,
      `<input type="hidden" name="baseVariable" value="first-secret">first-secret`,
    ];
    for (const html of invalidV1) {
      expect(() => sanitizeHistoryHtml(new Uint8Array(encode(html, "shift_jis")), "mobile-suica-worker-poc-v1"))
        .toThrow();
    }
    const invalidV2 = [
      `<input type="hidden" name="baseVariable" value="${SENTINEL}" value="second-secret">`,
      `<input type="hidden" type="text" name="baseVariable" value="${SENTINEL}">`,
      `<input type="hidden" name="baseVariable" name="other" value="${SENTINEL}">`,
    ];
    for (const html of invalidV2) {
      expect(() => sanitizeHistoryHtml(new Uint8Array(encode(html, "shift_jis")), "mobile-suica-worker-poc-v2"))
        .toThrow();
    }
  });

  test("accepts every collector-produced casing and unquoted baseVariable form", () => {
    const providerForms = [
      `<input TYPE=hidden NAME=BASEVARIABLE VALUE=short-lived-provider-state>`,
      `<input type='HIDDEN' name='BaseVariable' value='short-lived-provider-state'>`,
      `<input type="hidden" name="baseVariable" value="short-lived-provider-state">`,
    ];
    for (const html of providerForms) {
      const collectorBytes = new Uint8Array(sanitizeCollectorHistoryHtml(html));
      expect(() => sanitizeHistoryHtml(collectorBytes, "mobile-suica-worker-poc-v2")).not.toThrow();
      expect(decode(collectorBytes, "shift_jis")).toContain(SENTINEL);
    }
  });

  test("rejects a v2 HTML artifact with an incomplete CP932 lead byte", () => {
    const valid = historyHtml(SENTINEL, 1);
    const malformed = new Uint8Array(valid.byteLength + 1);
    malformed.set(valid);
    malformed[valid.byteLength] = 0x82;
    expect(() => sanitizeHistoryHtml(malformed, "mobile-suica-worker-poc-v2"))
      .toThrow("html_cp932_round_trip_failed");
  });

  test("imports legacy v1 without copying baseVariable or free failure text", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, { version: 1, rows: 1 });
    const central = new FakeCentral();
    const result = await importRun(bucket, central);
    expect(result).toMatchObject({
      source: "mobile-suica",
      status: "sealed",
      artifactCount: 4,
      sealed: true,
      finalChunkAllObjectsReused: false,
    });
    expect(central.requests).toHaveLength(15);
    const allCentralText = [...central.uploaded.values()].map((value) => decode(value, "shift_jis")).join("\n");
    expect(allCentralText).not.toContain("opaque-session-value");
    const descriptors = central.requests.filter((request) => request.path.endsWith("/artifacts"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(descriptors.find((value) => value.dataset === "sf-history-html")).toMatchObject({
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
      declaredMediaType: "text/html",
      pageGroupId: 20,
      pageIndex: 0,
    });
    expect(descriptors.find((value) => value.dataset === "sf-history")).toMatchObject({
      artifactRole: "collector_derived",
      lineageDisposition: "linked",
      relations: [{ parentArtifactKey: "sf-history-page-0001.html", relation: "input" }],
    });
    const run = JSON.parse(central.requests.find((request) => request.path === "/v1/runs")!.body);
    expect(run).toEqual({
      producerId: "collector-r2-importer",
      sourceId: "mobile-suica",
      externalIdNamespace: "mobile-suica-worker-poc-v1",
      externalSessionId: RUN_ID,
      sourceRunKey: "sf-history-mobile-suica-r2-v1",
    });
  });

  test("accepts the exact v2 manifest serialized by the live collector", async () => {
    const bucket = new FakeBucket();
    const fixture = await storeRun(bucket, { version: 2, rows: 1 });
    bucket.objects.delete(MANIFEST_KEY);
    const manifest: CollectionManifest = {
      schemaVersion: "mobile-suica-worker-poc-v2",
      source: "mobile-suica",
      runId: fixture.runId,
      startedAt: fixture.startedAt,
      completedAt: fixture.completedAt,
      status: "success",
      asOfDateJst: fixture.asOfDateJst,
      capturedSessionAt: fixture.capturedSessionAt,
      transactionCount: fixture.transactionCount,
      pageCount: fixture.pageCount,
      complete: true,
      artifacts: fixture.artifacts,
      failures: [],
    };
    await storeCollectorManifest({
      bucket: bucket as unknown as R2Bucket,
      prefix: PREFIX.slice(0, -1),
      manifest,
    });
    expect(JSON.parse(decode(bucket.objects.get(MANIFEST_KEY)!.body))).toMatchObject({ complete: true });
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ status: "sealed" });
  });

  test("accepts a pre-run browser capture for v1 and v2 but rejects one after completion", async () => {
    for (const version of [1, 2] as const) {
      const bucket = new FakeBucket();
      const manifest = await storeRun(bucket, { version, rows: 1 });
      manifest.capturedSessionAt = "2026-09-04T23:36:27.538Z";
      const summary = JSON.parse(decode(bucket.objects.get(`${PREFIX}collection-summary.json`)!.body));
      summary.capturedSessionAt = manifest.capturedSessionAt;
      await replaceArtifact(
        bucket,
        manifest,
        "collection-summary",
        new TextEncoder().encode(JSON.stringify(summary)),
        version,
      );
      await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ status: "sealed" });

      const future = new FakeBucket();
      const futureManifest = await storeRun(future, { version, rows: 1 });
      futureManifest.capturedSessionAt = "2026-09-05T00:01:00.001Z";
      await replaceManifest(future, futureManifest, version);
      const central = new FakeCentral();
      await expect(importRun(future, central)).rejects.toMatchObject({ code: "manifest_captured_at_invalid" });
      expect(central.requests).toHaveLength(0);
    }
  });

  test("accepts a v2 one-page 100-row boundary only as explicit partial evidence", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, { version: 2, rows: 100, boundary: true });
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({ artifactCount: 4, sealed: true });
    const report = central.requests.find((request) => request.path === "/v1/units/10/reports")!;
    expect(JSON.parse(report.body)).toMatchObject({
      producerStatus: "partial",
      normalizedOutcome: "partial",
      safeFailureCode: "history-boundary-unproven",
    });
    const manifestDescriptor = central.requests.filter((request) => request.path.endsWith("/artifacts"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((value) => value.dataset === "collector-manifest");
    expect(manifestDescriptor).toMatchObject({
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
      lineageDisposition: "not_applicable",
    });
  });

  test("rejects v1 100-row success and any multi-page declaration before central state", async () => {
    const boundary = new FakeBucket();
    await storeRun(boundary, { version: 1, rows: 100 });
    const firstCentral = new FakeCentral();
    await expect(importRun(boundary, firstCentral)).rejects.toMatchObject({ code: "history_boundary_unproven" });
    expect(firstCentral.requests).toHaveLength(0);

    const multi = new FakeBucket();
    await storeRun(multi, { version: 1, rows: 1 });
    const manifest = readManifest(multi);
    manifest.pageCount = 2;
    await replaceManifest(multi, manifest, 1);
    const secondCentral = new FakeCentral();
    await expect(importRun(multi, secondCentral)).rejects.toMatchObject({ code: "manifest_page_count_invalid" });
    expect(secondCentral.requests).toHaveLength(0);
  });

  test("accepts zero rows only with the history page marker", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, { version: 2, rows: 0 });
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ sealed: true });
    const html = bucket.objects.get(`${PREFIX}sf-history-page-0001.html`)!;
    html.body = new Uint8Array(encode("<html></html>", "shift_jis"));
    const manifest = readManifest(bucket);
    await replaceArtifact(bucket, manifest, "sf-history-html", html.body, 2);
    await expect(importRun(bucket, new FakeCentral())).rejects.toMatchObject({ code: "html_base_variable_invalid" });
  });

  test("validates v2 R2 failure artifact complement and rejects unredacted v2 bytes", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, { version: 2, rows: 1, omitSummary: true });
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ artifactCount: 3, sealed: true });
    const wrong = readManifest(bucket);
    wrong.failures[0]!.artifactKey = "sf-history.json";
    await replaceManifest(bucket, wrong, 2);
    expect(() => parseMobileSuicaManifest(bucket.objects.get(MANIFEST_KEY)!.body, MANIFEST_KEY))
      .toThrow("manifest_failure_complement_mismatch");

    const unsafe = new FakeBucket();
    await storeRun(unsafe, { version: 2, rows: 1 });
    const unsafeManifest = readManifest(unsafe);
    await replaceArtifact(unsafe, unsafeManifest, "sf-history-html", historyHtml("not-redacted", 1), 2);
    await expect(importRun(unsafe, new FakeCentral())).rejects.toMatchObject({ code: "html_base_variable_not_redacted" });
  });

  test("seals v1 and v2 partial runs when normalized survives an HTML R2 failure", async () => {
    for (const version of [1, 2] as const) {
      const bucket = new FakeBucket();
      await storeRun(bucket, { version, rows: 2, missing: ["sf-history-html"] });
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).resolves.toMatchObject({
        status: "sealed",
        artifactCount: 3,
        sealed: true,
      });
      const normalizedDescriptor = central.requests.filter((request) => request.path.endsWith("/artifacts"))
        .map((request) => JSON.parse(request.body) as Record<string, unknown>)
        .find((value) => value.dataset === "sf-history");
      expect(normalizedDescriptor).toMatchObject({
        artifactRole: "collector_derived",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
      });
      expect(normalizedDescriptor).not.toHaveProperty("relations");
      expect(central.requests.some((request) => request.path.endsWith("/page-groups"))).toBe(false);
    }
  });

  test("seals v1 and boundary-limited v2 manifest-only failed runs", async () => {
    const cases = [
      { version: 1 as const, rows: 2, boundary: false },
      { version: 2 as const, rows: 100, boundary: true },
    ];
    for (const value of cases) {
      const bucket = new FakeBucket();
      await storeRun(bucket, {
        version: value.version,
        rows: value.rows,
        boundary: value.boundary,
        missing: ["sf-history-html", "sf-history", "collection-summary"],
      });
      const manifest = readManifest(bucket);
      expect(manifest.status).toBe("failed");
      expect(manifest.failures.filter((failure) =>
        typeof failure.operation === "string" && (failure.operation === "r2" || failure.operation.startsWith("r2:"))
      )).toHaveLength(3);
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).resolves.toMatchObject({ artifactCount: 1, sealed: true });
      expect(central.requests.some((request) => request.path.endsWith("/page-groups"))).toBe(false);
    }
  });

  test("rejects forged terminal status for v1 and v2 before central state", async () => {
    for (const version of [1, 2] as const) {
      const bucket = new FakeBucket();
      const manifest = await storeRun(bucket, { version, rows: 1 });
      manifest.status = "partial";
      await replaceManifest(bucket, manifest, version);
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).rejects.toMatchObject({ code: "manifest_status_mismatch" });
      expect(central.requests).toHaveLength(0);
    }
  });

  test("strictly validates normalized dates without an HTML artifact", async () => {
    for (const dates of [["2026-09-06", "2026-09-04"], ["2026-09-04", "2026-09-05"], ["2026-02-30", "2026-02-28"]]) {
      const bucket = new FakeBucket();
      const manifest = await storeRun(bucket, { version: 2, rows: 2, missing: ["sf-history-html"] });
      const normalized = JSON.parse(decode(bucket.objects.get(`${PREFIX}sf-history.json`)!.body));
      normalized.rows[0].date = dates[0];
      normalized.rows[1].date = dates[1];
      await replaceArtifact(bucket, manifest, "sf-history", new TextEncoder().encode(JSON.stringify(normalized)), 2);
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).rejects.toBeDefined();
      expect(central.requests).toHaveLength(0);
    }
  });

  test("rejects checksum, metadata, semantic, and date-order mismatches before central state", async () => {
    for (const mutation of ["metadata", "checksum", "semantic", "order"] as const) {
      const bucket = new FakeBucket();
      await storeRun(bucket, { version: 2, rows: mutation === "order" ? 2 : 1 });
      const manifest = readManifest(bucket);
      if (mutation === "metadata") {
        bucket.objects.get(manifest.artifacts[0]!.key)!.customMetadata.extra = "x";
      } else if (mutation === "checksum") {
        const body = bucket.objects.get(manifest.artifacts[0]!.key)!.body;
        body[0] = body[0]! ^ 1;
      } else if (mutation === "semantic") {
        const normalized = JSON.parse(decode(bucket.objects.get(`${PREFIX}sf-history.json`)!.body));
        normalized.rows[0].amount = -999;
        await replaceArtifact(bucket, manifest, "sf-history", new TextEncoder().encode(JSON.stringify(normalized)), 2);
      } else {
        const normalized = JSON.parse(decode(bucket.objects.get(`${PREFIX}sf-history.json`)!.body));
        normalized.rows[1].date = "2026-09-06";
        await replaceArtifact(bucket, manifest, "sf-history", new TextEncoder().encode(JSON.stringify(normalized)), 2);
      }
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).rejects.toBeDefined();
      expect(central.requests).toHaveLength(0);
    }
  });

  test("rejects another collector credential", async () => {
    const bucket = new FakeBucket();
    await storeRun(bucket, { version: 2, rows: 1 });
    await expect(importMobileSuicaRun({
      bucket: bucket as unknown as R2Bucket,
      centralService: new FakeCentral() as unknown as Fetcher,
      centralToken: `collector-r2-sbi.${"s".repeat(32)}`,
      fingerprintKey: FINGERPRINT_KEY,
      importerVersion: "test-v1",
      manifestKey: MANIFEST_KEY,
    })).rejects.toThrow("central_auth_configuration_invalid");
  });
});

async function storeRun(bucket: FakeBucket, options: {
  version: 1 | 2;
  rows: number;
  boundary?: boolean;
  omitSummary?: boolean;
  missing?: Array<"sf-history-html" | "sf-history" | "collection-summary">;
}): Promise<TestManifest> {
  const htmlBody = historyHtml(options.version === 1 ? "opaque-session-value" : SENTINEL, options.rows);
  const htmlRows = parseHistoryRows(decode(htmlBody, "shift_jis"), "2026-09-05");
  const complete = options.rows < 100;
  const normalized = {
    asOfDateJst: "2026-09-05",
    pageCount: 1,
    transactionCount: options.rows,
    ...(options.version === 2 ? { complete } : {}),
    rows: htmlRows,
  };
  const summary = {
    asOfDateJst: "2026-09-05",
    pageCount: 1,
    transactionCount: options.rows,
    ...(options.version === 2 ? { complete } : {}),
    cookieNames: ["ASP.NET_SessionId", "TS0184138d", "sc_auth"],
    capturedSessionAt: "2026-09-05T00:00:10.000Z",
  };
  const missing = new Set(options.missing ?? (options.omitSummary ? ["collection-summary" as const] : []));
  const entries = [
    { dataset: "sf-history-html", filename: "sf-history-page-0001.html", mediaType: "text/html; charset=shift_jis", body: htmlBody },
    { dataset: "sf-history", filename: "sf-history.json", mediaType: "application/json", body: new TextEncoder().encode(JSON.stringify(normalized)) },
    { dataset: "collection-summary", filename: "collection-summary.json", mediaType: "application/json", body: new TextEncoder().encode(JSON.stringify(summary)) },
  ].filter((entry) => !missing.has(entry.dataset as "sf-history-html" | "sf-history" | "collection-summary"));
  const artifacts = [];
  for (const entry of entries) {
    const sha256 = await digest(entry.body);
    const key = `${PREFIX}${entry.filename}`;
    const metadata = options.version === 1
      ? { dataset: entry.dataset, sha256 }
      : { source: "mobile-suica", runId: RUN_ID, dataset: entry.dataset, sha256 };
    bucket.objects.set(key, stored(entry.body, metadata, entry.mediaType));
    artifacts.push({ dataset: entry.dataset, key, mediaType: entry.mediaType, sha256, bytes: entry.body.byteLength });
  }
  const artifactKey = {
    "sf-history-html": "sf-history-page-0001.html",
    "sf-history": "sf-history.json",
    "collection-summary": "collection-summary.json",
  } as const;
  const failures: Array<Record<string, unknown>> = [
    ...(options.boundary
      ? [{ operation: "pagination", errorType: "HistoryBoundaryUnproven", errorCode: "history_boundary_unproven" }]
      : []),
    ...[...missing].map((dataset) => options.version === 1
      ? { operation: `r2:${dataset}`, errorType: "Error", message: "write failed" }
      : { operation: "r2", errorType: "Error", errorCode: "artifact_store_failed", artifactKey: artifactKey[dataset] }),
  ];
  const manifest: TestManifest = {
    schemaVersion: `mobile-suica-worker-poc-v${options.version}`,
    source: "mobile-suica",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
    asOfDateJst: "2026-09-05",
    capturedSessionAt: "2026-09-05T00:00:10.000Z",
    transactionCount: options.rows,
    pageCount: 1,
    ...(options.version === 2 ? { complete } : {}),
    artifacts,
    failures,
  };
  await replaceManifest(bucket, manifest, options.version);
  return manifest;
}

function historyHtml(baseVariable: string, rows: number): Uint8Array {
  const body = Array.from({ length: rows }, (_value, index) => {
    const day = String(5 - Math.min(index, 4)).padStart(2, "0");
    return `<tr><td></td><td>09/${day}</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>`;
  }).join("");
  return new Uint8Array(encode(
    `<html><input type="hidden" name="baseVariable" value="${baseVariable}"><input name="specifyYearMonth" value="2026/09"><table>${body}</table></html>`,
    "shift_jis",
  ));
}

async function replaceArtifact(
  bucket: FakeBucket,
  manifest: TestManifest,
  dataset: string,
  body: Uint8Array,
  version: 1 | 2,
): Promise<void> {
  const artifact = manifest.artifacts.find((entry) => entry.dataset === dataset)!;
  const sha256 = await digest(body);
  artifact.sha256 = sha256;
  artifact.bytes = body.byteLength;
  const metadata = version === 1
    ? { dataset, sha256 }
    : { source: "mobile-suica", runId: RUN_ID, dataset, sha256 };
  bucket.objects.set(artifact.key, stored(body, metadata, artifact.mediaType));
  await replaceManifest(bucket, manifest, version);
}

async function replaceManifest(bucket: FakeBucket, manifest: TestManifest, version: 1 | 2): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const sha256 = await digest(body);
  const metadata = { source: "mobile-suica", status: manifest.status, runId: RUN_ID };
  bucket.objects.set(MANIFEST_KEY, stored(body, metadata, "application/json"));
}

function readManifest(bucket: FakeBucket): TestManifest {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body)) as TestManifest;
}

function importRun(bucket: FakeBucket, central: FakeCentral) {
  return importMobileSuicaRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "test-v1",
    manifestKey: MANIFEST_KEY,
  });
}

function stored(body: Uint8Array, customMetadata: Record<string, string>, contentType: string, nativeSha256?: string): StoredObject {
  return { body, customMetadata, contentType, ...(nativeSha256 ? { nativeSha256 } : {}) };
}

async function digest(body: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(body)));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
