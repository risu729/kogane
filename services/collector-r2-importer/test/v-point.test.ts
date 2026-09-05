import { describe, expect, test } from "bun:test";
import { importVPointRun, parseVPointManifest } from "../src/v-point";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/v-point/2026/09/05/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const REPORT_KEY = `derived/v-point-pay-email-reconciliation/2026/09/05/${RUN_ID}.json`;
const TOKEN = `collector-r2-v-point.${"p".repeat(32)}`;

interface Stored {
  body: Uint8Array;
  metadata: Record<string, string>;
  contentType: string;
  nativeSha256: string;
}

class FakeBucket {
  readonly objects = new Map<string, Stored>();

  async put(key: string, value: unknown, metadata: Record<string, string>): Promise<void> {
    const body = new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    this.objects.set(key, {
      body,
      metadata,
      contentType: "application/json",
      nativeSha256: await sha256(body),
    });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.body.byteLength,
      customMetadata: value.metadata,
      httpMetadata: { contentType: value.contentType },
      checksums: { sha256: hexBytes(value.nativeSha256).buffer },
      arrayBuffer: async () => owned(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .sort()
        .map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploads = new Map<string, Uint8Array>();
  readonly reports = new Map<string, string>();

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const reused = this.uploads.has(path);
      this.uploads.set(path, bytes);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) return Response.json({ unitId: 10 }, { status: 201 });
    if (path.endsWith("/page-groups"))
      return Response.json({ pageGroupId: path.includes("unused") ? 21 : 20 }, { status: 201 });
    if (path.endsWith("/inventories")) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (path.endsWith("/artifacts")) {
      return Response.json(
        { descriptorSha256: await descriptorHash(JSON.parse(body)) },
        { status: 201 },
      );
    }
    if (path.endsWith("/reports")) {
      const report = JSON.stringify(JSON.parse(body));
      const existing = this.reports.get(path);
      if (existing !== undefined && existing !== report) {
        return Response.json({ error: "report_immutable" }, { status: 409 });
      }
      this.reports.set(path, report);
      return Response.json({ ok: true }, { status: existing === undefined ? 201 : 200 });
    }
    if (path.endsWith("/seal")) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("V Point R2 importer", () => {
  test("imports a strict v2 run with reconciliation and reuses every object on replay", async () => {
    const { source, reconciliation } = await successRun();
    const central = new FakeCentral();
    const first = await importRun(source, reconciliation, central);
    expect(first).toMatchObject({
      source: "v-point",
      artifactCount: 7,
      sealed: true,
      allObjectsReused: false,
    });
    const descriptors = central.requests
      .filter((request) => request.path.endsWith("/artifacts"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(descriptors.find((value) => value.dataset === "history-page-0001")).toMatchObject({
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      lineageDisposition: "source_bytes_not_available",
      pageGroupId: 20,
      pageIndex: 0,
      formatVersion: "vpoint-worker-poc-v2",
    });
    expect(
      descriptors.find((value) => value.dataset === "v-point-pay-email-reconciliation"),
    ).toMatchObject({
      artifactRole: "collector_summary",
      payloadFidelity: "generated",
    });
    const replay = await importRun(source, reconciliation, central);
    expect(replay.status).toBe("sealed");
    if (replay.status !== "sealed") throw new Error("expected sealed replay");
    expect(replay.allObjectsReused).toBe(true);
    expect(central.uploads).toHaveLength(7);
  });

  test("redacts free collector failure text before central upload", async () => {
    const source = new FakeBucket();
    const reconciliation = new FakeBucket();
    const manifest = baseManifest({
      status: "failed",
      historyTotal: 0,
      historyPageCount: 0,
      vMoneyHistoryTotal: 0,
      vMoneyHistoryPageCount: 0,
      artifacts: [],
      failures: [
        { operation: "collect", errorType: "TypeError", message: "dummy-sensitive-detail" },
      ],
    });
    await source.put(MANIFEST_KEY, manifest, manifestMetadata("failed"));
    const central = new FakeCentral();
    await expect(importRun(source, reconciliation, central)).resolves.toMatchObject({
      artifactCount: 1,
    });
    const uploaded = new TextDecoder().decode([...central.uploads.values()][0]);
    expect(uploaded).toContain("failure_redacted");
    expect(uploaded).not.toContain("dummy-sensitive-detail");
    const centralManifest = central.requests
      .filter((request) => request.path.endsWith("/artifacts"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((descriptor) => descriptor.artifactKey === "manifest.json");
    expect(centralManifest).toMatchObject({
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
      lineageDisposition: "source_bytes_not_available",
      formatVersion: "vpoint-central-manifest-v2",
    });
    expect(centralManifest).not.toHaveProperty("transformSteps");
  });

  test("replays across importer deployments without changing immutable terminal reports", async () => {
    const { source, reconciliation } = await successRun();
    const central = new FakeCentral();
    await expect(
      importRun(source, reconciliation, central, 0, true, "deployment-a"),
    ).resolves.toMatchObject({ status: "sealed" });
    await expect(
      importRun(source, reconciliation, central, 0, true, "deployment-b"),
    ).resolves.toMatchObject({ status: "sealed", allObjectsReused: true });
    const runReport = JSON.parse(central.reports.get("/v1/runs/1/reports") ?? "null") as Record<
      string,
      unknown
    >;
    expect(runReport.producerVersion).toBe("vpoint-r2-v3");
    const createRun = central.requests.find((request) => request.path === "/v1/runs");
    expect(JSON.parse(createRun?.body ?? "null")).toMatchObject({
      sourceRunKey: "full-snapshot-vpoint-r2-v3",
    });
    expect(JSON.stringify([...central.reports.values()])).not.toContain("deployment-");
  });

  test("imports the audited legacy v1 contract in its own format namespace", async () => {
    const { source, reconciliation } = await successRun();
    await replaceArtifact(source, "collection-summary", {
      schemaVersion: "vpoint-collection-summary-v1",
      historyTotal: 1,
      historyPageCount: 1,
    });
    source.objects.delete(`${PREFIX}vmoney-history-page-0001.json`);
    const manifest = JSON.parse(new TextDecoder().decode(source.objects.get(MANIFEST_KEY)!.body));
    manifest.schemaVersion = "vpoint-worker-poc-v1";
    manifest.artifacts = manifest.artifacts.filter(
      (artifact: Record<string, unknown>) => artifact.dataset !== "vmoney-history-page-0001",
    );
    delete manifest.vMoneyHistoryTotal;
    delete manifest.vMoneyHistoryPageCount;
    delete manifest.emailReconciliation;
    await source.put(MANIFEST_KEY, manifest, manifestMetadata("success"));
    const central = new FakeCentral();
    await expect(importRun(source, reconciliation, central)).resolves.toMatchObject({
      artifactCount: 5,
    });
    const descriptors = central.requests
      .filter((request) => request.path.endsWith("/artifacts"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(
      descriptors.every((descriptor) =>
        descriptor.artifactKey === "manifest.json"
          ? descriptor.formatVersion === "vpoint-central-manifest-v2"
          : descriptor.formatVersion === "vpoint-worker-poc-v1",
      ),
    ).toBe(true);
  });

  test("rejects unknown manifest fields and exact-prefix drift before central writes", async () => {
    const { source, reconciliation, manifest } = await successRun();
    const central = new FakeCentral();
    expect(() =>
      parseVPointManifest(
        new TextEncoder().encode(JSON.stringify({ ...manifest, unexpected: true })),
        MANIFEST_KEY,
      ),
    ).toThrow("manifest_unknown_field");
    await source.put(
      `${PREFIX}unexpected.json`,
      {},
      { dataset: "unexpected", sha256: "0".repeat(64) },
    );
    await expect(importRun(source, reconciliation, central)).rejects.toThrow(
      "prefix_inventory_mismatch",
    );
    expect(central.requests).toHaveLength(0);
  });

  test("rejects a stagnant R2 listing cursor before central writes", async () => {
    const { source, reconciliation } = await successRun();
    const central = new FakeCentral();
    let calls = 0;
    source.list = async () =>
      ({
        objects: calls++ === 0 ? [{ key: MANIFEST_KEY }] : [],
        truncated: true,
        cursor: "stuck",
      }) as unknown as R2Objects;
    await expect(importRun(source, reconciliation, central)).rejects.toThrow(
      "prefix_cursor_stalled",
    );
    expect(central.requests).toHaveLength(0);
  });

  test("bounds an overlong R2 inventory before central writes", async () => {
    const { source, reconciliation } = await successRun();
    const central = new FakeCentral();
    source.list = async (options: R2ListOptions = {}) =>
      ({
        objects: [
          ...[...source.objects.keys()]
            .filter((key) => key.startsWith(options.prefix ?? ""))
            .sort()
            .map((key) => ({ key })),
          { key: `${PREFIX}unexpected.json` },
        ],
        truncated: false,
      }) as unknown as R2Objects;
    await expect(importRun(source, reconciliation, central)).rejects.toThrow(
      "prefix_inventory_mismatch",
    );
    expect(central.requests).toHaveLength(0);
  });

  test("accepts only the exact R2 failure complement", async () => {
    const { source, reconciliation } = await successRun();
    source.objects.delete(`${PREFIX}collection-summary.json`);
    const manifest = JSON.parse(new TextDecoder().decode(source.objects.get(MANIFEST_KEY)!.body));
    manifest.status = "partial";
    manifest.artifacts = manifest.artifacts.filter(
      (artifact: Record<string, unknown>) => artifact.dataset !== "collection-summary",
    );
    manifest.failures = [
      { operation: "r2:collection-summary", errorType: "Error", message: "write failed" },
    ];
    await source.put(MANIFEST_KEY, manifest, manifestMetadata("partial"));
    await expect(importRun(source, reconciliation, new FakeCentral())).resolves.toMatchObject({
      artifactCount: 6,
      sealed: true,
    });

    manifest.failures = [
      { operation: "r2:balance-info", errorType: "Error", message: "write failed" },
    ];
    await source.put(MANIFEST_KEY, manifest, manifestMetadata("partial"));
    await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(
      "manifest_failure_complement_mismatch",
    );
  });

  test("rejects checksum drift, pagination drift, and non-empty V Money", async () => {
    {
      const { source, reconciliation } = await successRun();
      source.objects.get(`${PREFIX}balance-info.json`)!.body[0] = 0x20;
      await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow();
    }
    {
      const { source, reconciliation } = await successRun();
      await replaceArtifact(source, "history-page-0001", history(2, 1));
      await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(
        "artifact_pagination_mismatch",
      );
    }
    {
      const { source, reconciliation } = await successRun();
      await replaceArtifact(source, "vmoney-history-page-0001", vmoney(1));
      await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(
        "vmoney_nonempty_unsupported",
      );
    }
  });

  test("defers an oversized valid run and seals it through staged offsets", async () => {
    const { source, reconciliation } = await successRun();
    await replaceArtifact(source, "history-page-0001", history(270, 30));
    await replaceArtifact(source, "collection-summary", {
      schemaVersion: "vpoint-collection-summary-v2",
      historyTotal: 270,
      historyPageCount: 9,
      vMoneyHistoryTotal: 0,
      vMoneyHistoryPageCount: 1,
    });
    const manifest = JSON.parse(new TextDecoder().decode(source.objects.get(MANIFEST_KEY)!.body));
    const additions = [];
    for (let page = 2; page <= 9; page += 1) {
      const dataset = `history-page-${String(page).padStart(4, "0")}`;
      const value = history(270, 30);
      const body = new TextEncoder().encode(JSON.stringify(value));
      const hash = await sha256(body);
      await source.put(`${PREFIX}${dataset}.json`, value, { dataset, sha256: hash });
      additions.push({
        dataset,
        key: `${PREFIX}${dataset}.json`,
        mediaType: "application/json",
        sha256: hash,
        bytes: body.byteLength,
      });
    }
    manifest.historyTotal = 270;
    manifest.historyPageCount = 9;
    delete manifest.emailReconciliation;
    manifest.artifacts.splice(3, 0, ...additions);
    await source.put(MANIFEST_KEY, manifest, manifestMetadata("success"));
    const central = new FakeCentral();
    await expect(importRun(source, reconciliation, central)).resolves.toMatchObject({
      status: "deferred",
      nextOffset: 0,
      artifactCount: 14,
    });
    expect(central.requests).toHaveLength(0);

    const firstChunk = await importRun(source, reconciliation, central, 0, false);
    expect(firstChunk).toMatchObject({ status: "deferred", nextOffset: 8, artifactCount: 14 });
    const finalChunk = await importRun(source, reconciliation, central, 8, false);
    expect(finalChunk).toMatchObject({ status: "sealed", artifactCount: 14, sealed: true });
    const inventories = central.requests
      .filter((request) => request.path.endsWith("/inventories"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(inventories).toHaveLength(2);
    expect(new Set(inventories.map((inventory) => inventory.inventorySha256))).toHaveLength(1);
    expect(inventories.every((inventory) => inventory.expectedArtifactCount === 14)).toBe(true);
    const itemChunks = central.requests
      .filter((request) => request.path.endsWith("/items"))
      .map(
        (request) =>
          (
            JSON.parse(request.body) as {
              items: Array<{ artifactKey: string }>;
            }
          ).items,
      );
    expect(itemChunks.map((items) => items.length)).toEqual([8, 6]);
    expect(new Set(itemChunks.flat().map((item) => item.artifactKey))).toHaveLength(14);
    expect(central.requests.filter((request) => request.path.endsWith("/seal"))).toHaveLength(1);
  });

  test("binds every reconciliation candidate to a unique validated history row", async () => {
    for (const [mutate, code] of [
      [
        (candidate: Record<string, unknown>) => {
          candidate.source = "history-page-0002.json";
        },
        "reconciliation_candidate_invalid",
      ],
      [
        (candidate: Record<string, unknown>) => {
          candidate.index = 1;
        },
        "reconciliation_candidate_invalid",
      ],
      [
        (candidate: Record<string, unknown>) => {
          candidate.fingerprint = "0".repeat(64);
        },
        "reconciliation_candidate_fingerprint_mismatch",
      ],
    ] as const) {
      const { source, reconciliation } = await successRun();
      const report = JSON.parse(
        new TextDecoder().decode(reconciliation.objects.get(REPORT_KEY)!.body),
      );
      mutate(report.entries[0].candidateRows[0]);
      await reconciliation.put(REPORT_KEY, report, {
        source: "v-point-pay-email-reconciliation",
        runId: RUN_ID,
      });
      await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(code);
    }

    const { source, reconciliation } = await successRun();
    const report = JSON.parse(
      new TextDecoder().decode(reconciliation.objects.get(REPORT_KEY)!.body),
    );
    report.entries[0].status = "ambiguous";
    report.entries[0].candidateRows.push({ ...report.entries[0].candidateRows[0] });
    await reconciliation.put(REPORT_KEY, report, {
      source: "v-point-pay-email-reconciliation",
      runId: RUN_ID,
    });
    await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(
      "reconciliation_candidate_duplicate",
    );
  });

  test("rejects a reconciliation count mismatch", async () => {
    const { source, reconciliation } = await successRun();
    const report = JSON.parse(
      new TextDecoder().decode(reconciliation.objects.get(REPORT_KEY)!.body),
    );
    report.entries[0].status = "unmatched";
    report.entries[0].candidateRows = [];
    await reconciliation.put(REPORT_KEY, report, {
      source: "v-point-pay-email-reconciliation",
      runId: RUN_ID,
    });
    await expect(importRun(source, reconciliation, new FakeCentral())).rejects.toThrow(
      "reconciliation_report_count_mismatch",
    );
  });

  test("accepts the exact audited legacy reconciliation match policy", async () => {
    const { source, reconciliation } = await successRun();
    const report = JSON.parse(
      new TextDecoder().decode(reconciliation.objects.get(REPORT_KEY)!.body),
    );
    report.policy.match = "exact JST date and explicit V Point amount";
    await reconciliation.put(REPORT_KEY, report, {
      source: "v-point-pay-email-reconciliation",
      runId: RUN_ID,
    });
    await expect(importRun(source, reconciliation, new FakeCentral())).resolves.toMatchObject({
      sealed: true,
    });
  });
});

async function successRun(): Promise<{
  source: FakeBucket;
  reconciliation: FakeBucket;
  manifest: Record<string, unknown>;
}> {
  const source = new FakeBucket();
  const reconciliation = new FakeBucket();
  const payloads: Array<[string, unknown]> = [
    ["balance-info", balance()],
    ["smfg-point", smfg()],
    ["history-page-0001", history(1, 1)],
    ["vmoney-history-page-0001", vmoney(0)],
    [
      "collection-summary",
      {
        schemaVersion: "vpoint-collection-summary-v2",
        historyTotal: 1,
        historyPageCount: 1,
        vMoneyHistoryTotal: 0,
        vMoneyHistoryPageCount: 1,
      },
    ],
  ];
  const artifacts = [];
  for (const [dataset, value] of payloads) {
    const body = new TextEncoder().encode(JSON.stringify(value));
    const hash = await sha256(body);
    await source.put(`${PREFIX}${dataset}.json`, value, { dataset, sha256: hash });
    artifacts.push({
      dataset,
      key: `${PREFIX}${dataset}.json`,
      mediaType: "application/json",
      sha256: hash,
      bytes: body.byteLength,
    });
  }
  const manifest = baseManifest({
    status: "success",
    historyTotal: 1,
    historyPageCount: 1,
    vMoneyHistoryTotal: 0,
    vMoneyHistoryPageCount: 1,
    artifacts,
    failures: [],
    emailReconciliation: {
      reportKey: REPORT_KEY,
      emailEventCount: 1,
      comparableCount: 1,
      matchedCount: 1,
      ambiguousCount: 0,
      unmatchedCount: 0,
      notComparableCount: 0,
      appLedgerStatus: "unavailable-no-live-snapshot",
    },
  });
  await source.put(MANIFEST_KEY, manifest, manifestMetadata("success"));
  await reconciliation.put(
    REPORT_KEY,
    {
      schemaVersion: "vpoint-pay-email-reconciliation-v1",
      runId: RUN_ID,
      completedAt: "2026-09-05T00:00:02.000Z",
      policy: {
        match:
          "exact JST date and explicit V Point amount, including an explicitly V Point-funded charge",
        mutation: "none",
        ambiguousMatchesRemainUnresolved: true,
      },
      sources: {
        vPointHistory: "current collector run",
        vPointPayEmail: "all normalized archived notifications",
        vPointPayApp: "unavailable-no-live-snapshot",
      },
      entries: [
        {
          emailEventId: "e".repeat(64),
          status: "matched",
          candidateRows: [
            {
              source: "history-page-0001.json",
              index: 0,
              fingerprint: await sha256(
                new TextEncoder().encode(
                  JSON.stringify(
                    (payloads[2]![1] as { results: { history: unknown[] } }).results.history[0],
                  ),
                ),
              ),
            },
          ],
        },
      ],
    },
    { source: "v-point-pay-email-reconciliation", runId: RUN_ID },
  );
  return { source, reconciliation, manifest };
}

function baseManifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "vpoint-worker-poc-v2",
    source: "v-point",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:00:02.000Z",
    ...overrides,
  };
}

function manifestMetadata(status: string): Record<string, string> {
  return { source: "v-point", status, runId: RUN_ID };
}

function envelope(results: unknown): unknown {
  return { status: { code: "0000", response: "" }, results };
}

function balance(): unknown {
  return envelope({
    common: [{ expiration: "", point: 10, point_type: 1 }],
    get_month: 1,
    store: [],
    tmoney: {},
  });
}

function smfg(): unknown {
  return envelope({ get_point: { point_smbc: 1, point_smcc: 2 } });
}

function history(total: number, rows: number): unknown {
  return envelope({
    graph: { monthly: [{ label: "2026-09", point: 1 }], yearly: [] },
    history: Array.from({ length: rows }, () => ({
      date_reflect: "20260905",
      date_use: "20260905",
      is_use_mbo: false,
      point: -1,
      point_div: 1,
      point_type: 1,
      reason: "",
      store_alliance_name: "",
      store_category: "",
      store_company: "",
      store_name: "",
    })),
    total,
  });
}

function vmoney(total: number): unknown {
  return envelope({ history: total === 0 ? [] : [{}], total });
}

async function replaceArtifact(bucket: FakeBucket, dataset: string, value: unknown): Promise<void> {
  const key = `${PREFIX}${dataset}.json`;
  const body = new TextEncoder().encode(JSON.stringify(value));
  const hash = await sha256(body);
  await bucket.put(key, value, { dataset, sha256: hash });
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
  const artifact = manifest.artifacts.find(
    (candidate: Record<string, unknown>) => candidate.dataset === dataset,
  );
  artifact.sha256 = hash;
  artifact.bytes = body.byteLength;
  await bucket.put(MANIFEST_KEY, manifest, manifestMetadata(manifest.status));
}

async function importRun(
  source: FakeBucket,
  reconciliation: FakeBucket,
  central: FakeCentral,
  offset = 0,
  immediate = true,
  importerVersion = "test-v1",
) {
  return importVPointRun({
    bucket: source as unknown as R2Bucket,
    reconciliationBucket: reconciliation as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: "ab".repeat(32),
    importerVersion,
    manifestKey: MANIFEST_KEY,
    offset,
    immediate,
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", owned(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function descriptorHash(descriptor: Record<string, unknown>): Promise<string> {
  const {
    http,
    storage,
    file,
    email,
    fetchUnitId,
    pageGroupId,
    pageIndex,
    ranges,
    transformSteps,
    relations,
    ...fields
  } = descriptor;
  return sha256(
    new TextEncoder().encode(
      canonicalJson({
        ...fields,
        fetchUnitId: fetchUnitId ?? null,
        pageGroupId: pageGroupId ?? null,
        pageIndex: pageIndex ?? null,
        origins: {
          http: http ?? null,
          storage:
            storage === undefined || storage === null
              ? null
              : {
                  ...(storage as Record<string, unknown>),
                  objectVersion: (storage as Record<string, unknown>).objectVersion ?? null,
                  etag: (storage as Record<string, unknown>).etag ?? null,
                  lastModifiedAtMs: (storage as Record<string, unknown>).lastModifiedAtMs ?? null,
                  lastModifiedAtBasis:
                    (storage as Record<string, unknown>).lastModifiedAtBasis ?? null,
                },
          file: file ?? null,
          email: email ?? null,
        },
        ranges: ranges ?? [],
        transformSteps: transformSteps ?? [],
        relations: relations ?? [],
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
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function owned(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
