// `GET /api/v2/changes?since=<instant>[&after=<source>]`: what was recorded in
// the store since an instant, per source (ADR 0127). Read-only, GET-only,
// served under the reader authority every signed-in subject already has over
// the evidence browser's GET routes. The answer is the application service's
// (`readChangesSince`), the one an agent gets from `kogane.changes.since`
// under its own grant, so a route and an agent read one answer. It changes
// nothing.
import { ERROR_STATUS, type Grant } from "../../../packages/application/src/index";
import {
  readChangesSince,
  type ChangesSinceOutcome,
  type ChangesSinceRequest,
} from "../../../packages/application/src/query/changes-since.ts";
import { CHANGES_SINCE_PATH } from "../../../packages/observation-shared/src/changes-since-contract.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { eventsV2Available } from "./events-api";
import { HttpError, json } from "./http";

export { CHANGES_SINCE_PATH };

/** The query parameters the route takes, each at most once. */
const PARAMETERS = ["since", "after"] as const;

/**
 * The digest for `grant` and `request`, with what this deployment serves: the
 * route and the MCP tool both call this, so the events line is served alike.
 */
export async function changesSinceFor(
  env: Env,
  grant: Grant,
  request: ChangesSinceRequest,
): Promise<ChangesSinceOutcome> {
  return readChangesSince({
    grant,
    sql: d1Executor(env.DB),
    served: { events: await eventsV2Available(env) },
    request,
    now: new Date().toISOString(),
  });
}

/**
 * Call only after the Access authentication gate; `subject` is the subject it
 * proved. Returns null for any other path. A query parameter other than
 * `since` and `after`, or one given twice, is refused, never ignored.
 */
export async function changesSinceApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== CHANGES_SINCE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  for (const key of new Set(url.searchParams.keys()))
    if (
      !(PARAMETERS as readonly string[]).includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new HttpError(400, "invalid_query");
  const outcome = await changesSinceFor(env, readerGrant(subject), {
    since: url.searchParams.get("since") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
  });
  if (!outcome.ok) return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  return json({ apiVersion: 2, ...outcome.answer });
}
