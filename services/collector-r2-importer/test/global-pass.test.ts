import { describe, expect, test } from "bun:test";
import {
  importGlobalPassRun,
  parseGlobalPassManifest,
  sanitizeGlobalPassHtml,
} from "../src/global-pass";
import { sanitizeGlobalPassActivityHtml } from "../../../poc/globalpass-worker/src/sanitize";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/prestia-globalpass/2026/09/05/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-global-pass.${"g".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);
const SENTINEL = "__KOGANE_REDACTED_DYNAMIC_VALUE__";

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256?: string;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.body.byteLength,
      customMetadata: value.customMetadata,
      httpMetadata: { contentType: value.contentType },
      checksums: value.nativeSha256
        ? { sha256: hexBytes(value.nativeSha256).buffer }
        : {},
      arrayBuffer: async () => ownedArrayBuffer(value.body),
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
  readonly runIdsBySourceKey = new Map<string, number>();

  constructor(
    private readonly mutateParsedDescriptor?: (
      descriptor: Record<string, unknown>,
    ) => Record<string, unknown>,
  ) {}

  seedRun(sourceRunKey: string, runId: number): void {
    this.runIdsBySourceKey.set(sourceRunKey, runId);
  }

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
    if (path === "/v1/runs") {
      const sourceRunKey = String((JSON.parse(body) as Record<string, unknown>).sourceRunKey);
      let runId = this.runIdsBySourceKey.get(sourceRunKey);
      if (runId === undefined) {
        runId = Math.max(0, ...this.runIdsBySourceKey.values()) + 1;
        this.runIdsBySourceKey.set(sourceRunKey, runId);
      }
      return Response.json({ runId }, { status: 201 });
    }
    if (/\/units$/u.test(path)) return Response.json({ unitId: 10 }, { status: 201 });
    if (/\/inventories$/u.test(path)) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (/\/inventories\/20\/items$/u.test(path)) return Response.json({ ok: true }, { status: 201 });
    if (/\/artifacts$/u.test(path)) {
      const parsed = centralNormalizedDescriptor(JSON.parse(body));
      const descriptor = this.mutateParsedDescriptor?.(parsed) ?? parsed;
      return Response.json({ descriptorSha256: await normalizedDescriptorSha256(descriptor) }, {
        status: 201,
      });
    }
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("GLOBAL PASS R2 importer", () => {
  test("accepts both audited legacy HTML variants and preserves empty hidden values", () => {
    for (const html of [
      variantA(["one", "two", "three", "four", "", ""]),
      variantB(["one", "two", "three", ""]),
    ]) {
      const sanitized = decode(sanitizeGlobalPassHtml(
        encode(html),
        "globalpass-browser-poc-v1",
      ));
      expect(sanitized.match(new RegExp(SENTINEL, "gu")))
        .toHaveLength(html.includes("W131301.referenceDate") ? 4 : 3);
      expect(sanitized.match(/name="nablarch_hidden" value=""/gu))
        .toHaveLength(html.includes("W131301.referenceDate") ? 2 : 1);
    }
  });

  test("accepts only the audited English legacy activity headers for v1", () => {
    const html = variantA(["one", "two", "three", "four", "", ""])
      .replace("利用明細", "Account")
      .replace(
        '<table data-fixture="activity"><tbody></tbody></table>',
        legacyEnglishActivityTables(),
      )
      .replace("<body>", '<body><a href="/">Home</a>')
      .replace(
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
        "/p/statementInquiry/RW1313010301",
      )
      .replace(
        'onclick="click()"',
        'onclick="if (window.innerWidth &lt; 640) { $(this.parentNode).toggleClass(' +
          "'.open'); } else { $('.target')[0].click(); } return false;\"",
      );
    const output = decode(sanitizeGlobalPassHtml(
      encode(html),
      "globalpass-browser-poc-v1",
    ));
    expect(output).toContain('href="https://www.debit.vpass.ne.jp/"');
    expect(output).toContain(
      'action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"',
    );
    expect(() => sanitizeGlobalPassHtml(
      encode(html),
      "globalpass-browser-poc-v2",
    )).toThrow("html_activity_contract_invalid");
  });

  test("accepts an empty English legacy page only with audited artifact authorization", () => {
    const note = '<p class="textNotice"><span>&lt;Note&gt;<br>' +
      " - Transaction dates are showed in ascending order.<br></span></p>";
    const html = variantA(["one", "two", "three", "four", "", ""])
      .replace("利用明細", "Account")
      .replace('<table data-fixture="activity"><tbody></tbody></table>', note)
      .replace(
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
        "/p/statementInquiry/RW1313010301",
      );
    expect(() => sanitizeGlobalPassHtml(
      encode(html),
      "globalpass-browser-poc-v1",
    )).toThrow("html_activity_contract_invalid");
    expect(() => sanitizeGlobalPassHtml(
      encode(html),
      "globalpass-browser-poc-v1",
      true,
    )).not.toThrow();
    expect(() => sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v2", true))
      .toThrow("html_activity_contract_invalid");
  });

  test("does not accept legacy activity words outside the exact table header set", () => {
    const base = variantA(["one", "two", "three", "four", "", ""])
      .replace("利用明細", "Account");
    for (const marker of [
      `<!-- ${legacyEnglishActivityTables()} -->`,
      `<script>const marker = ${JSON.stringify(legacyEnglishActivityTables())};</script>`,
      '<input type="hidden" value="Transaction Date Transaction Detail Transaction Currency and Amount Transaction Fee">',
      `<table hidden>${legacyEnglishActivityTables()}</table>`,
      legacyEnglishActivityTables().replace("<th>", "<th hidden>"),
      `<div aria-hidden="true">${legacyEnglishActivityTables()}</div>`,
      `<table style="display: none !important">${legacyEnglishActivityTables()}</table>`,
      `<div style="visibility:hidden!important">${legacyEnglishActivityTables()}</div>`,
      "<th>Transaction Detail</th>",
    ]) {
      const html = base.replace("</body>", `${marker}</body>`);
      expect(() => sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v1"))
        .toThrow("html_activity_contract_invalid");
    }
  });

  test("rejects legacy relative navigation in canonical v2 HTML", () => {
    const canonical = canonicalV2(variantA([
      SENTINEL,
      SENTINEL,
      SENTINEL,
      SENTINEL,
      "",
      "",
    ]));
    for (const html of [
      canonical.replace("<body>", '<body><a href="/">Home</a>'),
      canonical.replace(
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
        "/p/statementInquiry/RW1313010301",
      ),
    ]) {
      expect(() => sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v2"))
        .toThrow("html_url_attribute_invalid");
    }
  });

  test("sanitizes legacy variant A and removes free-form manifest messages", async () => {
    const bucket = new FakeBucket();
    const originalHtml = variantA(["opaque-a", "opaque-b", "opaque-c", "opaque-d", "", ""]);
    const manifest = await storeRun(bucket, "v1", originalHtml);
    manifest.status = "partial";
    manifest.failures = [{
      operation: "r2:2026-08",
      errorType: "Error",
      message: "synthetic sensitive diagnostic must not be copied",
    }];
    manifest.availableMonths = ["2026-09", "2026-08"];
    await replaceManifest(bucket, manifest);

    const central = new FakeCentral();
    const result = await importRun(bucket, central);
    expect(result).toMatchObject({
      source: "prestia-globalpass",
      manifestKey: MANIFEST_KEY,
      status: "sealed",
      artifactCount: 2,
      sealed: true,
      finalChunkAllObjectsReused: false,
    });
    const uploadedText = [...central.uploaded.values()].map(decode).join("\n");
    expect(uploadedText).toContain(SENTINEL);
    expect(uploadedText).not.toContain("opaque-");
    expect(uploadedText).toContain('href="#"');
    expect(uploadedText).toContain('onclick="return false;"');
    expect(uploadedText).toContain('onchange="return false;"');
    expect(uploadedText).not.toContain("#activity");
    expect(uploadedText).not.toContain("sel_submit(this)");
    expect(uploadedText).not.toContain("synthetic sensitive diagnostic");
    expect(uploadedText).toContain("artifact_store_failed");
    const run = JSON.parse(central.requests.find((request) => request.path === "/v1/runs")!.body);
    expect(run).toEqual({
      producerId: "collector-r2-importer",
      sourceId: "global-pass",
      externalIdNamespace: "globalpass-browser-poc-v1",
      externalSessionId: RUN_ID,
      sourceRunKey: "activity-global-pass-r2-v2",
    });
    const descriptor = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((value) => value.dataset === "globalpass-activity")!;
    const uploadedHtml = [...central.uploaded.values()].find((value) =>
      decode(value).startsWith("<!doctype html"))!;
    expect(descriptor).toMatchObject({
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
      formatId: "global-pass-activity-html-utf8-sanitized",
      sha256: await sha256Hex(uploadedHtml),
      byteSize: uploadedHtml.byteLength,
      transformSteps: [
        {
          stepIndex: 0,
          stepKind: "redacted",
          transformerId: "global-pass-html-sanitizer",
          transformerVersion: "v1",
        },
        {
          stepIndex: 1,
          stepKind: "reencoded",
          transformerId: "global-pass-html-sanitizer",
          transformerVersion: "v1",
        },
      ],
    });
    expect(await sha256Hex(uploadedHtml)).not.toBe(await sha256Hex(encode(originalHtml)));

    const manifestDescriptor = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((value) => value.artifactKey === "manifest.json")!;
    expect(manifestDescriptor.fetchUnitId).toBeNull();

    const replay = await importRun(bucket, central);
    expect(replay.status).toBe("sealed");
    if (replay.status !== "sealed") throw new Error("expected sealed replay");
    expect(replay.finalChunkAllObjectsReused).toBe(true);
    expect(central.uploaded.size).toBe(2);
  });

  test("accepts already-sanitized v2 variant B without changing bytes", async () => {
    const bucket = new FakeBucket();
    const html = canonicalV2(variantB([SENTINEL, SENTINEL, SENTINEL, ""]));
    await storeRun(bucket, "v2", html);
    const output = sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v2");
    expect(output).toEqual(encode(html));
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({ sealed: true });
    expect([...central.uploaded.values()].some((value) => decode(value) === html)).toBe(true);
  });

  test("hashes the complete central-normalized descriptor and rejects normalized drift", async () => {
    const bucket = new FakeBucket();
    const html = canonicalV2(variantB([SENTINEL, SENTINEL, SENTINEL, ""]));
    await storeRun(bucket, "v2", html);

    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({ sealed: true });
    const descriptors = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(descriptors).toHaveLength(2);
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({
        pageGroupId: null,
        pageIndex: null,
        http: null,
        file: null,
        email: null,
        ranges: [],
        relations: [],
      });
    }

    const driftedCentral = new FakeCentral((descriptor) => ({
      ...descriptor,
      pageGroupId: 99,
      pageIndex: 0,
    }));
    await expect(importRun(bucket, driftedCentral))
      .rejects.toThrow("central_descriptor_mismatch");
  });

  test("accepts the producer sanitizer output as canonical v2 HTML", () => {
    const produced = sanitizeGlobalPassActivityHtml(
      variantA(["producer-a", "producer-b", "producer-c", "producer-d", "", ""]),
    );
    const imported = sanitizeGlobalPassHtml(encode(produced), "globalpass-browser-poc-v2");
    expect(decode(imported)).toBe(produced);
  });

  test("seals a legacy failed manifest-only run as failed evidence", async () => {
    const bucket = new FakeBucket();
    const manifest = baseManifest("v1", []);
    manifest.status = "failed";
    manifest.availableMonths = [];
    manifest.artifacts = [];
    manifest.failures = [{
      operation: "browser-collection",
      errorType: "Error",
      message: "synthetic diagnostic",
    }];
    await putManifest(bucket, manifest);
    const central = new FakeCentral();
    const result = await importRun(bucket, central);
    expect(result).toMatchObject({ artifactCount: 1, sealed: true });
    const unitReport = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path))!;
    expect(JSON.parse(unitReport.body)).toMatchObject({
      normalizedOutcome: "failed",
      declaredArtifactCount: 0,
      safeFailureCode: "browser-collection-failed",
    });
    const manifestDescriptor = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((value) => value.artifactKey === "manifest.json")!;
    expect(manifestDescriptor.fetchUnitId).toBeNull();
  });

  test("moves an invalid v1 central run to one idempotent v2 run", async () => {
    const bucket = new FakeBucket();
    const manifest = baseManifest("v1", []);
    manifest.status = "failed";
    manifest.availableMonths = [];
    manifest.artifacts = [];
    manifest.failures = [{
      operation: "browser-collection",
      errorType: "Error",
      message: "synthetic diagnostic",
    }];
    await putManifest(bucket, manifest);
    const central = new FakeCentral();
    central.seedRun("activity-global-pass-r2-v1", 1);

    const first = await importRun(bucket, central);
    const replay = await importRun(bucket, central);
    expect(first).toMatchObject({ centralRunId: 2, sealed: true });
    expect(replay).toMatchObject({ centralRunId: 2, sealed: true });
    expect(central.runIdsBySourceKey).toEqual(new Map([
      ["activity-global-pass-r2-v1", 1],
      ["activity-global-pass-r2-v2", 2],
    ]));
  });

  test("defers a 15-month immediate run and resumes staged backfill in chunks", async () => {
    const bucket = new FakeBucket();
    await storeBackfillRun(bucket);
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      status: "deferred",
      artifactCount: 16,
      nextOffset: 0,
    });
    expect(central.requests).toHaveLength(0);

    const first = await importRun(bucket, central, { offset: 0, immediate: false });
    expect(first).toMatchObject({ status: "deferred", artifactCount: 16, nextOffset: 10 });
    const final = await importRun(bucket, central, { offset: 10, immediate: false });
    expect(final).toMatchObject({ status: "sealed", artifactCount: 16, sealed: true });
    expect(central.uploaded.size).toBe(16);

    await importRun(bucket, central, { offset: 0, immediate: false });
    const replay = await importRun(bucket, central, { offset: 10, immediate: false });
    expect(replay.status).toBe("sealed");
    if (replay.status !== "sealed") throw new Error("expected sealed replay");
    expect(replay.finalChunkAllObjectsReused).toBe(true);
    expect(central.uploaded.size).toBe(16);
  });

  test("rejects secret markers, login controls, shape drift and unredacted v2 state", () => {
    const valid = variantA(["one", "two", "three", "four", "", ""]);
    for (const html of [
      valid.replace("利用明細", "ordinary page"),
      valid.replace("</body>", '<input type="password" name="password"></body>'),
      valid.replace("</body>", "<script>localStorage.clear()</script></body>"),
      valid.replace(
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
        "https://unsafe.invalid/path",
      ),
      valid.replace('<input type="hidden" name="nablarch_submit" value="1">', ""),
      valid.replace('name="cc"', 'name="unknown_state"'),
      valid.replace('type="hidden" name="cc"', 'type="hidden" type="text" name="cc"'),
      valid.replace('name="cc"', 'id="one" id="two" name="cc"'),
      valid.replace('name="cc" value=""', 'name="cc" value="" value="duplicate"'),
      valid.replace(
        'action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"',
        'action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301" action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"',
      ),
      valid.replace("/js/run.js", "/js/run.js?unknown=1"),
      valid.replace('onclick="click()"', 'onload="click()"'),
      valid.replace("</body>",
        '<img src="/en/01006/img/logo.jpg" srcset="https://unsafe.invalid/x 1x"></body>'),
      valid.replace("</body>",
        '<a href="#activity" ping="https://unsafe.invalid/p">x</a></body>'),
      valid.replace("</body>",
        '<div style="background:url(https://unsafe.invalid/x)"></div></body>'),
      valid.replace("</body>",
        '<meta http-equiv="refresh" content="0;url=https://unsafe.invalid/x"></body>'),
      valid.replace("</body>",
        '<svg><use href="https://unsafe.invalid/x"></use></svg></body>'),
      valid.replace("</body>", '<base href="https://unsafe.invalid/"></body>'),
      valid.replace("</body>", '<object data="https://unsafe.invalid/x"></object></body>'),
      valid.replace("</body>", '<iframe src="https://unsafe.invalid/x"></iframe></body>'),
    ]) {
      expect(() => sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v1"))
        .toThrow();
    }
    expect(() => sanitizeGlobalPassHtml(
      encode(canonicalV2(variantB(["not-redacted", SENTINEL, SENTINEL, ""]))),
      "globalpass-browser-poc-v2",
    )).toThrow("html_nablarch_hidden_not_redacted");
    const canonical = canonicalV2(variantB([SENTINEL, SENTINEL, SENTINEL, ""]));
    for (const html of [
      canonical.replace('href="#"', 'href="#activity"'),
      canonical.replace('onclick="return false;"', 'onclick="click()"'),
      canonical.replace('onchange="return false;"', 'onchange="sel_submit(this)"'),
    ]) {
      expect(() => sanitizeGlobalPassHtml(encode(html), "globalpass-browser-poc-v2"))
        .toThrow();
    }
  });

  test("restricts an empty v2 failed run to one non-artifact browser or contract failure", () => {
    const allowed = baseManifest("v2", []);
    Object.assign(allowed, {
      status: "failed",
      availableMonths: [],
      selectedMonths: [],
      captureComplete: false,
      artifacts: [],
      failures: [{
        operation: "browser-collection",
        errorType: "Error",
        errorCode: "browser_collection_failed",
      }],
    });
    expect(() => parseGlobalPassManifest(encode(JSON.stringify(allowed)), MANIFEST_KEY))
      .not.toThrow();
    const twoFailures = structuredClone(allowed);
    twoFailures.failures.push({
      operation: "contract",
      errorType: "Error",
      errorCode: "container_contract_invalid",
    });
    expect(() => parseGlobalPassManifest(encode(JSON.stringify(twoFailures)), MANIFEST_KEY))
      .toThrow("manifest_empty_available_failure_invalid");
    const artifactFailure = structuredClone(allowed);
    artifactFailure.failures = [{
      operation: "r2",
      errorType: "Error",
      errorCode: "artifact_store_failed",
      artifactKey: "activity-2026-09.html",
    }];
    expect(() => parseGlobalPassManifest(encode(JSON.stringify(artifactFailure)), MANIFEST_KEY))
      .toThrow("manifest_empty_available_failure_invalid");
  });

  test("rejects status spoofing, missing-month complement drift and unknown fields", async () => {
    const bucket = new FakeBucket();
    const manifest = await storeRun(
      bucket,
      "v2",
      variantB([SENTINEL, SENTINEL, SENTINEL, ""]),
    );
    for (const mutate of [
      (value: Record<string, any>) => { value.status = "partial"; },
      (value: Record<string, any>) => { value.captureComplete = false; },
      (value: Record<string, any>) => { value.unknown = true; },
    ]) {
      const copy = structuredClone(manifest);
      mutate(copy);
      expect(() => parseGlobalPassManifest(encode(JSON.stringify(copy)), MANIFEST_KEY)).toThrow();
    }
  });

  test("rejects metadata, checksum and prefix inventory drift before central state", async () => {
    for (const mutation of ["metadata", "checksum", "prefix"] as const) {
      const bucket = new FakeBucket();
      const manifest = await storeRun(
        bucket,
        "v2",
        variantB([SENTINEL, SENTINEL, SENTINEL, ""]),
      );
      const artifact = manifest.artifacts[0];
      if (mutation === "metadata") {
        bucket.objects.get(artifact.key)!.customMetadata.extra = "unsafe";
      } else if (mutation === "checksum") {
        bucket.objects.get(artifact.key)!.body = encode("different");
      } else {
        bucket.objects.set(`${PREFIX}unexpected.html`, {
          body: encode("unexpected"),
          customMetadata: {},
          contentType: "text/html",
        });
      }
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).rejects.toBeInstanceOf(Error);
      expect(central.requests).toHaveLength(0);
    }
  });
});

