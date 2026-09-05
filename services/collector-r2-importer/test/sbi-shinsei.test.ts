import { describe, expect, test } from "bun:test";
import { importSbiShinseiRun, parseSbiShinseiManifest } from "../src/sbi-shinsei";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-shinsei/2026/08/31/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-sbi-shinsei.${"n".repeat(32)}`;
const FINGERPRINT_KEY = "de".repeat(32);
const DATASETS = [
  "top-accounts-balance-and-activity",
  "balance-summary-and-stage",
  "exchange-rate",
  "yen-deposit-account",
  "normalized",
] as const;
const FILENAMES: Record<(typeof DATASETS)[number], string> = {
  "top-accounts-balance-and-activity": "raw-top-accounts-balance-and-activity.json",
  "balance-summary-and-stage": "raw-balance-summary-and-stage.json",
  "exchange-rate": "raw-exchange-rate.json",
  "yen-deposit-account": "raw-yen-deposit-account.json",
  normalized: "normalized.json",
};

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
  liveReadsEnabled: boolean;
  artifacts: Array<{
    dataset: string;
    key: string;
    mediaType: string;
    sha256: string;
    bytes: number;
  }>;
  failures: Array<{ operation: string; errorType: string; message: string }>;
  window?: { from: string; to: string };
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
      checksums: value.nativeSha256 ? { sha256: hexBytes(value.nativeSha256).buffer } : {},
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
  readonly reports = new Map<string, string>();

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      expect(request.headers.get("x-kogane-byte-size")).toBe(String(bytes.byteLength));
      const reused = this.uploaded.has(path);
      this.uploaded.set(path, bytes);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (/\/units$/u.test(path)) return Response.json({ unitId: 10 }, { status: 201 });
    if (/\/artifacts$/u.test(path)) {
      return Response.json({ descriptorSha256: "1".repeat(64) }, { status: 201 });
    }
    if (/\/reports$/u.test(path)) return immutableReport(this.reports, path, body);
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("SBI Shinsei staged-run importer", () => {
  test("validates raw meaning, preserves safe bytes, and replays idempotently", async () => {
    const bucket = new FakeBucket();
    const { manifest, bodies } = await storeSuccessRun(bucket);
    const central = new FakeCentral();
    const first = await importRun(bucket, central);
    expect(first).toMatchObject({
      source: "sbi-shinsei",
      manifestKey: MANIFEST_KEY,
      artifactCount: 6,
      sealed: true,
      allObjectsReused: false,
    });
    for (const artifact of manifest.artifacts) {
      expect(central.uploaded.get(`/v1/runs/1/objects/${artifact.sha256}`)).toEqual(
        bodies.get(artifact.dataset),
      );
    }
    expect(central.requests).toHaveLength(17);
    expect(
      JSON.parse(central.requests.find((request) => request.path === "/v1/runs")!.body),
    ).toEqual({
      producerId: "collector-r2-importer",
      sourceId: "sbi-shinsei-bank",
      externalIdNamespace: "sbi-shinsei-worker-poc-v1",
      externalSessionId: RUN_ID,
      sourceRunKey: "current-snapshot-sbi-shinsei-r2-v2",
    });
    const runReport = central.requests.find((request) => request.path === "/v1/runs/1/reports");
    expect(runReport ? JSON.parse(runReport.body) : undefined).toMatchObject({
      producerVersion: "sbi-shinsei-r2-v2",
    });
    const topDescriptor = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((body) => body.dataset === "top-accounts-balance-and-activity")!;
    expect(topDescriptor).toMatchObject({
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
    });

    const replay = await importRun(bucket, central, "test-v99");
    expect(replay.allObjectsReused).toBe(true);
    expect(central.uploaded.size).toBe(6);
  });

  test("removes a legacy rotating CSRF token before central storage", async () => {
    const bucket = new FakeBucket();
    const { manifest } = await storeSuccessRun(bucket);
    const top = manifest.artifacts[0]!;
    const payload = JSON.parse(decode(bucket.objects.get(top.key)!.body));
    payload.header.newToken = "synthetic-rotating-token";
    await replaceArtifact(
      bucket,
      "top-accounts-balance-and-activity",
      encode(JSON.stringify(payload)),
    );
    const central = new FakeCentral();
    await importRun(bucket, central);
    const uploaded = decode([...central.uploaded.values()][0]!);
    expect(uploaded).not.toContain("synthetic-rotating-token");
    expect(uploaded).not.toContain("newToken");
  });

  test("accepts the exact legacy window shape and verifies it against the raw activity", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket, { legacyWindow: true, legacyMetadata: true });
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({ sealed: true });
    const run = JSON.parse(central.requests.find((request) => request.path === "/v1/runs")!.body);
    expect(run.externalIdNamespace).toBe("sbi-shinsei-worker-poc-v1-legacy-window");

    const manifest = readManifest(bucket);
    manifest.window = { from: "2026-08-02", to: "2026-08-31" };
    await replaceManifest(bucket, manifest);
    const rejected = new FakeCentral();
    await expect(importRun(bucket, rejected)).rejects.toMatchObject({
      status: 409,
      code: "manifest_window_payload_mismatch",
    });
    expect(rejected.requests).toHaveLength(0);
  });

  test("accepts a capture-bounded legacy window when the provider omits toDate", async () => {
    const bucket = new FakeBucket();
    const { manifest } = await storeSuccessRun(bucket, {
      legacyWindow: true,
      legacyMetadata: true,
    });
    const top = manifest.artifacts.find(
      (artifact) => artifact.dataset === "top-accounts-balance-and-activity",
    )!;
    const payload = JSON.parse(decode(bucket.objects.get(top.key)!.body));
    const activity = topActivity(payload);
    activity.fromDate = "2026-07-01";
    activity.toDate = "";
    await replaceArtifact(
      bucket,
      "top-accounts-balance-and-activity",
      encode(JSON.stringify(payload)),
    );

    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({ sealed: true });
    const topDescriptor = central.requests
      .filter((request) => /\/artifacts$/u.test(request.path))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .find((body) => body.dataset === "top-accounts-balance-and-activity")!;
    expect(topDescriptor).not.toHaveProperty("ranges");
  });

  test("rejects unsafe legacy empty-toDate window boundaries", async () => {
    const cases: Array<{
      name: string;
      mutateActivity?: (activity: ReturnType<typeof topActivity>) => void;
      mutateManifest?: (manifest: TestManifest) => void;
    }> = [
      {
        name: "raw fromDate after the declared window start",
        mutateActivity: (activity) => {
          activity.fromDate = "2026-08-02";
        },
      },
      {
        name: "posting date before the raw response start",
        mutateActivity: (activity) => {
          activity.fromDate = "2026-08-01";
          activity.activityDetails[0]!.postingDate = "2026-07-31";
        },
      },
      {
        name: "posting date after the capture date",
        mutateActivity: (activity) => {
          activity.activityDetails[0]!.postingDate = "2026-09-01";
        },
      },
      {
        name: "window end different from the capture date",
        mutateManifest: (manifest) => {
          manifest.window!.to = "2026-08-30";
        },
      },
    ];

    for (const fixture of cases) {
      const bucket = new FakeBucket();
      const entries = await successEntries();
      const topEntry = entries.find(
        (entry) => entry.dataset === "top-accounts-balance-and-activity",
      )!;
      const activity = topActivity(topEntry.body);
      activity.fromDate = "2026-07-01";
      activity.toDate = "";
      fixture.mutateActivity?.(activity);
      const manifest = await storeManifest(
        bucket,
        entries.filter((entry) => entry.dataset !== "normalized"),
        [
          {
            operation: "derive:normalized",
            errorType: "DerivationError",
            message: "normalized_derivation_failed",
          },
        ],
        { legacyWindow: true, legacyMetadata: true },
      );
      fixture.mutateManifest?.(manifest);
      if (fixture.mutateManifest) await replaceManifest(bucket, manifest, true);

      const central = new FakeCentral();
      await expect(importRun(bucket, central), fixture.name).rejects.toMatchObject({
        status: 409,
        code: "manifest_window_payload_mismatch",
      });
      expect(central.requests, fixture.name).toHaveLength(0);
    }
  });

  test("accepts the deployed no-window shape with legacy metadata independently", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket, { legacyMetadata: true });
    await expect(importRun(bucket, new FakeCentral())).resolves.toMatchObject({ sealed: true });
  });

  test("seals a terminal browser failure containing only its manifest", async () => {
    const bucket = new FakeBucket();
    await storeManifest(
      bucket,
      [],
      [
        {
          operation: "collect",
          errorType: "Error",
          message: "collector_request_failed",
        },
      ],
    );
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      artifactCount: 1,
      sealed: true,
    });
    const report = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path));
    expect(JSON.parse(report!.body)).toMatchObject({
      producerStatus: "failed",
      safeFailureCode: "collector-browser-failed",
      declaredArtifactCount: 0,
    });
  });

  test("sanitizes failure diagnostics in current and legacy partial and failed manifests", async () => {
    const privateDiagnostic = "synthetic-private-diagnostic-7f0d6f5c";
    for (const legacyWindow of [false, true]) {
      for (const partial of [false, true]) {
        const bucket = new FakeBucket();
        const entries = partial
          ? (await successEntries()).filter((entry) => entry.dataset !== "exchange-rate")
          : [];
        await storeManifest(
          bucket,
          entries,
          partial
            ? [{ operation: "r2:exchange-rate", errorType: "Error", message: privateDiagnostic }]
            : [{ operation: "collect", errorType: "Error", message: privateDiagnostic }],
          { legacyWindow, legacyMetadata: legacyWindow },
        );
        expect(readManifest(bucket).failures[0]!.message).toBe(privateDiagnostic);

        const central = new FakeCentral();
        await expect(importRun(bucket, central)).resolves.toMatchObject({ sealed: true });
        const centralText = [
          ...central.requests.map((request) => request.body),
          ...[...central.uploaded.values()].map(decode),
        ].join("\n");
        expect(centralText).not.toContain(privateDiagnostic);

        const centralManifest = [...central.uploaded.values()]
          .map((bytes) => JSON.parse(decode(bytes)) as Record<string, unknown>)
          .find((value) => value.source === "sbi-shinsei" && Array.isArray(value.failures));
        expect(centralManifest).toBeDefined();
        expect((centralManifest!.failures as TestManifest["failures"])[0]!.message).toBe(
          partial ? "staging_write_failed" : "collector_request_failed",
        );

        const descriptor = central.requests
          .filter((request) => /\/artifacts$/u.test(request.path))
          .map((request) => JSON.parse(request.body) as Record<string, unknown>)
          .find((value) => value.dataset === "collector-manifest");
        expect(descriptor).toMatchObject({
          artifactRole: "collector_derived",
          payloadFidelity: "transformed",
          lineageDisposition: "source_not_retained_for_security",
          transformSteps: [
            { stepIndex: 0, stepKind: "transport_decoded" },
            { stepIndex: 1, stepKind: "redacted" },
            { stepIndex: 2, stepKind: "reencoded" },
          ],
        });
      }
    }
  });

  test("requires an exact artifact/failure complement and safe failure text", async () => {
    const partial = new FakeBucket();
    const entries = await successEntries();
    await storeManifest(
      partial,
      entries.filter((entry) => entry.dataset !== "exchange-rate"),
      [{ operation: "r2:exchange-rate", errorType: "Error", message: "staging_write_failed" }],
    );
    await expect(importRun(partial, new FakeCentral())).resolves.toMatchObject({
      artifactCount: 5,
      sealed: true,
    });

    const wrong = readManifest(partial);
    wrong.failures[0]!.operation = "r2:yen-deposit-account";
    await replaceManifest(partial, wrong);
    expect(() =>
      parseSbiShinseiManifest(partial.objects.get(MANIFEST_KEY)!.body, MANIFEST_KEY),
    ).toThrow("manifest_failure_complement_mismatch");

    const unsafe = new FakeBucket();
    await storeManifest(
      unsafe,
      [],
      [
        {
          operation: "collect",
          errorType: "Error",
          message: "token=fixture-secret",
        },
      ],
    );
    expect(() =>
      parseSbiShinseiManifest(unsafe.objects.get(MANIFEST_KEY)!.body, MANIFEST_KEY),
    ).toThrow("manifest_failure_message_invalid");
  });

  test("catalogues a validated provider-read prefix as partial evidence", async () => {
    const bucket = new FakeBucket();
    const entries = await successEntries();
    await storeManifest(
      bucket,
      entries.filter(
        (entry) => entry.dataset !== "exchange-rate" && entry.dataset !== "yen-deposit-account",
      ),
      [
        {
          operation: "read:exchange-rate",
          errorType: "ProviderReadError",
          message: "provider_read_failed",
        },
        {
          operation: "read:yen-deposit-account",
          errorType: "NotAttempted",
          message: "provider_read_not_attempted",
        },
      ],
    );
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      artifactCount: 4,
      sealed: true,
    });
    const report = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path));
    expect(JSON.parse(report!.body)).toMatchObject({
      producerStatus: "partial",
      safeFailureCode: "provider-read-incomplete",
    });
  });

  test("catalogues valid later raw responses when the top schema drifts", async () => {
    const bucket = new FakeBucket();
    const entries = await successEntries();
    await storeManifest(
      bucket,
      entries.filter(
        (entry) =>
          entry.dataset !== "top-accounts-balance-and-activity" && entry.dataset !== "normalized",
      ),
      [
        {
          operation: "read:top-accounts-balance-and-activity",
          errorType: "ResponseSchemaError",
          message: "provider_response_invalid",
        },
        {
          operation: "derive:normalized",
          errorType: "DependencyInvalid",
          message: "normalized_source_invalid",
        },
      ],
    );
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      artifactCount: 4,
      sealed: true,
    });
    const report = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path));
    expect(JSON.parse(report!.body)).toMatchObject({
      producerStatus: "partial",
      safeFailureCode: "provider-read-incomplete",
      declaredArtifactCount: 3,
    });
  });

  test("catalogues all strict raw responses when normalized derivation fails", async () => {
    const bucket = new FakeBucket();
    const entries = await successEntries();
    await storeManifest(
      bucket,
      entries.filter((entry) => entry.dataset !== "normalized"),
      [
        {
          operation: "derive:normalized",
          errorType: "DerivationError",
          message: "normalized_derivation_failed",
        },
      ],
    );
    const central = new FakeCentral();
    await expect(importRun(bucket, central)).resolves.toMatchObject({
      artifactCount: 5,
      sealed: true,
    });
    const report = central.requests.find((request) => /\/units\/10\/reports$/u.test(request.path));
    expect(JSON.parse(report!.body)).toMatchObject({
      producerStatus: "partial",
      safeFailureCode: "normalized-derivation-failed",
      declaredArtifactCount: 4,
    });
  });

  test("requires normalized balance timestamps even when the top R2 write failed", async () => {
    const bucket = new FakeBucket();
    const entries = await successEntries();
    const normalized = entries.find((entry) => entry.dataset === "normalized")!;
    (normalized.body as { balances: Array<{ asOf: string }> }).balances[0]!.asOf =
      "2026-08-31T00:00:31.000Z";
    await storeManifest(
      bucket,
      entries.filter((entry) => entry.dataset !== "top-accounts-balance-and-activity"),
      [
        {
          operation: "r2:top-accounts-balance-and-activity",
          errorType: "Error",
          message: "staging_write_failed",
        },
      ],
    );
    await expect(importRun(bucket, new FakeCentral())).rejects.toMatchObject({
      status: 409,
      code: "normalized_capture_time_mismatch",
    });
  });

  test("rejects prefix, metadata, checksum, and normalized semantic mismatches before central state", async () => {
    const cases: Array<{
      code: string;
      mutate: (bucket: FakeBucket, manifest: TestManifest) => Promise<void> | void;
    }> = [
      {
        code: "prefix_inventory_too_large",
        mutate: (bucket) => {
          bucket.objects.set(
            `${PREFIX}unexpected.json`,
            stored(encode("{}"), {}, "application/json"),
          );
        },
      },
      {
        code: "artifact_metadata_mismatch",
        mutate: (bucket, manifest) => {
          bucket.objects.get(manifest.artifacts[0]!.key)!.customMetadata.extra = "not-allowed";
        },
      },
      {
        code: "artifact_checksum_mismatch",
        mutate: (bucket, manifest) => {
          const body = bucket.objects.get(manifest.artifacts[0]!.key)!.body;
          body[0] = body[0]! ^ 1;
        },
      },
      {
        code: "normalized_payload_mismatch",
        mutate: async (bucket) => {
          const body = JSON.parse(decode(bucket.objects.get(`${PREFIX}normalized.json`)!.body));
          body.balances[0].balance = "999999";
          await replaceArtifact(bucket, "normalized", encode(JSON.stringify(body)));
        },
      },
    ];
    for (const fixture of cases) {
      const bucket = new FakeBucket();
      const { manifest } = await storeSuccessRun(bucket);
      await fixture.mutate(bucket, manifest);
      const central = new FakeCentral();
      await expect(importRun(bucket, central)).rejects.toMatchObject({ code: fixture.code });
      expect(central.requests).toHaveLength(0);
    }
  });

  test("does not accept another collector credential", async () => {
    const bucket = new FakeBucket();
    await storeSuccessRun(bucket);
    await expect(
      importSbiShinseiRun({
        bucket: bucket as unknown as R2Bucket,
        centralService: new FakeCentral() as unknown as Fetcher,
        centralToken: `collector-r2-sbi.${"s".repeat(32)}`,
        fingerprintKey: FINGERPRINT_KEY,
        importerVersion: "test-v1",
        manifestKey: MANIFEST_KEY,
      }),
    ).rejects.toThrow("central_auth_configuration_invalid");
  });
});

async function successEntries() {
  const core = (await Bun.file(
    new URL("../../../poc/sbi-shinsei-worker/test/fixtures/core-responses.json", import.meta.url),
  ).json()) as Record<string, unknown>;
  const capturedAt = "2026-08-31T00:00:30.000Z";
  return [
    { dataset: DATASETS[0], body: core.topBalances },
    { dataset: DATASETS[1], body: core.balanceSummary },
    { dataset: DATASETS[2], body: core.exchangeRate },
    { dataset: DATASETS[3], body: core.yenDeposit },
    {
      dataset: DATASETS[4],
      body: {
        schemaVersion: "sbi-shinsei-v1",
        capturedAt,
        balances: [
          {
            accountKey: "synthetic-account-1",
            product: "yen-savings",
            currency: "JPY",
            balance: "100000",
            yenEquivalent: "100000",
            asOf: capturedAt,
          },
          {
            accountKey: "synthetic-account-2",
            product: "hyper-yokin",
            currency: "JPY",
            balance: "200000",
            yenEquivalent: "200000",
            asOf: capturedAt,
          },
        ],
        transactions: [
          {
            accountKey: "synthetic-account-1",
            transactionDate: "2026-08-30",
            description: "SYNTHETIC CREDIT",
            debit: null,
            credit: "1000",
            balance: "100000",
            currency: "JPY",
          },
        ],
      },
    },
  ];
}

async function storeSuccessRun(
  bucket: FakeBucket,
  options: { legacyWindow?: boolean; legacyMetadata?: boolean } = {},
) {
  const entries = await successEntries();
  const manifest = await storeManifest(bucket, entries, [], options);
  return {
    manifest,
    bodies: new Map<string, Uint8Array>(
      entries.map((entry) => [entry.dataset, encode(JSON.stringify(entry.body))]),
    ),
  };
}

async function storeManifest(
  bucket: FakeBucket,
  entries: Array<{ dataset: string; body: unknown }>,
  failures: TestManifest["failures"],
  options: { legacyWindow?: boolean; legacyMetadata?: boolean } = {},
): Promise<TestManifest> {
  const artifacts = [];
  for (const entry of entries) {
    const body = encode(JSON.stringify(entry.body));
    const sha256 = await digest(body);
    const key = `${PREFIX}${FILENAMES[entry.dataset as keyof typeof FILENAMES]}`;
    bucket.objects.set(
      key,
      stored(
        body,
        options.legacyMetadata
          ? { dataset: entry.dataset, sha256 }
          : { source: "sbi-shinsei", runId: RUN_ID, dataset: entry.dataset, sha256 },
        "application/json",
      ),
    );
    artifacts.push({
      dataset: entry.dataset,
      key,
      mediaType: "application/json",
      sha256,
      bytes: body.byteLength,
    });
  }
  const manifest: TestManifest = {
    schemaVersion: "sbi-shinsei-worker-poc-v1",
    source: "sbi-shinsei",
    runId: RUN_ID,
    startedAt: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:01:00.000Z",
    status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
    liveReadsEnabled: true,
    artifacts,
    failures,
    ...(options.legacyWindow ? { window: { from: "2026-08-01", to: "2026-08-31" } } : {}),
  };
  await replaceManifest(bucket, manifest, options.legacyMetadata);
  return manifest;
}

async function replaceArtifact(
  bucket: FakeBucket,
  dataset: (typeof DATASETS)[number],
  body: Uint8Array,
): Promise<void> {
  const manifest = readManifest(bucket);
  const artifact = manifest.artifacts.find((value) => value.dataset === dataset)!;
  const sha256 = await digest(body);
  const previous = bucket.objects.get(artifact.key)!;
  bucket.objects.set(
    artifact.key,
    stored(
      body,
      Object.hasOwn(previous.customMetadata, "source")
        ? { source: "sbi-shinsei", runId: RUN_ID, dataset, sha256 }
        : { dataset, sha256 },
      "application/json",
    ),
  );
  artifact.sha256 = sha256;
  artifact.bytes = body.byteLength;
  await replaceManifest(bucket, manifest);
}

async function replaceManifest(
  bucket: FakeBucket,
  manifest: TestManifest,
  legacyMetadata = bucket.objects.has(MANIFEST_KEY) &&
    !Object.hasOwn(bucket.objects.get(MANIFEST_KEY)!.customMetadata, "sha256"),
): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  const sha256 = await digest(body);
  bucket.objects.set(
    MANIFEST_KEY,
    stored(
      body,
      legacyMetadata
        ? { source: "sbi-shinsei", status: manifest.status, runId: RUN_ID }
        : { source: "sbi-shinsei", status: manifest.status, runId: RUN_ID, sha256 },
      "application/json",
    ),
  );
}

function readManifest(bucket: FakeBucket): TestManifest {
  return JSON.parse(decode(bucket.objects.get(MANIFEST_KEY)!.body)) as TestManifest;
}

function topActivity(value: unknown): {
  fromDate: unknown;
  toDate: unknown;
  activityDetails: Array<{ postingDate: unknown }>;
} {
  return (
    value as {
      responseParam: {
        activity: {
          responseParam: {
            fromDate: unknown;
            toDate: unknown;
            activityDetails: Array<{ postingDate: unknown }>;
          };
        };
      };
    }
  ).responseParam.activity.responseParam;
}

function importRun(bucket: FakeBucket, central: FakeCentral, importerVersion = "test-v1") {
  return importSbiShinseiRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion,
    manifestKey: MANIFEST_KEY,
  });
}

function immutableReport(reports: Map<string, string>, path: string, body: string): Response {
  const previous = reports.get(path);
  if (previous !== undefined && previous !== body) {
    return Response.json({ error: "immutable report conflict" }, { status: 409 });
  }
  reports.set(path, body);
  return Response.json(
    { reused: previous !== undefined },
    {
      status: previous === undefined ? 201 : 200,
    },
  );
}

function stored(
  body: Uint8Array,
  customMetadata: Record<string, string>,
  contentType: string,
): StoredObject {
  return { body, customMetadata, contentType };
}

async function digest(body: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(body)));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
