// `GET /api/v2/reported-state?date=YYYY-MM-DD`: what each provider last
// reported on a date, per account, beside the card statements due around it
// (packages/application/src/query/dated-state.ts, docs/reported-state.md).
// Read-only, GET-only, and served under the reader authority every signed-in
// subject already has over the other GET routes: it shows provider figures the
// evidence pages already show, adds none of them up and carries no review
// action. A store without the views it reads does not serve it. The route is
// an adapter: the request rules and refusal codes are the application
// service's (`readReportedStateRequest`), which the agent tool calls too.
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import {
  readReportedStateRequest,
  reportedStateBodyFromQuery,
} from "../../../packages/application/src/query/reported-state-read.ts";
import type { ReportedState } from "../../../packages/domain/src/reported-state.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

export const REPORTED_STATE_PATH = "/api/v2/reported-state";

/**
 * Served only where the store has what the read joins: the snapshot policy
 * table, the provider statement view and the settlement reviews (CORE 0044).
 */
export async function reportedStateAvailable(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "datedState");
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
  // The query string as the tool's body: the service's rules decide both.
  const query = reportedStateBodyFromQuery(url.searchParams);
  if (!query.ok) throw new HttpError(query.status, query.refusal);
  const state = await readReportedState(env, query.body);
  return json({ apiVersion: 2, ...state });
}

/**
 * The read the route and the agent tool `kogane.reported-state.read` both
 * call. The request rules, the read and the closed refusal codes are the
 * application service's (`readReportedStateRequest`), so both answer the same
 * state and the same refusal, thrown as `HttpError`: `invalid_query` for
 * another, repeated or empty key or a malformed filter, `invalid_date`,
 * `date_in_future`, and `result_limit_exceeded` (413) past the read's row
 * bound.
 */
export async function readReportedState(env: Env, body: unknown): Promise<ReportedState> {
  const outcome = await readReportedStateRequest({
    sql: d1Executor(env.DB),
    body,
    now: Date.now(),
  });
  if (!outcome.ok) throw new HttpError(outcome.status, outcome.refusal);
  return outcome.state;
}
