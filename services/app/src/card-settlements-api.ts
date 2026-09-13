import { queryCardSettlements } from "../../../packages/application/src/query/card-settlements.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { flagOn } from "./events-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export const CARD_SETTLEMENT_PATH = "/api/v2/reconciliation/card-settlements";

/** A schema-ahead deployment does not advertise a route it cannot serve. */
export async function cardSettlementsAvailable(env: Env): Promise<boolean> {
  if (!flagOn(env.EVENTS_V2_ENABLED)) return false;
  const row = await env.DB.prepare(
    "SELECT count(*) AS present FROM sqlite_master WHERE type='view' AND name IN ('card_settlement_reviews','card_settlement_readiness')",
  ).first<{ present: number }>();
  return row?.present === 2;
}

/** Operator-only until the agent query service can enforce per-candidate source scopes. */
export async function cardSettlementsApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== CARD_SETTLEMENT_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardSettlementsAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  for (const [key, value] of url.searchParams) {
    if (
      !["offset", "proposalId"].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value
    )
      throw new HttpError(400, "invalid_query");
  }
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  const proposalId = url.searchParams.get("proposalId");
  if (
    proposalId !== null &&
    (!/^[A-Za-z0-9_-]{1,128}$/u.test(proposalId) || url.searchParams.has("offset"))
  )
    throw new HttpError(400, "invalid_query");
  const page = await queryCardSettlements(d1Executor(env.DB), {
    offset,
    ...(proposalId === null ? {} : { proposalId }),
  });
  if (proposalId !== null && page.items.length === 0) throw new HttpError(404, "not_found");
  return json({ apiVersion: 2, ...page });
}
