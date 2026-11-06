export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /**
     * Safe identifiers the caller may act on — a field path it sent, an
     * operation id it holds. Never a rejected value, a provider string, an
     * amount or an exception message (addendum 10 §9, G3-08).
     */
    readonly refs: readonly string[] = [],
  ) {
    super(code);
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export function identifier(value: string, prefix: "r" | "a" | "c"): number {
  if (!new RegExp(`^${prefix}_[1-9][0-9]{0,15}$`).test(value))
    throw new HttpError(400, "invalid_identifier");
  const id = Number(value.slice(2));
  if (!Number.isSafeInteger(id)) throw new HttpError(400, "invalid_identifier");
  return id;
}

/**
 * The request body as text, refused with `413 request_too_large` once it
 * exceeds `limit` **bytes** — a declared `content-length` first, then the
 * bytes actually streamed, so a body that declares no length (or a wrong
 * one) is bounded too. Counting `text.length` instead would measure UTF-16
 * code units and let up to three times the bound of non-ASCII text through.
 */
export async function boundedText(request: Request, limit: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit))
    throw new HttpError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

export function cursor(url: URL): number {
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  ) {
    throw new HttpError(400, "invalid_query");
  }
  const value = url.searchParams.get("cursor");
  return value === null ? Number.MAX_SAFE_INTEGER : identifier(value, "c");
}

export function secureResponse(response: Response, request: Request, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("x-request-id", requestId);
  if (!headers.has("content-security-policy")) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}
