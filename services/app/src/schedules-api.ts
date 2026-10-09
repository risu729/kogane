// Operator schedule settings, plus one narrowly scoped deployment bootstrap.
//
// Every settings write (a job edit, a maintenance edit, a survey decision, a
// lease release) is recorded (ADR 0064, path `ui`): the Processor appends the
// `applied` record to the write's own batch, and this module records every
// refusal — its own or the Processor's — once, after the answer. The page's
// GET is a page load and is not recorded; the bootstrap is a service token's,
// with no subject, and is not recorded either.
import { accessIdentity } from "./auth";
import { type Answer, auditContext, auditedRoute, UpstreamLost, upstreamOutcome } from "./audit";
import { principalFor } from "./grants";
import { HttpError } from "./http";
import {
  type OperationCall,
  type OperationName,
  parseSubjectList,
  principalCan,
} from "../../../packages/application/src/index";
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
  envelope: Record<string, string> = {},
): Promise<Response> {
  try {
    return await env.PIPELINE.fetch(
      new Request(`https://observation-pipeline.internal/internal/schedules${suffix}`, {
        method: request.method,
        headers: {
          "x-kogane-internal-caller": "kogane-evidence-browser",
          ...(actor ? { "x-kogane-operator": actor } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...envelope,
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
/** The settings write a POST names, or null for a path that is not one. */
export function scheduleOperation(suffix: string): OperationName | null {
  if (suffix === "/maintenance") return "schedules.maintenance.update";
  if (/^\/leases\/[a-z0-9-]{1,100}$/u.test(suffix)) return "schedules.lease.release";
  if (/^\/proposals\/[1-9][0-9]{0,15}$/u.test(suffix)) return "schedules.survey.decide";
  if (/^\/[a-z0-9-]{1,100}$/u.test(suffix) && suffix !== "/bootstrap")
    return "schedules.job.update";
  return null;
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
  const suffix = url.pathname.slice(SCHEDULES_PATH.length);
  const operation = request.method === "POST" ? scheduleOperation(suffix) : null;
  if (operation === null) return scheduleRoute(request, env, url, subject, suffix);
  return auditedRoute(auditContext(request, env, "ui", subject), operation, (call) =>
    scheduleWrite(request, env, url, subject, suffix, call),
  );
}
/** The page's read and every request that names no settings write: recorded by nobody. */
async function scheduleRoute(
  request: Request,
  env: ScheduleEnv,
  url: URL,
  subject: string,
  suffix: string,
): Promise<Response> {
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!principalCan(principalFor(env, subject), "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if (request.method === "GET" && suffix === "") return relay(request, env, "");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  // A job id, a lease release, or the decision on one survey proposal (ADR 0050).
  throw new HttpError(404, "not_found");
}
/** One settings write, forwarded with the audit envelope (ADR 0064). */
async function scheduleWrite(
  request: Request,
  env: ScheduleEnv,
  url: URL,
  subject: string,
  suffix: string,
  call: OperationCall,
): Promise<Answer> {
  if (url.search) throw new HttpError(400, "invalid_query");
  const principal = principalFor(env, subject);
  call.grade(principal.id, principal.kind);
  if (!principalCan(principal, "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("x-kogane-settings") !== "1"
  )
    throw new HttpError(403, "same_origin_required");
  const body = await boundedBody(request);
  // A survey rejection changes no rule (R1); everything else this operation
  // records stays at its catalogued R2, whatever the Processor answers.
  if (call.operation === "schedules.survey.decide") {
    const decision = (JSON.parse(body) as { decision?: unknown } | null)?.decision;
    if (decision === "reject") call.setRisk("R1");
  }
  let upstream: Response;
  let text: string;
  try {
    upstream = await relay(request, env, suffix, subject, body, call.envelopeHeaders());
    text = await upstream.text();
  } catch {
    // The answer is the one a lost relay always produced; the record says the
    // Processor's answer was lost (its own `applied` record, if any, stands).
    throw new UpstreamLost(503, "scheduling_unavailable");
  }
  return {
    response: new Response(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    }),
    outcome: upstreamOutcome(upstream.status, upstream.headers, text, { result: "replayed" }),
  };
}
