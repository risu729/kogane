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
import {
  assertMethod,
  boundedText,
  HttpError,
  json,
  MethodNotAllowed,
  READ_METHODS,
  WRITE_METHODS,
} from "./http";
import {
  scheduleSnapshotSummary,
  type ScheduleSnapshot,
} from "../../../packages/collection/src/schedule-model.ts";
import {
  type OperationCall,
  type OperationName,
  parseSubjectList,
  principalCan,
} from "../../../packages/application/src/index";
import { READ_DETAILS } from "../../../packages/domain/src/read-detail.ts";
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
/**
 * A Processor answer as this Worker serves it: its status and its body bytes,
 * under this Worker's own JSON type. No header of the Processor's crosses back
 * — not its `content-type`, not a `content-security-policy` or a cookie — so a
 * relayed body can never choose how this origin serves it, whatever the
 * Processor answered. The same rule as the command relay (`command-api.ts`).
 */
function relayed(upstream: Response, body: BodyInit | null = upstream.body): Response {
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
/**
 * The schedules page's snapshot as the Processor answers it, relayed with no
 * actor: the page's GET and `kogane.schedules.read` (ADR 0081) both read it.
 */
export function relayScheduleSnapshot(env: Env): Promise<Response> {
  return relay(new Request("https://kogane.invalid/", { method: "GET" }), env, "");
}

/**
 * The schedules page at one detail (ADR 0123), the answer of the page's GET
 * and of `kogane.schedules.read`: `full` is the Processor's snapshot relayed
 * as its status and bytes (`relayed`); `summary` is `scheduleSnapshotSummary`
 * of that same snapshot. A refusal the Processor answers is relayed the same
 * way under either detail.
 */
export async function scheduleSnapshotResponse(
  env: Env,
  detail: ScheduleReadDetail,
): Promise<Response> {
  const upstream = await relayScheduleSnapshot(env);
  if (detail === "full" || upstream.status !== 200) return relayed(upstream);
  let snapshot: unknown;
  try {
    snapshot = await upstream.json();
  } catch {
    throw new HttpError(503, "scheduling_unavailable");
  }
  // A snapshot without its lists is not summarized into an empty page.
  const lists = snapshot as Partial<Record<keyof ScheduleSnapshot, unknown>> | null;
  if (
    lists === null ||
    typeof lists !== "object" ||
    !Array.isArray(lists.schedules) ||
    !Array.isArray(lists.maintenance) ||
    !Array.isArray(lists.leases)
  )
    throw new HttpError(503, "scheduling_unavailable");
  return json(scheduleSnapshotSummary(snapshot as ScheduleSnapshot));
}

/** The details the schedules page's GET answers; absent is `summary` (ADR 0123). */
const SCHEDULE_READ_DETAILS = READ_DETAILS;
type ScheduleReadDetail = (typeof SCHEDULE_READ_DETAILS)[number];

/** The page GET's one query parameter, `detail`; anything else is `invalid_query`. */
function scheduleReadDetail(url: URL): ScheduleReadDetail {
  const keys = [...url.searchParams.keys()];
  const detail = url.searchParams.get("detail");
  if (url.search === "") return "summary";
  if (
    keys.length !== 1 ||
    keys[0] !== "detail" ||
    !(SCHEDULE_READ_DETAILS as readonly (string | null)[]).includes(detail)
  )
    throw new HttpError(400, "invalid_query");
  return detail as ScheduleReadDetail;
}
/** Service tokens cannot edit settings. This only reconciles future reservations. */
export async function scheduleBootstrapApi(
  request: Request,
  env: ScheduleEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== `${SCHEDULES_PATH}/bootstrap`) return null;
  enabled(env);
  assertMethod(request, WRITE_METHODS);
  if (url.search) throw new HttpError(400, "invalid_request");
  // Bodyless: a bound of zero bytes, whose overflow (the first byte, read no
  // further) is this route's `400 invalid_request`, not a `413`.
  try {
    await boundedText(request, 0);
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "invalid_request");
    throw error;
  }
  const identity = await accessIdentity(request, env);
  const tokens = parseSubjectList(env.DEPLOYMENT_SCHEDULE_TOKENS);
  if (tokens === null) throw new HttpError(503, "grants_misconfigured");
  if (!identity.serviceToken || !tokens.includes(identity.serviceToken))
    throw new HttpError(403, "deployment_token_required");
  // Capture the deployment identity after service-token authorization. This
  // refusal is before bootstrap writes; only this closed code may be retried.
  const appSha = env.RELEASE_SHA;
  const expectedSha = request.headers.get("x-kogane-release-sha");
  if (typeof appSha !== "string" || !/^[0-9a-f]{40}$/u.test(appSha))
    throw new HttpError(503, "scheduling_unavailable");
  if (expectedSha !== null) {
    if (!/^[0-9a-f]{40}$/u.test(expectedSha)) throw new HttpError(400, "invalid_request");
    if (expectedSha !== appSha) throw new HttpError(503, "release_mismatch");
  }
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
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.releaseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.releaseSha)
  )
    throw new HttpError(503, "scheduling_unavailable");
  if (value.releaseSha !== appSha) throw new HttpError(503, "release_mismatch");
  const upstream = await relay(request, env, "/bootstrap", undefined, undefined, {
    "x-kogane-release-sha": appSha,
  });
  if (upstream.status !== 200) return relayed(upstream);
  // Identity comes from the POST that actually reconciled reservations, never
  // the earlier health GET. A lost/malformed postwrite answer is not replayable.
  let result: unknown;
  try {
    result = await upstream.json();
  } catch {
    throw new HttpError(503, "scheduling_unavailable");
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("releaseSha" in result) ||
    result.releaseSha !== appSha ||
    !("status" in result) ||
    result.status !== "armed" ||
    !("reservations" in result) ||
    !Array.isArray(result.reservations)
  )
    throw new HttpError(503, "scheduling_unavailable");
  return Response.json({ ...result, releaseSha: appSha, processorReleaseSha: result.releaseSha });
}
async function boundedBody(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
    throw new HttpError(415, "json_required");
  if (!request.body) throw new HttpError(400, "invalid_request");
  const text = await boundedText(request, 16 * 1024);
  try {
    JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request");
  }
  return text;
}
/** The settings write a POST names, or null for a path that is not one. */
function scheduleOperation(suffix: string): OperationName | null {
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
  // Only the page's read takes a query: its `detail`. HEAD is that read
  // without its body, as on every other read route.
  const read = suffix === "" && (READ_METHODS as readonly string[]).includes(request.method);
  const detail = read ? scheduleReadDetail(url) : null;
  if (detail === null && url.search) throw new HttpError(400, "invalid_query");
  if (!principalCan(principalFor(env, subject), "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if (detail !== null) return scheduleSnapshotResponse(env, detail);
  // The page itself is read; every path below it is a write (a job id, a
  // lease release, the decision on one survey proposal, ADR 0050), and a
  // POST that names none of them is 404.
  if (request.method !== "POST")
    throw new MethodNotAllowed(suffix === "" ? READ_METHODS : WRITE_METHODS);
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
  let bytes: ArrayBuffer;
  try {
    upstream = await relay(request, env, suffix, subject, body, call.envelopeHeaders());
    // The bytes are relayed; the text is read from them only for the record.
    // `Response.text()` would drop a leading byte-order mark and replace
    // invalid UTF-8, so the relayed body would not be the Processor's bytes.
    bytes = await upstream.arrayBuffer();
  } catch {
    // The answer is the one a lost relay always produced; the record says the
    // Processor's answer was lost (its own `applied` record, if any, stands).
    throw new UpstreamLost(503, "scheduling_unavailable");
  }
  const text = new TextDecoder().decode(bytes);
  return {
    response: relayed(upstream, bytes),
    outcome: upstreamOutcome(upstream.status, upstream.headers, text, { result: "replayed" }),
  };
}
