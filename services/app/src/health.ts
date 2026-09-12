// The release postcheck's view of this deployment (unified plan 11 §6, U14).
//
// `GET /api/ops/v1/health` answers the four questions a release cannot answer
// from the outside: *is this the build we just uploaded* (build identity), *can
// it reach its stores* (CORE, READ, the DATA bucket), *what does it think it
// can serve* (the capability snapshot), and *is the Processor alive and on the
// same release* (through the existing `PIPELINE` service binding — the
// Processor is published on no hostname at all, so this is the only way to ask
// it anything). Without it a broken App or Processor passed CD, because the old
// postcheck only read the unauthenticated `/health` of the ingest Worker.
//
// Three properties this route is responsible for:
//
//   * it is **authenticated**. It sits behind the same Cloudflare Access
//     verification as every other route of this Worker; the one thing it adds
//     is that an Access *service token* may reach it (and nothing else), which
//     is what lets CD call it without a human session;
//   * it is **read-only**. `SELECT 1`, the applied-migration list, one R2
//     `head` of a fixed marker key, one capability snapshot, one service
//     binding read. No write, no provider request, no bank access, no
//     collection, no backfill;
//   * it never carries a value. Counts, names of migration files, flags,
//     digests, ages and problem codes only — no observation, no amount, no
//     credential, no subject a grant list names.
//
// It is deliberately *not* behind `OPS_API_ENABLED`: a postcheck that only
// works once an unrelated flag is on is not a postcheck. It accepts no query
// string and no body.
import { centralStoreCapabilities } from "./capabilities";
import { accessIdentity } from "./auth";
import { grantsUsable, principalFor } from "./grants";
import { HttpError, json } from "./http";
import { OPS_PREFIX } from "./ops-api";
import {
  parseSubjectList,
  principalCan,
  subjectGrantTable,
} from "../../../packages/application/src/index";

/** The health route, inside the operations prefix and outside its flag. */
export const HEALTH_PATH = `${OPS_PREFIX}/health`;

/**
 * The key the DATA bucket is probed with. A `head` of it proves the binding
 * answers; whether the object exists is reported, never required, so the check
 * needs nothing to be written to production first. The key is under a prefix
 * no collection layout uses (`objects/`, `runs/`, `reports/`,
 * `projection-inputs/`), so it can never collide with evidence.
 */
export const DATA_MARKER_KEY = "health/release-marker";

/** The release this Worker was uploaded from, or "" in a local run. */
export function releaseSha(env: { RELEASE_SHA?: string }): string {
  const value = env.RELEASE_SHA;
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) ? value : "";
}

/**
 * The service tokens this deployment lets reach the health route, as a JSON
 * array of Access service-token *common names* (the token's Client ID), read
 * by the same parser as the subject lists. Absent or empty is the empty list,
 * which refuses every service token. A list that is present but cannot be
 * read is `null`, and the route answers nobody until it is fixed — the same
 * rule the grant lists follow: an unreadable allow-list is a deployment
 * problem to report, never a shorter list to guess at.
 */
export function healthProbeTokens(env: { HEALTH_PROBE_TOKENS?: string }): string[] | null {
  return parseSubjectList(env.HEALTH_PROBE_TOKENS);
}

interface D1Health {
  /** Whether this Worker has the binding at all. */
  bound: boolean;
  /** Whether `SELECT 1` answered. */
  ok: boolean;
  /** Whether `d1_migrations` exists — an empty database is not a broken one. */
  migrationsTable: boolean;
  /** Applied migration file names, in the order Wrangler applied them. */
  migrationsApplied: string[];
  latestMigration: string | null;
}

const ABSENT: D1Health = {
  bound: false,
  ok: false,
  migrationsTable: false,
  migrationsApplied: [],
  latestMigration: null,
};

/** `SELECT 1` and the applied-migration list of one database. */
export async function d1Health(database: D1Database | undefined): Promise<D1Health> {
  if (!database || typeof database.prepare !== "function") return { ...ABSENT };
  const health: D1Health = { ...ABSENT, bound: true };
  try {
    health.ok = (await database.prepare("SELECT 1 AS one").first<number>("one")) === 1;
  } catch {
    return health;
  }
  try {
    // Wrangler's own bookkeeping table. A database whose migrations have never
    // been applied has no such table, which is a state, not a failure: the
    // caller decides whether this database was supposed to be initialised.
    const applied = await database
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all<{ name: string }>();
    health.migrationsTable = true;
    health.migrationsApplied = applied.results.map((row) => row.name);
    health.latestMigration = health.migrationsApplied.at(-1) ?? null;
  } catch {
    /* No migration bookkeeping; `migrationsTable` stays false. */
  }
  return health;
}

/** One `head` of the fixed marker key. Read-only, and never a failure on absence. */
export async function bucketHealth(
  bucket: R2Bucket | undefined,
): Promise<{ bound: boolean; ok: boolean; markerPresent: boolean }> {
  if (!bucket || typeof bucket.head !== "function")
    return { bound: false, ok: false, markerPresent: false };
  try {
    const object = await bucket.head(DATA_MARKER_KEY);
    return { bound: true, ok: true, markerPresent: object !== null };
  } catch {
    return { bound: true, ok: false, markerPresent: false };
  }
}

/**
 * The Processor's own answer, over the service binding. The Processor is
 * published on no hostname, so an unreachable binding is reported as such
 * rather than guessed at.
 */
