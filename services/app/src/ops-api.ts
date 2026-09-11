// The operations API (`/api/ops/v1`, unified plan 02 §4-5, U06).
//
// One Hono sub-app mounted inside the existing `fetch` handler, after the
// Access check and before the Worker's GET-only boundary, so these six paths
// are the third — and last — explicitly enumerated non-GET surface of this
// Worker. Everything outside them still answers 405.
//
// What this module is allowed to be: a transport. It parses a bounded JSON
// body with a closed Zod schema, hands the validated request to the
// application service in `@kogane/application`, and turns the result into a
// status and a safe code. It holds no SQL, no idempotency rule, no source
// registry and no policy of its own — the MCP tools of the same names call the
// same services with the same schemas, which is what makes the two transports
// produce one operation record (G3-05).
//
// Three properties this file is responsible for:
//
//   * every schema is a *strict* object (zod v4 `z.object` silently strips
//     unknown keys; `strictObject` refuses them) and no field is coerced, so
//     an unknown key is a refusal rather than a quietly different request;
//   * no field is a URL, a host, a bucket key, a table name, an ordering or
//     SQL. A source is a declared source id, a release is a registered release
//     id, a run is a bounded run identifier (G3-13);
//   * an error carries a code and, at most, the identifiers the caller already
//     sent us back as a ref. A rejected value is never echoed (G3-08).
import { Hono } from "hono";
import { z } from "zod";
import {
  type AcceptedOperation,
  type CollectionRequest,
  type CommandResult,
  d1CommandStore,
  type ImportRequest,
  type OperationContext,
  principalCan,
  type ProjectionRequest,
  readOperation,
  type ReplayRequest,
  requestCollection,
  requestImport,
  requestProjectionRebuild,
  requestReplay,
  requestSessionRefresh,
  sessionRefreshPolicy,
  type SessionRefreshRequest,
  statusForCommandError,
} from "../../../packages/application/src/index";
import { principalFor } from "./command-api";
import { HttpError, json } from "./http";

export const OPS_PREFIX = "/api/ops/v1";
/** Largest request body any operations route reads, in bytes. */
export const OPS_BODY_LIMIT = 16 * 1024;

/**
 * The deployment flag. Off unless the variable is exactly "true"; absent,
 * empty or anything else is off (D13). Typed on the variable rather than on
 * `Env`, because the generated `Env` narrows a var declared in wrangler.jsonc
 * to its configured literal.
 */
export function opsApiEnabled(env: { OPS_API_ENABLED?: string }): boolean {
  return env.OPS_API_ENABLED === "true";
}

export function isOpsPath(path: string): boolean {
  return path === OPS_PREFIX || path.startsWith(`${OPS_PREFIX}/`);
}

/** Route label for the request log; identifiers never reach it. */
export function classifyOpsPath(path: string): string | null {
  if (!isOpsPath(path)) return null;
  const rest = path.slice(OPS_PREFIX.length).replace(/^\//u, "");
  const head = rest.split("/")[0] ?? "";
  return `ops_${/^[a-z]{1,32}$/u.test(head) ? head : "unknown"}`;
}

// ── request schemas ─────────────────────────────────────────────────────

/** A declared source id, in the shape the registry itself constrains ids to. */
const SOURCE = z.string().regex(/^[a-z0-9-]{1,100}$/u);
/** A date-only bound. Never coerced to a timestamp: a day is not an instant. */
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
/**
 * The caller's retry key. Absent means "this exact payload, once": the service
 * then keys the operation on the payload digest, so an identical re-send is
 * the same operation rather than a second collection (G3-06, G3-14).
 */
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
  .optional();
/** A run as the terminal contract names it: one path segment, never a key. */
const RUN_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
/** A registered parser release id (0028), never a version string a caller invents. */
const PARSER_RELEASE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u);