async function importRun(
  bucket: FakeBucket,
  central: FakeCentral,
  options: { offset?: number; immediate?: boolean } = {},
) {
  return importGlobalPassRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "collector-r2-importer-v10",
    manifestKey: MANIFEST_KEY,
    legacyEmptyArtifactSha256: new Set(),
    ...options,
  });
}

async function storeBackfillRun(bucket: FakeBucket): Promise<void> {
  const months = [
    "2026-09", "2026-08", "2026-07", "2026-06", "2026-05",
    "2026-04", "2026-03", "2026-02", "2026-01", "2025-12",
    "2025-11", "2025-10", "2025-09", "2025-08", "2025-07",
  ];
  const artifacts = [];
  for (const month of months) {
    const key = `${PREFIX}activity-${month}.html`;
    const body = encode(canonicalV2(variantB([SENTINEL, SENTINEL, SENTINEL, ""]))
      .replace("</body>", `<span>${month}</span></body>`));
    const sha256 = await sha256Hex(body);
    bucket.objects.set(key, {
      body,
      contentType: "text/html; charset=utf-8",
      customMetadata: {
        source: "prestia-globalpass",
        runId: RUN_ID,
        dataset: "globalpass-activity",
        sha256,
      },
      nativeSha256: sha256,
    });
    artifacts.push({
      dataset: "globalpass-activity",
      month,
      key,
      mediaType: "text/html",
      bytes: body.byteLength,
      sha256,
    });
  }
  const manifest = baseManifest("v2", artifacts);
  Object.assign(manifest, {
    mode: "backfill",
    availableMonths: months,
    selectedMonths: months,
  });
  await putManifest(bucket, manifest);
}

