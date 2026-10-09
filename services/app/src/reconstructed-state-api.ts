// `GET /api/v2/reconstructed-state?account=…&from=YYYY-MM-DD&to=YYYY-MM-DD`
// `[&basis=cash][&coreEpoch=…&commitSeq=N | &coreEpoch=…&instant=…][&setVersion=…]`:
// one account's balances reconstructed from adopted events over a range,
// beside what its provider reported at both ends, at one cut of the economic
// commit log (docs/reconstructed-state.md, ADR 0058 and its 2026-10-09
// amendment). The route is an adapter: the parameters, the request rules, the
// grant check, the bounds and the refusal codes are the application
// service's (`readReconstructedState`), which the agent tool
// `kogane.reconstructed-state.read` calls too.
//
// Read-only, GET-only, and served under the reader authority every signed-in
// subject already has over the other GET routes, like `/api/v2/reported-state`.
// It adopts, approves and writes nothing. Where the store lacks the views the
// reported state joins it does not exist; where it lacks CORE 0070 it answers
// `unavailable` (`economic_guard_missing`), as the query does.
import {
  readReconstructedState,
  RECONSTRUCTED_STATE_REFUSALS,
  reconstructedStateBodyFromQuery,
} from "../../../packages/application/src/index";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";
import { reportedStateAvailable } from "./reported-state-api";

export const RECONSTRUCTED_STATE_PATH = "/api/v2/reconstructed-state";

/**
 * Served exactly where `/api/v2/reported-state` is: the two dated reads it
 * compares need the same views. Without CORE 0070 it is still served and
 * says `unavailable`.
 */
export async function reconstructedStateAvailable(env: Env): Promise<boolean> {
  return reportedStateAvailable(env);
}

export async function reconstructedStateApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== RECONSTRUCTED_STATE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await reconstructedStateAvailable(env))) throw new HttpError(404, "not_found");
  const query = reconstructedStateBodyFromQuery(url.searchParams);
  const outcome = query.ok
    ? await readReconstructedState({
        // The principal `authenticate` proved, under the reader authority.
        grant: readerGrant(subject),
        sql: d1Executor(env.DB),
        body: query.body,
        now: new Date().toISOString(),
      })
    : query;
  if (!outcome.ok)
    throw new HttpError(
      RECONSTRUCTED_STATE_REFUSALS[outcome.refusal].status,
      outcome.refusal,
      outcome.refs,
    );
  return json(outcome.body);
}