export const collectionSchema = z.strictObject({
  source: SOURCE,
  requestedScope: z.strictObject({ from: DATE, to: DATE }),
  idempotencyKey: IDEMPOTENCY_KEY,
});
export const importSchema = z.strictObject({
  source: SOURCE,
  runId: RUN_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
});
export const replaySchema = z.strictObject({
  scope: z.strictObject({
    source: SOURCE,
    from: DATE.nullable(),
    to: DATE.nullable(),
  }),
  parserRelease: PARSER_RELEASE,
  idempotencyKey: IDEMPOTENCY_KEY,
});
export const projectionSchema = z.strictObject({
  // Why a rebuild was asked for. Bounded, single-line, no control characters;
  // it is stored with the request and never interpolated anywhere.
  reason: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\p{Cc}]+$/u),
  idempotencyKey: IDEMPOTENCY_KEY,
});
export const sessionRefreshSchema = z.strictObject({
  source: SOURCE,
  idempotencyKey: IDEMPOTENCY_KEY,
});
/** The body of the refresh route; its source comes from the path, not the body. */
export const sessionRefreshBodySchema = z.strictObject({ idempotencyKey: IDEMPOTENCY_KEY });
export const operationIdSchema = z.strictObject({
  operationId: z.string().regex(/^op_[0-9a-f]{64}$/u),
});

/** A window has to be a window: `to` before `from` is not a narrow request. */
function orderedWindow(from: string | null, to: string | null): boolean {
  return from === null || to === null || from <= to;
}

// ── parsing ─────────────────────────────────────────────────────────────

/**
 * Validation failures carry the *paths* of the offending fields and nothing
 * else: a bad value is never reflected back into an error, a log or a queue
 * (G3-08). Zod's own messages are not returned for the same reason.
 */
export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const outcome = schema.safeParse(value);
  if (outcome.success) return outcome.data;
  const refs = [
    ...new Set(
      outcome.error.issues.map((issue) =>
        issue.path.length === 0 ? "(body)" : issue.path.join("."),
      ),
    ),
  ].slice(0, 10);
  throw new HttpError(400, "invalid_request", refs);
}

async function boundedBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > OPS_BODY_LIMIT)
    throw new HttpError(413, "request_too_large");
  const text = await request.text();
  if (text.length > OPS_BODY_LIMIT) throw new HttpError(413, "request_too_large");
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "invalid_request");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request");
  }
}

// ── the services, as one call site per operation ────────────────────────

/** Everything a route or a tool needs; built once per request from the Env. */
export interface OpsContext extends OperationContext {
  nowMs: number;
  policy: ReturnType<typeof sessionRefreshPolicy>;
}

/**
 * Builds the context for a verified subject. The principal is graded by the
 * change lifecycle's own loader, so one deployment has one answer to "is this
 * subject an agent": an agent may propose and simulate, and an operations
 * request — a real provider session, a replay, a rebuild — needs the
 * capability an agent does not have (addendum 10 §5).
 */
export function opsContext(env: Env, subject: string): OpsContext {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(subject))
    throw new HttpError(403, "actor_not_supported");
  const principal = principalFor(env, subject);
  if (!principalCan(principal, "interpretation.accept"))
    throw new HttpError(403, "approval_required");
  return {
    store: d1CommandStore(env.DB),
    principal,
    now: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    nowMs: Date.now(),
    policy: sessionRefreshPolicy(env.SESSION_REFRESH_POLICY),
  };
}

interface OpsResponse {
  status: number;
  body: unknown;
}

/** One place where a service result becomes a status and a body. */
function accepted(outcome: CommandResult<AcceptedOperation>): OpsResponse {
  if (!outcome.ok)
    throw new HttpError(statusForCommandError(outcome.error), outcome.error, outcome.refs ?? []);
  // 202 for a first request and for a re-send alike: the record is the same
  // one, and a caller that retried must not be told it created something new.
  return {
    status: 202,
    body: { operationId: outcome.receipt.operationId, status: outcome.receipt.status },
  };
}

