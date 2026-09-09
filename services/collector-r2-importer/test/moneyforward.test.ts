import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { validateMoneyForwardRun } from "../src/moneyforward";
import { backfillMoneyForward } from "../src/worker";
import {
  RUN_ID,
  PREFIX,
  MANIFEST_KEY,
  TOKEN,
  FINGERPRINT_KEY,
  FakeBucket,
  FakeCentral,
  completeImport,
  runImport,
  storeSuccessRun,
  putManifest,
  readManifest,
  stored,
  encode,
  sha256Hex,
} from "./synthetic/moneyforward";

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
