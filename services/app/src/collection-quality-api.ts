// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// per configured job, per source and per source × unit × dataset × period,
// what each collection stage last did, in closed codes; and
// `GET /api/collection-quality/<sourceId>/accounts`, the same cells regrouped
// by the accounts their captures' observations name (ADR 0082)
// (packages/application/src/query/collection-quality.ts, ADR 0045,
// docs/evidence-browser.md). Read-only, GET-only, and served under the reader
// authority every signed-in subject already has over the evidence routes: it
// shows identifiers, capture times, counts and codes the evidence pages and
// the schedule page already hold, and no amount. A store without the
// scheduling tables (CORE 0065) does not serve it.
//
// A thin adapter (ADR 0081): each path calls the same application service as
// its agent read (`kogane.collection-quality.summary`, `.cells`,
// `.accounts`), which grades the grant, the store, the request and the bounds.
// This file only turns the URL into the service's request and the service's
// refusal into the HTTP error this route has always answered.
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
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { collectionQualityAlarms } from "./collection-quality-alarms";
import { HttpError, json } from "./http";

/** The offset's wire syntax in the query string: a decimal without a leading zero, seven digits at most. */
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;

/** The HTTP error each refusal has always answered on this route. */
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
  const sql = d1Executor(env.DB);
  // A query string where the read takes none is a key the service does not take.
  const extra = url.search ? { query: true } : {};
  if (path === COLLECTION_QUALITY_PATH)
    return answer(
      await readCollectionQualitySummaryForGrant({
        grant,
        sql,
        request: extra,
        alarms: collectionQualityAlarms(env),
      }),
    );
  const rest = path.slice(COLLECTION_QUALITY_PATH.length + 1);
  if (rest.endsWith(ACCOUNT_COVERAGE_SUFFIX))
    // Every cell of one source, regrouped by account (ADR 0082): no page and no parameter.
    return answer(
      await readAccountCoverageForGrant({
        grant,
        sql,
        request: { source: rest.slice(0, -ACCOUNT_COVERAGE_SUFFIX.length), ...extra },
      }),
    );
  return answer(
    await readCollectionQualityCellsForGrant({ grant, sql, request: cellsRequest(rest, url) }),
  );
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

function answer<T>(outcome: CollectionQualityOutcome<T>): Response {
  if (outcome.ok) return json(outcome.value);
  const [status, code] = HTTP_ERRORS[outcome.refusal];
  throw new HttpError(status, code);
}
