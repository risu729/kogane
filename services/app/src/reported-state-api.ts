// `GET /api/v2/reported-state?date=YYYY-MM-DD`: what each provider last
// reported on a date, per account, beside the card statements due around it
// (packages/application/src/query/dated-state.ts, docs/reported-state.md).
// Read-only, GET-only, and served under the reader authority every signed-in
// subject already has over the other GET routes: it shows provider figures the
// evidence pages already show, adds none of them up and carries no review
// action. A store without the views it reads does not serve it.
import {
  DatedStateLimitError,
  queryDatedState,
} from "../../../packages/application/src/query/dated-state.ts";
import { parseLocalDate } from "../../../packages/domain/src/time.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

export const REPORTED_STATE_PATH = "/api/v2/reported-state";
const PARAMETERS = ["date", "source", "account"];
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;

/**
 * Served only where the store has what the read joins: the snapshot policy
 * table, the provider statement view and the settlement reviews (CORE 0044).
 */
export async function reportedStateAvailable(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS present FROM sqlite_master
     WHERE (type='table' AND name='dataset_snapshot_policies')
        OR (type='view' AND name IN ('card_statement_facts','card_settlement_reviews'))`,
  ).first<{ present: number }>();
  return row?.present === 3;
}

/** Today's civil date in Asia/Tokyo: a later date has no reported state yet. */
function tokyoToday(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function reportedStateApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== REPORTED_STATE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await reportedStateAvailable(env))) throw new HttpError(404, "not_found");
  // The reader authority: every source and account, summaries and records.
  if (!readerGrant(subject).capabilities.includes("summary.read"))
    throw new HttpError(403, "forbidden");
  for (const [key, value] of url.searchParams)
    if (!PARAMETERS.includes(key) || url.searchParams.getAll(key).length !== 1 || !value)
      throw new HttpError(400, "invalid_query");
  const date = url.searchParams.get("date");
  if (date === null || !DATE.test(date) || parseLocalDate(date) === null)
    throw new HttpError(400, "invalid_date");
  if (date > tokyoToday(Date.now())) throw new HttpError(400, "date_in_future");
  const source = url.searchParams.get("source");
  if (source !== null && !SOURCE.test(source)) throw new HttpError(400, "invalid_query");
  const account = url.searchParams.get("account");
  if (account !== null && !ACCOUNT.test(account)) throw new HttpError(400, "invalid_query");
  let state;
  try {
    state = await queryDatedState(d1Executor(env.DB), {
      date,
      ...(source === null ? {} : { source }),
      ...(account === null ? {} : { account }),
    });
  } catch (error) {
    // More rows than the bound are refused, never cut into a partial answer.
    if (error instanceof DatedStateLimitError) throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
  return json({ apiVersion: 2, ...state });
}
