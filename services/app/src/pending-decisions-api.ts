// `GET /api/v2/decisions/pending`: what waits for the owner's decision, one
// line per kind of open proposal (ADR 0126), for the ホーム page. Operator-only,
// like the review pages it points at. The answer is the application service's
// (`readPendingDecisions`), the one an agent gets from
// `kogane.decisions.pending` under its own grant, so a page and an agent read
// one answer. It plans, approves and commits nothing.
import { ERROR_STATUS, fullGrant, type Grant } from "../../../packages/application/src/index";
import {
  readPendingDecisions,
  type PendingDecisionsOutcome,
} from "../../../packages/application/src/query/pending-decisions.ts";
import { PENDING_DECISIONS_PATH } from "../../../packages/observation-shared/src/pending-decisions-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { cardPurchasesAvailable } from "./card-purchases-api";
import { cardSettlementsAvailable } from "./card-settlements-api";
import { commandsEnabled } from "./command-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";
import { schedulesServed } from "./schedule-tools";

export { PENDING_DECISIONS_PATH };

/**
 * The summary for `grant`, with what this deployment serves: the route and
 * the MCP tool both call this, so the served lines are the same on both.
 */
export async function pendingDecisionsFor(
  env: Env,
  grant: Grant,
): Promise<PendingDecisionsOutcome> {
  return readPendingDecisions({
    grant,
    sql: d1Executor(env.DB),
    served: {
      cardSettlements: await cardSettlementsAvailable(env),
      cardPurchases: await cardPurchasesAvailable(env),
      schedules: schedulesServed(env),
      commands: commandsEnabled(env),
    },
    now: new Date().toISOString(),
  });
}

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path. The route takes no parameter: any
 * query parameter is refused, never ignored. The operator reads with the
 * authority an MCP client holds (ADR 0084), so both see the same lines.
 */
export async function pendingDecisionsApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== PENDING_DECISIONS_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if ([...url.searchParams.keys()].length > 0) throw new HttpError(400, "invalid_query");
  const outcome = await pendingDecisionsFor(env, fullGrant(subject));
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json({ apiVersion: 2, ...outcome.answer });
}
