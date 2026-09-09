import { describe, expect, test } from "bun:test";
import {
  importVpassRun,
  VPASS_INITIAL_TRANSFER_CHUNK_SIZE,
  VPASS_RESUME_TRANSFER_CHUNK_SIZE,
  validateVpassRun,
} from "../src/vpass";
import { backfillVpass } from "../src/worker";
import {
  RUN_ID,
  CARD_PREFIX,
  CARD_RECORD,
  FakeBucket,
  FakeCentral,
  vpassEnv,
  cardSnapshotBucket,
  largeCardSnapshotBucket,
  okEnvelope,
  cardListEnvelope,
  discoveryEnvelope,
  webPageEnvelope,
  importOptions,
  completeImport,
} from "./synthetic/vpass";

describe("Vpass R2 importer", () => {
  test("uses the full safe Service Binding budget only after initialization", () => {
    expect(VPASS_INITIAL_TRANSFER_CHUNK_SIZE).toBe(5);
    expect(VPASS_RESUME_TRANSFER_CHUNK_SIZE).toBe(12);
    expect(VPASS_RESUME_TRANSFER_CHUNK_SIZE * 2 + 4).toBe(28);
  });

  test("keeps resumed terminal and failure-audit calls below the Worker invocation limit", async () => {
    const bucket = largeCardSnapshotBucket();
    const central = new FakeCentral();
    const first = await importVpassRun(importOptions(bucket, central, CARD_RECORD));
    expect(first).toMatchObject({ status: "deferred", artifactCount: 17, nextOffset: 5 });
    if (first.status !== "deferred") throw new Error("expected deferred");
    const requestsAfterInitialization = central.requests.length;
    const sealed = await importVpassRun({
      ...importOptions(bucket, central, CARD_RECORD),
      continuation: first.continuation,
    });
    expect(sealed).toMatchObject({ status: "sealed", artifactCount: 17 });
    expect(central.requests.length - requestsAfterInitialization).toBe(28);

    const failingCentral = new FakeCentral();
    const failingFirst = await importVpassRun(importOptions(bucket, failingCentral, CARD_RECORD));
    if (failingFirst.status !== "deferred") throw new Error("expected deferred");
    const requestsBeforeFailure = failingCentral.requests.length;
    failingCentral.failNextSeal = true;
    await expect(
      importVpassRun({
        ...importOptions(bucket, failingCentral, CARD_RECORD),
        continuation: failingFirst.continuation,
      }),
    ).rejects.toThrow();
    expect(failingCentral.requests.length - requestsBeforeFailure).toBe(29);
    expect(failingCentral.requests.at(-1)?.path).toMatch(/\/attempts$/u);
  });

  test("validates, sanitizes, stages, seals, and replays across importer revisions", async () => {
    const bucket = cardSnapshotBucket();
    const central = new FakeCentral();
    central.runIds.set(`vpass-worker-card-v1:${RUN_ID}:card-001-vpass-r2-v1`, 900);
    const first = await completeImport(bucket, central, CARD_RECORD, "collector-r2-importer-v12");
    expect(first).toMatchObject({
      status: "sealed",
      centralRunId: 1,
      sealed: true,
      artifactCount: 6,
    });
    const centralText = [
      ...central.requests.map((request) => request.body),
      ...[...central.uploaded.values()].map((bytes) => new TextDecoder().decode(bytes)),
    ].join("\n");
    expect(centralText).not.toContain("private-card-key");
    expect(centralText).not.toContain("private-session-token");
    expect(centralText).not.toContain("Card ending 1234");
    expect(centralText).toContain("<redacted-card-reference>");
    expect(centralText).toContain("<redacted-vpass-sensitive>");
    const runReport = central.requests.find((request) => /\/runs\/1\/reports$/u.test(request.path));
    expect(JSON.parse(runReport!.body)).toMatchObject({
      producerVersion: "vpass-r2-v2",
      producerStatus: "success",
      normalizedOutcome: "success",
    });
    const createRun = central.requests.find((request) => request.path === "/v1/runs");
    expect(JSON.parse(createRun!.body)).toMatchObject({ sourceRunKey: "card-001-vpass-r2-v2" });
    const descriptors = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(
      descriptors.map(({ dataset, artifactRole, payloadFidelity, lineageDisposition }) => ({
        dataset,
        artifactRole,
        payloadFidelity,
        lineageDisposition,
      })),
    ).toEqual([
      {
        dataset: "card-list",
        artifactRole: "sanitized_provider_capture",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
      },
      {
        dataset: "card-selection",
        artifactRole: "sanitized_provider_capture",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
      },
      {
        dataset: "month-discovery",
        artifactRole: "sanitized_provider_capture",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
      },
      {
        dataset: "statement-page",
        artifactRole: "provider_response",
        payloadFidelity: "transformed",
        lineageDisposition: "source_bytes_not_available",
      },
      {
        dataset: "statement-page",
        artifactRole: "provider_response",
        payloadFidelity: "transformed",
        lineageDisposition: "source_bytes_not_available",
      },
      {
        dataset: "collector-manifest",
        artifactRole: "collector_manifest",
        payloadFidelity: "generated",
        lineageDisposition: "source_bytes_not_available",
      },
    ]);

    const replay = await completeImport(bucket, central, CARD_RECORD, "collector-r2-importer-v99");
    expect(replay).toMatchObject({ status: "sealed", centralRunId: 1, sealed: true });
    expect(central.runIds.size).toBe(2);
  });

  test("imports a strict legacy discrete page inventory", async () => {
    const prefix = `vpass/2026/09/05/${RUN_ID}/`;
    const recordKey = `${prefix}manifest.json`;
    const bucket = new FakeBucket();
    bucket.putJson(`${prefix}web-meisai-top.json`, discoveryEnvelope());
    bucket.putJson(`${prefix}months/202609/top-000.json`, webPageEnvelope());
    bucket.putJson(recordKey, {
      runId: RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
      monthCount: 1,
      pageCount: 1,
      transactionCount: 1,
      objectCount: 3,
      status: "success",
      months: { "202609": { pages: 1, transactions: 1 } },
    });
    const loaded = await validateVpassRun(bucket as unknown as R2Bucket, recordKey);
    expect(loaded.record.schemaVersion).toBe("vpass-worker-single-card-v1");
    expect(loaded.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      "web-meisai-top.json",
      "months/202609/top-000.json",
      "manifest.json",
    ]);
  });

  test("imports error-only prefixes as failed evidence", async () => {
    const prefix = `vpass/2026/09/05/${RUN_ID}/`;
    const recordKey = `${prefix}error.json`;
    const bucket = new FakeBucket();
    bucket.putJson(recordKey, {
      runId: RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      failedAt: "2026-09-05T00:00:05.000Z",
      status: "error",
      message: JSON.stringify({ category: "authentication", errorType: "Error" }),
      objectCount: 1,
    });
    const central = new FakeCentral();
    const result = await completeImport(bucket, central, recordKey, "collector-r2-importer-v12");
    expect(result).toMatchObject({ status: "sealed", artifactCount: 1 });
    const runReport = central.requests.find((request) => /\/runs\/1\/reports$/u.test(request.path));
    expect(JSON.parse(runReport!.body)).toMatchObject({
      producerVersion: "vpass-r2-v2",
      producerStatus: "failed",
      normalizedOutcome: "failed",
    });
    expect(JSON.parse(runReport!.body)).not.toHaveProperty("safeFailureCode");
    const unitReport = central.requests.find((request) =>
      /\/units\/10\/reports$/u.test(request.path),
    );
    expect(JSON.parse(unitReport!.body)).toMatchObject({
      producerStatus: "failed",
      normalizedOutcome: "failed",
      safeFailureCode: "collector-failed",
    });
    const descriptor = central.requests.find((request) => /\/artifacts$/u.test(request.path));
    expect(JSON.parse(descriptor!.body)).toMatchObject({
      dataset: "collector-error",
      artifactRole: "collector_error",
      payloadFidelity: "generated",
      lineageDisposition: "source_bytes_not_available",
    });
  });

  test("imports only a strict acquisition-prefix complement for legacy partial failures", async () => {
    const prefix = `vpass/2026/09/05/${RUN_ID}/`;
    const recordKey = `${prefix}error.json`;
    const bucket = new FakeBucket();
    bucket.putJson(`${prefix}session/card-list.json`, cardListEnvelope());
    bucket.putJson(`${prefix}cards/card-001/select-card.json`, okEnvelope({ selected: true }));
    bucket.putJson(`${prefix}cards/card-001/web-meisai-top.json`, discoveryEnvelope());
    bucket.putJson(`${prefix}cards/card-001/months/202609/top-000.json`, webPageEnvelope());
    bucket.putJson(recordKey, {
      runId: RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      failedAt: "2026-09-05T00:01:00.000Z",
      status: "error",
      message: "fixture provider failure",
      objectCount: 3,
    });
    const loaded = await validateVpassRun(bucket as unknown as R2Bucket, recordKey);
    expect(loaded.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      "session/card-list.json",
      "cards/card-001/select-card.json",
      "cards/card-001/web-meisai-top.json",
      "cards/card-001/months/202609/top-000.json",
      "error.json",
    ]);
    expect(loaded.pageGroups).toEqual([{ key: "card-001-202609", count: 1 }]);
    const central = new FakeCentral();
    const first = await importVpassRun(importOptions(bucket, central, recordKey));
    expect(first).toMatchObject({ status: "deferred", artifactCount: 5, nextOffset: 5 });
    if (first.status !== "deferred") throw new Error("expected deferred");
    const sealed = await importVpassRun({
      ...importOptions(bucket, central, recordKey),
      continuation: first.continuation,
    });
    expect(sealed).toMatchObject({ status: "sealed", artifactCount: 5, sealed: true });
    bucket.putJson(`${prefix}cards/card-002/months/202609/top-000.json`, webPageEnvelope());
    await expect(validateVpassRun(bucket as unknown as R2Bucket, recordKey)).rejects.toThrow(
      "error_semantics_invalid",
    );
  });

  test("fails closed before central state on inventory, metadata, checksum, status, and pagination drift", async () => {
    const mutations: Array<(bucket: FakeBucket) => void> = [
      (bucket) => bucket.putJson(`${CARD_PREFIX}unexpected.json`, {}),
      (bucket) => {
        bucket.values.get(CARD_RECORD)!.contentType = "application/json";
      },
      (bucket) => {
        bucket.values.get(CARD_RECORD)!.metadata = { source: "vpass" };
      },
      (bucket) => {
        bucket.values.get(CARD_RECORD)!.native = new Uint8Array(32);
      },
      (bucket) => {
        const value = JSON.parse(new TextDecoder().decode(bucket.values.get(CARD_RECORD)!.bytes));
        value.status = "partial";
        bucket.putJson(CARD_RECORD, value);
      },
      (bucket) => {
        const value = JSON.parse(
          new TextDecoder().decode(bucket.values.get(`${CARD_PREFIX}snapshot.json`)!.bytes),
        );
        value.months["202609"].pages[1].index = 2;
        bucket.putJson(`${CARD_PREFIX}snapshot.json`, value);
      },
    ];
    for (const mutate of mutations) {
      const bucket = cardSnapshotBucket();
      mutate(bucket);
      const central = new FakeCentral();
      await expect(importVpassRun(importOptions(bucket, central, CARD_RECORD))).rejects.toThrow();
      expect(central.requests).toHaveLength(0);
    }
  });

  test("rejects a tampered HMAC continuation", async () => {
    const bucket = cardSnapshotBucket();
    const central = new FakeCentral();
    const first = await importVpassRun(importOptions(bucket, central, CARD_RECORD));
    expect(first.status).toBe("deferred");
    if (first.status !== "deferred") throw new Error("expected deferred");
    expect(first.continuation.startsWith("vpass-transfer-v2.")).toBe(true);
    await expect(
      importVpassRun({
        ...importOptions(bucket, central, CARD_RECORD),
        continuation: first.continuation.replace("vpass-transfer-v2.", "vpass-transfer-v1."),
      }),
    ).rejects.toThrow("transfer_token_invalid");
    const tampered = `${first.continuation.slice(0, -1)}${first.continuation.endsWith("a") ? "b" : "a"}`;
    await expect(
      importVpassRun({
        ...importOptions(bucket, central, CARD_RECORD),
        continuation: tampered,
      }),
    ).rejects.toThrow("transfer_token_invalid");
  });

  test("does not advance the R2 scan cursor until a staged record seals", async () => {
    const bucket = cardSnapshotBucket();
    const central = new FakeCentral();
    const env = vpassEnv(bucket, central);
    await expect(backfillVpass(env, "vpass-scan-v1.fixture.signature")).rejects.toThrow(
      "cursor_invalid",
    );
    const first = await backfillVpass(env, undefined);
    expect(first).toMatchObject({ deferredRecordCount: 1, importedRecordCount: 0 });
    expect(bucket.listCursors.every((value) => value === undefined)).toBe(true);
    let cursor = first.nextCursor as string;
    expect(cursor.startsWith("vpass-scan-v2.")).toBe(true);
    let terminal: Record<string, unknown> | undefined;
    for (let step = 0; step < 10; step += 1) {
      const page = await backfillVpass(env, cursor);
      cursor = page.nextCursor as string;
      if (page.importedRecordCount === 1) {
        terminal = page;
        break;
      }
    }
    expect(terminal).toMatchObject({ importedRecordCount: 1, failedRecordCount: 0 });
    expect(bucket.listCursors.every((value) => value === undefined)).toBe(true);
    expect(cursor).toBeString();
  });

  test("retains a signed pre-record scan cursor after validation failure", async () => {
    const bucket = new FakeBucket();
    const recordKey = `vpass/2026/09/05/${RUN_ID}/error.json`;
    bucket.putJson(recordKey, { status: "partial" });
    const env = vpassEnv(bucket, new FakeCentral());
    const first = await backfillVpass(env, undefined);
    expect(first).toMatchObject({ failedRecordCount: 1, importedRecordCount: 0 });
    const cursor = first.nextCursor as string;
    const second = await backfillVpass(env, cursor);
    expect(second).toMatchObject({ failedRecordCount: 1, nextCursor: cursor });
    expect(bucket.listCursors).toEqual([undefined, undefined]);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    await expect(backfillVpass(env, tampered)).rejects.toThrow("cursor_invalid");
  });
});
