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
  sizeOverride?: number;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  listCalls = 0;
  truncated = false;

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.sizeOverride ?? value.body.byteLength,
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
      truncated: this.truncated,
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
  failure: { path: string; occurrence: number } | null = null;
  readonly pathOccurrences = new Map<string, number>();

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const occurrence = (this.pathOccurrences.get(path) ?? 0) + 1;
    this.pathOccurrences.set(path, occurrence);
    if (this.failure?.path === path && this.failure.occurrence === occurrence) {
      return Response.json({ error: "synthetic_failure" }, { status: 503 });
    }
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
    expect(central.requests).toHaveLength(9);
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
        externalIdNamespace: "vpoint-pay-email-pair-v2",
        sourceRunKey: "email-pair-vpoint-pay-email-r2-v2",
      }),
      expect.objectContaining({
        sourceId: "v-point-pay",
        externalIdNamespace: "vpoint-pay-email-pair-v2",
        sourceRunKey: "email-pair-vpoint-pay-email-r2-v2",
      }),
    ]);
    const reports = central.requests
      .filter((entry) => entry.path === "/v1/runs/1/reports")
      .map((entry) => JSON.parse(entry.body));
    expect(reports).toEqual([
      expect.objectContaining({ producerVersion: "vpoint-pay-email-r2-v2" }),
      expect.objectContaining({ producerVersion: "vpoint-pay-email-r2-v2" }),
    ]);
    const seal = JSON.parse(central.requests.find((entry) => entry.path.endsWith("/seal"))!.body);
    expect(seal.declarationBasis).toBe("email_batch");
    const rawDescriptors = central.requests
      .filter((entry) => entry.path.endsWith("/artifacts"))
      .map((entry) => JSON.parse(entry.body))
      .filter((entry) => entry.artifactKey === "notification.eml");
    expect(rawDescriptors).toEqual([
      expect.objectContaining({
        artifactRole: "user_capture",
        payloadFidelity: "unknown",
        email: expect.objectContaining({ transportShape: "unknown", senderDomain: null }),
      }),
      expect.objectContaining({
        artifactRole: "user_capture",
        payloadFidelity: "unknown",
        email: expect.objectContaining({ transportShape: "unknown", senderDomain: null }),
      }),
    ]);
    expect(central.requests).toHaveLength(18);
  });

  test("binds new direct envelope provenance but keeps the provider source unverified", async () => {
    const fixture = await storedPair({ provenance: "direct" });
    const central = new FakeCentral();
    await runImport(fixture.bucket, central, fixture.normalizedKey, "v14");
    const raw = central.requests
      .filter((entry) => entry.path.endsWith("/artifacts"))
      .map((entry) => JSON.parse(entry.body))
      .find((entry) => entry.artifactKey === "notification.eml");
    expect(raw).toMatchObject({
      artifactRole: "user_capture",
      payloadFidelity: "unknown",
      email: {
        transportShape: "direct",
        senderDomain: "prepaid.smbc-card.com",
      },
    });
  });

  test("binds a forwarded envelope to the retained inner RFC822 boundary", async () => {
    const fixture = await storedPair({ provenance: "forwarded-rfc822" });
    const central = new FakeCentral();
    await runImport(fixture.bucket, central, fixture.normalizedKey, "v14");
    const raw = central.requests
      .filter((entry) => entry.path.endsWith("/artifacts"))
      .map((entry) => JSON.parse(entry.body))
      .find((entry) => entry.artifactKey === "notification.eml");
    expect(raw).toMatchObject({
      artifactRole: "user_capture",
      payloadFidelity: "unknown",
      email: {
        transportShape: "forwarded_rfc822",
        senderDomain: "example.invalid",
        innerSenderDomain: "prepaid.smbc-card.com",
      },
    });
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

    const extra = await storedPair();
    extra.bucket.objects.set(`${extra.rawKey}.extra`, extra.bucket.objects.get(extra.rawKey)!);
    await expect(
      auditVPointPayEmailPair(extra.bucket as unknown as R2Bucket, extra.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_pair_inventory_mismatch");

    const truncated = await storedPair();
    truncated.bucket.truncated = true;
    await expect(
      auditVPointPayEmailPair(truncated.bucket as unknown as R2Bucket, truncated.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_pair_inventory_mismatch");

    const contentType = await storedPair();
    contentType.bucket.objects.get(contentType.rawKey)!.contentType = "application/octet-stream";
    await expect(
      auditVPointPayEmailPair(contentType.bucket as unknown as R2Bucket, contentType.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_content_type_invalid");

    const size = await storedPair();
    size.bucket.objects.get(size.normalizedKey)!.sizeOverride = 64 * 1024 + 1;
    await expect(
      auditVPointPayEmailPair(size.bucket as unknown as R2Bucket, size.normalizedKey),
    ).rejects.toThrow("vpoint_pay_email_size_invalid");

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

  test("records the exact failing central phase and retries immutable state", async () => {
    const fixture = await storedPair({ provenance: "direct" });
    const rawSha256 = fixture.rawKey.split("/").at(-1)!.replace(".eml", "");
    const normalizedSha256 = fixture.bucket.objects.get(fixture.normalizedKey)!.nativeSha256!;
    const phaseFailures = [
      { path: "/v1/runs/1/units", occurrence: 1, code: "unit_failed" },
      { path: `/v1/runs/1/objects/${rawSha256}`, occurrence: 1, code: "raw_upload_failed" },
      { path: "/v1/runs/1/artifacts", occurrence: 1, code: "raw_catalogue_failed" },
      {
        path: `/v1/runs/1/objects/${normalizedSha256}`,
        occurrence: 1,
        code: "normalized_upload_failed",
      },
      { path: "/v1/runs/1/artifacts", occurrence: 2, code: "normalized_catalogue_failed" },
      { path: "/v1/units/10/reports", occurrence: 1, code: "unit_report_failed" },
      { path: "/v1/runs/1/reports", occurrence: 1, code: "run_report_failed" },
      { path: "/v1/runs/1/seal", occurrence: 1, code: "seal_failed" },
    ];
    for (const failure of phaseFailures) {
      const central = new FakeCentral();
      central.failure = { path: failure.path, occurrence: failure.occurrence };
      try {
        await runImport(fixture.bucket, central, fixture.normalizedKey, "v14");
        throw new Error(`expected_${failure.code}`);
      } catch (error) {
        expect(String(error)).not.toBe(`Error: expected_${failure.code}`);
      }
      const attempts = central.requests
        .filter((entry) => entry.path === "/v1/runs/1/attempts")
        .map((entry) => JSON.parse(entry.body));
      expect(attempts).toHaveLength(1);
      expect(attempts[0].errorCode).toBe(failure.code);
      expect(central.requests.length).toBeLessThanOrEqual(10);
      central.failure = null;
      await expect(
        runImport(fixture.bucket, central, fixture.normalizedKey, "v99"),
      ).resolves.toMatchObject({
        status: "sealed",
        sealed: true,
      });
      expect(central.runs).toHaveLength(1);
      expect(central.seals).toHaveLength(1);
    }
  });

  test("does not invent an attempt when central run creation fails", async () => {
    const fixture = await storedPair({ provenance: "direct" });
    const central = new FakeCentral();
    central.failure = { path: "/v1/runs", occurrence: 1 };
    await expect(runImport(fixture.bucket, central, fixture.normalizedKey, "v14")).rejects.toThrow(
      "central_503_synthetic_failure",
    );
    expect(central.requests).toHaveLength(1);
    expect(central.requests.some((entry) => entry.path.endsWith("/attempts"))).toBeFalse();
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

async function storedPair(
  options: { sender?: string; provenance?: "direct" | "forwarded-rfc822" } = {},
) {
  const raw = notification(options.sender ?? "info@prepaid.smbc-card.com");
  const syntheticId = await sha256Hex(raw);
  const event: Record<string, unknown> = {
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
  };
  if (options.provenance) {
    event.schemaVersion = "vpoint-pay-email-event-v2";
    event.sourceProvenance = {
      schemaVersion: "vpoint-pay-email-source-provenance-v1",
      delivery: options.provenance,
      storedMessageScope:
        options.provenance === "direct" ? "smtp-message" : "forwarded-rfc822-part",
      sourceVerification: "source_unverified",
      envelopeFrom:
        options.provenance === "direct" ? "info@prepaid.smbc-card.com" : "owner@example.invalid",
      envelopeTo: "vpointpay@takuk.me",
      outerMessageSha256: options.provenance === "direct" ? syntheticId : "b".repeat(64),
      authenticationProvenance: "not-exposed-by-cloudflare-email-event",
    };
  }
  return putPair(raw, event);
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
    ...(event.schemaVersion === "vpoint-pay-email-event-v2"
      ? {
          eventSchema: "vpoint-pay-email-event-v2",
          delivery: (event.sourceProvenance as { delivery: string }).delivery,
          sourceVerification: "source_unverified",
        }
      : {}),
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
