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

/** The three `h2` headings the credit menu was observed with; the digit is synthetic. */
const MENU_LATEST_HEADING = "最新のご利用明細";
const MENU_PAST_HEADING = "過去の明細";
export const MENU_SCHEDULE_HEADING = "ボーナス2回払い・ショッピングスキップ払い";

/**
 * A credit menu (`detailMenu.html`) in the observed shape: every link is a
 * 「明細を見る」 `detail.html?detailMonth=N` link in a card box under an `h2`,
 * positions 0 and 1 under the latest heading, the schedule positions next, and
 * the older months last (observed DOM order 0, 1, 7, 8, 2, 3, 4, 5, 6). The
 * box texts are synthetic and name no date or amount.
 */
export function creditMenu(
  months: readonly (number | string)[],
  schedules: readonly (number | string)[] = [],
): string {
  const box = (position: number | string, text: string) =>
    `<div class="box"><p>${text}</p><a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${position}&amp;output=web">明細を見る</a></div>`;
  const section = (heading: string, positions: readonly (number | string)[], text: string) =>
    positions.length === 0
      ? ""
      : `<section><h2>${heading}</h2>${positions.map((position) => box(position, text)).join("")}</section>`;
  const latest = months.filter((month) => Number(month) < 2);
  const past = months.filter((month) => Number(month) >= 2);
  return `<!doctype html><html lang="ja"><body><h1>カードご利用明細</h1>${section(
    MENU_LATEST_HEADING,
    latest,
    "未確定 お支払い分",
  )}${section(MENU_SCHEDULE_HEADING, schedules, "未確定 ショッピングスキップ払い")}${section(
    MENU_PAST_HEADING,
    past,
    "ご請求はありません",
  )}</body></html>`;
}
