import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { importMoneyForwardRun, validateMoneyForwardRun } from "../src/moneyforward";
import { backfillMoneyForward } from "../src/worker";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/moneyforward/2026/09/05/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-moneyforward.${"f".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256: string;
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
      checksums: { sha256: ownedArrayBuffer(hexBytes(value.nativeSha256)) },
      arrayBuffer: async () => ownedArrayBuffer(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    if (options.limit === 1) {
      const offset = options.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > keys.length) {
        throw new Error("fake cursor invalid");
      }
      const objects = keys.slice(offset, offset + 1).map((key) => ({ key }));
      const nextOffset = offset + objects.length;
      const truncated = nextOffset < keys.length;
      return {
        objects,
        truncated,
        ...(truncated ? { cursor: String(nextOffset) } : {}),
      } as unknown as R2Objects;
    }
    return { objects: keys.map((key) => ({ key })), truncated: false } as unknown as R2Objects;
  }
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Set<string>();
  readonly inventoryItems = new Set<string>();
  readonly reports = new Map<string, string>();
  readonly units = new Map<string, number>();
  sealCount = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const reused = this.uploaded.has(path);
      this.uploaded.add(path);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) {
      if (!this.units.has(body)) this.units.set(body, 10 + this.units.size);
      return Response.json({ unitId: this.units.get(body) }, { status: 201 });
    }
    if (path.endsWith("/inventories")) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (path.endsWith("/items")) {
      const items = (JSON.parse(body) as { items: Array<{ artifactKey: string }> }).items;
      for (const item of items) this.inventoryItems.add(item.artifactKey);
      return Response.json({ ok: true }, { status: 201 });
    }
    if (path.endsWith("/artifacts")) {
      return Response.json(
        { descriptorSha256: await normalizedDescriptorSha256(JSON.parse(body)) },
        { status: 201 },
      );
    }
    if (path.endsWith("/reports")) return immutableReport(this.reports, path, body);
    if (path.endsWith("/seal")) {
      this.sealCount += 1;
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("MoneyForward R2 importer", () => {
  test("strictly validates and seals a multi-chunk production-shaped run", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const before = [...bucket.objects.keys()].sort();
    const validated = await validateMoneyForwardRun(bucket as unknown as R2Bucket, MANIFEST_KEY);
    expect(validated.artifacts).toHaveLength(14);
    expect([...bucket.objects.keys()].sort()).toEqual(before);

    const central = new FakeCentral();
    await completeImport(bucket, central, "collector-r2-importer-v17");
    expect(central.inventoryItems.size).toBe(15);
    expect(central.sealCount).toBe(1);
    const descriptors = central.requests
      .filter((entry) => entry.path.endsWith("/artifacts"))
      .map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
    expect(descriptors.find((entry) => entry.dataset === "accounts-index")).toMatchObject({
      artifactRole: "provider_response",
      payloadFidelity: "exact",
      lineageDisposition: "not_applicable",
      formatVersion: "moneyforward-worker-poc-v1",
    });
    expect(descriptors.find((entry) => entry.dataset === "collector-manifest")).toMatchObject({
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
      lineageDisposition: "source_bytes_not_available",
      formatVersion: "moneyforward-central-manifest-v1",
    });
  });

  test("backfill resumes two encrypted continuations and seals the third chunk", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    const env = {
      MONEYFORWARD_SNAPSHOTS: bucket as unknown as R2Bucket,
      RAW_EVIDENCE: central as unknown as Fetcher,
      RAW_EVIDENCE_TOKEN_MONEYFORWARD: TOKEN,
      ORIGIN_FINGERPRINT_KEY: FINGERPRINT_KEY,
      IMPORTER_VERSION: "collector-r2-importer-test",
    } as unknown as Env;
    let cursor: string | undefined;
    let deferredChunks = 0;
    let importedManifests = 0;
    let completed = false;
    for (let page = 0; page < 20; page += 1) {
      const result = await backfillMoneyForward(env, cursor);
      deferredChunks += Number(result.deferredManifestCount);
      importedManifests += Number(result.importedManifestCount);
      if (result.nextCursor === null) {
        completed = true;
        break;
      }
      expect(typeof result.nextCursor).toBe("string");
      expect(result.nextCursor).not.toBe(cursor);
      cursor = result.nextCursor as string;
    }
    expect(completed).toBe(true);
    expect(deferredChunks).toBe(2);
    expect(importedManifests).toBe(1);
    expect(central.inventoryItems.size).toBe(15);
    expect(central.sealCount).toBe(1);
  });

  test("binds each detail and twelve monthly artifacts to one stable account unit", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket, 2);
    const central = new FakeCentral();
    await completeImport(bucket, central, "test");
    expect(central.units.size).toBe(3);
    const descriptors = central.requests
      .filter((entry) => entry.path.endsWith("/artifacts"))
      .map((entry) => JSON.parse(entry.body));
    const accountUnitIds = new Set<number>();
    for (const ordinal of ["01", "02"]) {
      const detail = descriptors.find(
        (item) => item.artifactKey === `account-detail-${ordinal}.html`,
      );
      accountUnitIds.add(detail.fetchUnitId);
      const monthly = descriptors.filter((item) =>
        item.artifactKey.startsWith(`account-${ordinal}-month-`),
      );
      expect(monthly.length).toBe(12);
      expect(monthly.every((item) => item.fetchUnitId === detail.fetchUnitId)).toBe(true);
      expect(
        JSON.parse(central.reports.get(`/v1/units/${detail.fetchUnitId}/reports`)!),
      ).toMatchObject({ declaredArtifactCount: 13, normalizedOutcome: "success" });
    }
    expect(accountUnitIds.size).toBe(2);
    const units = [...central.units.keys()].map((body) => JSON.parse(body));
    expect(
      units
        .filter((unit) => unit.unitKind === "account")
        .every((unit) => /^moneyforward-account-v1-[0-9a-f]{64}$/u.test(unit.unitKey)),
    ).toBe(true);
    expect(JSON.stringify(units)).not.toContain("opaque-account");
    expect(descriptors.find((item) => item.dataset === "accounts-index").fetchUnitId).toBe(10);
    expect(
      descriptors.find((item) => item.dataset === "collector-manifest").fetchUnitId,
    ).toBeNull();
  });

  test("keeps maximum-account transfer state bounded and rejects old continuations", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket, 64);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    if (first.status !== "deferred") throw new Error("expected deferred import");
    expect(central.units.size).toBe(65);
    expect(first.continuation.length).toBeLessThan(8000);
    const second = await runImport(bucket, central, first.continuation);
    expect(second.status).toBe("deferred");
    expect(central.units.size).toBe(65);
    await expect(
      runImport(
        bucket,
        central,
        first.continuation.replace("moneyforward-transfer-v3.", "moneyforward-transfer-v2."),
      ),
    ).rejects.toThrow("transfer_token_invalid");
  }, 20_000);

  test("keeps immutable terminal reports deployment-revision independent", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    await completeImport(bucket, central, "collector-r2-importer-v17");
    const firstReports = new Map(central.reports);
    await completeImport(bucket, central, "collector-r2-importer-v999");
    expect(central.reports).toEqual(firstReports);
    const runReport = JSON.parse(central.reports.get("/v1/runs/1/reports")!);
    expect(runReport).toMatchObject({ producerVersion: "moneyforward-r2-v2" });
    expect(runReport).not.toHaveProperty("producerRevision");
    expect(central.sealCount).toBe(2);
  });

  test("partial snapshots report each known unit conservatively and preserve unassigned evidence", async () => {
    for (const missingDetail of [false, true]) {
      const bucket = new FakeBucket();
      await storeSuccessRun(bucket);
      const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
      const removed = manifest.artifacts.splice(missingDetail ? 1 : 2, 1)[0];
      bucket.objects.delete(removed.key);
      manifest.status = "partial";
      manifest.failures = [
        {
          operation: `r2:${removed.dataset}`,
          errorType: "Error",
          message: "operation_failed",
          stage: "artifact-store",
          failureCode: "operation_failed",
        },
      ];
      await putManifest(bucket, manifest);
      const central = new FakeCentral();
      await completeImport(bucket, central, "test");
      expect(central.sealCount).toBe(1);
      expect(central.units.size).toBe(missingDetail ? 1 : 2);
      expect(
        [...central.reports.values()].every(
          (report) => JSON.parse(report).normalizedOutcome === "partial",
        ),
      ).toBe(true);
    }
  });

  test("seals a manifest-only failed collection without an unusable continuation", async () => {
    const bucket = new FakeBucket();
    await putManifest(bucket, {
      schemaVersion: "moneyforward-worker-poc-v1",
      source: "moneyforward-me",
      runId: RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
      status: "failed",
      accountDetailCount: 0,
      monthlyFragmentCount: 0,
      artifacts: [],
      failures: [
        {
          operation: "collect",
          errorType: "UnknownError",
          message: "operation_failed",
          stage: "accounts-index",
          failureCode: "operation_failed",
        },
      ],
    });
    const central = new FakeCentral();
    const result = await runImport(bucket, central);
    expect(result).toMatchObject({ status: "sealed", artifactCount: 1, sealed: true });
    expect(result).not.toHaveProperty("manifestKey");
    expect(central.inventoryItems).toEqual(new Set(["manifest.json"]));
    expect(central.sealCount).toBe(1);
  });

  test("rejects failure stage and code combinations the collector cannot produce", async () => {
    const impossibleFailures = [
      {
        operation: "collect",
        errorType: "Error",
        message: "credential_configuration_required",
        stage: "monthly-detail",
        failureCode: "credential_configuration_required",
      },
      {
        operation: "collect",
        errorType: "UnknownError",
        message: "credential_configuration_required",
        stage: "credential-load",
        failureCode: "credential_configuration_required",
      },
      {
        operation: "collect",
        errorType: "Error",
        message: "operation_failed",
        stage: "artifact-store",
        failureCode: "operation_failed",
      },
      {
        operation: "r2:accounts-index",
        errorType: "Error",
        message: "credential_configuration_required",
        stage: "artifact-store",
        failureCode: "credential_configuration_required",
      },
      {
        operation: "collect",
        errorType: "MoneyForwardHttpError",
        message: "provider_http_failed",
        stage: "passkey-sign",
        failureCode: "provider_http_failed",
        httpStatus: 503,
      },
      {
        operation: "collect",
        errorType: "MoneyForwardProtocolError",
        message: "provider_protocol_failed",
        stage: "monthly-detail",
        failureCode: "provider_protocol_failed",
        reasonCode: "invalid-response",
      },
      {
        operation: "collect",
        errorType: "MoneyForwardHttpError",
        message: "provider_http_failed",
        stage: "passkey-options",
        failureCode: "provider_http_failed",
      },
      {
        operation: "collect",
        errorType: "MoneyForwardProtocolError",
        message: "provider_protocol_failed",
        stage: "passkey-options",
        failureCode: "provider_protocol_failed",
      },
      {
        operation: "collect",
        errorType: "MoneyForwardProtocolError",
        message: "provider_protocol_failed",
        stage: "passkey-options",
        failureCode: "provider_protocol_failed",
        reasonCode: "missing-csrf",
      },
      {
        operation: "collect",
        errorType: "MoneyForwardProtocolError",
        message: "provider_protocol_failed",
        stage: "accounts-index",
        failureCode: "provider_protocol_failed",
        httpStatus: 302,
        reasonCode: "unexpected-redirect",
      },
    ];
    for (const failure of impossibleFailures) {
      const bucket = new FakeBucket();
      await putManifest(bucket, {
        schemaVersion: "moneyforward-worker-poc-v1",
        source: "moneyforward-me",
        runId: RUN_ID,
        startedAt: "2026-09-05T00:00:00.000Z",
        completedAt: "2026-09-05T00:01:00.000Z",
        status: "failed",
        accountDetailCount: 0,
        monthlyFragmentCount: 0,
        artifacts: [],
        failures: [failure],
      });
      await expect(
        validateMoneyForwardRun(bucket as unknown as R2Bucket, MANIFEST_KEY),
      ).rejects.toThrow("manifest_failure_contract_invalid");
    }

    const validR2Failure = new FakeBucket();
    await putManifest(validR2Failure, {
      schemaVersion: "moneyforward-worker-poc-v1",
      source: "moneyforward-me",
      runId: RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
      status: "failed",
      accountDetailCount: 0,
      monthlyFragmentCount: 0,
      artifacts: [],
      failures: [
        {
          operation: "r2:accounts-index",
          errorType: "Error",
          message: "operation_failed",
          stage: "artifact-store",
          failureCode: "operation_failed",
        },
      ],
    });
    await expect(
      validateMoneyForwardRun(validR2Failure as unknown as R2Bucket, MANIFEST_KEY),
    ).resolves.toMatchObject({ manifest: { status: "failed" } });

    const genericStages = [
      "login-entry",
      "passkey-options",
      "passkey-sign",
      "passkey-assert",
      "auth-redirect",
      "accounts-index",
      "account-selector",
      "account-detail",
      "monthly-detail",
    ];
    const httpStages = ["passkey-options", "passkey-assert", "account-detail", "monthly-detail"];
    const protocolReasonsByStage: Record<string, string[]> = {
      "login-entry": ["unexpected-redirect", "redirect-limit", "missing-location", "missing-csrf"],
      "passkey-options": ["invalid-response"],
      "passkey-assert": ["invalid-response"],
      "auth-redirect": ["unexpected-redirect", "redirect-limit", "missing-location"],
      "accounts-index": [
        "unexpected-redirect",
        "redirect-limit",
        "missing-location",
        "session-not-authenticated",
      ],
      "account-selector": [
        "unexpected-redirect",
        "redirect-limit",
        "missing-location",
        "invalid-response",
      ],
      "account-detail": ["missing-csrf", "missing-account-context"],
    };
    const protocolStatusStages = new Set(["login-entry", "auth-redirect", "account-selector"]);
    const possibleCollectFailures = [
      {
        operation: "collect",
        errorType: "Error",
        message: "credential_configuration_required",
        stage: "credential-load",
        failureCode: "credential_configuration_required",
      },
      ...genericStages.map((stage) => ({
        operation: "collect",
        errorType: "UnknownError",
        message: "operation_failed",
        stage,
        failureCode: "operation_failed",
      })),
      ...httpStages.map((stage) => ({
        operation: "collect",
        errorType: "MoneyForwardHttpError",
        message: "provider_http_failed",
        stage,
        failureCode: "provider_http_failed",
        httpStatus: 503,
      })),
      ...Object.entries(protocolReasonsByStage).flatMap(([stage, reasons]) =>
        reasons.flatMap((reasonCode) => {
          const failure = {
            operation: "collect",
            errorType: "MoneyForwardProtocolError",
            message: "provider_protocol_failed",
            stage,
            failureCode: "provider_protocol_failed",
            reasonCode,
          };
          return reasonCode === "unexpected-redirect" && protocolStatusStages.has(stage)
            ? [failure, { ...failure, httpStatus: 302 }]
            : [failure];
        }),
      ),
    ];
    for (const failure of possibleCollectFailures) {
      const bucket = new FakeBucket();
      await putManifest(bucket, {
        schemaVersion: "moneyforward-worker-poc-v1",
        source: "moneyforward-me",
        runId: RUN_ID,
        startedAt: "2026-09-05T00:00:00.000Z",
        completedAt: "2026-09-05T00:01:00.000Z",
        status: "failed",
        accountDetailCount: 0,
        monthlyFragmentCount: 0,
        artifacts: [],
        failures: [failure],
      });
      await expect(
        validateMoneyForwardRun(bucket as unknown as R2Bucket, MANIFEST_KEY),
      ).resolves.toMatchObject({ manifest: { failures: [failure] } });
    }
  });

  test("rejects prefix, metadata, payload, and continuation tampering", async () => {
    const mutations: Array<(bucket: FakeBucket) => Promise<void> | void> = [
      async (bucket) => {
        bucket.objects.set(
          `${PREFIX}extra.html`,
          await stored(encode("<div>extra</div>"), "text/html; charset=utf-8", {
            dataset: "monthly-transactions",
            sha256: "0".repeat(64),
          }),
        );
      },
      (bucket) => {
        bucket.objects.get(`${PREFIX}accounts.html`)!.customMetadata.extra = "drift";
      },
      async (bucket) => {
        const key = `${PREFIX}account-detail-01.html`;
        const body = encode("<html><body>missing context</body></html>");
        const object = bucket.objects.get(key)!;
        const sha256 = await sha256Hex(body);
        bucket.objects.set(
          key,
          await stored(body, object.contentType, { dataset: "account-detail", sha256 }),
        );
        const manifest = readManifest(bucket);
        const artifact = manifest.artifacts.find((entry) => entry.key === key)!;
        artifact.sha256 = sha256;
        artifact.bytes = body.byteLength;
        await putManifest(bucket, manifest);
      },
    ];
    for (const mutate of mutations) {
      const bucket = new FakeBucket();
      await storeSuccessRun(bucket);
      await mutate(bucket);
      const central = new FakeCentral();
      await expect(runImport(bucket, central)).rejects.toThrow();
      expect(central.requests).toHaveLength(0);
    }

    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    if (first.status !== "deferred") throw new Error("expected deferred import");
    expect(first).not.toHaveProperty("manifestKey");
    expect(first.continuation).toMatch(
      /^moneyforward-transfer-v3\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,7900}$/u,
    );
    expect(
      first.continuation
        .split(".")
        .slice(1)
        .map((part) => Buffer.from(part!, "base64url").toString())
        .join(""),
    ).not.toContain(MANIFEST_KEY);
    const tamperedParts = first.continuation.split(".");
    tamperedParts[1] = `${tamperedParts[1]![0] === "a" ? "b" : "a"}${tamperedParts[1]!.slice(1)}`;
    await expect(runImport(bucket, central, tamperedParts.join("."))).rejects.toThrow(
      "transfer_token_invalid",
    );
    await expect(
      runImport(bucket, central, first.continuation, "collector-r2-importer-test", "cd".repeat(32)),
    ).rejects.toThrow("transfer_token_invalid");
    await expect(
      runImport(bucket, central, first.continuation, "collector-r2-importer-test", "invalid"),
    ).rejects.toThrow("fingerprint_configuration_invalid");
    await expect(
      runImport(bucket, central, `moneyforward-transfer-v1.payload.${"0".repeat(64)}`),
    ).rejects.toThrow("transfer_token_invalid");
    expect(central.sealCount).toBe(0);

    const changedBucket = new FakeBucket();
    await storeSuccessRun(changedBucket);
    const changedCentral = new FakeCentral();
    const changedFirst = await runImport(changedBucket, changedCentral);
    if (changedFirst.status !== "deferred") throw new Error("expected deferred import");
    const semanticallyUnchanged = readManifest(changedBucket);
    const body = encode(JSON.stringify(semanticallyUnchanged, null, 2));
    changedBucket.objects.set(
      MANIFEST_KEY,
      await stored(body, "application/json", {
        source: "moneyforward-me",
        status: String(semanticallyUnchanged.status),
        runId: RUN_ID,
      }),
    );
    await expect(
      runImport(changedBucket, changedCentral, changedFirst.continuation),
    ).rejects.toThrow("transfer_state_mismatch");
    expect(changedCentral.sealCount).toBe(0);
  });
});

