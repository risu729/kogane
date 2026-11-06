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
import {
  COLLECTION_QUALITY_PATH,
  validCollectionQualityAlarms,
  type CollectionQualitySummary,
} from "../../../packages/observation-shared/src/collection-quality-contract.ts";
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
  // Resolve authority before schema/source enumeration. This aggregation
  // cannot safely answer an account-filtered grant, even for a known source.
  const grant = readerGrant(subject);
  if (!grant.capabilities.includes("evidence.read")) throw new HttpError(403, "forbidden");
  if (grant.scopes.sources !== "*" || grant.scopes.accounts !== "*")
    throw new HttpError(403, "scope_restricted");
  if (!(await collectionQualityAvailable(env))) throw new HttpError(404, "not_found");
  try {
    if (path === COLLECTION_QUALITY_PATH) {
      if (url.search) throw new HttpError(400, "invalid_query");
      const summary = await queryCollectionQualitySummary(d1Executor(env.DB));
      await readAlarms(env, summary);
      return json(summary);
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
