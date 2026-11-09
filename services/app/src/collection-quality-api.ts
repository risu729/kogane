// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// per configured job, per source and per source × unit × dataset × period,
// what each collection stage last did, in closed codes
// (packages/application/src/query/collection-quality.ts, ADR 0045,
// docs/evidence-browser.md); and `GET /api/collection-quality/<sourceId>/accounts`,
// the same source's cells regrouped by the accounts their captures'
// observations name (ADR 0088). Read-only, GET-only, and served under the reader
// authority every signed-in subject already has over the evidence routes: it
// shows identifiers, capture times, counts and codes the evidence pages and
// the schedule page already hold, and no amount. A store without the
// scheduling tables (CORE 0065) does not serve it.
import {
  CollectionQualityLimitError,
  queryAccountCoverage,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../../../packages/application/src/query/collection-quality.ts";
import {
  ACCOUNT_COVERAGE_SUFFIX,
  COLLECTION_QUALITY_PATH,
  validCollectionQualityAlarms,
  type CollectionQualitySummary,
} from "../../../packages/observation-shared/src/collection-quality-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;

/** Served only where the store has what the read joins: the scheduling and collection tables. */
export async function collectionQualityAvailable(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "collectionQuality");
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
  // Resolve authority before schema/source enumeration. This aggregation
  // cannot safely answer an account-filtered grant, even for a known source.
  const grant = readerGrant(subject);
  if (!grant.capabilities.includes("evidence.read")) throw new HttpError(403, "forbidden");
  if (grant.scopes.sources !== "*" || grant.scopes.accounts !== "*")
    throw new HttpError(403, "scope_restricted");
  if (!(await collectionQualityAvailable(env))) throw new HttpError(404, "not_found");
  // The summary and the account view take no query at all, not even an empty one (`?`).
  if ((path === COLLECTION_QUALITY_PATH || path.endsWith(ACCOUNT_COVERAGE_SUFFIX)) && url.search)
    throw new HttpError(400, "invalid_query");
  return json(await readCollectionQuality(env, url));
}

/**
 * The collection quality summary, one source's cells or that source's cells
 * per account (ADR 0088) for this path and query: the answer of the route and
 * of `kogane.collection-quality.read` (ADR 0081), once the caller's authority
 * and the store's tables are known. Its refusals are `HttpError`s with the
 * route's closed codes.
 */
export async function readCollectionQuality(
  env: Env,
  url: { pathname: string; searchParams: URLSearchParams },
): Promise<unknown> {
  const path = url.pathname;
  // Every age of the answer is counted to this one instant (collection-freshness-v1).
  const asOf = new Date().toISOString();
  try {
    if (path === COLLECTION_QUALITY_PATH) {
      if ([...url.searchParams.keys()].length > 0) throw new HttpError(400, "invalid_query");
      const summary = await queryCollectionQualitySummary(d1Executor(env.DB), { asOf });
      await readAlarms(env, summary);
      return summary;
    }
    const rest = path.slice(COLLECTION_QUALITY_PATH.length + 1);
    if (rest.endsWith(ACCOUNT_COVERAGE_SUFFIX)) {
      const sourceId = rest.slice(0, -ACCOUNT_COVERAGE_SUFFIX.length);
      if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
      if ([...url.searchParams.keys()].length > 0) throw new HttpError(400, "invalid_query");
      const coverage = await queryAccountCoverage(d1Executor(env.DB), { sourceId, asOf });
      if (coverage === null) throw new HttpError(404, "not_found");
      return coverage;
    }
    const sourceId = rest;
    if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
    for (const [key, value] of url.searchParams)
      if (key !== "offset" || url.searchParams.getAll(key).length !== 1 || !value)
        throw new HttpError(400, "invalid_query");
    const offsetText = url.searchParams.get("offset") ?? "0";
    if (!OFFSET.test(offsetText)) throw new HttpError(400, "invalid_offset");
    const cells = await queryCollectionQualityCells(d1Executor(env.DB), {
      sourceId,
      offset: Number(offsetText),
      asOf,
    });
    if (cells === null) throw new HttpError(404, "not_found");
    return cells;
  } catch (error) {
    // More jobs, sources, cells or account periods than the bound are refused,
    // never cut into a partial answer.
    if (error instanceof CollectionQualityLimitError)
      throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
}

/** Enrich only matching stored configurations; a relay failure stays unknown. */
async function readAlarms(env: Env, summary: CollectionQualitySummary): Promise<void> {
  if (env.SCHEDULES_ENABLED !== "true") return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("alarm_read_unavailable"));
    }, 5000);
  });
  try {
    // The deadline covers both headers and JSON, even for a relay that does
    // not honor cancellation. The core summary remains available.
    const value: unknown = await Promise.race([
      (async () => {
        const response = await env.PIPELINE.fetch(
          new Request("https://observation-pipeline.internal/internal/collection-quality/alarms", {
            headers: { "x-kogane-internal-caller": "kogane-evidence-browser" },
            signal: controller.signal,
          }),
        );
        return response.ok ? response.json() : null;
      })(),
      deadline,
    ]);
    if (!validCollectionQualityAlarms(value)) return;
    for (const schedule of [
      ...summary.sources.flatMap((source) => source.schedules),
      ...summary.otherSchedules,
    ]) {
      const found = value.alarms.find((alarm) => alarm.id === schedule.id);
      if (
        found &&
        found.enabled === schedule.enabled &&
        found.nextRunAt === schedule.nextRunAt &&
        found.nextNominalAt === schedule.nextNominalAt
      )
        schedule.alarm = found.alarm;
    }
  } catch {
    // No actual reservation claim is inferred from the stored settings.
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
