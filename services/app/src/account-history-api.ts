// `GET /api/identity/account-history?sourceAccountId=`: one source account's
// append-only correction history for the 口座の対応候補 page (ADR 0077,
// amendment 2026-11-08). `kogane.accounts.history` calls the same service.
import { readAccountHistoryForGrant } from "../../../packages/application/src/query/account-history-read.ts";
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { ACCOUNT_HISTORY_PATH } from "../../../packages/observation-shared/src/account-history-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

/** Called after Access, GET/HEAD only, ahead of the identity catalogue. */
export async function accountHistoryApi(
  _request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_HISTORY_PATH) return null;
  if (
    [...url.searchParams.keys()].some((key) => key !== "sourceAccountId") ||
    url.searchParams.getAll("sourceAccountId").length !== 1
  )
    throw new HttpError(400, "invalid_query");
  const outcome = await readAccountHistoryForGrant({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    sourceAccountId: url.searchParams.get("sourceAccountId"),
  });
  return outcome.ok ? json(outcome.history) : json(outcome.error, ERROR_STATUS[outcome.error.code]);
}
