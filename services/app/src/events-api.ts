// `/api/v2/activity` and `/api/v2/obligations` (architecture addendum A10).
// Read-only, behind the `eventsV2` capability, and served only when the
// projection exists in this database. A deploy ahead of migration 0032
// answers 404, like any unknown route. The agent tool `kogane.events.read`
// answers through the same request rules and reader (`readEvents`).
//
// Every figure carries its basis and its explanation refs. The activity list
// never mixes cash-out with cost recognised at purchase: the basis is a
// required part of the request (addendum 07 section 6).
import {
  createEventsReader,
  d1Executor,
  isActivityBasis,
  type ActivityBasis,
} from "../../../packages/read-model/src/index";
import { HttpError, json } from "./http";

export const EVENTS_PATHS = ["/api/v2/activity", "/api/v2/obligations"] as const;
export type EventsPath = (typeof EVENTS_PATHS)[number];
const DEFAULT_ACTIVITY_BASIS: ActivityBasis = "cash-movement";
/** One page; the reader asks for one row more to report `nextCursor`. */
export const EVENTS_PAGE_SIZE = 200;

/**
 * The capability is not a static claim: the routes are served only when the
 * A10 projection is actually present in this database. A build deployed ahead
 * of migration 0032 advertises `eventsV2: false` and serves nothing.
 */
export async function eventsV2Available(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='economic_event_revisions'",
  ).first<{ present: number }>();
  return row?.present === 1;
}

function offsetOf(parameters: URLSearchParams): number {
  const text = parameters.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  return offset;
}

/** Called only after the Access gate and the read-only method check of `worker.ts`. */
export async function eventsApi(env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!(EVENTS_PATHS as readonly string[]).includes(path)) return null;
  if (!(await eventsV2Available(env))) throw new HttpError(404, "not_found");
  return json(await readEvents(env, path as EventsPath, url.searchParams));
}

/**
 * The routes' request rules and their read, shared with the agent tool
 * `kogane.events.read` so both answer the same page and the same closed
 * refusal codes (thrown as `HttpError`): `invalid_query` for a parameter the
 * path does not take, a repeated, empty or over-long one, or an unknown
 * basis; `invalid_offset` for an offset that is not a whole number up to
 * 1,000,000. Whether the projection exists is the caller's question.
 */
export async function readEvents(
  env: Env,
  path: EventsPath,
  parameters: URLSearchParams,
): Promise<Record<string, unknown>> {
  const allowed = path === "/api/v2/activity" ? ["basis", "offset"] : ["offset"];
  for (const key of parameters.keys()) {
    const value = parameters.get(key)!;
    if (
      !allowed.includes(key) ||
      parameters.getAll(key).length !== 1 ||
      !value ||
      value.length > 64
    )
      throw new HttpError(400, "invalid_query");
  }
  const offset = offsetOf(parameters);
  const reader = createEventsReader(d1Executor(env.DB), { pageSize: EVENTS_PAGE_SIZE });
  if (path === "/api/v2/obligations")
    return { apiVersion: 2, ...(await reader.obligations({ offset })) };
  const basisParam = parameters.get("basis");
  if (basisParam !== null && !isActivityBasis(basisParam))
    throw new HttpError(400, "invalid_query");
  const basis: ActivityBasis = basisParam ?? DEFAULT_ACTIVITY_BASIS;
  return { apiVersion: 2, basis, ...(await reader.activity({ basis, offset })) };
}
