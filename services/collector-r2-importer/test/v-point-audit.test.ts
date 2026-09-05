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
      schemaVersion: "vpoint-r2-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 0,
      skippedObjectCount: 1,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
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
      failureCode: "manifest_not_found",
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