export const opsServices = {
  async collection(context: OpsContext, request: CollectionRequest) {
    if (!orderedWindow(request.requestedScope.from, request.requestedScope.to))
      throw new HttpError(400, "invalid_request", ["requestedScope"]);
    return accepted(await requestCollection({ ...context, request }));
  },
  async import(context: OpsContext, request: ImportRequest) {
    return accepted(await requestImport({ ...context, request }));
  },
  async replay(context: OpsContext, request: ReplayRequest) {
    if (!orderedWindow(request.scope.from, request.scope.to))
      throw new HttpError(400, "invalid_request", ["scope"]);
    return accepted(await requestReplay({ ...context, request }));
  },
  async projection(context: OpsContext, request: ProjectionRequest) {
    return accepted(await requestProjectionRebuild({ ...context, request }));
  },
  async sessionRefresh(context: OpsContext, request: SessionRefreshRequest) {
    return accepted(await requestSessionRefresh({ ...context, request, policy: context.policy }));
  },
  async operation(context: OpsContext, operationId: string) {
    const outcome = await readOperation({ ...context, operationId });
    // An operation another principal accepted answers exactly like one that
    // does not exist: the API never confirms that an id it cannot show exists.
    if (!outcome.ok)
      throw new HttpError(statusForCommandError(outcome.error), outcome.error, outcome.refs ?? []);
    return { status: 200, body: outcome.receipt };
  },
};

// ── the Hono sub-app ────────────────────────────────────────────────────

/**
 * The verified subject travels in the bindings object this module builds, not
 * in a header or a body: nothing a caller sends can name the actor.
 */
type OpsBindings = Env & { VERIFIED_SUBJECT: string };

const app = new Hono<{ Bindings: OpsBindings }>().basePath(OPS_PREFIX);

// Hono's own error and not-found answers are not used: rethrowing puts every
// failure through the Worker's single response formatter, so an operations
// error looks exactly like every other error of this Worker (code + requestId).
app.onError((error) => {
  throw error;
});
app.notFound(() => {
  throw new HttpError(404, "not_found");
});

app.post("/collections", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const request = parseRequest(collectionSchema, await boundedBody(context.req.raw));
  const outcome = await opsServices.collection(ops, request);
  return json(outcome.body, outcome.status);
});

app.post("/imports", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const request = parseRequest(importSchema, await boundedBody(context.req.raw));
  const outcome = await opsServices.import(ops, request);
  return json(outcome.body, outcome.status);
});

app.post("/replays", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const request = parseRequest(replaySchema, await boundedBody(context.req.raw));
  const outcome = await opsServices.replay(ops, request);
  return json(outcome.body, outcome.status);
});

app.post("/projections", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const request = parseRequest(projectionSchema, await boundedBody(context.req.raw));
  const outcome = await opsServices.projection(ops, request);
  return json(outcome.body, outcome.status);
});

app.post("/sessions/:source/refresh", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const body = parseRequest(sessionRefreshBodySchema, await boundedBody(context.req.raw));
  // The path segment is validated by the same schema the MCP tool uses, so a
  // source that is not a source id is refused identically on both transports.
  const request = parseRequest(sessionRefreshSchema, {
    ...body,
    source: context.req.param("source"),
  });
  const outcome = await opsServices.sessionRefresh(ops, request);
  return json(outcome.body, outcome.status);
});

app.get("/operations/:id", async (context) => {
  const ops = opsContext(context.env, context.env.VERIFIED_SUBJECT);
  const { operationId } = parseRequest(operationIdSchema, { operationId: context.req.param("id") });
  const outcome = await opsServices.operation(ops, operationId);
  return json(outcome.body, outcome.status);
});

/**
 * Entry point from `worker.ts`. Returns `null` when this Worker does not serve
 * the path or the flag is off, so a deployment with the flag off answers these
 * paths exactly as it does today — the GET-only boundary rejects a POST with
 * 405 and an unrouted GET is 404 — and nothing downstream is touched.
 */
export async function opsApi(
  request: Request,
  env: Env,
  url: URL,
  /** The subject `authenticate` proved; never a body or header claim. */
  subject: string,
): Promise<Response | null> {
  if (!isOpsPath(url.pathname)) return null;
  if (!opsApiEnabled(env)) return null;
  // Two verbs exist here: POST to accept, GET to read. Anything else is the
  // same 405 the Worker gives every other non-GET request, not a 404 that
  // would suggest a different path might take it.
  if (request.method !== "POST" && request.method !== "GET")
    throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_query");
  return app.fetch(request, { ...env, VERIFIED_SUBJECT: subject });
}
