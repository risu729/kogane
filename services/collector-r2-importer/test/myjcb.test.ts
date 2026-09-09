import { describe, expect, test } from "bun:test";
import { importMyJcbRun, validateMyJcbRun } from "../src/myjcb";
import {
  PREFIX,
  MANIFEST_KEY,
  FINGERPRINT_KEY,
  FakeBucket,
  FakeCentral,
  runImport,
  storeSuccessRun,
  storeFailedRun,
  storeMaxConnectionsRun,
  putManifest,
  rewriteArtifactHash,
  readManifest,
  stored,
  html,
  encode,
  sha256Hex,
} from "./synthetic/myjcb";

describe("MyJCB R2 importer", () => {
  test("strictly imports a multi-chunk success run and replays idempotently", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();

    const first = await runImport(bucket, central);
    expect(first).toMatchObject({ status: "deferred", artifactCount: 8, nextOffset: 5 });
    if (first.status !== "deferred") throw new Error("expected deferred import");
    const second = await runImport(bucket, central, first.continuation);
    expect(second).toMatchObject({
      status: "sealed",
      centralRunId: 1,
      artifactCount: 8,
      sealed: true,
    });
    expect(central.inventoryItems.size).toBe(8);
    expect(central.seals).toHaveLength(1);
    const runReport = central.requests.find((entry) => entry.path === "/v1/runs/1/reports");
    expect(runReport ? JSON.parse(runReport.body) : undefined).toMatchObject({
      producerVersion: "myjcb-r2-v2",
    });
    const descriptors = central.requests
      .filter((entry) => entry.path === "/v1/runs/1/artifacts")
      .map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
    expect(descriptors.find((entry) => entry.dataset === "credit-ledger")).toMatchObject({
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      lineageDisposition: "linked",
      transformSteps: [
        { stepIndex: 0, stepKind: "extracted", transformerId: "myjcb-ledger-parser" },
        { stepIndex: 1, stepKind: "generated", transformerId: "myjcb-ledger-parser" },
      ],
      relations: [{ relation: "input", transformerId: "myjcb-ledger-parser" }],
    });
    expect(descriptors.find((entry) => entry.dataset === "discovery")).toMatchObject({
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      lineageDisposition: "source_bytes_not_available",
      transformSteps: [
        { stepIndex: 0, stepKind: "extracted", transformerId: "myjcb-discovery-parser" },
        { stepIndex: 1, stepKind: "generated", transformerId: "myjcb-discovery-parser" },
      ],
      relations: [],
    });
    expect(descriptors.find((entry) => entry.dataset === "collector-manifest")).toMatchObject({
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
      lineageDisposition: "source_bytes_not_available",
      formatVersion: "myjcb-central-manifest-v2",
      transformSteps: [],
      relations: [],
    });

    const replayFirst = await runImport(bucket, central, undefined, "collector-r2-importer-v99");
    if (replayFirst.status !== "deferred") throw new Error("expected deferred replay");
    const replaySecond = await runImport(
      bucket,
      central,
      replayFirst.continuation,
      "collector-r2-importer-v99",
    );
    expect(replaySecond).toMatchObject({ status: "sealed", centralRunId: 1 });
    expect(central.inventoryItems.size).toBe(8);
    expect(central.seals).toHaveLength(2);
  });

  test("catalogues a manifest-only failed collection without inventing artifacts", async () => {
    const bucket = new FakeBucket();
    await storeFailedRun(bucket);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    expect(first).toMatchObject({ status: "deferred", artifactCount: 1, nextOffset: 1 });
    if (first.status !== "deferred") throw new Error("expected deferred import");
    const result = await runImport(bucket, central, first.continuation);
    expect(result).toMatchObject({ status: "sealed", artifactCount: 1 });
    expect(central.inventoryItems).toEqual(new Set(["manifest.json"]));
    const report = central.requests.find((entry) => entry.path === "/v1/units/10/reports");
    expect(JSON.parse(report!.body)).toMatchObject({
      producerStatus: "failed",
      normalizedOutcome: "failed",
      declaredArtifactCount: 0,
      artifactCountScope: "direct",
      safeFailureCode: "collection-failed",
    });
  });

  test("does not copy a source failure message into the central manifest", async () => {
    const bucket = new FakeBucket();
    await storeFailedRun(bucket);
    const manifest = readManifest(bucket);
    const sentinel = "legacy diagnostic wording sentinel";
    manifest.connections[0]!.blocker = sentinel;
    manifest.failures[0]!.message = sentinel;
    await putManifest(bucket, manifest);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    expect(first).toMatchObject({ status: "deferred", artifactCount: 1 });
    expect(central.uploadedBodies.join("\n")).not.toContain(sentinel);
    expect(central.uploadedBodies.join("\n")).toContain("collector-failure");
  });

  test("fresh retry converges after an interrupted first chunk", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    central.failNextInventoryItems = true;
    await expect(runImport(bucket, central)).rejects.toThrow("central_503_temporary");
    const firstChunkObjectCount = central.uploaded.size;
    expect(firstChunkObjectCount).toBeGreaterThan(0);
    expect(central.requests.filter((entry) => entry.method === "PUT")).toHaveLength(5);

    const retried = await runImport(bucket, central);
    expect(retried).toMatchObject({ status: "deferred", nextOffset: 5 });
    expect(central.uploaded.size).toBe(firstChunkObjectCount);
    expect(central.requests.filter((entry) => entry.method === "PUT")).toHaveLength(10);
    if (retried.status !== "deferred") throw new Error("expected deferred retry");
    await expect(runImport(bucket, central, retried.continuation)).resolves.toMatchObject({
      status: "sealed",
      centralRunId: 1,
    });
  });

  test("keeps the maximum 16-connection initialization at 29 central calls", async () => {
    const bucket = new FakeBucket();
    await storeMaxConnectionsRun(bucket);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    expect(first).toMatchObject({ status: "deferred", artifactCount: 81, nextOffset: 5 });
    expect(central.requests).toHaveLength(29);
    expect(central.unitIds.size).toBe(16);
  });

  test("requires R2 failures to be the exact mandatory-artifact complement", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const discoveryKey = `${PREFIX}primary/discovery.json`;
    bucket.objects.delete(discoveryKey);
    const manifest = readManifest(bucket);
    manifest.status = "partial";
    manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.key !== discoveryKey);
    manifest.connections[0]!.status = "partial";
    manifest.connections[0]!.artifactCount = manifest.artifacts.length;
    manifest.failures = [
      {
        connectionId: "primary",
        operation: "r2:discovery",
        errorType: "Error",
        message: "Collector operation failed",
      },
    ];
    await putManifest(bucket, manifest);
    await expect(
      validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY),
    ).resolves.toBeDefined();

    manifest.failures[0]!.operation = "r2:credit-pdf";
    await putManifest(bucket, manifest);
    const central = new FakeCentral();
    await expect(runImport(bucket, central)).rejects.toThrow("manifest_dataset_unobserved");
    expect(central.requests).toHaveLength(0);
  });

  test("rejects unobserved artifacts and derivative-before-detail ordering", async () => {
    const unobserved = new FakeBucket();
    await storeSuccessRun(unobserved);
    const unobservedManifest = readManifest(unobserved);
    unobservedManifest.artifacts[3]!.dataset = "credit-pdf";
    await putManifest(unobserved, unobservedManifest);
    await expect(validateMyJcbRun(unobserved as unknown as R2Bucket, MANIFEST_KEY)).rejects.toThrow(
      "manifest_dataset_unobserved",
    );

    const reordered = new FakeBucket();
    await storeSuccessRun(reordered);
    const reorderedManifest = readManifest(reordered);
    [reorderedManifest.artifacts[2], reorderedManifest.artifacts[3]] = [
      reorderedManifest.artifacts[3]!,
      reorderedManifest.artifacts[2]!,
    ];
    await putManifest(reordered, reorderedManifest);
    await expect(validateMyJcbRun(reordered as unknown as R2Bucket, MANIFEST_KEY)).rejects.toThrow(
      "manifest_credit_artifact_order_invalid",
    );
  });

  test("normalizes active HTML surfaces before central storage", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const key = `${PREFIX}primary/credit-menu.html`;
    const unsafe = encode(
      html(
        "credit-menu",
        `<span>detailMonth generalJsonShikibetuId</span>
         <script>window.sessionToken="script-secret"</script>
         <meta name="csrf-token" content="meta-secret">
         <div data-token="data-secret" onclick="sendSecret()">
           <a href="/next?token=href-secret">next</a>
           <form action="/submit?session=action-secret">
             <textarea>textarea-secret</textarea>
           </form>
         </div>`,
      ),
    );
    const original = bucket.objects.get(key)!;
    bucket.objects.set(
      key,
      await stored(unsafe, original.contentType, {
        ...original.customMetadata,
        sha256: await sha256Hex(unsafe),
      }),
    );
    await rewriteArtifactHash(bucket, key, unsafe);

    const validated = await validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY);
    const normalized = new TextDecoder().decode(validated.artifacts[0]!.centralBytes);
    for (const sentinel of [
      "script-secret",
      "meta-secret",
      "data-secret",
      "sendSecret",
      "href-secret",
      "action-secret",
      "textarea-secret",
    ]) {
      expect(normalized).not.toContain(sentinel);
    }
    expect(normalized).not.toMatch(/<(?:script|meta)\b|\s(?:data-token|onclick|href|action)\s*=/iu);

    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    expect(first.status).toBe("deferred");
    expect(central.uploadedBodies.join("\n")).not.toContain("script-secret");
  });

  test("normalizes a malformed active HTML element without copying its text", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const key = `${PREFIX}primary/credit-menu.html`;
    const malformed = encode(
      html(
        "credit-menu",
        '<span>detailMonth generalJsonShikibetuId</span><script>window.token="unterminated"',
      ),
    );
    const original = bucket.objects.get(key)!;
    bucket.objects.set(
      key,
      await stored(malformed, original.contentType, {
        ...original.customMetadata,
        sha256: await sha256Hex(malformed),
      }),
    );
    await rewriteArtifactHash(bucket, key, malformed);
    const validated = await validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY);
    const normalized = new TextDecoder().decode(validated.artifacts[0]!.centralBytes);
    expect(normalized).not.toContain("unterminated");
    expect(normalized).not.toMatch(/<script\b/iu);

    const central = new FakeCentral();
    const result = await runImport(bucket, central);
    expect(result.status).toBe("deferred");
  });

  test("accepts a redacted credit menu whose navigation markers were intentionally removed", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const key = `${PREFIX}primary/credit-menu.html`;
    const redacted = encode(
      '<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB <input name="generalJsonShikibetuId" value="[redacted]"></body></html>',
    );
    const original = bucket.objects.get(key)!;
    bucket.objects.set(
      key,
      await stored(redacted, original.contentType, {
        ...original.customMetadata,
        sha256: await sha256Hex(redacted),
      }),
    );
    await rewriteArtifactHash(bucket, key, redacted);
    await expect(
      validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY),
    ).resolves.toMatchObject({ artifacts: expect.any(Array) });

    const missingDiscriminator = encode(
      '<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB menu</body></html>',
    );
    bucket.objects.set(
      key,
      await stored(missingDiscriminator, original.contentType, {
        ...original.customMetadata,
        sha256: await sha256Hex(missingDiscriminator),
      }),
    );
    await rewriteArtifactHash(bucket, key, missingDiscriminator);
    await expect(validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY)).rejects.toThrow(
      "artifact_credit_menu_semantics_invalid",
    );
  });

  test("accepts a redacted credit detail identified by its retained provider labels", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const key = `${PREFIX}primary/credit-detail-00.html`;
    const redacted = encode(
      '<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB ご利用明細 お支払い</body></html>',
    );
    const original = bucket.objects.get(key)!;
    bucket.objects.set(
      key,
      await stored(redacted, original.contentType, {
        ...original.customMetadata,
        sha256: await sha256Hex(redacted),
      }),
    );
    await rewriteArtifactHash(bucket, key, redacted);
    await expect(
      validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY),
    ).resolves.toMatchObject({ artifacts: expect.any(Array) });
  });

  test("rejects prefix, metadata, and semantic drift before creating central state", async () => {
    for (const mutate of [
      async (bucket: FakeBucket) => {
        bucket.objects.set(
          `${PREFIX}primary/extra.json`,
          await stored(encode("{}"), "application/json", { source: "myjcb" }),
        );
      },
      async (bucket: FakeBucket) => {
        bucket.objects.get(`${PREFIX}primary/credit-menu.html`)!.customMetadata.extra = "drift";
      },
      async (bucket: FakeBucket) => {
        const key = `${PREFIX}primary/credit-menu.html`;
        const unsafe = encode(html("credit-menu", '<input name="csrf" value="not-redacted">'));
        const object = bucket.objects.get(key)!;
        bucket.objects.set(
          key,
          await stored(unsafe, object.contentType, {
            ...object.customMetadata,
            sha256: await sha256Hex(unsafe),
          }),
        );
        await rewriteArtifactHash(bucket, key, unsafe);
      },
    ]) {
      const bucket = new FakeBucket();
      await storeSuccessRun(bucket);
      await mutate(bucket);
      const central = new FakeCentral();
      await expect(runImport(bucket, central)).rejects.toThrow();
      expect(central.requests).toHaveLength(0);
    }
  });

  test("rejects a tampered signed transfer continuation", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    const first = await runImport(bucket, central);
    if (first.status !== "deferred") throw new Error("expected deferred import");
    const final = first.continuation.at(-1) === "a" ? "b" : "a";
    const tampered = `${first.continuation.slice(0, -1)}${final}`;
    await expect(runImport(bucket, central, tampered)).rejects.toThrow("transfer_token_invalid");
    expect(central.seals).toHaveLength(0);
  });

  test("does not accept another collector credential for the MyJCB route", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const central = new FakeCentral();
    await expect(
      importMyJcbRun({
        bucket: bucket as unknown as R2Bucket,
        centralService: central as unknown as Fetcher,
        centralToken: `collector-r2-global-pass.${"g".repeat(32)}`,
        fingerprintKey: FINGERPRINT_KEY,
        importerVersion: "collector-r2-importer-test",
        manifestKey: MANIFEST_KEY,
      }),
    ).rejects.toThrow("central_auth_configuration_invalid");
    expect(central.requests).toHaveLength(0);
  });

  test("validates every source object without changing the bucket", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    const before = [...bucket.objects.keys()].sort();
    const run = await validateMyJcbRun(bucket as unknown as R2Bucket, MANIFEST_KEY);
    expect(run.artifacts).toHaveLength(7);
    expect([...bucket.objects.keys()].sort()).toEqual(before);
  });
});
