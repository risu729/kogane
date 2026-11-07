// `GET /api/v2/reconciliation/card-statements-unmatched`: the card statements
// no settlement candidate cites, each with its closed reason and the ADR 0074
// planner's read-only answer, for the `カード照合` page
// (docs/card-settlements.md, Statements without a candidate). Operator-only,
// like the candidate list it sits beside. The answer is the application
// service's (`reviewUnmatchedCardStatements`), the one an agent gets from
// `kogane.card-settlements.unmatched` under its own grant, so a page and an
// agent read one page of one read. It plans, approves and commits nothing.
import { ERROR_STATUS } from "../../../packages/application/src/index";
import {
  parseUnmatchedCardStatementsRequest,
  reviewUnmatchedCardStatements,
  UNMATCHED_KEYS,
} from "../../../packages/application/src/query/card-statements-unmatched.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { cardSettlementsAvailable } from "./card-settlements-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";
import { CARD_STATEMENTS_UNMATCHED_PATH } from "../../../packages/observation-shared/src/card-statements-unmatched-contract.ts";

export { CARD_STATEMENTS_UNMATCHED_PATH };

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path.
 */
export async function cardStatementsUnmatchedApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== CARD_STATEMENTS_UNMATCHED_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardSettlementsAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  const body: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (
      !(UNMATCHED_KEYS as readonly string[]).includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value
    )
      throw new HttpError(400, "invalid_query");
    if (!/^(0|[1-9]\d{0,6})$/u.test(value)) throw new HttpError(400, "invalid_offset");
    body[key] = Number(value);
  }
  const parsed = parseUnmatchedCardStatementsRequest(body);
  if (!parsed.ok) throw new HttpError(400, "invalid_offset");
  const outcome = await reviewUnmatchedCardStatements({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    request: parsed.value,
  });
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json({ apiVersion: 2, ...outcome.review });
}
