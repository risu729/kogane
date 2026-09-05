import { timingSafeEqual } from "node:crypto";
import { VPointPayCredentialState } from "./state";

export { VPointPayCredentialState };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        collectionEnabled: false,
        status: "disabled",
        reason: "email_only",
        source: "v-point-pay",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method === "POST" && ["/trigger", "/probe", "/reset-credentials"].includes(url.pathname)) {
      return Response.json({ error: "App API collector disabled; email collection remains active", collectionEnabled: false }, { status: 410 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const state = stateStub(env);
    if (url.pathname === "/credential-status") {
      return Response.json(await state.credentialStatus());
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(): Promise<void> {
    console.log(JSON.stringify({ event: "vpoint-pay-app-collection-disabled", reason: "email_only" }));
  },
} satisfies ExportedHandler<Env>;

function stateStub(
  env: Env,
): DurableObjectStub<VPointPayCredentialState> {
  return env.VPOINT_PAY_STATE.get(env.VPOINT_PAY_STATE.idFromName("primary"));
}

function authorized(request: Request, expected: string | undefined): boolean {
  const provided = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!provided || !expected) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
