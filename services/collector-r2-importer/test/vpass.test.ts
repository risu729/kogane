import { describe, expect, test } from "bun:test";
import { centralDescriptorSha256 } from "../src/central";
import { importVpassRun, validateVpassRun } from "../src/vpass";
import { backfillVpass } from "../src/worker";

const RUN_ID = "2026-09-05T00-00-00-000Z";
const CARD_PREFIX = `vpass/2026/09/05/${RUN_ID}/card-001/`;
const CARD_RECORD = `${CARD_PREFIX}manifest.json`;
const TOKEN = `collector-r2-vpass.${"v".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);
const CONTENT_TYPE = "application/json; charset=utf-8";

class FakeBucket {
  readonly values = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType: string;
      metadata: Record<string, string>;
      native?: Uint8Array;
    }
  >();
  readonly listCursors: Array<string | undefined> = [];

  putJson(
    key: string,
    value: unknown,
    options: { contentType?: string; metadata?: Record<string, string>; native?: Uint8Array } = {},
  ): void {
    this.values.set(key, {
      bytes: new TextEncoder().encode(JSON.stringify(value)),
      contentType: options.contentType ?? CONTENT_TYPE,
      metadata: options.metadata ?? {},
      ...(options.native ? { native: options.native } : {}),
    });
  }

  get = async (key: string): Promise<R2ObjectBody | null> => {
    const stored = this.values.get(key);
    if (!stored) return null;
    return {
      key,
      version: "test",
      size: stored.bytes.byteLength,
      etag: "test",
      httpEtag: '"test"',
      uploaded: new Date("2026-09-05T00:01:00.000Z"),
      storageClass: "Standard",
      checksums: { sha256: stored.native ? new Uint8Array(stored.native).buffer : undefined },
      httpMetadata: { contentType: stored.contentType },
      customMetadata: stored.metadata,
      range: undefined,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(stored.bytes);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: async () => stored.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(stored.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
      blob: async () => new Blob([new Uint8Array(stored.bytes).buffer]),
      writeHttpMetadata: () => undefined,
    } as unknown as R2ObjectBody;
  };

  list = async (options?: R2ListOptions): Promise<R2Objects> => {
    this.listCursors.push(options?.cursor);
    const prefix = options?.prefix ?? "";
    const allObjects = [...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, stored]) =>
          ({
            key,
            version: "test",
            size: stored.bytes.byteLength,
            etag: "test",
            httpEtag: '"test"',
            uploaded: new Date("2026-09-05T00:01:00.000Z"),
            storageClass: "Standard",
            checksums: {},
          }) as R2Object,
      );
    const offset = options?.cursor ? Number(options.cursor.slice(2)) : 0;
    const limit = options?.limit ?? 1_000;
    const objects = allObjects.slice(offset, offset + limit);
    const nextOffset = offset + objects.length;
    const truncated = nextOffset < allObjects.length;
    return truncated
      ? { objects, truncated: true, cursor: `c:${nextOffset}`, delimitedPrefixes: [] }
      : { objects, truncated: false, delimitedPrefixes: [] };
  };
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Map<string, Uint8Array>();
  readonly runIds = new Map<string, number>();
  readonly terminalReports = new Map<string, string>();
  nextRunId = 1;

  fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const body = request.method === "PUT" ? "" : await request.text();
    this.requests.push({ path, method: request.method, body });
    if (request.method === "PUT") {
      const sha = path.split("/").at(-1)!;
      const bytes = new Uint8Array(await request.arrayBuffer());
      const reused = this.uploaded.has(sha);
      this.uploaded.set(sha, bytes);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const identity = `${parsed.externalIdNamespace}:${parsed.externalSessionId}:${parsed.sourceRunKey}`;
      let runId = this.runIds.get(identity);
      if (runId === undefined) {
        runId = this.nextRunId;
        this.nextRunId += 1;
        this.runIds.set(identity, runId);
      }
      return Response.json({ runId }, { status: 201 });
    }
    if (/\/units$/u.test(path)) return Response.json({ unitId: 10 }, { status: 201 });
    if (/\/page-groups$/u.test(path)) {
      const parsed = JSON.parse(body) as { pageGroupKey: string };
      return Response.json(
        { pageGroupId: 100 + Number(parsed.pageGroupKey.slice(-2)) },
        { status: 201 },
      );
    }
    if (/\/inventories$/u.test(path)) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (/\/artifacts$/u.test(path)) {
      return Response.json(
        { descriptorSha256: await centralDescriptorSha256(JSON.parse(body)) },
        { status: 201 },
      );
    }
    if (/\/reports$/u.test(path)) {
      const previous = this.terminalReports.get(path);
      if (previous !== undefined && previous !== body) {
        return Response.json({ error: "immutable_report_conflict" }, { status: 409 });
      }
      this.terminalReports.set(path, body);
      return Response.json({ reused: previous !== undefined }, { status: previous ? 200 : 201 });
    }
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("Vpass R2 importer", () => {
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

function vpassEnv(bucket: FakeBucket, central: FakeCentral): Env {
  return {
    VPASS_SNAPSHOTS: bucket as unknown as R2Bucket,
    RAW_EVIDENCE: central as unknown as Fetcher,
    RAW_EVIDENCE_TOKEN_VPASS: TOKEN,
    ORIGIN_FINGERPRINT_KEY: FINGERPRINT_KEY,
    IMPORTER_VERSION: "collector-r2-importer-v12",
  } as unknown as Env;
}

function cardSnapshotBucket(): FakeBucket {
  const bucket = new FakeBucket();
  const top = customizedPageEnvelope([], "1", "2");
  const answer = customizedPageEnvelope([{ data: ["fixture merchant", "100"] }], "1", "3");
  bucket.putJson(`${CARD_PREFIX}snapshot.json`, {
    format: "kogane-vpass-r2-snapshot/v1",
    runId: RUN_ID,
    selectedCardIndex: 1,
    cardListRawJson: JSON.stringify(cardListEnvelope()),
    selectCardRawJson: JSON.stringify(okEnvelope({ selected: true })),
    webMeisaiTopRawJson: JSON.stringify(discoveryEnvelope()),
    months: {
      "202609": {
        pages: [
          { kind: "top", index: 0, rawJson: JSON.stringify(top) },
          { kind: "answer", index: 1, rawJson: JSON.stringify(answer) },
        ],
        transactionCount: 1,
      },
    },
  });
  bucket.putJson(CARD_RECORD, {
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    cardCount: 1,
    selectedCardIndex: 1,
    monthCount: 1,
    pageCount: 2,
    transactionCount: 1,
    objectCount: 2,
    status: "success",
    months: { "202609": { pages: 2, transactions: 1 } },
  });
  return bucket;
}

function okEnvelope(content: Record<string, unknown>): Record<string, unknown> {
  return {
    header: { resultCode: 0, sessionId: "private-session-token" },
    body: { content },
  };
}

function cardListEnvelope(): Record<string, unknown> {
  return okEnvelope({
    DropdownListInitDisplayServiceBean: {
      multiCardInfoList: [{ name: "Card ending 1234", value: "private-card-key" }],
    },
  });
}

function discoveryEnvelope(): Record<string, unknown> {
  return okEnvelope({
    WebMeisaiTopDisplayServiceBean: { seikyuYMList: [{ name: "2026年9月", value: "202609" }] },
  });
}

function customizedPageEnvelope(
  rows: unknown[],
  total: string,
  pageFlg: string,
): Record<string, unknown> {
  return okEnvelope({
    CustomizedMeisaiAnsDisplayServiceBean: {
      meisaiList: rows,
      total,
      pageSize: "100",
      pageFlg,
    },
  });
}

function webPageEnvelope(): Record<string, unknown> {
  return okEnvelope({
    WebMeisaiTopDisplayServiceBean: {
      meisaiList: [{ data: ["fixture merchant", "100"] }],
      webMeisaiTopK3Vo: { allCnt: "1", nextPageRow: "2" },
    },
  });
}

function importOptions(bucket: FakeBucket, central: FakeCentral, recordKey: string) {
  return {
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "collector-r2-importer-v12",
    recordKey,
  };
}

async function completeImport(
  bucket: FakeBucket,
  central: FakeCentral,
  recordKey: string,
  importerVersion: string,
) {
  let continuation: string | undefined;
  for (let step = 0; step < 20; step += 1) {
    const result = await importVpassRun({
      ...importOptions(bucket, central, recordKey),
      importerVersion,
      ...(continuation ? { continuation } : {}),
    });
    if (result.status === "sealed") return result;
    continuation = result.continuation;
  }
  throw new Error("import did not seal");
}
