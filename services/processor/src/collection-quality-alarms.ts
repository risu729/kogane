// The quality page's bounded read of actual reservations. No reconciliation,
// lease changes or writes: a failed RPC is unknown, never an absent alarm.
import {
  COLLECTION_QUALITY_BOUND,
  type CollectionQualityAlarms,
} from "../../../packages/observation-shared/src/collection-quality-contract.ts";

type AlarmEnv = Pick<Env, "DB"> & {
  SCHEDULE_ALARMS: {
    getByName(id: string): {
      alarmTime(): Promise<
        Awaited<ReturnType<ReturnType<Env["SCHEDULE_ALARMS"]["getByName"]>["alarmTime"]>>
      >;
    };
  };
  SCHEDULES_ENABLED?: string;
};

export async function collectionQualityAlarms(
  env: AlarmEnv,
): Promise<CollectionQualityAlarms | null> {
  const rows = await env.DB.prepare(
    `SELECT id, enabled, next_nominal_at, next_run_at FROM collection_schedules ORDER BY id LIMIT ${COLLECTION_QUALITY_BOUND + 1}`,
  ).all<{
    id: string;
    enabled: number;
    next_nominal_at: string | null;
    next_run_at: string | null;
  }>();
  if (rows.results.length > COLLECTION_QUALITY_BOUND) return null;
  const alarms: CollectionQualityAlarms["alarms"] = [];
  // Sequential RPCs keep work bounded by the configured schedule count.
  for (const row of rows.results) {
    let alarm: CollectionQualityAlarms["alarms"][number]["alarm"] = {
      status: "unavailable",
      actualAt: null,
    };
    try {
      alarm = {
        status: "observed",
        actualAt: await env.SCHEDULE_ALARMS.getByName(row.id).alarmTime(),
      };
    } catch {
      // The absence of an answer is not the absence of a reservation.
    }
    alarms.push({
      id: row.id,
      enabled: row.enabled === 1,
      nextNominalAt: row.next_nominal_at,
      nextRunAt: row.next_run_at,
      alarm,
    });
  }
  return { alarms };
}
export async function collectionQualityAlarmRoute(
  request: Request,
  env: AlarmEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/internal/collection-quality/alarms") return null;
  if (
    request.headers.has("cf-connecting-ip") ||
    request.headers.get("x-kogane-internal-caller") !== "kogane-evidence-browser" ||
    env.SCHEDULES_ENABLED !== "true"
  )
    return Response.json({ error: "service_binding_required" }, { status: 403 });
  if (request.method !== "GET")
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (url.search) return Response.json({ error: "invalid_query" }, { status: 400 });
  const value = await collectionQualityAlarms(env);
  return value === null
    ? Response.json({ error: "result_limit_exceeded" }, { status: 413 })
    : Response.json(value);
}
