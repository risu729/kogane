import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/v-point-pay-email-audit-worker";

describe("V Point Pay email aggregate-only R2 audit", () => {
  test("returns only bounded aggregate fields and never source identifiers", async () => {
    const bucket = listBucket({
      objects: [{ key: `raw/v-point-pay-email/2026/08/31/${"a".repeat(64)}.eml` }],
      truncated: false,
    });
    const response = await auditWorker.fetch(auditRequest(), { VPOINT_PAY_SNAPSHOTS: bucket });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "vpoint-pay-email-r2-aggregate-audit-v1",
      scannedObjectCount: 1,
      rawObjectCount: 1,
      normalizedObjectCount: 0,
      failedObjectCount: 0,
      nativeChecksumPresentObjectCount: 0,
      nativeChecksumMissingObjectCount: 1,
      eventTypeCounts: { usage: 0, charge: 0, balanceAddition: 0, declined: 0 },
      nextCursor: null,
      truncated: false,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("reduces pair validation failure to a stable aggregate code", async () => {
    const key = `raw/v-point-pay-email/2026/08/31/${"a".repeat(64)}.json`;
    const bucket = {
      list: async () => ({ objects: [{ key }], truncated: false }) as unknown as R2Objects,
      get: async () => null,
    } as unknown as R2Bucket;
    const response = await auditWorker.fetch(auditRequest(), { VPOINT_PAY_SNAPSHOTS: bucket });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      scannedObjectCount: 1,
      rawObjectCount: 0,
      normalizedObjectCount: 0,
      failedObjectCount: 1,
      failureCode: "vpoint_pay_email_pair_inventory_mismatch",
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("the repeatable audit stays local, remote-read-only, and never deploys", () => {
    const script = readFileSync(
      new URL("../scripts/audit-v-point-pay-email-r2.sh", import.meta.url),
      "utf8",
    );
    const worker = readFileSync(
      new URL("../src/v-point-pay-email-audit-worker.ts", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-v-point-pay-email.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(worker).not.toContain('prefix: "raw/v-point-pay/"');
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    const buckets = config.r2_buckets as Array<Record<string, unknown>>;
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ remote: true });
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
      expect(options).toMatchObject({ prefix: "raw/v-point-pay-email/", limit: 25 });
      return result as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
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