async function storeRun(bucket: FakeBucket, version: "v1" | "v2", html: string) {
  const month = "2026-09";
  const key = `${PREFIX}activity-${month}.html`;
  const body = encode(version === "v2" ? canonicalV2(html) : html);
  const sha256 = await sha256Hex(body);
  bucket.objects.set(key, {
    body,
    contentType: "text/html; charset=utf-8",
    customMetadata: version === "v1"
      ? { dataset: "globalpass-activity", month, sha256 }
      : { source: "prestia-globalpass", runId: RUN_ID, dataset: "globalpass-activity", sha256 },
    nativeSha256: sha256,
  });
  const manifest = baseManifest(version, [{
    ...(version === "v2" ? { dataset: "globalpass-activity" } : {}),
    month,
    key,
    ...(version === "v2" ? { mediaType: "text/html" } : {}),
    bytes: body.byteLength,
    sha256,
  }]);
  await putManifest(bucket, manifest);
  return manifest;
}

function baseManifest(version: "v1" | "v2", artifacts: any[]) {
  return {
    schemaVersion: version === "v1" ? "globalpass-browser-poc-v1" : "globalpass-browser-poc-v2",
    source: "prestia-globalpass",
    runtimeRevision: "fixture-v1",
    runId: RUN_ID,
    mode: "daily",
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:00:01.000Z",
    status: "success",
    availableMonths: ["2026-09"],
    ...(version === "v2" ? {
      selectedMonths: ["2026-09"],
      captureComplete: true,
      paginationStatus: "unproven",
    } : {}),
    artifacts,
    failures: [],
  } as Record<string, any>;
}

