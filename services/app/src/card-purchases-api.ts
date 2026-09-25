// `GET /api/v2/card-purchases`: recognised card purchases explained through
// their provider statement, the reviewed settlement and the bank debit
// (packages/application/src/query/card-purchases.ts). Read-only and
// operator-only, like the card settlement review: this route carries the
// review actions of each candidate. An agent reads the same page through the
// agent API's `kogane.purchases.explain` instead, graded by its own grant,
// served only while `cardPurchasesAvailable` is, and without those actions
// (packages/application/src/query/purchases-explain.ts, docs/agent-api.md).
import {
  CARD_PURCHASE_EVENT_ID,
  CARD_PURCHASE_PERIOD,
  CardPurchaseLimitError,
  queryCardPurchases,
} from "../../../packages/application/src/query/card-purchases.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { flagOn } from "./events-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export const CARD_PURCHASES_PATH = "/api/v2/card-purchases";
const PARAMETERS = ["offset", "period", "eventId"];

/**
 * Served only where the event reader flag is on and CORE 0047 is applied, so
 * a build deployed ahead of the migration neither advertises nor serves it.
 */
export async function cardPurchasesAvailable(env: Env): Promise<boolean> {
  if (!flagOn(env.EVENTS_V2_ENABLED)) return false;
  const row = await env.DB.prepare(
    `SELECT count(*) AS present FROM sqlite_master
     WHERE (type='table' AND name='card_purchase_recognitions')
        OR (type='view' AND name IN ('current_card_purchase_recognitions','current_card_purchase_keys'))`,
  ).first<{ present: number }>();
  return row?.present === 3;
}

export async function cardPurchasesApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== CARD_PURCHASES_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardPurchasesAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  for (const [key, value] of url.searchParams)
    if (
      !PARAMETERS.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 128
    )
      throw new HttpError(400, "invalid_query");
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  const period = url.searchParams.get("period");
  if (period !== null && !CARD_PURCHASE_PERIOD.test(period))
    throw new HttpError(400, "invalid_period");
  const eventId = url.searchParams.get("eventId");
  // One event is an exact read: no paging or period beside it.
  if (
    eventId !== null &&
    (!CARD_PURCHASE_EVENT_ID.test(eventId) ||
      url.searchParams.has("offset") ||
      url.searchParams.has("period"))
  )
    throw new HttpError(400, "invalid_query");
  let page;
  try {
    page = await queryCardPurchases(d1Executor(env.DB), {
      offset,
      ...(period === null ? {} : { period }),
      ...(eventId === null ? {} : { eventId }),
    });
  } catch (error) {
    // A filter too large to total is refused, never partially summed.
    if (error instanceof CardPurchaseLimitError) throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
  if (eventId !== null && page.items.length === 0) throw new HttpError(404, "not_found");
  return json({ apiVersion: 2, ...page });
}
