// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// per configured job, per source and per source × unit × dataset × period,
// what each collection stage last did, in closed codes
// (packages/application/src/query/collection-quality.ts, ADR 0045,
// docs/evidence-browser.md); and `GET /api/collection-quality/<sourceId>/accounts`,
// the same source's cells regrouped by the accounts their captures'
// observations name (ADR 0088), as a paged summary by default (ADR 0123,
// amendment 2026-11-20); and `GET /api/collection-quality?view=status`,
// one line per configured job saying whether it is stuck (ADR 0045, amendment
// 2026-11-19). Read-only, GET-only, and served under the reader
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
import { queryCollectionQualityStatus } from "../../../packages/application/src/query/collection-quality-status.ts";
import {
  accountCoverageSummary,
  collectionQualityCellSummary,
  collectionQualitySummaryLines,
} from "../../../packages/application/src/query/collection-quality-detail.ts";
import {
  ACCOUNT_COVERAGE_SUFFIX,
  COLLECTION_QUALITY_DETAILS,
  COLLECTION_QUALITY_PAGE,
  COLLECTION_QUALITY_PATH,
  COLLECTION_QUALITY_SUMMARY_CELL_BOUND,
  type CollectionQualityCells,
  type CollectionQualityDetail,
  COLLECTION_STATUS_VIEW,
  validCollectionQualityAlarms,
  type CollectionQualitySummary,
} from "../../../packages/observation-shared/src/collection-quality-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;
/** The status view's query (ADR 0045, amendment 2026-11-19), exactly. */
const STATUS_SEARCH = "?view=status";

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
  // The summary, the cells and the account view take their `detail` (and
  // `offset`) (ADR 0123), checked by the reader; the summary's path is else
  // its status view, `?view=status` exactly, which takes no `detail`.
  if (
    path === COLLECTION_QUALITY_PATH &&
    url.searchParams.has("view") &&
    url.search !== STATUS_SEARCH
  )
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
      if (url.searchParams.has("view")) {
        // The status view is compact already: it takes no `detail` (ADR 0123).
        const keys = [...url.searchParams.keys()];
        if (
          keys.length !== 1 ||
          keys[0] !== "view" ||
          url.searchParams.get("view") !== COLLECTION_STATUS_VIEW
        )
          throw new HttpError(400, "invalid_query");
        return await queryCollectionQualityStatus(d1Executor(env.DB), { asOf });
      }
      const detail = detailOf(url.searchParams, []);
      const summary = await queryCollectionQualitySummary(d1Executor(env.DB), { asOf });
      await readAlarms(env, summary);
      return detail === "full" ? summary : collectionQualitySummaryLines(summary);
    }
    const rest = path.slice(COLLECTION_QUALITY_PATH.length + 1);
    if (rest.endsWith(ACCOUNT_COVERAGE_SUFFIX)) {
      const sourceId = rest.slice(0, -ACCOUNT_COVERAGE_SUFFIX.length);
      if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
      // The full answer is unpaged; the summary pages its lines (`offset`).
      const detail = detailOf(url.searchParams, ["offset"]);
      if (detail === "full" && url.searchParams.has("offset"))
        throw new HttpError(400, "invalid_query");
      const offset = offsetOf(url.searchParams);
      const coverage = await queryAccountCoverage(d1Executor(env.DB), { sourceId, asOf });
      if (coverage === null) throw new HttpError(404, "not_found");
      return detail === "full" ? coverage : accountCoverageSummary(coverage, offset);
    }
    const sourceId = rest;
    if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
    const detail = detailOf(url.searchParams, ["offset"]);
    const offset = offsetOf(url.searchParams);
    if (detail === "full") {
      const cells = await queryCollectionQualityCells(d1Executor(env.DB), {
        sourceId,
        offset,
        asOf,
      });
      if (cells === null) throw new HttpError(404, "not_found");
      return cells;
    }
    // The summary collapses every cell of the source, so it reads every page
    // of the same cell read at the same instant; `offset` then pages lines.
    const pages: CollectionQualityCells[] = [];
    for (let at = 0; ; at += COLLECTION_QUALITY_PAGE) {
      const page = await queryCollectionQualityCells(d1Executor(env.DB), {
        sourceId,
        offset: at,
        asOf,
      });
      if (page === null) throw new HttpError(404, "not_found");
      pages.push(page);
      if (
        pages.reduce((sum, entry) => sum + entry.cells.length, 0) >
        COLLECTION_QUALITY_SUMMARY_CELL_BOUND
      )
        throw new CollectionQualityLimitError();
      if (!page.coverage.truncated) break;
    }
    return collectionQualityCellSummary(pages, offset);
  } catch (error) {
    // More jobs, sources, cells or account periods than the bound are refused,
    // never cut into a partial answer.
    if (error instanceof CollectionQualityLimitError)
      throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
}

/**
 * The `detail` a summary or cell request names (ADR 0123): absent is
 * `summary`. Each parameter, `detail` and those `others` the route takes,
 * appears at most once with a value; anything else is `invalid_query`.
 */
function detailOf(params: URLSearchParams, others: readonly string[]): CollectionQualityDetail {
  for (const [key, value] of params)
    if ((key !== "detail" && !others.includes(key)) || params.getAll(key).length !== 1 || !value)
      throw new HttpError(400, "invalid_query");
  const detail = params.get("detail") ?? "summary";
  if (!(COLLECTION_QUALITY_DETAILS as readonly string[]).includes(detail))
    throw new HttpError(400, "invalid_query");
  return detail as CollectionQualityDetail;
}

/** The `offset` a cell or account request names; absent is 0. */
function offsetOf(params: URLSearchParams): number {
  const text = params.get("offset") ?? "0";
  if (!OFFSET.test(text)) throw new HttpError(400, "invalid_offset");
  return Number(text);
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