async function replaceManifest(bucket: FakeBucket, manifest: Record<string, any>) {
  await putManifest(bucket, manifest);
}

async function putManifest(bucket: FakeBucket, manifest: Record<string, any>) {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(MANIFEST_KEY, {
    body,
    contentType: "application/json; charset=utf-8",
    customMetadata: {
      source: "prestia-globalpass",
      status: String(manifest.status),
      runId: RUN_ID,
    },
  });
}

function variantA(values: string[]): string {
  return htmlVariant({ forms: 6, actions: 1, submits: 6, referenceDate: 1, values });
}

function variantB(values: string[]): string {
  return htmlVariant({ forms: 5, actions: 0, submits: 4, referenceDate: 0, values });
}

function canonicalV2(html: string): string {
  return html.replace('href="#activity"', 'href="#"')
    .replace('onclick="click()"', 'onclick="return false;"')
    .replace('onchange="sel_submit(this)"', 'onchange="return false;"');
}

function legacyEnglishActivityTables(): string {
  return "<table><thead><tr>" +
    "<th>Transaction Date</th>" +
    "<th>Transaction Detail</th>" +
    "<th>Transaction Fee</th>" +
    "</tr></thead><tbody></tbody></table>" +
    "<table><thead><tr>" +
    "<th>Transaction Currency and Amount</th>" +
    "<th>Transaction Detail</th>" +
    "</tr></thead><tbody></tbody></table>" +
    "<table><thead><tr>" +
    "<th>Transaction Currency and Amount</th>" +
    "<th>Transaction Fee</th>" +
    "</tr></thead><tbody></tbody></table>";
}

