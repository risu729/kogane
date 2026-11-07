// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// per configured job, per source and per source × unit × dataset × period,
// what each collection stage last did, in closed codes; and
// `GET /api/collection-quality/<sourceId>/accounts`, the same cells regrouped
// by the accounts their captures' observations name (ADR 0088)
// (packages/application/src/query/collection-quality.ts, ADR 0045,
// docs/evidence-browser.md). Read-only, GET-only, and served under the reader
// authority every signed-in subject already has over the evidence routes: it
// shows identifiers, capture times, counts and codes the evidence pages and
// the schedule page already hold, and no amount. A store without the
// scheduling tables (CORE 0065) does not serve it.
//
// A thin adapter (ADR 0081): each path and its page read
// (`kogane.collection-quality.summary`, `.cells`, `.accounts`,
// src/page-read-tools.ts) call `readCollectionQuality`, which calls the
// application service that grades the grant, the store, the request and the
// bounds, and answers a refusal with the HTTP error this route has always
// answered. This file only turns the URL into the service's request.
import {
  collectionQualityServed,
  readAccountCoverageForGrant,
  readCollectionQualityCellsForGrant,
  readCollectionQualitySummaryForGrant,
  type CollectionQualityOutcome,
  type CollectionQualityRefusal,
} from "../../../packages/application/src/query/collection-quality.ts";
import {
  ACCOUNT_COVERAGE_SUFFIX,
  COLLECTION_QUALITY_PATH,
} from "../../../packages/observation-shared/src/collection-quality-contract.ts";
import type { Grant } from "../../../packages/application/src/grants.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { collectionQualityAlarms } from "./collection-quality-alarms";
import { HttpError, json } from "./http";

/** The offset's wire syntax in the query string: a decimal without a leading zero, seven digits at most. */
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;

/** The HTTP error each refusal has always answered on this route, and answers to an agent. */
const HTTP_ERRORS: Record<CollectionQualityRefusal, [number, string]> = {
  unauthorized: [403, "forbidden"],
  scope_restricted: [403, "scope_restricted"],
  unavailable: [404, "not_found"],
  unknown_source: [404, "not_found"],
  invalid_query: [400, "invalid_query"],
  invalid_offset: [400, "invalid_offset"],
  limit_exceeded: [413, "result_limit_exceeded"],
};

/** Served only where the store has what the read joins: the scheduling and collection tables. */
export async function collectionQualityAvailable(env: Env): Promise<boolean> {
  return collectionQualityServed(d1Executor(env.DB));
}

export async function collectionQualityApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  const path = url.pathname;
  if (path !== COLLECTION_QUALITY_PATH && !path.startsWith(`${COLLECTION_QUALITY_PATH}/`))
    return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  const grant = readerGrant(subject);
  // A query string where the read takes none is a key the service does not take.
  const extra = url.search ? { query: true } : {};
  if (path === COLLECTION_QUALITY_PATH)
    return json(await readCollectionQuality(env, grant, "summary", extra));
  const rest = path.slice(COLLECTION_QUALITY_PATH.length + 1);
  if (rest.endsWith(ACCOUNT_COVERAGE_SUFFIX))
    // Every cell of one source, regrouped by account (ADR 0088): no page and no parameter.
    return json(
      await readCollectionQuality(env, grant, "accounts", {
        source: rest.slice(0, -ACCOUNT_COVERAGE_SUFFIX.length),
        ...extra,
      }),
    );
  return json(await readCollectionQuality(env, grant, "cells", cellsRequest(rest, url)));
}

/** The three collection quality reads: the summary, one source's cell page, and its cells per account. */
type CollectionQualityRead = "summary" | "cells" | "accounts";

/**
 * One collection quality read for `grant`: the body of its route for this
 * request, and the `data` of its page read (ADR 0081), so the page and an
 * agent read one function. A refusal is an `HttpError` with the route's
 * status and closed code, the same on every transport.
 */
export async function readCollectionQuality(
  env: Env,
  grant: Grant,
  read: CollectionQualityRead,
  request: unknown,
): Promise<unknown> {
  const sql = d1Executor(env.DB);
  switch (read) {
    case "summary":
      return value(
        await readCollectionQualitySummaryForGrant({
          grant,
          sql,
          request,
          alarms: collectionQualityAlarms(env),
        }),
      );
    case "cells":
      return value(await readCollectionQualityCellsForGrant({ grant, sql, request }));
    case "accounts":
      return value(await readAccountCoverageForGrant({ grant, sql, request }));
  }
}

/**
 * The cell read's request from the URL: `offset` given once and non-empty is
 * the only query key; its text becomes a number only in its wire syntax, and
 * any other text is passed on for the service to refuse.
 */
function cellsRequest(source: string, url: URL): Record<string, unknown> {
  for (const [key, value] of url.searchParams)
    if (key !== "offset" || url.searchParams.getAll(key).length !== 1 || !value)
      return { source, query: true };
  const text = url.searchParams.get("offset");
  if (text === null) return { source };
  return { source, offset: OFFSET.test(text) ? Number(text) : text };
}

function value<T>(outcome: CollectionQualityOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  const [status, code] = HTTP_ERRORS[outcome.refusal];
  throw new HttpError(status, code);
}
