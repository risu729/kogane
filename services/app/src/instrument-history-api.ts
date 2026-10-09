import { readInstrumentHistoryForGrant } from "../../../packages/application/src/query/instrument-history-read.ts";
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { INSTRUMENT_HISTORY_PATH } from "../../../packages/observation-shared/src/instrument-history-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

/** Called after Access, GET/HEAD only, ahead of the identity catalogue. */
export async function instrumentHistoryApi(
  _request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== INSTRUMENT_HISTORY_PATH) return null;
  if (
    [...url.searchParams.keys()].some((key) => key !== "identifierId") ||
    url.searchParams.getAll("identifierId").length !== 1
  )
    throw new HttpError(400, "invalid_query");
  const outcome = await readInstrumentHistoryForGrant({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    identifierId: url.searchParams.get("identifierId"),
  });
  return outcome.ok ? json(outcome.history) : json(outcome.error, ERROR_STATUS[outcome.error.code]);
}
