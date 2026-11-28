// `/api/v2/activity` and `/api/v2/obligations` (architecture addendum A10).
// Read-only, behind the `eventsV2` capability, and served only when the
// projection exists in this database. A deploy ahead of migration 0032
// answers 404, like any unknown route.
//
// Every figure carries its basis and its explanation refs. The activity list
// never mixes cash-out with cost recognised at purchase: the basis is a
// required part of the request (addendum 07 section 6).
//
// The activity list takes optional filters (ADR 0081, amendment of
// 2026-11-20): `since` and `before` on when a revision was recorded,
// `account` and `source`. Without a filter it is the shipped list, paged by
// `offset`, byte for byte. With one it is the same list narrowed, paged by a
// keyset `cursor` bound to the basis and the filters; each page walks a
// fixed number of live revisions (`ACTIVITY_FILTER_WALK`).
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../../packages/domain/src/paging.ts";
import { parseQueryInstant } from "../../../packages/domain/src/query-instant.ts";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import {
  type ActivityFilters,
  type ActivityKey,
  createEventsReader,
  d1Executor,
  isActivityBasis,
  type ActivityBasis,
} from "../../../packages/read-model/src/index";
import { offsetPagedFields } from "../../../packages/observation-shared/src/paging-contract.ts";
import { HttpError, json } from "./http";

const V2_PATHS = ["/api/v2/activity", "/api/v2/obligations"] as const;
const DEFAULT_ACTIVITY_BASIS: ActivityBasis = "cash-movement";
/** One page; the reader asks for one row more to report `nextCursor`. */
export const EVENTS_PAGE_SIZE = 200;

/** The activity filters, in the order they are checked and echoed. */
const ACTIVITY_FILTER_KEYS = ["since", "before", "account", "source"] as const;
/**
 * The arguments a filtered activity cursor is bound to, by
 * `kogane.events.read`'s names (the route's path is `collection`): a cursor
 * read with any of them changed is `400 cursor_mismatch` naming these
 * (ADR 0123's `mustMatch`).
 */
export const ACTIVITY_CURSOR_INPUTS = ["collection", "basis", ...ACTIVITY_FILTER_KEYS] as const;
/** What a filtered activity cursor names as its snapshot: the live projection, not a snapshot. */
const ACTIVITY_CURSOR_SCOPE = "economic-events:activity";
/** The longest value each query parameter takes; any other is at most 64 characters. */
const MAX_LENGTH: Readonly<Record<string, number>> = { account: 300, cursor: 2048 };

/** An account id as `accounts` holds it, optionally as a leg names it (`account:<id>`). */
const ACCOUNT = /^(?:account:)?([A-Za-z0-9][A-Za-z0-9_.-]{0,255})$/u;
/** A source id, in the evidence browser's charset. */
const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;

/**
 * The capability is not a static claim: the routes are served only when the
 * A10 projection is actually present in this database. A build deployed ahead
 * of migration 0032 advertises `eventsV2: false` and serves nothing.
 */
export async function eventsV2Available(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "economicEvents");
}

function offsetOf(url: Pick<URL, "searchParams">): number {
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  return offset;
}

/**
 * The activity filters of this query in their compared form, or null when
 * none is given. A malformed value is `400 invalid_query` naming it
 * (`since:format`, `before:format`, `account:format`, `source:format`), and
 * a window with no instant in it is `window:empty`.
 */
function activityFilters(params: URLSearchParams): ActivityFilters | null {
  if (!ACTIVITY_FILTER_KEYS.some((key) => params.has(key))) return null;
  const refused: string[] = [];
  const text = (key: (typeof ACTIVITY_FILTER_KEYS)[number]) => params.get(key);
  const instant = (key: "since" | "before") => {
    const value = text(key);
    if (value === null) return null;
    // `created_at` is compared in `strftime`'s four-digit years, so an
    // instant whose UTC form leaves them is refused like a malformed one.
    const parsed = parseQueryInstant(value);
    if (!parsed.ok) refused.push(`${key}:format`);
    return parsed.ok ? parsed.iso : null;
  };
  const since = instant("since");
  const before = instant("before");
  const accountText = text("account");
  const account = accountText === null ? null : (ACCOUNT.exec(accountText)?.[1] ?? null);
  if (accountText !== null && account === null) refused.push("account:format");
  const source = text("source");
  if (source !== null && !SOURCE.test(source)) refused.push("source:format");
  if (refused.length === 0 && since !== null && before !== null && since >= before)
    refused.push("window:empty");
  if (refused.length > 0) throw new HttpError(400, "invalid_query", refused);
  return { since, before, account, source };
}

/** What a filtered activity cursor is bound to: the route, the basis and every filter. */
function activityDigest(basis: ActivityBasis, filters: ActivityFilters): Promise<string> {
  return canonicalDigest({ route: "/api/v2/activity", basis, ...filters });
}

