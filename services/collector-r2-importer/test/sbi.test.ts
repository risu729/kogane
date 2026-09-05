import { describe, expect, test } from "bun:test";
import { ImportError, importSbiRun, parseSbiManifest } from "../src/sbi";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-securities/2026/09/03/${RUN_ID}/`;
const KEY = `${PREFIX}manifest.json`;
const TOKEN = `collector-r2-sbi.${"s".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);

interface StoredObject {
  body: Uint8Array;
  customMetadata?: Record<string, string>;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.body.byteLength,
      customMetadata: stored.customMetadata,
      arrayBuffer: async () => stored.body.slice().buffer,
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
  readonly requests: Array<{ url: string; method: string; body: string }> = [];
  readonly uploaded = new Map<string, Uint8Array>();
  readonly reports = new Map<string, string>();
  nextUnitId = 10;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ url: request.url, method: request.method, body });
    const path = new URL(request.url).pathname;
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const body = new Uint8Array(await request.arrayBuffer());
      expect(request.headers.get("x-kogane-byte-size")).toBe(String(body.byteLength));
      this.uploaded.set(path, body);
      return Response.json({ reused: false }, { status: 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (/\/units$/u.test(path)) {
      return Response.json({ unitId: this.nextUnitId++ }, { status: 201 });
    }
    if (/\/artifacts$/u.test(path)) {
      const body = (await request.json()) as { artifactKey: string };
      const byte = body.artifactKey === "manifest.json" ? "b" : "a";
      return Response.json({ descriptorSha256: byte.repeat(64) }, { status: 201 });
    }
    if (/\/reports$/u.test(path)) return immutableReport(this.reports, path, body);
    if (/\/seal$/u.test(path)) return Response.json({ sealed: true }, { status: 201 });
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("SBI staged-run importer", () => {
  test("preserves exact bytes and seals seven data artifacts plus the manifest", async () => {
    const datasets = [
      "domestic-cash-positions",
      "account-assets-current",
      "yen-detail-history",
      "domestic-trade-records",
      "foreign-cash-positions",
      "foreign-cash-balances",
      "foreign-trade-records",
    ];
    const bucket = new FakeBucket();
    const artifacts = [];
    for (const [index, dataset] of datasets.entries()) {
      const body = new TextEncoder().encode(`{ "dataset": "${dataset}", "index": ${index} }\n`);
      const sha256 = await digest(body);
      const key = `${PREFIX}${dataset}.json`;
      bucket.objects.set(key, { body, customMetadata: { dataset, sha256 } });
      artifacts.push({
        dataset,
        key,
        sha256,
        bytes: body.byteLength,
        ...(dataset.endsWith("trade-records")
          ? { window: { from: "2026-06-06", to: "2026-09-03" } }
          : {}),
      });
    }
    const manifest = manifestBytes({ artifacts });
    bucket.objects.set(KEY, { body: manifest, customMetadata: manifestMetadata() });
    const central = new FakeCentral();

    const result = await importSbiRun({
      bucket: bucket as unknown as R2Bucket,
      centralService: central as unknown as Fetcher,
      centralToken: TOKEN,
      fingerprintKey: FINGERPRINT_KEY,
      importerVersion: "collector-r2-importer-v1",
      manifestKey: KEY,
    });

    expect(result).toMatchObject({ centralRunId: 1, artifactCount: 8, sealed: true });
    const runReport = central.requests.find(
      (request) => new URL(request.url).pathname === "/v1/runs/1/reports",
    );
    expect(runReport ? JSON.parse(runReport.body) : undefined).toMatchObject({
      producerVersion: "sbi-r2-v3",
    });
    expect(central.requests).toHaveLength(23);
    for (const artifact of artifacts) {
      const uploaded = central.uploaded.get(`/v1/runs/1/objects/${artifact.sha256}`);
      expect(uploaded).toEqual(bucket.objects.get(artifact.key)?.body);
    }
    const artifactBodies = central.requests
      .filter((request) => /\/artifacts$/u.test(new URL(request.url).pathname))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(artifactBodies.at(-1)).toMatchObject({
      artifactKey: "manifest.json",
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
    });
    expect(
      artifactBodies.find((body) => body.artifactKey === "foreign-trade-records.json"),
    ).toMatchObject({ containerKind: "bundle" });
    await expect(
      importSbiRun({
        bucket: bucket as unknown as R2Bucket,
        centralService: central as unknown as Fetcher,
        centralToken: TOKEN,
        fingerprintKey: FINGERPRINT_KEY,
        importerVersion: "collector-r2-importer-v99",
        manifestKey: KEY,
      }),
    ).resolves.toMatchObject({ centralRunId: 1, sealed: true });
  });

  test("rejects a corrupted source object before creating central state", async () => {
    const dataset = "domestic-cash-positions";
    const body = new TextEncoder().encode('{"value":1}');
    const declared = await digest(body);
    const bucket = new FakeBucket();
    const key = `${PREFIX}${dataset}.json`;
    bucket.objects.set(key, {
      body: new TextEncoder().encode('{"value":2}'),
      customMetadata: { dataset, sha256: declared },
    });
    bucket.objects.set(KEY, {
      body: manifestBytes({
        scope: "domestic",
        status: "partial",
        artifacts: [{ dataset, key, sha256: declared, bytes: body.byteLength }],
        failures: [
          {
            scope: "domestic",
            operation: "main-site",
            errorType: "Error",
            message: "sanitized failure",
          },
        ],
      }),
      customMetadata: manifestMetadata("partial"),
    });
    const central = new FakeCentral();

    await expect(
      importSbiRun({
        bucket: bucket as unknown as R2Bucket,
        centralService: central as unknown as Fetcher,
        centralToken: TOKEN,
        fingerprintKey: FINGERPRINT_KEY,
        importerVersion: "collector-r2-importer-v1",
        manifestKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "artifact_checksum_mismatch" });
    expect(central.requests).toHaveLength(0);
  });

  test("seals a failed collection as a one-artifact evidence inventory", async () => {
    const bucket = new FakeBucket();
    const manifest = manifestBytes({
      scope: "domestic",
      status: "failed",
      artifacts: [],
      failures: [
        {
          scope: "domestic",
          operation: "passkey-mts",
          errorType: "Error",
          message: "sanitized failure",
        },
      ],
    });
    bucket.objects.set(KEY, {
      body: manifest,
      customMetadata: manifestMetadata("failed"),
    });
    const central = new FakeCentral();
    const result = await importSbiRun({
      bucket: bucket as unknown as R2Bucket,
      centralService: central as unknown as Fetcher,
      centralToken: TOKEN,
      fingerprintKey: FINGERPRINT_KEY,
      importerVersion: "collector-r2-importer-v1",
      manifestKey: KEY,
    });
    expect(result.artifactCount).toBe(1);
    expect(central.requests).toHaveLength(7);
    const unitReport = central.requests.find((request) =>
      /\/units\/\d+\/reports$/u.test(new URL(request.url).pathname),
    );
    expect(unitReport ? JSON.parse(unitReport.body) : undefined).toMatchObject({
      normalizedOutcome: "failed",
      declaredArtifactCount: 0,
      safeFailureCode: "passkey-mts-failed",
    });
  });

  test("strictly rejects unknown fields, mismatched scope, and extra prefix objects", async () => {
    const valid = JSON.parse(new TextDecoder().decode(manifestBytes())) as Record<string, unknown>;
    expect(() => parseSbiManifest(manifestBytes(), KEY)).toThrow(
      "manifest_dataset_completeness_mismatch",
    );
    expect(() =>
      parseSbiManifest(
        new TextEncoder().encode(JSON.stringify({ ...valid, unexpected: true })),
        KEY,
      ),
    ).toThrow(ImportError);

    const dataset = "foreign-cash-balances";
    const body = new TextEncoder().encode("{}");
    const sha256 = await digest(body);
    expect(() =>
      parseSbiManifest(
        manifestBytes({
          scope: "domestic",
          artifacts: [{ dataset, key: `${PREFIX}${dataset}.json`, sha256, bytes: 2 }],
        }),
        KEY,
      ),
    ).toThrow("manifest_artifact_scope_mismatch");

    const bucket = new FakeBucket();
    bucket.objects.set(KEY, {
      body: manifestBytes({
        scope: "domestic",
        status: "failed",
        failures: [
          {
            scope: "domestic",
            operation: "passkey-mts",
            errorType: "Error",
            message: "sanitized failure",
          },
        ],
      }),
      customMetadata: manifestMetadata("failed"),
    });
    bucket.objects.set(`${PREFIX}unexpected.json`, { body });
    const central = new FakeCentral();
    await expect(
      importSbiRun({
        bucket: bucket as unknown as R2Bucket,
        centralService: central as unknown as Fetcher,
        centralToken: TOKEN,
        fingerprintKey: FINGERPRINT_KEY,
        importerVersion: "collector-r2-importer-v1",
        manifestKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "prefix_inventory_mismatch" });
    expect(central.requests).toHaveLength(0);
  });
});

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

function manifestMetadata(status = "success"): Record<string, string> {
  return { source: "sbi-securities", status, runId: RUN_ID };
}

function manifestBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "sbi-worker-poc-v1",
      source: "sbi-securities",
      runId: RUN_ID,
      scope: "all",
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:00:01.000Z",
      status: "success",
      artifacts: [],
      failures: [],
      ...overrides,
    }),
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
