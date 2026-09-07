import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/v-point-audit-worker";

describe("V Point aggregate-only R2 audit", () => {
  test("returns only bounded aggregate fields and never source identifiers", async () => {
    const bucket = listBucket({
      objects: [{ key: "raw/v-point/2026/09/05/run/balance-info.json" }],
      truncated: false,
    });
    const response = await auditWorker.fetch(auditRequest(), environment(bucket));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "vpoint-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 0,
      skippedObjectCount: 1,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("parses every financial artifact in a strict success run and ignores only summary", async () => {
    const bucket = await successBucket();
    const response = await auditWorker.fetch(auditRequest(), environment(bucket));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "success",
      artifactCount: 4,
      financialArtifactCount: 3,
      ignoredArtifactCount: 1,
      parsedObservationCount: 7,
      balanceObservationCount: 5,
      transactionObservationCount: 2,
      externalIdObservationCount: 0,
      positivePointTransactionCount: 1,
      negativePointTransactionCount: 1,
      zeroPointTransactionCount: 0,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("a valid failed run produces no financial observations", async () => {
    const response = await auditWorker.fetch(auditRequest(), environment(await failedBucket()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "failed",
      artifactCount: 0,
      financialArtifactCount: 0,
      ignoredArtifactCount: 0,
      parsedObservationCount: 0,
      balanceObservationCount: 0,
      transactionObservationCount: 0,
      externalIdObservationCount: 0,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("reduces manifest validation failures to a stable aggregate code", async () => {
    const bucket = {
      ...listBucket({
        objects: [
          {
            key: "raw/v-point/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
          },
        ],
        truncated: false,
      }),
      get: async () => null,
    } as unknown as R2Bucket;
    const response = await auditWorker.fetch(auditRequest(), environment(bucket));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      scannedObjectCount: 1,
      auditedManifestCount: 0,
      skippedObjectCount: 0,
      failedManifestCount: 1,
      failureCode: "vpoint_contract_validation_failed",
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("the repeatable audit stays local, remote-read-only, and never deploys", () => {
    const script = readFileSync(new URL("../scripts/audit-v-point-r2.sh", import.meta.url), "utf8");
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-v-point.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    const buckets = config.r2_buckets as Array<Record<string, unknown>>;
    expect(buckets).toHaveLength(2);
    expect(buckets.every((binding) => binding.remote === true)).toBe(true);
  });
});

function auditRequest(cursor?: string): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cursor ? { cursor } : {}),
  });
}

function listBucket(result: {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}): R2Bucket {
  return {
    list: async (options: R2ListOptions) => {
      expect(options).toMatchObject({ prefix: "raw/v-point/", limit: 1 });
      return result as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function environment(bucket: R2Bucket): Pick<Env, "VPOINT_SNAPSHOTS" | "VPOINT_PAY_SNAPSHOTS"> {
  return {
    VPOINT_SNAPSHOTS: bucket,
    VPOINT_PAY_SNAPSHOTS: {} as R2Bucket,
  };
}

async function successBucket(): Promise<R2Bucket> {
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const prefix = `raw/v-point/2099/01/05/${runId}/`;
  const fixture = (name: string): Uint8Array =>
    readFileSync(
      new URL(`../../../poc/observation-pipeline/fixtures/v-point/${name}.json`, import.meta.url),
    );
  const payloads = new Map<string, Uint8Array>([
    ["balance-info", fixture("balance-info")],
    ["smfg-point", fixture("smfg-point")],
    ["history-page-0001", fixture("history-page-0001")],
    [
      "collection-summary",
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: "vpoint-collection-summary-v1",
          historyTotal: 2,
          historyPageCount: 1,
        }),
      ),
    ],
  ]);
  const stored = new Map<
    string,
    { body: Uint8Array; metadata: Record<string, string>; sha256: string }
  >();
  const artifacts = [];
  for (const [dataset, body] of payloads) {
    const digest = await sha256(body);
    const key = `${prefix}${dataset}.json`;
    stored.set(key, { body, metadata: { dataset, sha256: digest }, sha256: digest });
    artifacts.push({
      dataset,
      key,
      mediaType: "application/json",
      sha256: digest,
      bytes: body.byteLength,
    });
  }
  const manifestKey = `${prefix}manifest.json`;
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "vpoint-worker-poc-v1",
      source: "v-point",
      runId,
      startedAt: "2099-01-05T00:00:00.000Z",
      completedAt: "2099-01-05T00:00:02.000Z",
      status: "success",
      historyTotal: 2,
      historyPageCount: 1,
      artifacts,
      failures: [],
    }),
  );
  stored.set(manifestKey, {
    body: manifest,
    metadata: { source: "v-point", status: "success", runId },
    sha256: await sha256(manifest),
  });
  return {
    list: async (options: R2ListOptions) =>
      ({
        objects:
          options.prefix === "raw/v-point/"
            ? [{ key: manifestKey }]
            : [...stored.keys()]
                .filter((key) => key.startsWith(options.prefix ?? ""))
                .sort()
                .map((key) => ({ key })),
        truncated: false,
      }) as unknown as R2Objects,
    get: async (key: string) => {
      const item = stored.get(key);
      if (!item) return null;
      return {
        key,
        size: item.body.byteLength,
        customMetadata: item.metadata,
        httpMetadata: { contentType: "application/json" },
        checksums: { sha256: hexBytes(item.sha256).buffer },
        arrayBuffer: async () => owned(item.body),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

async function failedBucket(): Promise<R2Bucket> {
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const manifestKey = `raw/v-point/2099/01/05/${runId}/manifest.json`;
  const body = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "vpoint-worker-poc-v1",
      source: "v-point",
      runId,
      startedAt: "2099-01-05T00:00:00.000Z",
      completedAt: "2099-01-05T00:00:02.000Z",
      status: "failed",
      historyTotal: 0,
      historyPageCount: 0,
      artifacts: [],
      failures: [{ operation: "collect", errorType: "Error", message: "anonymous failure" }],
    }),
  );
  const digest = await sha256(body);
  return {
    list: async (_options: R2ListOptions) =>
      ({ objects: [{ key: manifestKey }], truncated: false }) as unknown as R2Objects,
    get: async (key: string) => {
      if (key !== manifestKey) return null;
      return {
        key,
        size: body.byteLength,
        customMetadata: { source: "v-point", status: "failed", runId },
        httpMetadata: { contentType: "application/json" },
        checksums: { sha256: hexBytes(digest).buffer },
        arrayBuffer: async () => owned(body),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", owned(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:key|hash|sha256|body|value|amount|balance|points?)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}
