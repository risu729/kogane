import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/sbi-vc-audit-worker";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-vc-trade/2026/09/07/${RUN_ID}/`;
const FIXTURE_ROOT = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-vc-trade/2026-09-07/run-20260907-synthetic01/",
  import.meta.url,
);
const DATASETS = [
  "cash-balances",
  "account-margin",
  "position-summary",
  "executions-recent-page-0001",
  "executions-historical-page-0001",
  "cashflows-historical-page-0001",
] as const;

describe("SBI VC aggregate-only R2 Layer B audit", () => {
  test("parses a complete run while returning aggregate evidence only", async () => {
    const objects = new Map<string, StoredObject>();
    const artifacts = [];
    for (const dataset of DATASETS) {
      const bytes = new Uint8Array(readFileSync(new URL(`${dataset}.json`, FIXTURE_ROOT)));
      const sha256 = await digest(bytes);
      const key = `${PREFIX}${dataset}.json`;
      objects.set(key, stored(bytes));
      artifacts.push({ dataset, key, sha256, bytes: bytes.byteLength });
    }
    const manifestKey = `${PREFIX}manifest.json`;
    objects.set(
      manifestKey,
      stored(
        encode({
          schemaVersion: "sbi-vc-trade-worker-poc-v1",
          source: "sbi-vc-trade",
          runId: RUN_ID,
          startedAt: "2026-09-07T00:00:00.000Z",
          completedAt: "2026-09-07T00:00:06.000Z",
          status: "success",
          artifacts,
          failures: [],
        }),
      ),
    );
    const bucket = fakeBucket(objects, manifestKey);
    const response = await auditWorker.fetch(auditRequest(), { SBI_VC_SNAPSHOTS: bucket });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "sbi-vc-r2-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "success",
      artifactCount: 6,
      matchedArtifactCount: 6,
      parsedArtifactCount: 6,
      hasNonEmptyPosition: true,
      hasNonEmptyRecentExecutions: true,
      hasMultipleHistoricalExecutionPages: false,
      hasMultipleHistoricalCashflowPages: false,
      hasCrossViewExecutionOverlap: false,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("the harness is local, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(new URL("../scripts/audit-sbi-vc-r2.sh", import.meta.url), "utf8");
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-sbi-vc.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "SBI_VC_SNAPSHOTS",
        bucket_name: "kogane-sbi-vc-trade-poc",
        remote: true,
      },
    ]);
  });
});

interface StoredObject {
  body: Uint8Array;
  size: number;
  httpMetadata: { contentType: string };
}

function stored(body: Uint8Array): StoredObject {
  return { body, size: body.byteLength, httpMetadata: { contentType: "application/json" } };
}

function fakeBucket(objects: Map<string, StoredObject>, manifestKey: string): R2Bucket {
  return {
    get: async (key: string) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        ...object,
        arrayBuffer: async () => object.body.slice().buffer,
      } as unknown as R2ObjectBody;
    },
    list: async (options: R2ListOptions) => {
      if (options.prefix === "raw/sbi-vc-trade/" && options.limit === 1) {
        return { objects: [{ key: manifestKey }], truncated: false } as unknown as R2Objects;
      }
      const entries = [...objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .sort()
        .map((key) => ({ key }));
      return { objects: entries, truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function auditRequest(): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function digest(body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:key|hash|sha256|body|value|amount|balance)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}