export async function processorHealth(env: Env): Promise<Record<string, unknown>> {
  const pipeline = env.PIPELINE;
  if (!pipeline || typeof pipeline.fetch !== "function")
    return { ok: false, error: "binding_absent" };
  try {
    const response = await pipeline.fetch(
      new Request("https://observation-pipeline.internal/internal/health", {
        method: "GET",
        // The Processor answers this route for a service-binding caller only;
        // the header is how the caller names itself (docs/processor.md).
        headers: { "x-kogane-internal-caller": "kogane-evidence-browser" },
      }),
    );
    if (response.status !== 200) return { ok: false, error: "unhealthy", status: response.status };
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return { ok: false, error: "unreadable" };
    return body as Record<string, unknown>;
  } catch {
    // Only a safe code: never the exception text of an internal call.
    return { ok: false, error: "unreachable" };
  }
}

/**
 * Decides whether the verified identity may read the health route. Two kinds
 * may:
 *
 *   * the operator this deployment names in `OPERATOR_SUBJECTS` — graded by
 *     the Worker's one `principalFor`, so a subject no list names and an
 *     agent subject (which may propose but not accept) are refused here
 *     exactly as on the operations API;
 *   * a service token named in `HEALTH_PROBE_TOKENS`, which is how CD calls
 *     the route. A service token is never a subject and may reach nothing else.
 *
 * A `HEALTH_PROBE_TOKENS` that is present but unreadable closes the route to
 * everyone with `503 grants_misconfigured`, as an unreadable grant list does.
 */
export function authorizeHealth(env: Env, identity: Awaited<ReturnType<typeof accessIdentity>>) {
  const probeTokens = healthProbeTokens(env);
  if (probeTokens === null) {
    // Reported as a code, as `grants.ts` reports its lists: the value may
    // carry a token's identity and a log line is not the place to learn one.
    try {
      console.log(
        JSON.stringify({ event: "grants_misconfigured", problem: "health_probe_tokens_invalid" }),
      );
    } catch {
      /* Observability never changes the answer. */
    }
    throw new HttpError(503, "grants_misconfigured");
  }
  if (identity.serviceToken !== null) {
    if (!probeTokens.includes(identity.serviceToken))
      throw new HttpError(403, "actor_not_supported");
    return { caller: "service-token" as const };
  }
  // The Worker's one grader: an unnamed subject is `subject_not_granted`, an
  // agent may propose but not accept, and unreadable subject lists are a
  // `grants_misconfigured` deployment — exactly as on the operations API.
  if (!principalCan(principalFor(env, identity.subject), "interpretation.accept"))
    throw new HttpError(403, "approval_required");
  return { caller: "operator" as const };
}

/**
 * Whether this deployment's grant lists can be read, as a code. Both lists
 * empty or absent is usable — deny-all is a configuration, the committed one
 * — and only a list that is present but unreadable, or a subject in both
 * lists, is not. `grantsUsable` is the Worker's one reporter of that problem
 * (it logs the code); the table is read once more only to name it here.
 */
export function grantsHealth(env: Env): { usable: true } | { usable: false; problem: string } {
  if (grantsUsable(env)) return { usable: true };
  const table = subjectGrantTable(env);
  return { usable: false, problem: table.ok ? "unknown" : table.problem };
}

/**
 * Builds the body. `status` is `ok` only when everything this deployment
 * actually depends on answered: CORE and its migrations, the DATA bucket, the
 * Processor, the grant configuration, and READ when the deployment reads it.
 * READ that is bound but not yet initialised is reported, and is not a failure
 * while the flag is off (docs/rollout.md §4). Unreadable grant lists are a
 * deployment that grades nobody, and a release must not certify one.
 */
export async function healthBody(env: Env): Promise<{ status: number; body: unknown }> {
  const grants = grantsHealth(env);
  const core = await d1Health(env.DB);
  const read = await d1Health(env.READ);
  const data = await bucketHealth(env.EVIDENCE);
  const processor = await processorHealth(env);
  const readRequired = true;
  let capabilities: unknown = null;
  try {
    capabilities = await centralStoreCapabilities(env);
  } catch {
    /* A capability snapshot that cannot be resolved is a degraded App. */
  }
  // Schema *readiness* is CD's assertion, not this route's: the release knows
  // which migration it expected and compares it with `migrationsApplied`
  // (docs/ci-cd.md § Postcheck). What makes this deployment degraded is a store
  // or the Processor not answering at all, so a database whose migration
  // bookkeeping is missing is reported rather than turned into a 503 here.
  const healthy =
    core.ok &&
    data.ok &&
    capabilities !== null &&
    processor["ok"] === true &&
    grants.usable &&
    (!readRequired || read.ok);
  return {
    status: healthy ? 200 : 503,
    body: {
      status: healthy ? "ok" : "degraded",
      worker: "kogane-evidence-browser",
      releaseSha: releaseSha(env),
      core,
      read: { ...read, required: readRequired },
      data,
      capabilities,
      grants,
      processor,
    },
  };
}

/**
 * Entry point from `worker.ts`, before every subject-based path: this is the
 * only route an Access service token may reach. Returns `null` when the
 * request is not for it, so nothing else in the Worker changes.
 */
export async function healthApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== HEALTH_PATH) return null;
  // Identity first, as on every other route of this Worker: a caller that is
  // not allowed here learns nothing about the route's shape from a 405 or 400.
  authorizeHealth(env, await accessIdentity(request, env));
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_query");
  const { status, body } = await healthBody(env);
  return json(body, status);
}
