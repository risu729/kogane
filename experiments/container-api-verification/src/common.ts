import { createHash, timingSafeEqual } from "node:crypto";
export interface HarnessEnv {
  HARNESS: DurableObjectNamespace;
  HARNESS_KEY: string;
  HARNESS_REVISION: string;
  HARNESS_MONITOR: string;
}
export const revisions = new Set([
  "baseline_sdk",
  "native",
  "native_unmonitored",
  "native_recovered",
  "rollback_sdk",
]);
const sentinel = "synthetic-sentinel-v1";
export async function storageState(ctx: DurableObjectState, initialize = false) {
  ctx.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS verification_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  if (initialize) {
    await ctx.storage.put("verification-sentinel", sentinel);
    ctx.storage.sql.exec("INSERT OR IGNORE INTO verification_sentinel VALUES (1, ?)", sentinel);
  }
  const rows = ctx.storage.sql
    .exec<{ value: string }>("SELECT value FROM verification_sentinel WHERE id = 1")
    .toArray();
  return {
    kvSentinelMatch: Number((await ctx.storage.get("verification-sentinel")) === sentinel),
    sqlSentinelMatch: Number(rows.length === 1 && rows[0]?.value === sentinel),
    sdkAlarmPresent: Number((await ctx.storage.getAlarm()) !== null),
  };
}
export function worker() {
  return {
    async fetch(request: Request, env: HarnessEnv): Promise<Response> {
      // No unauthenticated DO lookup or process startup.
      const provided = request.headers.get("authorization") ?? "";
      const expected = `Bearer ${env.HARNESS_KEY}`;
      const digest = (value: string) => createHash("sha256").update(value).digest();
      if (!env.HARNESS_KEY || !timingSafeEqual(digest(provided), digest(expected)))
        return Response.json({ code: "unauthorized" }, { status: 401 });
      if (!revisions.has(env.HARNESS_REVISION))
        return Response.json({ code: "revision_invalid" }, { status: 503 });
      const path = new URL(request.url).pathname;
      const methods: Record<string, string> = {
        "/initialize": "POST",
        "/state": "GET",
        "/once": "POST",
        "/stats": "GET",
        "/delay": "GET",
        "/stream": "GET",
        "/backpressure": "GET",
        "/stream-error": "GET",
        "/hold": "GET",
        "/destroy": "POST",
        "/signal": "POST",
        "/exit": "POST",
      };
      if (methods[path] !== request.method)
        return Response.json({ code: "route_missing" }, { status: 404 });
      try {
        const stub = env.HARNESS.get(env.HARNESS.idFromName("synthetic-fixed-object-v1"));
        // Credentials remain in the Worker; the synthetic image receives no headers/body.
        const response = await stub.fetch(
          new Request(`http://container${path}`, { method: request.method }),
        );
        if (response.status !== 200) {
          if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
            throw new Error("invalid_synthetic_status");
          await response.body?.cancel();
          return Response.json(
            { code: "operation_failed" },
            {
              status: 502,
              headers: {
                "x-verification-failure": "upstream_http",
                "x-verification-upstream-status": String(response.status),
              },
            },
          );
        }
        return response;
      } catch {
        return Response.json(
          { code: "operation_failed" },
          {
            status: 502,
            headers: { "x-verification-failure": "worker_exception" },
          },
        );
      }
    },
  };
}
