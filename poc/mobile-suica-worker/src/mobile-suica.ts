import { decode } from "iconv-lite";
import { sanitizeHistoryHtml } from "./sanitize";
import type { HistoryRow, RawArtifact, SessionEnvelope } from "./types";

const historyUrl = "https://www.mobilesuica.com/iq/ir/SuicaDisp.aspx";
const maxResponseBytes = 2 * 1024 * 1024;
const historyPageLimit = 100;
const requiredCookieNames = ["ASP.NET_SessionId", "sc_auth", "TS0184138d"];

export function parseSessionEnvelope(input: string): SessionEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Mobile Suica session envelope is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("Mobile Suica session envelope must be an object");
  const cookieHeader = requiredString(value.cookieHeader, "cookieHeader");
  const formBody = requiredString(value.formBody, "formBody");
  const userAgent = requiredString(value.userAgent, "userAgent");
  rejectHeaderInjection(cookieHeader, "cookieHeader");
  rejectHeaderInjection(userAgent, "userAgent");
  const cookieNames = new Set(parseCookieHeader(cookieHeader).keys());
  for (const name of requiredCookieNames) {
    if (!cookieNames.has(name)) throw new Error(`Mobile Suica session is missing cookie ${name}`);
  }
  const fields = new URLSearchParams(formBody);
  if (!fields.get("baseVariable")) {
    throw new Error("Mobile Suica session is missing baseVariable");
  }
  return {
    cookieHeader,
    formBody,
    userAgent,
    ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
  };
}

export async function collectMobileSuica(options: {
  session: SessionEnvelope;
  asOfDateJst: string;
}): Promise<{ artifacts: RawArtifact[]; rows: HistoryRow[]; pageCount: 1; complete: boolean }> {
  const cookieJar = parseCookieHeader(options.session.cookieHeader);
  const initialFields = new URLSearchParams(options.session.formBody);
  const baseVariable = requiredString(initialFields.get("baseVariable"), "baseVariable");
  const response = await fetch(historyUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja-JP,ja;q=0.9,en;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      cookie: serializeCookies(cookieJar),
      origin: "https://www.mobilesuica.com",
      referer: `${historyUrl}?returnId=SFRCMMEPC03`,
      "user-agent": options.session.userAgent,
    },
    body: historySearchBody(baseVariable, options.asOfDateJst),
  });
  updateCookies(cookieJar, response.headers.getSetCookie());
  if (response.status !== 200)
    throw Object.assign(new Error("history_request_failed"), { httpStatus: response.status });
  const responseBytes = await readBounded(response, maxResponseBytes);
  const html = decode(responseBytes, "shift_jis");
  if (isLoginPage(html)) throw new Error("history_session_expired");
  const collectedRows = parseHistoryRows(html, options.asOfDateJst);
  if (collectedRows.length === 0 && !isHistoryPage(html)) {
    throw new Error("history_response_invalid");
  }
  const complete = collectionCompleteness(collectedRows.length);
  const sanitizedBytes = sanitizeHistoryHtml(html);
  const artifacts: RawArtifact[] = [
    {
      dataset: "sf-history-html",
      filename: "sf-history-page-0001.html",
      mediaType: "text/html; charset=shift_jis",
      body: sanitizedBytes,
    },
  ];
  artifacts.push({
    dataset: "sf-history",
    filename: "sf-history.json",
    mediaType: "application/json",
    body: JSON.stringify({
      asOfDateJst: options.asOfDateJst,
      pageCount: 1,
      transactionCount: collectedRows.length,
      complete,
      rows: collectedRows,
    }),
  });
  artifacts.push({
    dataset: "collection-summary",
    filename: "collection-summary.json",
    mediaType: "application/json",
    body: JSON.stringify({
      asOfDateJst: options.asOfDateJst,
      pageCount: 1,
      transactionCount: collectedRows.length,
      complete,
      cookieNames: [...cookieJar.keys()].sort(),
      capturedSessionAt: options.session.capturedAt,
    }),
  });
  return { artifacts, rows: collectedRows, pageCount: 1, complete };
}

