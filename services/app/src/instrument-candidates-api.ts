// `GET /api/identity/instrument-candidates`: the cross-identifier instrument
// candidate review of ADR 0055 (its 2026-10-09 amendment) for the browser's
// `銘柄の同一性の候補` page. Read-only, GET-only, behind the same Access gate as
// the other identity routes and under the reader grant a signed-in browser
// already has over every GET route (`readerGrant`). The answer is the
// application service's (`reviewInstrumentCandidates`), the one an agent gets
// from `kogane.instruments.candidates` under its own grant, so a page and an
// agent read one page of one read.
//
// A proposed candidate carries the payloads of the existing commands that
// would decide it. Deciding is a plan of that payload through the change
// lifecycle (`/api/command/v1/*`), graded there by its own grant lists; this
// route plans, approves and commits nothing.
import {
  INSTRUMENT_CANDIDATES_KEYS,
  parseInstrumentCandidatesRequest,
  reviewInstrumentCandidates,
} from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { INSTRUMENT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/instrument-candidates-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path, so it is registered before the
 * identity catalogue, which answers 404 for an unknown `/api/identity/` path.
 */
export async function instrumentCandidatesApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== INSTRUMENT_CANDIDATES_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  const body: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (
      !(INSTRUMENT_CANDIDATES_KEYS as readonly string[]).includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 128
    )
      throw new HttpError(400, "invalid_query");
    if (key === "offset") {
      if (!/^(0|[1-9]\d{0,6})$/u.test(value)) throw new HttpError(400, "invalid_offset");
      body[key] = Number(value);
    } else body[key] = value;
  }
  const parsed = parseInstrumentCandidatesRequest(body);
  // Keys are already closed above, so a refusal here is a malformed value.
  if (!parsed.ok) throw new HttpError(400, "invalid_query", parsed.refs);
  const outcome = await reviewInstrumentCandidates({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    request: parsed.value,
  });
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json(outcome.review);
}
