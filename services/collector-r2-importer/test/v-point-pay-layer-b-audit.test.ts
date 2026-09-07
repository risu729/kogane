import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/v-point-pay-layer-b-audit-worker";

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
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
      checksums: {},
      arrayBuffer: async () => owned(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    return {
      objects: keys.slice(0, options.limit).map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

describe("V Point Pay aggregate-only R2 Layer-B audit", () => {
  test("validates the Layer A pair, ignores mail, and returns counts only", async () => {
    const bucket = await storedPair();
    const result = await auditWorker.fetch(auditRequest(), {
      VPOINT_PAY_SNAPSHOTS: bucket as unknown as R2Bucket,
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "v-point-pay-r2-layer-b-aggregate-audit-v1",
      scannedObjectCount: 2,
      ignoredRawObjectCount: 1,
      auditedNormalizedObjectCount: 1,
      failedNormalizedObjectCount: 0,
      transactionObservationCount: 1,
      balanceObservationCount: 1,
      declinedObservationCount: 0,
      nextCursor: null,
      truncated: false,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("reduces contract failures to one stable aggregate code", async () => {
    const key = `raw/v-point-pay-email/2026/08/31/${"a".repeat(64)}.json`;
    const bucket = {
      list: async () => ({ objects: [{ key }], truncated: false }) as unknown as R2Objects,
      get: async () => null,
    } as unknown as R2Bucket;
    const result = await auditWorker.fetch(auditRequest(), { VPOINT_PAY_SNAPSHOTS: bucket });
    expect(await result.json()).toMatchObject({
      scannedObjectCount: 1,
      auditedNormalizedObjectCount: 0,
      failedNormalizedObjectCount: 1,
      failureCode: "layer_a_contract_failed",
    });
  });

  test("the harness is local, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(
      new URL("../scripts/audit-v-point-pay-layer-b-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-v-point-pay-layer-b.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "VPOINT_PAY_SNAPSHOTS",
        bucket_name: "kogane-vpoint-pay-collector-poc",
        remote: true,
      },
    ]);
  });
});

async function storedPair(): Promise<FakeBucket> {
  const raw = notification();
  const id = await sha256Hex(raw);
  const event = {
    schemaVersion: "vpoint-pay-email-event-v1",
    id,
    sourceMessageId: "<synthetic@example.invalid>",
    occurredAt: "2026-08-31T03:00:00.000Z",
    eventType: "usage",
    subject: "【VポイントPay】ご利用のお知らせ",
    merchant: "匿名加盟店",
    detail: null,
    amountYen: 1234,
    usedPoints: 200,
    balanceYen: 4321,
  };
  const normalized = new TextEncoder().encode(JSON.stringify(event));
  const prefix = `raw/v-point-pay-email/2026/08/31/${id}`;
  const metadata = { source: "v-point-pay-email", eventType: "usage", sha256: id };
  const bucket = new FakeBucket();
  bucket.objects.set(`${prefix}.eml`, {
    body: raw,
    customMetadata: metadata,
    contentType: "message/rfc822",
  });
  bucket.objects.set(`${prefix}.json`, {
    body: normalized,
    customMetadata: metadata,
    contentType: "application/json",
  });
  return bucket;
}

function notification(): Uint8Array {
  const subject = "【VポイントPay】ご利用のお知らせ";
  return new TextEncoder().encode(
    [
      "From: V Point Pay <info@prepaid.smbc-card.com>",
      "To: owner@example.invalid",
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "Date: Sun, 31 Aug 2026 12:00:00 +0900",
      "Message-ID: <synthetic@example.invalid>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "◇利用先：匿名加盟店\r\n◇利用金額：1,234円\r\n（内、利用Vポイント数： 200ポイント）\r\n◇利用後の残高：4,321円",
    ].join("\r\n"),
  );
}

function auditRequest(): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:key|hash|sha256|body|value|amount|balance|points?)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", owned(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