function htmlVariant(options: {
  forms: number;
  actions: number;
  submits: number;
  referenceDate: number;
  values: string[];
}): string {
  const forms = Array.from({ length: options.forms }, (_, index) =>
    `<form${index < options.actions
      ? ' action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"'
      : ""}></form>`
  ).join("");
  const nablarch = options.values.map((value) =>
    `<input type="hidden" name="nablarch_hidden" value="${value}">`
  ).join("");
  const submits = Array.from({ length: options.submits }, () =>
    '<input type="hidden" name="nablarch_submit" value="1">').join("");
  return `<!doctype html><html><head><title>利用明細</title>` +
    '<link rel="stylesheet" href="/en//01006/css/master.css">' +
    '<script src="/js/run.js"></script></head><body>' +
    '<a href="#activity" onclick="click()">明細</a>' +
    '<select onchange="sel_submit(this)"></select>' + forms +
    '<input type="hidden" name="cc" value="">' +
    '<input type="hidden" name="engUseFlg" value="">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    nablarch + submits +
    (options.referenceDate === 1
      ? '<input type="hidden" name="W131301.referenceDate" value="">'
      : "") +
    '<table data-fixture="activity"><tbody></tbody></table></body></html>';
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function centralNormalizedDescriptor(
  descriptor: Record<string, unknown>,
): Record<string, unknown> {
  const { http, storage, file, email, ...fields } = descriptor;
  return {
    ...fields,
    containerKind: descriptor.containerKind ?? "single",
    dataset: descriptor.dataset ?? null,
    formatId: descriptor.formatId ?? null,
    formatVersion: descriptor.formatVersion ?? null,
    declaredMediaType: descriptor.declaredMediaType ?? null,
    mediaTypeBasis: descriptor.mediaTypeBasis ?? null,
    fetchedAtMs: descriptor.fetchedAtMs ?? null,
    fetchedAtBasis: descriptor.fetchedAtBasis ?? null,
    fetchUnitId: descriptor.fetchUnitId ?? null,
    pageGroupId: descriptor.pageGroupId ?? null,
    pageIndex: descriptor.pageIndex ?? null,
    sequence: descriptor.sequence ?? null,
    origins: {
      http: http ?? null,
      storage: storage ?? null,
      file: file ?? null,
      email: email ?? null,
    },
    ranges: descriptor.ranges ?? [],
    transformSteps: descriptor.transformSteps ?? [],
    relations: descriptor.relations ?? [],
  };
}

async function normalizedDescriptorSha256(
  descriptor: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(encode(JSON.stringify(canonical(descriptor))));
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

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
