// The Processor's answer to the release postcheck (unified plan 11 §6, U14).
//
// This Worker is published on no hostname at all (`workers_dev: false`, no
// routes), so a release could not check it: a broken Processor deployed and
// reported success. `GET /internal/health` is the answer, and it is reachable
// exactly the way every other route of this Worker is — through a Service
// Binding from the App, which authenticates the caller with Cloudflare Access
// and passes on nothing from the request but the question itself
// (`services/app/src/health.ts`).
//
// What it reports: the build identity the deploy stamped, whether CORE, READ
// and the DATA bucket answer, which bindings exist, the declared value of every
// lane flag, the lane bookkeeping, how old the bounded collection scan's cursor
// is, and whether the READ active pointer has ever been switched.
//
// What it does not do: write anything, contact a provider, run a lane, move a
// cursor, or report a value. Counts, identifiers, file names, flags and ages
// only — the same rule the `/status` route already follows.
import {
  COLLECTION_SCAN_LANE,
  readCollectionScanState,
} from "../../../packages/storage-d1/src/core/collection-runs.ts";

/** The route this module owns. */
export const INTERNAL_HEALTH_PATH = "/internal/health";

/**
 * The header the calling Worker names itself with. A request that arrives
 * through a Service Binding is built by the caller, so this header is present
 * exactly when the caller put it there; a request from the internet is
 * terminated at Cloudflare's edge first, which always attaches
 * `CF-Connecting-IP`. Requiring the one and refusing the other is defence in
 * depth behind the real boundary, which is that this Worker has no public
 * hostname to reach in the first place.
 */
export const INTERNAL_CALLER_HEADER = "x-kogane-internal-caller";

/** Whether this request may read the internal health route. */
export function serviceBindingRequest(request: Request): boolean {
  if (request.headers.has("cf-connecting-ip")) return false;
  const caller = request.headers.get(INTERNAL_CALLER_HEADER);
  return caller !== null && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(caller);
}

/**
 * The lane flags this deployment declares, reported as the strings they are.
 * Reporting the declared value rather than a resolved boolean keeps one
 * definition of "on" in the lane code itself; what the postcheck needs is that
 * the deployed Worker holds the configuration the release carried.
 */
export function declaredFlags(env: Env): Record<string, string> {
  return {
    SHARED_R2_INGEST_ENABLED: env.SHARED_R2_INGEST_ENABLED,
    BALANCE_PROJECTION_ENABLED: env.BALANCE_PROJECTION_ENABLED,
    READ_PROJECTION_ENABLED: env.READ_PROJECTION_ENABLED,
    RECONCILIATION_ENABLED: env.RECONCILIATION_ENABLED,
    RELEASE_CANDIDATES_ENABLED: env.RELEASE_CANDIDATES_ENABLED,
    REWARD_CLAIMS_ENABLED: env.REWARD_CLAIMS_ENABLED,
    REWARD_READ_PROJECTION_ENABLED: env.REWARD_READ_PROJECTION_ENABLED,
    REPORTS_ENABLED: env.REPORTS_ENABLED,
    OPS_DISPATCH_ENABLED: env.OPS_DISPATCH_ENABLED,
  };
}

