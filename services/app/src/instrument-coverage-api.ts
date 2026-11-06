// `GET /api/identity/instrument-coverage`: per-source counts of instrument
// identifiers by their ADR 0055 state (ADR 0073), for the `口座・銘柄の整理`
// page. Read-only, GET/HEAD only, behind the same Access gate as the other
// identity routes and under the reader grant a signed-in browser already has
// (`readerGrant`). The answer is the application service's
// (`readInstrumentCoverage`), which runs the candidate read itself and counts
// its identifier states, so the counts and the candidate page agree.
import {
  INSTRUMENT_COVERAGE_KEYS,
  readInstrumentCoverage,
} from "../../../packages/application/src/query/instrument-coverage.ts";
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { INSTRUMENT_COVERAGE_PATH } from "../../../packages/observation-shared/src/instrument-coverage-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path, so it is registered before the
 * identity catalogue, which answers 404 for an unknown `/api/identity/` path.
 */
export async function instrumentCoverageApi(
  _request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  // GET/HEAD only: `worker.ts` answers 405 to every other method first.
  if (url.pathname !== INSTRUMENT_COVERAGE_PATH) return null;
  for (const [key, value] of url.searchParams)
    if (
      !(INSTRUMENT_COVERAGE_KEYS as readonly string[]).includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 128 ||
      /[\u0000-\u001f]/u.test(value)
    )
      throw new HttpError(400, "invalid_query");
  const outcome = await readInstrumentCoverage({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    source: url.searchParams.get("source"),
  });
  return outcome.ok
    ? json(outcome.coverage)
    : json(outcome.error, ERROR_STATUS[outcome.error.code]);
}