async function completeImport(
  bucket: FakeBucket,
  central: FakeCentral,
  importerVersion: string,
): Promise<void> {
  let continuation: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await runImport(bucket, central, continuation, importerVersion);
    if (result.status === "sealed") return;
    if (continuation !== undefined && result.continuation === continuation) {
      throw new Error("test continuation did not advance");
    }
    continuation = result.continuation;
  }
  throw new Error("test import did not seal within page bound");
}

async function runImport(
  bucket: FakeBucket,
  central: FakeCentral,
  continuation?: string,
  importerVersion = "collector-r2-importer-test",
  fingerprintKey = FINGERPRINT_KEY,
) {
  return importMoneyForwardRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey,
    importerVersion,
    manifestKey: MANIFEST_KEY,
    ...(continuation ? { continuation } : {}),
  });
}

async function storeSuccessRun(bucket: FakeBucket, accountCount = 1): Promise<void> {
  const artifacts: Array<Record<string, unknown>> = [];
  artifacts.push(
    await putArtifact(
      bucket,
      "accounts-index",
      "accounts.html",
      `<html><body>${Array.from({ length: accountCount }, (_, index) => `<a href="/accounts/show/${accountCount === 1 ? "opaque-account" : `opaque-account-${String(index + 1).padStart(2, "0")}`}?x=1">account</a>`).join("")}</body></html>`,
    ),
  );
  for (let ordinal = 1; ordinal <= accountCount; ordinal += 1) {
    const label = String(ordinal).padStart(2, "0");
    artifacts.push(
      await putArtifact(
        bucket,
        "account-detail",
        `account-detail-${label}.html`,
        `<html><head><meta name="csrf-token" content="opaque-csrf"></head><body><input name="account[id_hash]" value="${accountCount === 1 ? "opaque-account" : `opaque-account-${label}`}"><input name="service[id]" value="opaque-service"></body></html>`,
      ),
    );
    for (const month of recentMonths("2026-09-05T00:00:00.000Z")) {
      artifacts.push(
        await putArtifact(
          bucket,
          "monthly-transactions",
          `account-${label}-month-${month}.html`,
          '<div class="transaction-list"></div>',
        ),
      );
    }
  }
  await putManifest(bucket, {
    schemaVersion: "moneyforward-worker-poc-v1",
    source: "moneyforward-me",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    accountDetailCount: accountCount,
    monthlyFragmentCount: accountCount * 12,
    artifacts,
    failures: [],
  });
}

