// `GET /api/v2/reconciliation/card-debit-accounts`: which bank account each
// credit card is debited from, with the evidence each answer rests on, for
// the `カード照合` page (docs/card-settlements.md, Debit account per card;
// ADR 0114). Operator-only, like the candidate list it sits beside. The
// answer is the application service's (`reviewCardDebitAccounts`), the one an
// agent gets from `kogane.card-settlements.debit-accounts` under its own
// grant, so a page and an agent read one answer. It plans, approves and
// commits nothing.
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { reviewCardDebitAccounts } from "../../../packages/application/src/query/card-debit-accounts.ts";
import { CARD_DEBIT_ACCOUNTS_PATH } from "../../../packages/observation-shared/src/card-debit-accounts-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { cardSettlementsAvailable } from "./card-settlements-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export { CARD_DEBIT_ACCOUNTS_PATH };

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path. The route takes no parameter: any
 * query parameter is refused, never ignored.
 */
export async function cardDebitAccountsApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== CARD_DEBIT_ACCOUNTS_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardSettlementsAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if ([...url.searchParams.keys()].length > 0) throw new HttpError(400, "invalid_query");
  const outcome = await reviewCardDebitAccounts({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
  });
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json({ apiVersion: 2, ...outcome.review });
}
