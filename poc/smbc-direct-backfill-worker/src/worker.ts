import { SmbcBackfillSession } from "./session";
import { renderUi } from "./ui";
import { accessJwtSubject } from "./access";
import { backfillStoredRuns } from "./raw-evidence";

export { SmbcBackfillSession };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      if (!(await authorized(request, env.ADMIN_TRIGGER_TOKEN))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if ([...url.searchParams.keys()].some((key) => key !== "limit" && key !== "cursor") ||
          url.searchParams.getAll("limit").length !== 1 ||
          url.searchParams.get("limit") !== "1" ||
          url.searchParams.getAll("cursor").length > 1) {
        return json({ error: "backfill_options_invalid" }, 400);
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && !safeCursor(cursor)) {
        return json({ error: "cursor_invalid" }, 400);
      }
      try {
        return json(await backfillStoredRuns(env.RAW_EVIDENCE_IMPORTER, cursor));
      } catch {
        return json({ error: "raw_evidence_backfill_failed" }, 502);
      }
    }
    if (!ctx.access) {
      console.warn(JSON.stringify({
        message: "access_context_missing",
        hasAssertion: request.headers.has("cf-access-jwt-assertion"),
      }));
      return new Response("Cloudflare Access authentication required", { status: 403 });
    }
    const identity = await ctx.access.getIdentity();
    const assertionSubject = accessJwtSubject(request.headers.get("cf-access-jwt-assertion"));
    const identityKey = identity?.user_uuid ?? identity?.email ?? assertionSubject;
    if (!identityKey) {
      console.warn(JSON.stringify({
        message: "access_identity_missing",
        hasAssertion: request.headers.has("cf-access-jwt-assertion"),
      }));
      return new Response("Cloudflare Access identity required", { status: 403 });
    }

    const stub = env.BACKFILL_SESSION.getByName(await identityHash(identityKey));
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const nonce = randomNonce();
        return new Response(renderUi({ nonce }), {
          headers: securityHeaders(nonce),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(await stub.getStatus());
      }
      if (request.method === "POST" && url.pathname === "/api/start") {
        assertSameOriginAction(request);
        await readJsonObject(request);
        return json(await stub.startChallenge());
      }
      if (request.method === "POST" && url.pathname === "/api/finish") {
        assertSameOriginAction(request);
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 0) throw new Error("finish_options_not_supported");
        return json(await stub.finishAndStart());
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      const errorCode = classifyError(error);
      console.error(JSON.stringify({
        message: "smbc_backfill_request_failed",
        operation: url.pathname === "/api/start" ? "start" : url.pathname === "/api/finish" ? "finish" : "request",
        errorCode,
      }));
      return json({ errorCode }, 400);
    }
  },
} satisfies ExportedHandler<Env>;

async function authorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || expected.length < 20 || expected.length > 512 ||
      /[\x00-\x20\x7f]/u.test(expected)) {
    return false;
  }
  const supplied = header.slice("Bearer ".length);
  if (supplied.length < 20 || supplied.length > 512 || /[\x00-\x20\x7f]/u.test(supplied)) {
    return false;
  }
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function safeCursor(value: string): boolean {
  return value.length > 0 && value.length <= 12_000 && !/[\x00-\x20\x7f]/u.test(value);
}

async function identityHash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function securityHeaders(nonce: string): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function assertSameOriginAction(request: Request): void {
  if (request.headers.get("x-kogane-action") !== "1") throw new Error("action_header_missing");
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("origin_invalid");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new Error("cross_site_request_rejected");
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("content_type_invalid");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 4096) throw new Error("request_body_too_large");
  if (!request.body) throw new Error("json_body_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error("request_body_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("json_body_invalid");
  return body as Record<string, unknown>;
}

function classifyError(error: unknown): string {
  if (error instanceof Error) {
    const code = error.message.toLowerCase();
    if (/^[a-z0-9_]+$/u.test(code)) return code;
  }
  if (error instanceof SyntaxError) return "json_parse_failed";
  if (error instanceof TypeError) return "type_error";
  return "unexpected_error";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