async function putArtifact(
  bucket: FakeBucket,
  dataset: string,
  filename: string,
  value: string,
): Promise<Record<string, unknown>> {
  const body = encode(value);
  const sha256 = await sha256Hex(body);
  const key = `${PREFIX}${filename}`;
  bucket.objects.set(key, await stored(body, "text/html; charset=utf-8", { dataset, sha256 }));
  return { dataset, key, mediaType: "text/html; charset=utf-8", sha256, bytes: body.byteLength };
}

async function putManifest(bucket: FakeBucket, manifest: Record<string, unknown>): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(
    MANIFEST_KEY,
    await stored(body, "application/json", {
      source: "moneyforward-me",
      status: String(manifest.status),
      runId: RUN_ID,
    }),
  );
}

function readManifest(bucket: FakeBucket): {
  artifacts: Array<{ key: string; sha256: string; bytes: number }>;
} & Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
}

function recentMonths(value: string): string[] {
  const now = new Date(Date.parse(value) + 9 * 60 * 60 * 1_000);
  return Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

async function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<StoredObject> {
  return { body, contentType, customMetadata, nativeSha256: await sha256Hex(body) };
}

function immutableReport(reports: Map<string, string>, path: string, body: string): Response {
  const previous = reports.get(path);
  if (previous !== undefined && previous !== body) {
    return Response.json({ error: "immutable_report_conflict" }, { status: 409 });
  }
  reports.set(path, body);
  return Response.json({ reused: previous !== undefined }, { status: previous ? 200 : 201 });
}

async function normalizedDescriptorSha256(descriptor: Record<string, unknown>): Promise<string> {
  const { http, storage, file, email, ...fields } = descriptor;
  return sha256Hex(
    encode(
      canonicalJson({
        ...fields,
        origins: {
          http: http ?? null,
          storage: storage ?? null,
          file: file ?? null,
          email: email ?? null,
        },
      }),
    ),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
