// `GET /api/identity/account-candidates`: the account correspondence
// candidate review of ADR 0077 for the browser's `口座の対応候補` page.
// Read-only, GET-only, behind the same Access gate as the other identity
// routes and under the reader grant a signed-in browser already has over every
// GET route (`readerGrant`). The answer is the application service's
// (`reviewAccountCandidates`), the one an agent gets from
// `kogane.accounts.candidates` under its own grant, so a page and an agent
// read one page of one read.
//
// A candidate carries the payloads of the existing commands that would decide
// it (`relation.accept` / `relation.reject` of `connection_contains`).
// Deciding is a plan of that payload through the change lifecycle
// (`/api/command/v1/*`), graded there by its own grant lists; this route plans,
// approves and commits nothing.
import {
  ACCOUNT_CANDIDATES_KEYS,
  parseAccountCandidatesRequest,
  reviewAccountCandidates,
} from "../../../packages/application/src/query/account-candidates.ts";
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { ACCOUNT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/account-candidates-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { HttpError, json } from "./http";

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path, so it is registered before the
 * identity catalogue, which answers 404 for an unknown `/api/identity/` path.
 */
export async function accountCandidatesApi(
  _request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  // GET/HEAD only: `worker.ts` answers 405 to every other method before any
  // read route is reached, so this module does not check the method again.
  if (url.pathname !== ACCOUNT_CANDIDATES_PATH) return null;
  const body: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (
      !(ACCOUNT_CANDIDATES_KEYS as readonly string[]).includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 256
    )
      throw new HttpError(400, "invalid_query");
    if (key === "offset") {
      if (!/^(0|[1-9]\d{0,6})$/u.test(value)) throw new HttpError(400, "invalid_offset");
      body[key] = Number(value);
    } else body[key] = value;
  }
  const parsed = parseAccountCandidatesRequest(body);
  // Keys are already closed above, so a refusal here is a malformed value.
  if (!parsed.ok) throw new HttpError(400, "invalid_query", parsed.refs);
  const outcome = await reviewAccountCandidates({
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    request: parsed.value,
  });
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json(outcome.review);
}
