// Fetching one allowlisted page and turning its bytes into text lines
// (ADR 0050). The transport is injected, so every test runs on a synthetic one
// and nothing here can reach a provider from a test. What comes back is bytes,
// a closed media type and an HTTP status, or a closed failure code: never the
// provider's text in a log or a record.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { SurveyFailureCode } from "../../../../packages/collection/src/maintenance-survey-model.ts";

/** The platform `fetch` shape; production passes `fetch`, tests a synthetic function. */
export type SurveyTransport = (url: string, init: RequestInit) => Promise<Response>;

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const SURVEY_USER_AGENT = "kogane-maintenance-survey/1";
const MEDIA_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;
export type SurveyMediaType = (typeof MEDIA_TYPES)[number];

export type FetchedPage =
  | {
      ok: true;
      status: number;
      mediaType: SurveyMediaType;
      /** The `charset` parameter of Content-Type, lower-cased, if any. */
      charset: string | null;
      bytes: Uint8Array;
    }
  | {
      ok: false;
      code: SurveyFailureCode;
      status: number | null;
      mediaType: SurveyMediaType | "other" | null;
    };

/**
 * One GET with no cookie or credential (the Worker keeps no cookie jar and
 * none is sent), no redirect following (a redirect is
 * a failure the owner resolves by confirming the new URL), a timeout and a
 * byte cap. A retry is the lane's next attempt, not a loop here: the cursor
 * backs off, so a failing page is never hammered.
 */
export async function fetchPage(
  url: string,
  transport: SurveyTransport,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await transport(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "user-agent": SURVEY_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
      status: null,
      mediaType: null,
    };
  }
  const status = response.status;
  const header = response.headers.get("content-type") ?? "";
  const [type = "", ...params] = header.split(";").map((part) => part.trim().toLowerCase());
  const mediaType = (MEDIA_TYPES as readonly string[]).includes(type)
    ? (type as SurveyMediaType)
    : type
      ? "other"
      : null;
  const fail = async (code: SurveyFailureCode): Promise<FetchedPage> => {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, code, status, mediaType };
  };
  if (status >= 300 && status < 400) return fail("redirected");
  if (status < 200 || status >= 300) return fail("http_error");
  if (mediaType === null || mediaType === "other") return fail("unsupported_content_type");
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) return fail("too_large");
  const bytes = await boundedBytes(response, MAX_PAGE_BYTES);
  if (bytes === null) return { ok: false, code: "too_large", status, mediaType };
  if (bytes.byteLength === 0) return { ok: false, code: "empty_body", status, mediaType };
  const charset =
    params
      .find((p) => p.startsWith("charset="))
      ?.slice(8)
      .replaceAll('"', "") || null;
  return { ok: true, status, mediaType, charset, bytes };
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The page as text, by the charset the response declares, else its byte order
 * mark, else a `<meta charset>` in the first 1024 bytes, else UTF-8. Decoding
 * is fatal: bytes that are not valid in that charset are `decode_failed`, not
 * a page read with replacement characters. A label the runtime's
 * `TextDecoder` does not know is `decode_failed` too.
 */
export function decodePage(bytes: Uint8Array, declared: string | null): string | null {
  let label = declared;
  if (!label) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
    else {
      // The prescan reads only ASCII, so a byte-per-character view is enough.
      const head = String.fromCharCode(...bytes.subarray(0, 1024));
      label = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_-]{1,40})/iu.exec(head)?.[1] ?? "utf-8";
    }
  }
  try {
    return new TextDecoder(label.toLowerCase(), { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type Node = DefaultTreeAdapterMap["node"];
/** Elements whose content is not page text a reader sees. */
const SKIPPED = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "select",
  "textarea",
]);
/** Elements that end a line; table cells only separate words, so a row stays one line. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul",
]);

/**
 * The visible text of a page as lines, whitespace collapsed. Comments,
 * scripts, styles and elements marked `hidden` or `aria-hidden` are not read.
 * Text is data: it is only ever matched against the closed extraction grammar.
 */
export function pageLines(text: string, mediaType: SurveyMediaType): string[] {
  if (mediaType === "text/plain") return lines(text);
  const out: string[] = [];
  let current = "";
  const breakLine = () => {
    out.push(current);
    current = "";
  };
  const walk = (node: Node): void => {
    if (node.nodeName === "#text") {
      current += (node as DefaultTreeAdapterMap["textNode"]).value;
      return;
    }
    if (!("childNodes" in node)) return;
    const tag = "tagName" in node ? node.tagName : "";
    if (SKIPPED.has(tag)) return;
    if (
      "attrs" in node &&
      node.attrs.some(
        (a) => a.name === "hidden" || (a.name === "aria-hidden" && a.value.trim() === "true"),
      )
    )
      return;
    const block = BLOCK.has(tag);
    if (block) breakLine();
    else if (tag === "td" || tag === "th") current += " ";
    for (const child of node.childNodes) walk(child);
    if (block) breakLine();
  };
  walk(parse(text));
  breakLine();
  return lines(out.join("\n"));
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
}
