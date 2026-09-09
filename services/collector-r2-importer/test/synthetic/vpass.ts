import { centralDescriptorSha256 } from "../../src/central";
import { importVpassRun } from "../../src/vpass";

export const RUN_ID = "2026-09-05T00-00-00-000Z";
export const CARD_PREFIX = `vpass/2026/09/05/${RUN_ID}/card-001/`;
export const CARD_RECORD = `${CARD_PREFIX}manifest.json`;
export const TOKEN = `collector-r2-vpass.${"v".repeat(32)}`;
export const FINGERPRINT_KEY = "ab".repeat(32);
export const CONTENT_TYPE = "application/json; charset=utf-8";

export class FakeBucket {
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

export class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Map<string, Uint8Array>();
  readonly runIds = new Map<string, number>();
  readonly terminalReports = new Map<string, string>();
  nextRunId = 1;
  failNextSeal = false;

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
    if (/\/seal$/u.test(path)) {
      if (this.failNextSeal) {
        this.failNextSeal = false;
        return Response.json({ error: "fixture_seal_failure" }, { status: 500 });
      }
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

export function vpassEnv(bucket: FakeBucket, central: FakeCentral): Env {
  return {
    VPASS_SNAPSHOTS: bucket as unknown as R2Bucket,
    RAW_EVIDENCE: central as unknown as Fetcher,
    RAW_EVIDENCE_TOKEN_VPASS: TOKEN,
    ORIGIN_FINGERPRINT_KEY: FINGERPRINT_KEY,
    IMPORTER_VERSION: "collector-r2-importer-v12",
  } as unknown as Env;
}

export function cardSnapshotBucket(): FakeBucket {
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

export function largeCardSnapshotBucket(): FakeBucket {
  const bucket = new FakeBucket();
  const pages = [
    {
      kind: "top",
      index: 0,
      rawJson: JSON.stringify(customizedPageEnvelope([{ data: ["fixture", "1"] }], "13", "2")),
    },
    ...Array.from({ length: 12 }, (_, offset) => ({
      kind: "answer",
      index: offset + 1,
      rawJson: JSON.stringify(
        customizedPageEnvelope([{ data: ["fixture", "1"] }], "13", offset === 11 ? "3" : "2"),
      ),
    })),
  ];
  bucket.putJson(`${CARD_PREFIX}snapshot.json`, {
    format: "kogane-vpass-r2-snapshot/v1",
    runId: RUN_ID,
    selectedCardIndex: 1,
    cardListRawJson: JSON.stringify(cardListEnvelope()),
    selectCardRawJson: JSON.stringify(okEnvelope({ selected: true })),
    webMeisaiTopRawJson: JSON.stringify(discoveryEnvelope()),
    months: { "202609": { pages, transactionCount: 13 } },
  });
  bucket.putJson(CARD_RECORD, {
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    cardCount: 1,
    selectedCardIndex: 1,
    monthCount: 1,
    pageCount: 13,
    transactionCount: 13,
    objectCount: 2,
    status: "success",
    months: { "202609": { pages: 13, transactions: 13 } },
  });
  return bucket;
}

export function okEnvelope(content: Record<string, unknown>): Record<string, unknown> {
  return {
    header: { resultCode: 0, sessionId: "private-session-token" },
    body: { content },
  };
}

export function cardListEnvelope(): Record<string, unknown> {
  return okEnvelope({
    DropdownListInitDisplayServiceBean: {
      multiCardInfoList: [{ name: "Card ending 1234", value: "private-card-key" }],
    },
  });
}

export function discoveryEnvelope(): Record<string, unknown> {
  return okEnvelope({
    WebMeisaiTopDisplayServiceBean: { seikyuYMList: [{ name: "2026年9月", value: "202609" }] },
  });
}

export function customizedPageEnvelope(
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

export function webPageEnvelope(): Record<string, unknown> {
  return okEnvelope({
    WebMeisaiTopDisplayServiceBean: {
      meisaiList: [{ data: ["fixture merchant", "100"] }],
      webMeisaiTopK3Vo: { allCnt: "1", nextPageRow: "2" },
    },
  });
}

export function importOptions(bucket: FakeBucket, central: FakeCentral, recordKey: string) {
  return {
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "collector-r2-importer-v12",
    recordKey,
  };
}

export async function completeImport(
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
