import { describe, expect, test } from "bun:test";
import { importMyJcbRun, validateMyJcbRun } from "../src/myjcb";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/myjcb/2026/09/05/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-myjcb.${"j".repeat(32)}`;
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
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Set<string>();
  readonly inventoryItems = new Set<string>();
  readonly seals: number[] = [];
  readonly uploadedBodies: string[] = [];
  readonly unitIds = new Map<string, number>();
  failNextInventoryItems = false;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const reused = this.uploaded.has(path);
      this.uploaded.add(path);
      this.uploadedBodies.push(body);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) {
      const connection = (JSON.parse(body) as { unitKey: string }).unitKey;
      if (!this.unitIds.has(connection)) this.unitIds.set(connection, 10 + this.unitIds.size);
      return Response.json({ unitId: this.unitIds.get(connection)! }, { status: 201 });
    }
    if (path.endsWith("/inventories")) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (path.endsWith("/items")) {
      if (this.failNextInventoryItems) {
        this.failNextInventoryItems = false;
        return Response.json({ error: "temporary" }, { status: 503 });
      }
      const items = (JSON.parse(body) as { items: Array<{ artifactKey: string }> }).items;
      for (const item of items) this.inventoryItems.add(item.artifactKey);
      return Response.json({ ok: true }, { status: 201 });
    }
    if (path.endsWith("/artifacts")) {
      return Response.json(
        {
          descriptorSha256: await normalizedDescriptorSha256(JSON.parse(body)),
        },
        { status: 201 },
      );
    }
    if (path.endsWith("/seal")) {
      this.seals.push(1);
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

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

    const replayFirst = await runImport(bucket, central);
    if (replayFirst.status !== "deferred") throw new Error("expected deferred replay");
    const replaySecond = await runImport(bucket, central, replayFirst.continuation);
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

async function runImport(bucket: FakeBucket, central: FakeCentral, continuation?: string) {
  return importMyJcbRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion: "collector-r2-importer-test",
    manifestKey: MANIFEST_KEY,
    ...(continuation ? { continuation } : {}),
  });
}

async function storeSuccessRun(bucket: FakeBucket): Promise<void> {
  const artifacts = [
    await putArtifact(
      bucket,
      "primary",
      "credit-menu",
      "credit-menu.html",
      html("credit-menu", "<span>detailMonth generalJsonShikibetuId</span>"),
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-past-months",
      "credit-past-months.json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "030100601",
        result: {
          errId: "",
          errMessage: "",
          detailPastJsonInfo: [
            {
              detailAvailableFlag: true,
              detailMonth: "0",
              payAmount: "0",
              payAmountDispFlag: true,
              settlementYM: "2026年9月",
            },
            {
              detailAvailableFlag: true,
              detailMonth: "1",
              payAmount: "0",
              payAmountDispFlag: true,
              settlementYM: "2026年8月",
            },
          ],
        },
      }),
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-detail",
      "credit-detail-00.html",
      html("credit-detail", '<a href="/iss-pc/member/details_inquiry/current">detail</a>'),
      "unconfirmed",
      "detailMonth-0",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-ledger",
      "credit-ledger-00.json",
      ledger(0, "detailMonth-0", "unconfirmed"),
      "unconfirmed",
      "detailMonth-0",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-detail",
      "credit-detail-01.html",
      html("credit-detail", '<a href="/iss-pc/member/details_inquiry/previous">detail</a>'),
      "confirmed",
      "detailMonth-1",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-ledger",
      "credit-ledger-01.json",
      ledger(1, "detailMonth-1", "confirmed"),
      "confirmed",
      "detailMonth-1",
    ),
    await putArtifact(
      bucket,
      "primary",
      "discovery",
      "discovery.json",
      JSON.stringify({
        schemaVersion: 1,
        bootstrapMode: "passkey",
        cards: [{ localId: "card-001", productHint: "JCB W", switchCandidate: false }],
        periodCount: 2,
        cookieCount: 3,
        limitations: [
          "Root-card switching remains discovery-only until its current POST contract is observed.",
          "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter.",
        ],
      }),
    ),
  ];
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    trigger: "manual",
    connections: [
      {
        connectionId: "primary",
        bootstrapMode: "passkey",
        status: "success",
        cardCount: 1,
        periodCount: 2,
        artifactCount: artifacts.length,
      },
    ],
    artifacts,
    failures: [],
  });
}

async function storeFailedRun(bucket: FakeBucket): Promise<void> {
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "failed",
    trigger: "scheduled",
    connections: [
      {
        connectionId: "primary",
        bootstrapMode: "passkey",
        status: "failed",
        cardCount: 0,
        periodCount: 0,
        artifactCount: 0,
        blocker: "collect-credit",
      },
    ],
    artifacts: [],
    failures: [
      {
        connectionId: "primary",
        operation: "collect",
        errorType: "StopConditionError",
        message: "collect-credit",
      },
    ],
  });
}

async function storeMaxConnectionsRun(bucket: FakeBucket): Promise<void> {
  const artifacts: Array<Record<string, unknown>> = [];
  const connections: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 16; index += 1) {
    const connectionId = `account-${String(index).padStart(2, "0")}`;
    const connectionArtifacts = [
      await putArtifact(
        bucket,
        connectionId,
        "credit-menu",
        "credit-menu.html",
        html("credit-menu", "<span>detailMonth generalJsonShikibetuId</span>"),
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-past-months",
        "credit-past-months.json",
        JSON.stringify({
          jsonrpc: "2.0",
          id: "030100601",
          result: {
            errId: "",
            errMessage: "",
            detailPastJsonInfo: [
              {
                detailAvailableFlag: true,
                detailMonth: "0",
                payAmount: "0",
                payAmountDispFlag: true,
                settlementYM: "2026年9月",
              },
            ],
          },
        }),
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-detail",
        "credit-detail-00.html",
        html("credit-detail", '<a href="/iss-pc/member/details_inquiry/current">detail</a>'),
        "unconfirmed",
        "detailMonth-0",
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-ledger",
        "credit-ledger-00.json",
        ledger(0, "detailMonth-0", "unconfirmed"),
        "unconfirmed",
        "detailMonth-0",
      ),
      await putArtifact(
        bucket,
        connectionId,
        "discovery",
        "discovery.json",
        JSON.stringify({
          schemaVersion: 1,
          bootstrapMode: "passkey",
          cards: [{ localId: "card-001", productHint: "JCB W", switchCandidate: false }],
          periodCount: 1,
          cookieCount: 1,
          limitations: [
            "Root-card switching remains discovery-only until its current POST contract is observed.",
            "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter.",
          ],
        }),
      ),
    ];
    artifacts.push(...connectionArtifacts);
    connections.push({
      connectionId,
      bootstrapMode: "passkey",
      status: "success",
      cardCount: 1,
      periodCount: 1,
      artifactCount: connectionArtifacts.length,
    });
  }
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    trigger: "manual",
    connections,
    artifacts,
    failures: [],
  });
}

async function putArtifact(
  bucket: FakeBucket,
  connectionId: string,
  dataset: string,
  filename: string,
  text: string,
  statementState?: string,
  period?: string,
): Promise<Record<string, unknown>> {
  const body = encode(text);
  const sha256 = await sha256Hex(body);
  const mediaType = filename.endsWith(".html") ? "text/html; charset=utf-8" : "application/json";
  const key = `${PREFIX}${connectionId}/${filename}`;
  bucket.objects.set(
    key,
    await stored(body, mediaType, {
      source: "myjcb",
      dataset,
      sha256,
      ...(statementState ? { statementState } : {}),
      ...(period ? { period } : {}),
    }),
  );
  return {
    dataset,
    key,
    mediaType,
    sha256,
    bytes: body.byteLength,
    ...(statementState ? { statementState } : {}),
    ...(period ? { period } : {}),
  };
}

async function putManifest(bucket: FakeBucket, manifest: Record<string, unknown>): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(
    MANIFEST_KEY,
    await stored(body, "application/json", {
      source: "myjcb",
      status: String(manifest.status),
      runId: RUN_ID,
    }),
  );
}

async function rewriteArtifactHash(
  bucket: FakeBucket,
  key: string,
  body: Uint8Array,
): Promise<void> {
  const manifestObject = bucket.objects.get(MANIFEST_KEY)!;
  const manifest = JSON.parse(new TextDecoder().decode(manifestObject.body)) as {
    artifacts: Array<{ key: string; sha256: string; bytes: number }>;
  } & Record<string, unknown>;
  const artifact = manifest.artifacts.find((entry) => entry.key === key)!;
  artifact.sha256 = await sha256Hex(body);
  artifact.bytes = body.byteLength;
  await putManifest(bucket, manifest);
}

function readManifest(bucket: FakeBucket): {
  status: string;
  artifacts: Array<{ dataset: string; key: string; sha256: string; bytes: number }>;
  connections: Array<{ status: string; artifactCount: number; blocker?: string }>;
  failures: Array<{ connectionId: string; operation: string; errorType: string; message: string }>;
} & Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
}

async function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<StoredObject> {
  return { body, contentType, customMetadata, nativeSha256: await sha256Hex(body) };
}

function html(_dataset: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB details_inquiry ${body}</body></html>`;
}

function ledger(detailMonth: number, period: string, state: "confirmed" | "unconfirmed"): string {
  return JSON.stringify({
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers:
      state === "unconfirmed"
        ? ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"]
        : ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"],
    rows: [],
  });
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
