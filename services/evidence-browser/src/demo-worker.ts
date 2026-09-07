import snapshot from "../demo-snapshot.json";
import { authenticate } from "./auth";
import { HttpError, json, secureResponse } from "./http";

type DemoEnv = Pick<Env, "ASSETS" | "ACCESS_ISSUER" | "ACCESS_AUDIENCE">;
const responses: Record<string, { status: number; contentType: string; bodyBase64: string }> =
  snapshot.responses;

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
    let response: Response;
    let errorCode: string | null = null;
    try {
      await authenticate(request, env);
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "method_not_allowed");
      if (snapshot.schemaVersion !== 1 || snapshot.classification !== "synthetic")
        throw new HttpError(503, "demo_not_configured");
      if (api) {
        if (url.search) throw new HttpError(400, "invalid_query");
        const item = Object.hasOwn(responses, url.pathname) ? responses[url.pathname] : undefined;
        if (!item) throw new HttpError(404, "not_found");
        const headers = new Headers({ "content-type": item.contentType });
        if (url.pathname.startsWith("/api/raw/")) {
          headers.set("content-disposition", 'attachment; filename="synthetic-evidence.bin"');
          headers.set("content-security-policy", "default-src 'none'; sandbox");
        }
        response = new Response(
          Uint8Array.from(atob(item.bodyBase64), (char) => char.charCodeAt(0)),
          { status: item.status, headers },
        );
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (error) {
      const known = error instanceof HttpError;
      errorCode = known ? error.code : "internal_error";
      response = json({ error: errorCode, requestId }, known ? error.status : 500);
    }
    if (response.status === 405) response.headers.set("allow", "GET, HEAD");
    console.log(
      JSON.stringify({
        event: "demo_request",
        route: api ? "api" : "assets",
        method: request.method,
        status: response.status,
        requestId,
        durationMs: Date.now() - started,
        errorCode,
      }),
    );
    return secureResponse(response, request, requestId);
  },
} satisfies ExportedHandler<DemoEnv>;
