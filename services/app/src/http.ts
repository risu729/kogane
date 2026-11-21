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
    /**
     * Closed hints that travel beside the code, such as `mustMatch` on a
     * `cursor_mismatch` (ADR 0123): input names only, never a value.
     */
    readonly hints: HttpErrorHints = {},
  ) {
    super(code);
  }
}

/**
 * The methods a read route serves: GET, and HEAD, which is the GET's answer
 * — status and headers — without its body (`secureResponse` drops it).
 */
export const READ_METHODS = ["GET", "HEAD"] as const;
/** The one method of every state-changing route of this Worker, `/mcp` included. */
export const WRITE_METHODS = ["POST"] as const;

/**
 * `405 method_not_allowed`, carrying the methods the target route serves.
 * The Worker's one error formatter (`errorResponse`) turns them into the
 * `Allow` header RFC 9110 §15.5.6 requires on every 405, so no route sets the
 * header itself and none can leave it out.
 */
export class MethodNotAllowed extends HttpError {
  constructor(readonly allow: readonly string[]) {
    super(405, "method_not_allowed");
  }
}

/** Refuses a request whose method is not one of `allow`, naming them (`MethodNotAllowed`). */
export function assertMethod(request: Request, allow: readonly string[]): void {
  if (!allow.includes(request.method)) throw new MethodNotAllowed(allow);
}

/**
 * The Worker's answer to a thrown error: the closed code, the request id and
 * the error's safe refs and hints, with `Allow` on a 405. Anything that is not
 * an `HttpError` is `500 internal_error`, its text never sent.
 */
export function errorResponse(error: unknown, requestId: string): Response {
  if (!(error instanceof HttpError)) return json({ error: "internal_error", requestId }, 500);
  const refs = error.refs.length > 0 ? { refs: error.refs } : {};
  return Response.json(
    { error: error.code, requestId, ...refs, ...error.hints },
    {
      status: error.status,
      ...(error instanceof MethodNotAllowed ? { headers: { allow: error.allow.join(", ") } } : {}),
    },
  );
}

/**
 * The hints an `HttpError` may carry beside its code. The keys are closed, so
 * a hint can never replace the body's `error`, `requestId` or `refs`.
 */
export interface HttpErrorHints {
  /** The argument names a continuation must repeat as they were (ADR 0123). */
  readonly mustMatch?: readonly string[];
}

/**
 * This Worker's own-origin rule (ADR 0047 for the agent paths, ADR 0078 for
 * the command and operations routes): an `Origin` that is present and is not
 * this Worker's own origin is `403 origin_not_allowed`. A browser attaches
 * `Origin` to every POST — `null` when the page hides its own — so a page on
 * another site cannot drive a signed-in browser's Access session into a
 * state-changing call. A non-browser client (an MCP client, an operator's
 * `curl`) sends no `Origin` and is unaffected.
 */
export function assertOwnOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) throw new HttpError(403, "origin_not_allowed");
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
  return (await boundedRead(request, limit)).text;
}

/**
 * `boundedText`, with the number of bytes the body carried. A route that
 * treats an empty body specially asks the bytes, not the text: a lone UTF-8
 * byte-order mark decodes to no text but is not an empty body.
 */
export async function boundedRead(
  request: Request,
  limit: number,
): Promise<{ text: string; bytes: number }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit))
    throw new HttpError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
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
  return { text: text + decoder.decode(), bytes: size };
}

export function cursor(url: Pick<URL, "searchParams">): number {
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
  // Every answer is authenticated financial data or the shell that reads it:
  // another site may not load it as a no-cors subresource, and no window
  // across origins keeps a handle on this one.
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("x-request-id", requestId);
  if (!headers.has("content-security-policy")) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  }
  // A HEAD answer has no body: the GET's is cancelled, never read, so a relayed
  // stream (the schedules snapshot in full) is released at once.
  if (request.method === "HEAD") response.body?.cancel().catch(() => undefined);
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}
