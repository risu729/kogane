// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// per configured job, per source and per source × unit × dataset × period,
// what each collection stage last did, in closed codes
// (packages/application/src/query/collection-quality.ts, ADR 0045,
// docs/evidence-browser.md). Read-only, GET-only, and served under the reader
// authority every signed-in subject already has over the evidence routes: it
// shows identifiers, capture times, counts and codes the evidence pages and
// the schedule page already hold, and no amount. A store without the
// scheduling tables (CORE 0065) does not serve it.
import {
  CollectionQualityLimitError,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../../../packages/application/src/query/collection-quality.ts";
import { COLLECTION_QUALITY_PATH } from "../../../packages/observation-shared/src/collection-quality-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;

/** Served only where the store has what the read joins: the scheduling and collection tables. */
export async function collectionQualityAvailable(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS present FROM sqlite_master
     WHERE type='table' AND name IN ('collection_schedules','collection_schedule_occurrences',
       'collection_execution_leases','collection_runs','collection_run_stages')`,
  ).first<{ present: number }>();
  return row?.present === 5;
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
  if (!(await collectionQualityAvailable(env))) throw new HttpError(404, "not_found");
  // The reader authority: every source, evidence identifiers and codes.
  if (!readerGrant(subject).capabilities.includes("evidence.read"))
    throw new HttpError(403, "forbidden");
  try {
    if (path === COLLECTION_QUALITY_PATH) {
      if (url.search) throw new HttpError(400, "invalid_query");
      return json(await queryCollectionQualitySummary(d1Executor(env.DB)));
    }
    const sourceId = path.slice(COLLECTION_QUALITY_PATH.length + 1);
    if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
    for (const [key, value] of url.searchParams)
      if (key !== "offset" || url.searchParams.getAll(key).length !== 1 || !value)
        throw new HttpError(400, "invalid_query");
    const offsetText = url.searchParams.get("offset") ?? "0";
    if (!OFFSET.test(offsetText)) throw new HttpError(400, "invalid_offset");
    const cells = await queryCollectionQualityCells(d1Executor(env.DB), {
      sourceId,
      offset: Number(offsetText),
    });
    if (cells === null) throw new HttpError(404, "not_found");
    return json(cells);
  } catch (error) {
    // More jobs or sources than the bound are refused, never cut into a partial answer.
    if (error instanceof CollectionQualityLimitError)
      throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
}
