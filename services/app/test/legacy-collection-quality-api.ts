// FROZEN COPY of services/app/src/collection-quality-api.ts as of commit
// 517bd0ef (PR #1054's head), before the three collection quality routes
// became thin adapters over the shared grant-graded services of
// packages/application/src/query/collection-quality.ts (ADR 0081).
//
// Test-only. It exists so collection-quality-parity.test.ts can answer every
// request through the old route and the new one and compare status, headers
// and body bytes. Two edits, neither changing an answer: imports point at
// ../src, and the account branch calls `queryAccountCoverage` directly where
// it called the old `readAccountCoverageForGrant`, whose grant, scope and
// source checks the route had already made and whose two refusals it mapped
// to the same 404 and 413 this copy answers. Do not edit otherwise.
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
import { readerGrant } from "../src/agent-api";
import { HttpError, json } from "../src/http";

const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const OFFSET = /^(?:0|[1-9][0-9]{0,6})$/u;

/** Served only where the store has what the read joins: the scheduling and collection tables. */
async function collectionQualityAvailable(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS present FROM sqlite_master
     WHERE type='table' AND name IN ('collection_schedules','collection_schedule_occurrences',
       'collection_execution_leases','collection_runs','collection_run_stages')`,
  ).first<{ present: number }>();
  return row?.present === 5;
}

export async function legacyCollectionQualityApi(
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
    const rest = path.slice(COLLECTION_QUALITY_PATH.length + 1);
    if (rest.endsWith(ACCOUNT_COVERAGE_SUFFIX)) {
      // Every cell of one source, regrouped by account (ADR 0082): no page and no parameter.
      const sourceId = rest.slice(0, -ACCOUNT_COVERAGE_SUFFIX.length);
      if (!SOURCE.test(sourceId)) throw new HttpError(404, "not_found");
      if (url.search) throw new HttpError(400, "invalid_query");
      // The old service's read, past the checks the route had already made: a
      // bound it refused is the outer catch's 413, an unknown source 404.
      const coverage = await queryAccountCoverage(d1Executor(env.DB), { sourceId });
      if (coverage === null) throw new HttpError(404, "not_found");
      return json(coverage);
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
