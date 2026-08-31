import PostalMime, { type Email } from "postal-mime";

const VPOINT_PAY_SENDER = "info@prepaid.smbc-card.com";
const MAX_RFC822_DEPTH = 2;

export type VPointPayEmailEventType =
  | "usage"
  | "charge"
  | "balance-addition"
  | "declined";

export interface VPointPayEmailEvent {
  schemaVersion: "vpoint-pay-email-event-v1";
  id: string;
  sourceMessageId: string | null;
  occurredAt: string;
  eventType: VPointPayEmailEventType;
  subject: string;
  merchant: string | null;
  detail: string | null;
  amountYen: number | null;
  usedPoints: number | null;
  balanceYen: number | null;
}

export interface ParsedVPointPayEmail {
  event: VPointPayEmailEvent;
  raw: Uint8Array;
}

export interface StoredVPointPayEmail {
  event: VPointPayEmailEvent;
  rawKey: string;
  normalizedKey: string;
  duplicate: boolean;
}

export async function parseVPointPayEmail(
  raw: ArrayBuffer | Uint8Array,
): Promise<ParsedVPointPayEmail | null> {
  return parseCandidate(toBytes(raw), 0);
}

export async function storeVPointPayEmail(options: {
  bucket: R2Bucket;
  parsed: ParsedVPointPayEmail;
}): Promise<StoredVPointPayEmail> {
  const { event, raw } = options.parsed;
  const date = event.occurredAt.slice(0, 10).replaceAll("-", "/");
  const prefix = `raw/v-point-pay-email/${date}/${event.id}`;
  const rawKey = `${prefix}.eml`;
  const normalizedKey = `${prefix}.json`;
  const duplicate = (await options.bucket.head(rawKey)) !== null;
  await Promise.all([
    duplicate
      ? Promise.resolve()
      : options.bucket.put(rawKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: {
          source: "v-point-pay-email",
          eventType: event.eventType,
          sha256: event.id,
        },
      }),
    options.bucket.put(normalizedKey, JSON.stringify(event), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          source: "v-point-pay-email",
          eventType: event.eventType,
          sha256: event.id,
        },
    }),
  ]);
  return { event, rawKey, normalizedKey, duplicate };
}

async function parseCandidate(
  raw: Uint8Array,
  depth: number,
): Promise<ParsedVPointPayEmail | null> {
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    rfc822Attachments: true,
    forceRfc822Attachments: true,
  });
  const direct = await normalize(email, raw);
  if (direct) return direct;
  if (depth >= MAX_RFC822_DEPTH) return null;
  for (const attachment of email.attachments) {
    if (attachment.mimeType.toLowerCase() !== "message/rfc822") continue;
    const content = typeof attachment.content === "string"
      ? new TextEncoder().encode(attachment.content)
      : new Uint8Array(attachment.content);
    const nested = await parseCandidate(content, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function normalize(
  email: Email,
  raw: Uint8Array,
): Promise<ParsedVPointPayEmail | null> {
  if (senderAddress(email) !== VPOINT_PAY_SENDER) return null;
  const subject = email.subject?.trim() ?? "";
  const eventType = classifySubject(subject);
  if (!eventType || !email.text || !email.date) return null;
  const occurredAt = new Date(email.date);
  if (!Number.isFinite(occurredAt.getTime())) return null;
  const id = await sha256Hex(raw);
  const text = normalizeText(email.text);
  const amountLabel = eventType === "usage"
    ? "利用金額"
    : eventType === "charge"
      ? "チャージ金額"
      : eventType === "balance-addition"
        ? "加算額"
        : "利用金額";
  const balanceLabel = eventType === "charge"
    ? "チャージ後の残高"
    : eventType === "balance-addition"
      ? "加算後のプリペイド残高"
      : "利用後の残高";
  const event: VPointPayEmailEvent = {
    schemaVersion: "vpoint-pay-email-event-v1",
    id,
    sourceMessageId: email.messageId ?? null,
    occurredAt: occurredAt.toISOString(),
    eventType,
    subject,
    merchant: field(text, "利用先"),
    detail: field(text, eventType === "balance-addition" ? "加算方法" : "取引内容"),
    amountYen: yenField(text, amountLabel),
    usedPoints: pointsField(text, "内、利用Vポイント数"),
    balanceYen: yenField(text, balanceLabel),
  };
  return { event, raw };
}

function senderAddress(email: Email): string | null {
  const address = email.from && "address" in email.from
    ? email.from.address
    : undefined;
  return address?.trim().toLowerCase() ?? null;
}

function classifySubject(subject: string): VPointPayEmailEventType | null {
  if (subject.includes("ご利用のお知らせ")) return "usage";
  if (subject.includes("チャージ受付のお知らせ")) return "charge";
  if (subject.includes("プリペイド残高加算のお知らせ")) {
    return "balance-addition";
  }
  if (
    subject.includes("ご利用不可のお知らせ") ||
    subject.includes("カードがご利用頂けませんでした")
  ) return "declined";
  return null;
}

function normalizeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("：", ":")
    .replaceAll("Ｖ", "V")
    .replaceAll("　", " ");
}

function field(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = text.match(new RegExp(`(?:◇\\s*)?${escaped}\\s*:\\s*([^\\n]+)`, "u"));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function yenField(text: string, label: string): number | null {
  const value = field(text, label);
  if (!value) return null;
  const match = value.match(/(-?[0-9,]+)\s*円/u);
  return match?.[1] ? Number(match[1].replaceAll(",", "")) : null;
}

function pointsField(text: string, label: string): number | null {
  const value = field(text, label);
  if (!value) return null;
  const match = value.match(/(-?[0-9,]+)\s*ポイント/u);
  return match?.[1] ? Number(match[1].replaceAll(",", "")) : null;
}

function toBytes(raw: ArrayBuffer | Uint8Array): Uint8Array {
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