interface D1Health {
  bound: boolean;
  ok: boolean;
  migrationsTable: boolean;
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

/**
 * `SELECT 1` and the applied-migration list of one database. The App has the
 * same few lines (`services/app/src/health.ts`) on purpose: the two Workers
 * share no runtime, and a health probe that imported a package to ask "can I
 * reach my own database" would be reporting on the import as much as on the
 * binding.
 */
export async function d1Health(database: D1Database | undefined): Promise<D1Health> {
  if (!database || typeof database.prepare !== "function") return { ...ABSENT };
  const health: D1Health = { ...ABSENT, bound: true };
  try {
    health.ok = (await database.prepare("SELECT 1 AS one").first<number>("one")) === 1;
  } catch {
    return health;
  }
  try {
    const applied = await database
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all<{ name: string }>();
    health.migrationsTable = true;
    health.migrationsApplied = applied.results.map((row) => row.name);
    health.latestMigration = health.migrationsApplied.at(-1) ?? null;
  } catch {
    /* A database whose migrations were never applied has no such table. */
  }
  return health;
}

/** One `head` of a fixed key: proof the binding answers, not that data exists. */
export const DATA_MARKER_KEY = "health/release-marker";

async function bucketHealth(
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

/** The release this Worker was uploaded from, or "" in a local run. */
export function releaseSha(env: { RELEASE_SHA?: string }): string {
  const value = env.RELEASE_SHA;
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) ? value : "";
}

/** Everything the postcheck reads, as one object. */
export async function internalHealthBody(env: Env): Promise<{ status: number; body: unknown }> {
  const now = Date.now();
  const core = await d1Health(env.DB);
  const read = await d1Health(env.READ);
  const data = await bucketHealth(env.DATA);
  const evidence = await bucketHealth(env.EVIDENCE);
  const flags = declaredFlags(env);
  let lanes: { lane: string; lastSweepAgeMs: number | null }[] = [];
  try {
    const rows = await env.DB.prepare(
      "SELECT lane,last_sweep_at_ms FROM observation_lane_state ORDER BY lane",
    ).all<{ lane: string; last_sweep_at_ms: number | null }>();
    lanes = rows.results.map((row) => ({
      lane: row.lane,
      lastSweepAgeMs: row.last_sweep_at_ms === null ? null : now - row.last_sweep_at_ms,
    }));
  } catch {
    /* Reported as an empty list; `core` already says whether CORE answers. */
  }
  let collectionScan: Record<string, unknown> = { lane: COLLECTION_SCAN_LANE, recorded: false };
  try {
    const state = await readCollectionScanState(env.DB);
    collectionScan =
      state === null
        ? { lane: COLLECTION_SCAN_LANE, recorded: false }
        : {
            lane: state.lane,
            recorded: true,
            // How stale the bounded scan of `runs/` is. The flag being off is
            // why it can be stale, and the flag is in `flags` above.
            cursorAgeMs: state.last_scan_at_ms === 0 ? null : now - state.last_scan_at_ms,
            midCycle: state.cursor !== null,
            pagesCompleted: state.pages_completed,
            cyclesCompleted: state.cycles_completed,
          };
  } catch {
    /* Before migration 0039 there is no such table; `recorded` stays false. */
  }
  let readPointer: Record<string, unknown> = { present: false };
  try {
    const row = await env.READ.prepare(
      "SELECT snapshot_id,switched_at FROM balance_snapshot_pointer WHERE id=1",
    ).first<{ snapshot_id: string; switched_at: string }>();
    readPointer =
      row === null
        ? { present: false }
        : {
            present: true,
            snapshotId: row.snapshot_id,
            switchedAt: row.switched_at,
            ageMs: Number.isNaN(Date.parse(row.switched_at))
              ? null
              : now - Date.parse(row.switched_at),
          };
  } catch {
    /* READ not initialised, or no pointer yet; both are `present: false`. */
  }
  // The queue this Worker consumes is declared in its configuration and cannot
  // be introspected from inside the isolate, so what is asserted here is the
  // binding set: a deploy that lost a binding is a broken deploy.
  const bindings = {
    DB: core.bound,
    READ: read.bound,
    EVIDENCE: evidence.bound,
    DATA: data.bound,
  };
  // As in the App: a store that does not answer is degraded; which migrations
  // the release expected is CD's comparison, not this route's.
  const healthy = core.ok && data.ok && evidence.ok && read.bound && read.ok;
  return {
    status: healthy ? 200 : 503,
    body: {
      ok: healthy,
      worker: "kogane-observation-pipeline",
      releaseSha: releaseSha(env),
      core,
      read,
      data,
      evidence,
      bindings,
      flags,
      lanes,
      collectionScan,
      readPointer,
    },
  };
}

/**
 * Entry point from `worker.ts`. Returns `null` when the request is not for the
 * internal health route; a caller that is not a service binding is refused
 * rather than answered.
 */
export async function internalHealthRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== INTERNAL_HEALTH_PATH) return null;
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  if (!serviceBindingRequest(request))
    return new Response("Forbidden", {
      status: 403,
      headers: { "x-kogane-error": "service_binding_required" },
    });
  const { status, body } = await internalHealthBody(env);
  return Response.json(body, { status });
}
