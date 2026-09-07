import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/vpass-layer-b-audit-worker";

describe("Vpass aggregate-only R2 Layer-B audit", () => {
  test("returns only aggregate fields for a skipped source object", async () => {
    const result = await auditWorker.fetch(auditRequest(), {
      VPASS_SNAPSHOTS: listBucket({
        objects: [{ key: "vpass/example/snapshot.json" }],
        truncated: false,
      }),
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "vpass-r2-layer-b-structural-audit-v1",
      scannedObjectCount: 1,
      auditedRecordCount: 0,
      skippedObjectCount: 1,
      failedRecordCount: 0,
      parsedStatementArtifactCount: 0,
      parsedTransactionCount: 0,
      parserWarningCount: 0,
      blockedStatementArtifactCount: 0,
      nextCursor: null,
      truncated: false,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("reduces a missing record to one stable contract code", async () => {
    const bucket = {
      ...listBucket({
        objects: [{ key: "vpass/2026/09/07/2026-09-07T00-00-00-000Z/card-001/manifest.json" }],
        truncated: false,
      }),
      get: async () => null,
    } as unknown as R2Bucket;
    const result = await auditWorker.fetch(auditRequest(), { VPASS_SNAPSHOTS: bucket });
    expect(await result.json()).toMatchObject({
      scannedObjectCount: 1,
      failedRecordCount: 1,
      failureCodeCounts: { source_object_missing: 1 },
    });
  });

  test("the harness is local, paginated, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(
      new URL("../scripts/audit-vpass-layer-b-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-vpass-layer-b.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).toContain("nextCursor");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "VPASS_SNAPSHOTS",
        bucket_name: "kogane-vpass-collector-poc",
        remote: true,
      },
    ]);
  });
});

function auditRequest(): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function listBucket(result: {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}): R2Bucket {
  return {
    list: async (options: R2ListOptions) => {
      expect(options).toMatchObject({ prefix: "vpass/", limit: 50 });
      return result as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:object_?key|hash|sha256|body|value|amount|balance)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}
