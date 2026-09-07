import { describe, expect, test } from "bun:test";
import { auditVPointPayEmailPair, importVPointPayEmailPair } from "../src/v-point-pay-email";
import { centralDescriptorSha256 } from "../src/central";

const TOKEN = `collector-r2-v-point-pay-email.${"e".repeat(32)}`;
const FINGERPRINT_KEY = "ab".repeat(32);

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256?: string;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  listCalls = 0;

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.body.byteLength,
      customMetadata: value.customMetadata,
      httpMetadata: { contentType: value.contentType },
      checksums: value.nativeSha256 ? { sha256: hexBytes(value.nativeSha256).buffer } : {},
      arrayBuffer: async () => owned(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    this.listCalls += 1;
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
  readonly runs = new Map<string, number>();
  readonly objects = new Set<string>();
  readonly artifacts = new Map<string, string>();
  readonly reports = new Map<string, string>();
  readonly seals = new Map<string, string>();
  readonly requests: Array<{ path: string; method: string; body: string }> = [];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const reused = this.objects.has(path);
      this.objects.add(path);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") {
      const key = body;
      if (!this.runs.has(key)) this.runs.set(key, this.runs.size + 1);
      return Response.json({ runId: this.runs.get(key)! }, { status: 201 });
    }
    if (path.endsWith("/units")) return Response.json({ unitId: 10 }, { status: 201 });
    if (path.endsWith("/artifacts")) {
      const descriptorSha256 = await centralDescriptorSha256(JSON.parse(body));
      const previous = this.artifacts.get(path + body);
      this.artifacts.set(path + body, descriptorSha256);
      return Response.json({ descriptorSha256 }, { status: previous ? 200 : 201 });
    }
    if (path.endsWith("/reports")) return immutable(this.reports, path, body);
    if (path.endsWith("/seal")) {
      const previous = this.seals.get(path);
      this.seals.set(path, "sealed");
      return Response.json({ sealed: true }, { status: previous ? 200 : 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

describe("V Point Pay email R2 importer", () => {
  test("strictly imports one exact pair and replays across deploy revisions", async () => {
    const fixture = await storedPair();
    const central = new FakeCentral();
    const first = await runImport(fixture.bucket, central, fixture.normalizedKey, "v14");
    expect(first).toMatchObject({ status: "sealed", artifactCount: 2, sealed: true });
    const replay = await runImport(fixture.bucket, central, fixture.normalizedKey, "v99");
    expect(replay).toMatchObject({
      status: "sealed",
      centralRunId: first.centralRunId,
      artifactCount: 2,
      sealed: true,
      allObjectsReused: true,
    });
    expect(central.runs).toHaveLength(1);
    expect(central.objects).toHaveLength(2);
    expect(central.seals).toHaveLength(1);
    expect(fixture.bucket.listCalls).toBe(4);
    const runRequests = central.requests.filter((entry) => entry.path === "/v1/runs");
    expect(runRequests.map((entry) => JSON.parse(entry.body))).toEqual([
      expect.objectContaining({
        sourceId: "v-point-pay",
        externalIdNamespace: "vpoint-pay-email-event-v1",
        sourceRunKey: "email-pair-vpoint-pay-email-r2-v1",
      }),
      expect.objectContaining({
        sourceId: "v-point-pay",
        externalIdNamespace: "vpoint-pay-email-event-v1",
        sourceRunKey: "email-pair-vpoint-pay-email-r2-v1",
      }),
    ]);
    const reports = central.requests
      .filter((entry) => entry.path === "/v1/runs/1/reports")
      .map((entry) => JSON.parse(entry.body));
    expect(reports).toEqual([
      expect.objectContaining({ producerVersion: "vpoint-pay-email-r2-v1" }),
      expect.objectContaining({ producerVersion: "vpoint-pay-email-r2-v1" }),
    ]);
    const seal = JSON.parse(central.requests.find((entry) => entry.path.endsWith("/seal"))!.body);
    expect(seal.declarationBasis).toBe("email_batch");
  });

  test("fails closed on pair inventory, metadata, recorded checksum, and derivation drift", async () => {
    const missing = await storedPair();
    missing.bucket.objects.delete(missing.rawKey);
    await expect(
      auditVPointPayEmailPair(missing.bucket as unknown as R2Bucket, missing.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_pair_inventory_mismatch");

    const metadata = await storedPair();
    metadata.bucket.objects.get(metadata.normalizedKey)!.customMetadata.extra = "unexpected";
    await expect(
      auditVPointPayEmailPair(metadata.bucket as unknown as R2Bucket, metadata.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_metadata_invalid");

    const checksum = await storedPair();
    checksum.bucket.objects.get(checksum.rawKey)!.nativeSha256 = "0".repeat(64);
    await expect(
      auditVPointPayEmailPair(checksum.bucket as unknown as R2Bucket, checksum.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_native_checksum_mismatch");

    const missingChecksum = await storedPair();
    delete missingChecksum.bucket.objects.get(missingChecksum.normalizedKey)!.nativeSha256;
    await expect(
      auditVPointPayEmailPair(
        missingChecksum.bucket as unknown as R2Bucket,
        missingChecksum.normalizedKey,
      ),
    ).resolves.toEqual({ eventType: "usage" });

    const drift = await storedPair();
    const normalized = drift.bucket.objects.get(drift.normalizedKey)!;
    const event = JSON.parse(new TextDecoder().decode(normalized.body));
    event.amountYen += 1;
    normalized.body = new TextEncoder().encode(JSON.stringify(event));
    normalized.nativeSha256 = await sha256Hex(normalized.body);
    await expect(
      auditVPointPayEmailPair(drift.bucket as unknown as R2Bucket, drift.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_derivation_mismatch");
  });

  test("rejects a lookalike sender and a key date that disagrees with the RFC date", async () => {
    const sender = await storedPair({ sender: "attacker@example.invalid" });
    await expect(
      auditVPointPayEmailPair(sender.bucket as unknown as R2Bucket, sender.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_sender_invalid");

    const date = await storedPair();
    const badKey = date.normalizedKey.replace("/08/31/", "/08/30/");
    date.bucket.objects.set(badKey, date.bucket.objects.get(date.normalizedKey)!);
    date.bucket.objects.set(badKey.replace(".json", ".eml"), date.bucket.objects.get(date.rawKey)!);
    await expect(
      auditVPointPayEmailPair(date.bucket as unknown as R2Bucket, badKey),
    ).rejects.toThrow("vpoint_pay_email_identity_mismatch");
  });
});

async function storedPair(options: { sender?: string } = {}) {
  const raw = notification(options.sender ?? "info@prepaid.smbc-card.com");
  const syntheticId = await sha256Hex(raw);
  return putPair(raw, {
    schemaVersion: "vpoint-pay-email-event-v1",
    id: syntheticId,
    sourceMessageId: "<synthetic@example.invalid>",
    occurredAt: "2026-08-31T03:00:00.000Z",
    eventType: "usage",
    subject: "【VポイントPay】ご利用のお知らせ",
    merchant: "テスト加盟店",
    detail: null,
    amountYen: 1234,
    usedPoints: 200,
    balanceYen: null,
  });
}

async function putPair(raw: Uint8Array, event: Record<string, unknown>) {
  const bucket = new FakeBucket();
  const id = String(event.id);
  const prefix = `raw/v-point-pay-email/2026/08/31/${id}`;
  const rawKey = `${prefix}.eml`;
  const normalizedKey = `${prefix}.json`;
  const normalized = new TextEncoder().encode(JSON.stringify(event));
  const metadata = {
    source: "v-point-pay-email",
    eventType: String(event.eventType),
    sha256: id,
  };
  bucket.objects.set(rawKey, {
    body: raw,
    customMetadata: { ...metadata },
    contentType: "message/rfc822",
    nativeSha256: await sha256Hex(raw),
  });
  bucket.objects.set(normalizedKey, {
    body: normalized,
    customMetadata: { ...metadata },
    contentType: "application/json",
    nativeSha256: await sha256Hex(normalized),
  });
  return { bucket, rawKey, normalizedKey };
}

function notification(sender: string): Uint8Array {
  const subject = "【VポイントPay】ご利用のお知らせ";
  return new TextEncoder().encode(
    [
      `From: V Point Pay <${sender}>`,
      "To: owner@example.invalid",
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "Date: Sun, 31 Aug 2026 12:00:00 +0900",
      "Message-ID: <synthetic@example.invalid>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "◇利用先：テスト加盟店\r\n◇利用金額：1,234円\r\n（内、利用Vポイント数： 200ポイント）",
    ].join("\r\n"),
  );
}

function runImport(
  bucket: FakeBucket,
  central: FakeCentral,
  normalizedKey: string,
  importerVersion: string,
) {
  return importVPointPayEmailPair({
    bucket: bucket as unknown as R2Bucket,
    centralService: { fetch: central.fetch } as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion,
    normalizedKey,
  });
}

function immutable(store: Map<string, string>, key: string, body: string): Response {
  const previous = store.get(key);
  if (previous !== undefined && previous !== body) {
    return Response.json({ error: "immutable_report_conflict" }, { status: 409 });
  }
  store.set(key, body);
  return Response.json({ reused: previous !== undefined }, { status: previous ? 200 : 201 });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", owned(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
