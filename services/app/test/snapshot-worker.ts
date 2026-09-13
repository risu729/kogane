// Test-only snapshot adapter. No Wrangler configuration deploys this fixture.
import snapshot from "../demo-snapshot.json";
import { authenticate } from "../src/auth";
import { isAgentPath, SHARED_QUERY_PATH } from "../src/agent-api";
import { HttpError, json, secureResponse } from "../src/http";
import { downloadDisposition } from "../src/read";

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
      // The demo serves a fixed synthetic snapshot and has no read model, no
      // grant table and no write path. The agent API is not deployed here.
      if (isAgentPath(url.pathname) || url.pathname === SHARED_QUERY_PATH)
        throw new HttpError(403, "agent_api_not_configured");
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
          const sha256 = url.pathname.split("/").at(-1)!;
          headers.set(
            "content-disposition",
            downloadDisposition({
              artifact_key: sha256,
              declared_media_type: item.contentType,
              sha256,
            }),
          );
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