/** The key a filtered activity cursor continues after, once it is checked against this query. */
function continuationOf(text: string, digest: string): ActivityKey {
  const cursor = decodeKeysetCursor(text);
  if (
    cursor === null ||
    cursor.s !== ACTIVITY_CURSOR_SCOPE ||
    cursor.r !== undefined ||
    cursor.k.length === 0 ||
    cursor.t < 1
  )
    throw new HttpError(400, "invalid_cursor");
  if (cursor.f !== digest)
    throw new HttpError(400, "cursor_mismatch", [], { mustMatch: ACTIVITY_CURSOR_INPUTS });
  return { eventId: cursor.k, revision: cursor.t };
}

/** Called only after the Access gate and the read-only method check of `worker.ts`. */
export async function eventsApi(env: Env, url: URL): Promise<Response | null> {
  if (!(V2_PATHS as readonly string[]).includes(url.pathname)) return null;
  return json(await readEventsRoute(env, url));
}

/**
 * One events route's answer for this path and query: the reader both
 * `GET /api/v2/{activity,obligations}` and `kogane.events.read` call
 * (ADR 0081), with the route's refusals as `HttpError`s. Absent (404) where
 * the projection is not in this database, like the routes.
 */
export async function readEventsRoute(
  env: Env,
  url: { pathname: string; searchParams: URLSearchParams },
): Promise<unknown> {
  const path = url.pathname;
  if (!(V2_PATHS as readonly string[]).includes(path)) throw new HttpError(404, "not_found");
  if (!(await eventsV2Available(env))) throw new HttpError(404, "not_found");
  const allowed =
    path === "/api/v2/activity"
      ? ["basis", "offset", ...ACTIVITY_FILTER_KEYS, "cursor"]
      : ["offset"];
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key)!;
    if (
      !allowed.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > (MAX_LENGTH[key] ?? 64)
    )
      throw new HttpError(400, "invalid_query");
  }
  // Without a filter or a cursor, each list is the shipped one, paged by
  // offset and refused in the shipped order.
  const byOffset =
    path === "/api/v2/obligations" ||
    ![...ACTIVITY_FILTER_KEYS, "cursor"].some((key) => url.searchParams.has(key));
  const offset = byOffset ? offsetOf(url) : 0;
  const reader = createEventsReader(d1Executor(env.DB), { pageSize: EVENTS_PAGE_SIZE });
  if (path === "/api/v2/obligations")
    return { apiVersion: 2, ...paged(await reader.obligations({ offset }), offset) };
  const basisParam = url.searchParams.get("basis");
  if (basisParam !== null && !isActivityBasis(basisParam))
    throw new HttpError(400, "invalid_query");
  const basis: ActivityBasis = basisParam ?? DEFAULT_ACTIVITY_BASIS;
  if (byOffset)
    return { apiVersion: 2, basis, ...paged(await reader.activity({ basis, offset }), offset) };
  // A filtered list pages by its cursor alone; an offset would count rows of
  // a list whose pages the walk, not the offset, decides.
  if (url.searchParams.has("offset")) throw new HttpError(400, "invalid_query", ["offset"]);
  const filters = activityFilters(url.searchParams);
  const cursor = url.searchParams.get("cursor");
  // A cursor is issued only for a filtered list: without the filters it was
  // read with, it continues nothing.
  if (filters === null)
    throw new HttpError(400, "cursor_mismatch", [], { mustMatch: ACTIVITY_CURSOR_INPUTS });
  const digest = await activityDigest(basis, filters);
  const after = cursor === null ? null : continuationOf(cursor, digest);
  const page = await reader.filteredActivity({ basis, filters, after });
  const nextCursor =
    page.next === null
      ? null
      : encodeKeysetCursor({
          s: ACTIVITY_CURSOR_SCOPE,
          f: digest,
          k: page.next.eventId,
          t: page.next.revision,
        });
  return {
    apiVersion: 2,
    basis,
    filters,
    walk: { bound: page.walk, walked: page.walked },
    items: page.items,
    nextCursor,
    ...filteredPaging(page.items.length, nextCursor),
    dataCoverage: page.dataCoverage,
  };
}

/**
 * A page with its `next` and `paging` (ADR 0128). The reader's `nextCursor`
 * is the next offset as text; it stays, deprecated, for one release.
 */
function paged<T extends { items: unknown[]; nextCursor: string | null }>(page: T, offset: number) {
  return {
    ...page,
    ...offsetPagedFields({
      limit: EVENTS_PAGE_SIZE,
      offset,
      returned: page.items.length,
      hasMore: page.nextCursor !== null,
    }),
  };
}

/**
 * A filtered page's `next` and `paging`, the one paging surface of ADR 0128
 * (proposed): the arguments to merge into the same call, and how the page
 * ended. A page the walk bound ended before it filled says `walk`, a stop
 * ADR 0128 does not list yet.
 */
export function filteredPaging(returned: number, nextCursor: string | null) {
  return {
    next: nextCursor === null ? null : { arguments: { cursor: nextCursor } },
    paging: {
      limit: EVENTS_PAGE_SIZE,
      returned,
      hasMore: nextCursor !== null,
      stoppedBy:
        nextCursor === null
          ? null
          : returned === EVENTS_PAGE_SIZE
            ? ("limit" as const)
            : ("walk" as const),
    },
  };
}
