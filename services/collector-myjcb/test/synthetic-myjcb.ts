export const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
export const PREFIX = `raw/myjcb/2026/09/05/${RUN_ID}/`;
export const MANIFEST_KEY = `${PREFIX}manifest.json`;

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
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

export async function putArtifact(
  bucket: FakeBucket,
  connectionId: string,
  dataset: string,
  filename: string,
  text: string,
  statementState?: string,
  period?: string,
): Promise<Record<string, unknown>> {
  const body = encode(text);
  const sha256 = await sha256Hex(body);
  const mediaType = filename.endsWith(".html") ? "text/html; charset=utf-8" : "application/json";
  const key = `${PREFIX}${connectionId}/${filename}`;
  bucket.objects.set(
    key,
    await stored(body, mediaType, {
      source: "myjcb",
      dataset,
      sha256,
      ...(statementState ? { statementState } : {}),
      ...(period ? { period } : {}),
    }),
  );
  return {
    dataset,
    key,
    mediaType,
    sha256,
    bytes: body.byteLength,
    ...(statementState ? { statementState } : {}),
    ...(period ? { period } : {}),
  };
}

export async function putManifest(
  bucket: FakeBucket,
  manifest: Record<string, unknown>,
): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(
    MANIFEST_KEY,
    await stored(body, "application/json", {
      source: "myjcb",
      status: String(manifest.status),
      runId: RUN_ID,
    }),
  );
}

export function readManifest(bucket: FakeBucket): {
  status: string;
  artifacts: Array<{ dataset: string; key: string; sha256: string; bytes: number }>;
  connections: Array<{ status: string; artifactCount: number; blocker?: string }>;
  failures: Array<{ connectionId: string; operation: string; errorType: string; message: string }>;
} & Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
}

export async function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<StoredObject> {
  return { body, contentType, customMetadata, nativeSha256: await sha256Hex(body) };
}

export function html(_dataset: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB details_inquiry ${body}</body></html>`;
}

export function ledger(
  detailMonth: number,
  period: string,
  state: "confirmed" | "unconfirmed",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers:
      state === "unconfirmed"
        ? ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"]
        : ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"],
    rows: [],
  });
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
