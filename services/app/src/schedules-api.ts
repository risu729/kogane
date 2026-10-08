// Operator schedule settings, plus one narrowly scoped deployment bootstrap.
import { accessIdentity } from "./auth";
import { principalFor } from "./grants";
import { HttpError } from "./http";
import { parseSubjectList, principalCan } from "../../../packages/application/src/index";
export const SCHEDULES_PATH = "/api/ops/v1/schedules";
type ScheduleEnv = Env & { SCHEDULES_ENABLED?: string; DEPLOYMENT_SCHEDULE_TOKENS?: string };
function enabled(env: ScheduleEnv) {
  if (env.SCHEDULES_ENABLED !== "true") throw new HttpError(404, "not_found");
}
async function relay(
  request: Request,
  env: Env,
  suffix: string,
  actor?: string,
  body?: string,
): Promise<Response> {
  try {
    return await env.PIPELINE.fetch(
      new Request(`https://observation-pipeline.internal/internal/schedules${suffix}`, {
        method: request.method,
        headers: {
          "x-kogane-internal-caller": "kogane-evidence-browser",
          ...(actor ? { "x-kogane-operator": actor } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      }),
    );
  } catch {
    throw new HttpError(503, "scheduling_unavailable");
  }
}
/** Service tokens cannot edit settings. This only reconciles future reservations. */
export async function scheduleBootstrapApi(
  request: Request,
  env: ScheduleEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== `${SCHEDULES_PATH}/bootstrap`) return null;
  enabled(env);
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_request");
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > 0) {
          await reader.cancel();
          throw new HttpError(400, "invalid_request");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const identity = await accessIdentity(request, env);
  const tokens = parseSubjectList(env.DEPLOYMENT_SCHEDULE_TOKENS);
  if (tokens === null) throw new HttpError(503, "grants_misconfigured");
  if (!identity.serviceToken || !tokens.includes(identity.serviceToken))
    throw new HttpError(403, "deployment_token_required");
  // An older App must not initialize a newer Processor (or the reverse).
  let health: Response;
  try {
    health = await env.PIPELINE.fetch(
      new Request("https://observation-pipeline.internal/internal/health", {
        headers: { "x-kogane-internal-caller": "kogane-evidence-browser" },
      }),
    );
  } catch {
    throw new HttpError(503, "scheduling_unavailable");
  }
  let value: { releaseSha?: string };
  try {
    value = (await health.json()) as { releaseSha?: string };
  } catch {
    throw new HttpError(503, "scheduling_unavailable");
  }
  if (
    health.status !== 200 ||
    !/^[0-9a-f]{40}$/u.test(env.RELEASE_SHA) ||
    value.releaseSha !== env.RELEASE_SHA
  )
    throw new HttpError(503, "release_mismatch");
  return relay(request, env, "/bootstrap");
}
async function boundedBody(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
    throw new HttpError(415, "json_required");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request");
  }
  return text;
}
export async function schedulesApi(
  request: Request,
  env: ScheduleEnv,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== SCHEDULES_PATH && !url.pathname.startsWith(`${SCHEDULES_PATH}/`))
    return null;
  enabled(env);
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!principalCan(principalFor(env, subject), "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  const suffix = url.pathname.slice(SCHEDULES_PATH.length);
  if (request.method === "GET" && suffix === "") return relay(request, env, "");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  // A job id, a lease release, or the decision on one survey proposal (ADR 0050).
  if (
    !/^\/(?:[a-z0-9-]{1,100}|leases\/[a-z0-9-]{1,100}|proposals\/[1-9][0-9]{0,15})$/u.test(
      suffix,
    ) ||
    suffix === "/bootstrap"
  )
    throw new HttpError(404, "not_found");
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("x-kogane-settings") !== "1"
  )
    throw new HttpError(403, "same_origin_required");
  return relay(request, env, suffix, subject, await boundedBody(request));
}
