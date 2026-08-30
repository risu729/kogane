import type { DiscoveredCard, DiscoveredPeriod, StatementState } from "./types";

const ALLOWED_PRODUCT_HINTS = [
  "JCB W",
  "リクルートカード",
  "みずほJCBデビット",
  "京銀JCBデビット",
] as const;

export function parseCardInventory(html: string): DiscoveredCard[] {
  const candidates = [...html.matchAll(
    /<(?:option|a)\b[^>]*(?:data-card-index|value|href)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:option|a)>/giu,
  )];
  const cards: DiscoveredCard[] = [];
  for (const [index, match] of candidates.entries()) {
    const text = normalizeText(stripTags(match[2] ?? ""));
    if (!/(?:カード|JCB|デビット)/u.test(text)) continue;
    cards.push({
      localId: `card-${String(index + 1).padStart(3, "0")}`,
      ...(productHint(text) ? { productHint: productHint(text) } : {}),
      switchCandidate: /(?:切替|おまとめ|card)/iu.test(`${match[1] ?? ""} ${text}`),
    });
  }
  return dedupeCards(cards);
}

export function parseStatementPeriods(html: string): DiscoveredPeriod[] {
  const periods = new Map<string, DiscoveredPeriod>();
  for (const match of html.matchAll(
    /<(?:option|a)\b[^>]*(?:value|href)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:option|a)>/giu,
  )) {
    const target = decodeHtml(match[1] ?? "");
    const label = normalizeText(stripTags(match[2] ?? ""));
    const sequence = target.match(/[?&]seq=(\d{1,2})(?:&|$)/u)?.[1] ??
      (/^\d{1,2}$/u.test(target) ? target : undefined);
    if (sequence === undefined && !/(?:\d{4}年\d{1,2}月|未確定|確定)/u.test(label)) continue;
    const numericSequence = sequence === undefined ? undefined : Number(sequence);
    if (numericSequence !== undefined && (numericSequence < 0 || numericSequence > 14)) continue;
    const key = `${numericSequence ?? "label"}:${label}`;
    periods.set(key, {
      ...(numericSequence === undefined ? {} : { sequence: numericSequence }),
      label,
      state: statementState(label),
      exportKinds: exportKindsNear(html, match.index ?? 0),
    });
  }
  return [...periods.values()];
}

export function statementState(value: string): StatementState {
  const normalized = normalizeText(value);
  if (/未確定/u.test(normalized)) return "unconfirmed";
  if (/確定/u.test(normalized)) return "confirmed";
  if (/(?:お振替日|差額発生日|デビット)/u.test(normalized)) return "debit";
  return "unknown";
}

export function redactedStatementHtml(html: string): string {
  return html
    .replace(
      /(<input\b[^>]*\bvalue=["'])[^"']*(["'])/giu,
      "$1[redacted]$2",
    )
    .replace(
      /(<textarea\b[^>]*(?:name|id)=["'][^"']*(?:token|csrf|password|userid|user_id|session|otp|secret)[^"']*["'][^>]*>)[\s\S]*?(<\/textarea>)/giu,
      "$1[redacted]$2",
    )
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/gu, "[card-number-redacted]");
}

function exportKindsNear(
  html: string,
  index: number,
): readonly ("csv" | "pdf" | "ofx")[] {
  const nearby = html.slice(Math.max(0, index - 600), index + 1200);
  const result: ("csv" | "pdf" | "ofx")[] = [];
  if (/CSV/iu.test(nearby)) result.push("csv");
  if (/PDF/iu.test(nearby)) result.push("pdf");
  if (/OFX/iu.test(nearby)) result.push("ofx");
  return result;
}

function productHint(value: string): string | undefined {
  return ALLOWED_PRODUCT_HINTS.find((name) => value.includes(name));
}

function dedupeCards(cards: readonly DiscoveredCard[]): DiscoveredCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.productHint ?? "unknown"}:${card.switchCandidate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/gu, " "));
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
