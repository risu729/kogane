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
// Exact response literal emitted by the pinned @cloudflare/containers 0.3.7 startup catch.
// This classifies the returned response only; it makes no claim about provisioning or cause.
export const SDK_NO_INSTANCE_RESPONSE =
  "There is no Container instance available at this time.\n" +
  "This is likely because you have reached your max concurrent instance count (set in wrangler config) or are you currently provisioning the Container.\n" +
  "If you are deploying your Container for the first time, check your dashboard to see provisioning status, this may take a few minutes.";
export type SdkStartupCategory = "sdk_no_instance_response" | "other_503_response" | "unavailable";
export async function classifySdkStartupResponse(
  response: Response,
  { timeoutMs = 1_000, now = Date.now }: { timeoutMs?: number; now?: () => number } = {},
): Promise<SdkStartupCategory> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_000) return "unavailable";
  const started = now();
  const expected = new TextEncoder().encode(SDK_NO_INSTANCE_RESPONSE);
  let category: SdkStartupCategory = "unavailable";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false,
    timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = () => {
    const elapsed = now() - started;
    return !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs || timedOut;
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("sdk_startup_observation_timeout"));
    }, timeoutMs);
  });
  // All operation rejections, including those resolving after timeout, have a race handler.
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
  try {
    reader = response.body?.getReader();
    if (reader) {
      let size = 0;
      for (let samples = 0; samples < 338; samples++) {
        if (expired()) break;
        const part = await bounded(reader.read());
        if (expired()) break;
        if (part.done) {
          complete = true;
          category =
            size === expected.byteLength ? "sdk_no_instance_response" : "other_503_response";
          break;
        }
        if (!(part.value instanceof Uint8Array)) break;
        if (part.value.byteLength > 338 - size) {
          category = "other_503_response";
          break;
        }
        let matches = true;
        for (const byte of part.value) {
          if (size >= expected.byteLength || byte !== expected[size]) matches = false;
          size++;
        }
        if (!matches) {
          category = "other_503_response";
          break;
        }
      }
    }
  } catch {
    category = "unavailable";
  } finally {
    if (reader && !complete) {
      try {
        const cancellation = reader.cancel();
        if (expired()) void cancellation.catch(() => {});
        else await bounded(cancellation);
      } catch {
        // Cleanup failure cannot replace the original HTTP failure.
      }
    }
    if (expired()) category = "unavailable";
    if (timer) clearTimeout(timer);
    try {
      reader?.releaseLock();
    } catch {
      // A pending source read is already guarded by its race handler.
    }
  }
  return category;
}
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
        return Response.json(
          { code: "unauthorized" },
          { status: 401, headers: { "x-verification-failure": "worker_unauthorized" } },
        );
      if (!revisions.has(env.HARNESS_REVISION))
        return Response.json(
          { code: "revision_invalid" },
          { status: 503, headers: { "x-verification-failure": "worker_revision_invalid" } },
        );
      const path = new URL(request.url).pathname;
      const methods: Record<string, string> = {
        "/initialize": "POST",
        "/state": "GET",
        "/once": "POST",
        "/stats": "GET",
        "/delay": "GET",
        "/stream": "GET",
        "/backpressure": "GET",
        "/backpressure-check": "GET",
        "/reader-resume-check": "GET",
        "/reader-cancel-check": "GET",
        "/backpressure-compare": "GET",
        "/stream-error-compare": "GET",
        "/stream-error-check": "GET",
        "/stream-error": "GET",
        "/hold": "GET",
        "/destroy": "POST",
        "/signal": "POST",
        "/exit": "POST",
      };
      if (methods[path] !== request.method)
        return Response.json(
          { code: "route_missing" },
          { status: 404, headers: { "x-verification-failure": "worker_route_missing" } },
        );
      if (
        (path === "/backpressure-compare" || path === "/stream-error-compare") &&
        env.HARNESS_REVISION !== "baseline_sdk"
      )
        return Response.json(
          { code: "route_missing" },
          { status: 404, headers: { "x-verification-failure": "worker_route_missing" } },
        );
      try {
        const stub = env.HARNESS.get(env.HARNESS.idFromName("synthetic-fixed-object-v1"));
        // Credentials remain in the Worker; the synthetic image receives no headers/body.
        const response = await stub.fetch(
          new Request(`http://container${path}`, { method: request.method }),
        );
        if (response.status !== 200) {
          if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
            throw new Error("invalid_synthetic_status");
          let startupCategory: SdkStartupCategory | undefined;
          if (
            path === "/once" &&
            request.method === "POST" &&
            response.status === 503 &&
            ["baseline_sdk", "rollback_sdk"].includes(env.HARNESS_REVISION)
          )
            startupCategory = await classifySdkStartupResponse(response);
          else await response.body?.cancel();
          return Response.json(
            { code: "operation_failed" },
            {
              status: 502,
              headers: {
                "x-verification-failure": "upstream_http",
                "x-verification-upstream-status": String(response.status),
                ...(startupCategory ? { "x-verification-sdk-startup": startupCategory } : {}),
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
