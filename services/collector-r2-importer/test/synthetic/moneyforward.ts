import { expect } from "bun:test";
import { importMoneyForwardRun } from "../../src/moneyforward";

export const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
export const PREFIX = `raw/moneyforward/2026/09/05/${RUN_ID}/`;
export const MANIFEST_KEY = `${PREFIX}manifest.json`;
export const TOKEN = `collector-r2-moneyforward.${"f".repeat(32)}`;
export const FINGERPRINT_KEY = "ab".repeat(32);

export interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256: string;
}

export class FakeBucket {
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
    if (options.limit === 1) {
      const offset = options.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > keys.length) {
        throw new Error("fake cursor invalid");
      }
      const objects = keys.slice(offset, offset + 1).map((key) => ({ key }));
      const nextOffset = offset + objects.length;
      const truncated = nextOffset < keys.length;
      return {
        objects,
        truncated,
        ...(truncated ? { cursor: String(nextOffset) } : {}),
      } as unknown as R2Objects;
    }
    return { objects: keys.map((key) => ({ key })), truncated: false } as unknown as R2Objects;
  }
}

export class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Set<string>();
  readonly inventoryItems = new Set<string>();
  readonly reports = new Map<string, string>();
  readonly units = new Map<string, number>();
  sealCount = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const reused = this.uploaded.has(path);
      this.uploaded.add(path);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) {
      if (!this.units.has(body)) this.units.set(body, 10 + this.units.size);
      return Response.json({ unitId: this.units.get(body) }, { status: 201 });
    }
    if (path.endsWith("/inventories")) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (path.endsWith("/items")) {
      const items = (JSON.parse(body) as { items: Array<{ artifactKey: string }> }).items;
      for (const item of items) this.inventoryItems.add(item.artifactKey);
      return Response.json({ ok: true }, { status: 201 });
    }
    if (path.endsWith("/artifacts")) {
      return Response.json(
        { descriptorSha256: await normalizedDescriptorSha256(JSON.parse(body)) },
        { status: 201 },
      );
    }
    if (path.endsWith("/reports")) return immutableReport(this.reports, path, body);
    if (path.endsWith("/seal")) {
      this.sealCount += 1;
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

export async function completeImport(
  bucket: FakeBucket,
  central: FakeCentral,
  importerVersion: string,
): Promise<void> {
  let continuation: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await runImport(bucket, central, continuation, importerVersion);
    if (result.status === "sealed") return;
    if (continuation !== undefined && result.continuation === continuation) {
      throw new Error("test continuation did not advance");
    }
    continuation = result.continuation;
  }
  throw new Error("test import did not seal within page bound");
}

export async function runImport(
  bucket: FakeBucket,
  central: FakeCentral,
  continuation?: string,
  importerVersion = "collector-r2-importer-test",
  fingerprintKey = FINGERPRINT_KEY,
) {
  return importMoneyForwardRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey,
    importerVersion,
    manifestKey: MANIFEST_KEY,
    ...(continuation ? { continuation } : {}),
  });
}

export async function storeSuccessRun(bucket: FakeBucket, accountCount = 1): Promise<void> {
  const artifacts: Array<Record<string, unknown>> = [];
  artifacts.push(
    await putArtifact(
      bucket,
      "accounts-index",
      "accounts.html",
      `<html><body>${Array.from({ length: accountCount }, (_, index) => `<a href="/accounts/show/${accountCount === 1 ? "opaque-account" : `opaque-account-${String(index + 1).padStart(2, "0")}`}?x=1">account</a>`).join("")}</body></html>`,
    ),
  );
  for (let ordinal = 1; ordinal <= accountCount; ordinal += 1) {
    const label = String(ordinal).padStart(2, "0");
    artifacts.push(
      await putArtifact(
        bucket,
        "account-detail",
        `account-detail-${label}.html`,
        `<html><head><meta name="csrf-token" content="opaque-csrf"></head><body><input name="account[id_hash]" value="${accountCount === 1 ? "opaque-account" : `opaque-account-${label}`}"><input name="service[id]" value="opaque-service"></body></html>`,
      ),
    );
    for (const month of recentMonths("2026-09-05T00:00:00.000Z")) {
      artifacts.push(
        await putArtifact(
          bucket,
          "monthly-transactions",
          `account-${label}-month-${month}.html`,
          '<div class="transaction-list"></div>',
        ),
      );
    }
  }
  await putManifest(bucket, {
    schemaVersion: "moneyforward-worker-poc-v1",
    source: "moneyforward-me",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    accountDetailCount: accountCount,
    monthlyFragmentCount: accountCount * 12,
    artifacts,
    failures: [],
  });
}

export async function putArtifact(
  bucket: FakeBucket,
  dataset: string,
  filename: string,
  value: string,
): Promise<Record<string, unknown>> {
  const body = encode(value);
  const sha256 = await sha256Hex(body);
  const key = `${PREFIX}${filename}`;
  bucket.objects.set(key, await stored(body, "text/html; charset=utf-8", { dataset, sha256 }));
  return { dataset, key, mediaType: "text/html; charset=utf-8", sha256, bytes: body.byteLength };
}

export async function putManifest(
  bucket: FakeBucket,
  manifest: Record<string, unknown>,
): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(
    MANIFEST_KEY,
    await stored(body, "application/json", {
      source: "moneyforward-me",
      status: String(manifest.status),
      runId: RUN_ID,
    }),
  );
}

export function readManifest(bucket: FakeBucket): {
  artifacts: Array<{ key: string; sha256: string; bytes: number }>;
} & Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
}

export function recentMonths(value: string): string[] {
  const now = new Date(Date.parse(value) + 9 * 60 * 60 * 1_000);
  return Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export async function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<StoredObject> {
  return { body, contentType, customMetadata, nativeSha256: await sha256Hex(body) };
}

export function immutableReport(
  reports: Map<string, string>,
  path: string,
  body: string,
): Response {
  const previous = reports.get(path);
  if (previous !== undefined && previous !== body) {
    return Response.json({ error: "immutable_report_conflict" }, { status: 409 });
  }
  reports.set(path, body);
  return Response.json({ reused: previous !== undefined }, { status: previous ? 200 : 201 });
}

export async function normalizedDescriptorSha256(
  descriptor: Record<string, unknown>,
): Promise<string> {
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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function canonical(value: unknown): unknown {
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

export function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
