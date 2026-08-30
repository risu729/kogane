import { timingSafeEqual } from "node:crypto";
import { VPointPayCredentialState } from "./state";
import type { CollectionResult } from "./types";
import { probeVPointPayApi } from "./vpoint-pay";

export { VPointPayCredentialState };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "v-point-pay",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const state = stateStub(env);
    if (url.pathname === "/probe") {
      await probeVPointPayApi();
      return Response.json({ ok: true, upstream: "v-point-pay" });
    }
    if (url.pathname === "/reset-credentials") {
      return Response.json(await state.resetFromSecrets());
    }
    if (url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const result = await state.runCollection();
    return Response.json(publicResult(result), {
      status: result.status === "failed" ? 502 : 200,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await stateStub(env).runCollection();
    if (result.status === "failed") {
      throw new Error(
        `V Point Pay collection failed; manifest=${result.manifestKey}`,
      );
    }
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

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    earliestMonth: result.earliestMonth,
    latestMonth: result.latestMonth,
    transactionMonthCount: result.transactionMonthCount,
    transactionCount: result.transactionCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    requiresAppReauthentication: result.failures.some((failure) =>
      failure.errorType === "VPointPayReauthenticationRequiredError"
    ),
    manifestKey: result.manifestKey,
  };
}
