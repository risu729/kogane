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