export function collectionCompleteness(rowCount: number): boolean {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > historyPageLimit) {
    throw new Error("history_row_count_invalid");
  }
  return rowCount < historyPageLimit;
}

export function parseHistoryRows(html: string, cursorDate: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let inferredYear = Number(cursorDate.slice(0, 4));
  let previousTime = Date.parse(`${cursorDate}T23:59:59+09:00`);
  for (const cells of tableRows(html)) {
    if (cells.length < 8 || !/^\d{1,2}\/\d{1,2}$/u.test(cells[1] ?? "")) continue;
    const [monthText, dayText] = (cells[1] ?? "").split("/");
    const month = Number(monthText);
    const day = Number(dayText);
    let time = Date.parse(`${inferredYear}-${pad(month)}-${pad(day)}T00:00:00+09:00`);
    while (time > previousTime) {
      inferredYear -= 1;
      time = Date.parse(`${inferredYear}-${pad(month)}-${pad(day)}T00:00:00+09:00`);
    }
    previousTime = time;
    const typeFrom = cells[2] ?? "";
    const placeFrom = cells[3] ?? "";
    const typeTo = cells[4] ?? "";
    const placeTo = cells[5] ?? "";
    rows.push({
      date: `${inferredYear}-${pad(month)}-${pad(day)}`,
      typeFrom,
      placeFrom,
      typeTo,
      placeTo,
      balanceText: cells[6] ?? "",
      amountText: cells[7] ?? "",
      balance: parseAmount(cells[6] ?? ""),
      amount: parseAmount(cells[7] ?? ""),
      kind: classify(typeFrom, placeFrom, typeTo),
    });
  }
  return rows;
}

export function historySearchBody(baseVariable: string, date: string): string {
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) throw new Error("Mobile Suica cursor date is invalid");
  return [
    `baseVariable=${encodeURIComponent(baseVariable)}`,
    `specifyYearMonth=${encodeURIComponent(`${year}/${month}`)}`,
    `specifyDay=${encodeURIComponent(day)}`,
    "SEARCH=%8C%9F%8D%F5",
  ].join("&");
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) =>
      textContent(cell[1] ?? ""),
    ),
  );
}

function textContent(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(nbsp|amp|lt|gt|#\d+);/giu, (_match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized === "nbsp") return " ";
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      return String.fromCodePoint(Number(normalized.slice(1)));
    })
    .replace(/\s+/gu, " ")
    .trim();
}

function parseAmount(value: string): number | null {
  const normalized = value.replace(/[￥¥\\円,\s]/gu, "");
  return /^[+-]?\d+$/u.test(normalized) ? Number(normalized) : null;
}

function classify(typeFrom: string, placeFrom: string, typeTo: string): HistoryRow["kind"] {
  const from = typeFrom.normalize("NFKC");
  const place = placeFrom.normalize("NFKC");
  if ((from === "入" || from === "*入") && typeTo === "出") return "rail";
  if (from === "カード" && place === "モバイル") return "charge";
  if (from === "物販") return "payment";
  if (from === "バス等") return "bus";
  if (from === "繰") return "carryover";
  return "other";
}

function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function serializeCookies(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function updateCookies(cookies: Map<string, string>, setCookies: string[]): void {
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0];
    const index = pair?.indexOf("=") ?? -1;
    if (!pair || index <= 0) continue;
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit)
    throw new Error("Mobile Suica response is too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Mobile Suica response is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isHistoryPage(html: string): boolean {
  return /name=["']baseVariable["']/iu.test(html) && /name=["']specifyYearMonth["']/iu.test(html);
}

function isLoginPage(html: string): boolean {
  return /name=["']MailAddress["']/iu.test(html) || /WebCaptcha/i.test(html);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function rejectHeaderInjection(value: string, name: string): void {
  if (/\r|\n/u.test(value)) throw new Error(`${name} contains a newline`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
