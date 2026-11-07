// `GET /api/v2/reported-holdings-change?from=YYYY-MM-DD&to=YYYY-MM-DD`
// `[&source=…][&account=…]`: the reported holdings of two dates side by side
// per provider holding key, with the exact change where both dates list a
// holding (packages/application/src/query/holdings-change.ts, ADR 0075 and its
// 2026-11-06 amendment, docs/reported-state.md). Exposed exactly as
// `/api/v2/reported-state` is: read-only, GET-only, served under the reader
// authority every signed-in subject already has over the other GET routes,
// and absent where the store lacks the views the two dated reads join. It
// adds no holdings up, values nothing and carries no review action.
import {
  HoldingsChangeError,
  queryHoldingsChange,
  type HoldingsChangeRefusal,
} from "../../../packages/application/src/query/holdings-change.ts";
import { parseLocalDate } from "../../../packages/domain/src/time.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";
import { reportedStateAvailable } from "./reported-state-api";

export const REPORTED_HOLDINGS_CHANGE_PATH = "/api/v2/reported-holdings-change";
const PARAMETERS = ["from", "to", "source", "account"];
// The reported state's own parameter shapes.
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;

/** The HTTP answer of each refusal of the query; every one is a closed code. */
const REFUSALS: Record<HoldingsChangeRefusal, { status: number; code: string }> = {
  invalid_request: { status: 400, code: "invalid_query" },
  invalid_range: { status: 400, code: "invalid_range" },
  date_in_future: { status: 400, code: "date_in_future" },
  unknown_source: { status: 404, code: "unknown_source" },
  unknown_account: { status: 404, code: "unknown_account" },
  // More holdings or rows than the bound are refused, never cut into a partial answer.
  holding_limit_exceeded: { status: 413, code: "result_limit_exceeded" },
  dated_state_limit_exceeded: { status: 413, code: "result_limit_exceeded" },
};

/** Served exactly where `/api/v2/reported-state` is: both dated reads need its views. */
export async function reportedHoldingsChangeAvailable(env: Env): Promise<boolean> {
  return reportedStateAvailable(env);
}

/** Today's civil date in Asia/Tokyo: a later date has no reported state yet. */
function tokyoToday(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

const validDate = (value: string | null): value is string =>
  value !== null && DATE.test(value) && parseLocalDate(value) !== null;

export async function reportedHoldingsChangeApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== REPORTED_HOLDINGS_CHANGE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await reportedHoldingsChangeAvailable(env))) throw new HttpError(404, "not_found");
  // The reader authority: every source and account, summaries and records.
  if (!readerGrant(subject).capabilities.includes("summary.read"))
    throw new HttpError(403, "forbidden");
  return json(await readHoldingsChange(env, url.searchParams));
}

/**
 * The two dated reported states side by side for these query parameters: the
 * answer of the route and of `kogane.reported-holdings-change.read`
 * (ADR 0081), once the caller's authority and the store's views are known.
 * Its refusals are `HttpError`s with the route's closed codes.
 */
export async function readHoldingsChange(
  env: Env,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  for (const [key, value] of params)
    if (!PARAMETERS.includes(key) || params.getAll(key).length !== 1 || !value)
      throw new HttpError(400, "invalid_query");
  const from = params.get("from");
  const to = params.get("to");
  if (!validDate(from) || !validDate(to)) throw new HttpError(400, "invalid_date");
  const source = params.get("source");
  if (source !== null && !SOURCE.test(source)) throw new HttpError(400, "invalid_query");
  const account = params.get("account");
  if (account !== null && !ACCOUNT.test(account)) throw new HttpError(400, "invalid_query");
  let change;
  try {
    change = await queryHoldingsChange(d1Executor(env.DB), {
      from,
      to,
      today: tokyoToday(Date.now()),
      ...(source === null ? {} : { source }),
      ...(account === null ? {} : { account }),
    });
  } catch (error) {
    if (error instanceof HoldingsChangeError) {
      const refusal = REFUSALS[error.code];
      throw new HttpError(
        refusal.status,
        refusal.code,
        refusal.code === error.code ? [] : [error.code],
      );
    }
    throw error;
  }
  return { apiVersion: 2, ...change };
}
