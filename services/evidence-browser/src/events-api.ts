// `/api/v2/activity` and `/api/v2/obligations` (architecture addendum A10).
// Read-only, behind the `eventsV2` capability, and served only when both the
// projection exists in this database and the reader flag is on; otherwise the
// paths 404 like any unknown route, so a deploy without the projection changes
// nothing a reader sees.
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

const V2_PATHS = ["/api/v2/activity", "/api/v2/obligations"] as const;
const DEFAULT_ACTIVITY_BASIS: ActivityBasis = "cash-movement";
/** One page; the reader asks for one row more to report `nextCursor`. */
export const EVENTS_PAGE_SIZE = 200;

/** A flag is on only when it is explicitly on; anything else, including absent, is off. */
export function flagOn(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * The capability is not a static claim: the routes are served only when the
 * A10 projection is actually present in this database. A build deployed ahead
 * of migration 0032 advertises `eventsV2: false` and serves nothing.
 */
export async function eventsV2Available(env: Env): Promise<boolean> {
  if (!flagOn(env.EVENTS_V2_ENABLED)) return false;
  const row = await env.DB.prepare(
    "SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='economic_event_revisions'",
  ).first<{ present: number }>();
  return row?.present === 1;
}

function offsetOf(url: URL): number {
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  return offset;
}

/** Called only after the Access gate and the read-only method check of `worker.ts`. */
export async function eventsApi(env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!(V2_PATHS as readonly string[]).includes(path)) return null;
  if (!(await eventsV2Available(env))) throw new HttpError(404, "not_found");
  const allowed = path === "/api/v2/activity" ? ["basis", "offset"] : ["offset"];
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key)!;
    if (
      !allowed.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 64
    )
      throw new HttpError(400, "invalid_query");
  }
  const offset = offsetOf(url);
  const reader = createEventsReader(d1Executor(env.DB), { pageSize: EVENTS_PAGE_SIZE });
  if (path === "/api/v2/obligations")
    return json({ apiVersion: 2, ...(await reader.obligations({ offset })) });
  const basisParam = url.searchParams.get("basis");
  if (basisParam !== null && !isActivityBasis(basisParam))
    throw new HttpError(400, "invalid_query");
  const basis: ActivityBasis = basisParam ?? DEFAULT_ACTIVITY_BASIS;
  return json({ apiVersion: 2, basis, ...(await reader.activity({ basis, offset })) });
}
