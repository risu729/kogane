// `GET /api/v2/card-purchases`: recognised card purchases explained through
// their provider statement, the reviewed settlement and the bank debit
// (packages/application/src/query/card-purchases.ts). Read-only and
// operator-only, like the card settlement review: this route carries the
// review actions of each candidate. An agent reads the same page through the
// agent API's `kogane.purchases.explain` instead, graded by its own grant,
// served only while `cardPurchasesAvailable` is, and without those actions
// (packages/application/src/query/purchases-explain.ts, docs/agent-api.md).
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { CARD_PURCHASE_LINE_SORTS } from "../../../packages/domain/src/card-purchase-view.ts";
import {
  CARD_PURCHASE_ACCOUNT,
  CARD_PURCHASE_EVENT_ID,
  CARD_PURCHASE_LINES_CURSOR_MAX,
  CARD_PURCHASE_PERIOD,
  CardPurchaseLimitError,
  queryCardPurchaseCards,
  queryCardPurchaseLines,
  queryCardPurchases,
} from "../../../packages/application/src/query/card-purchases.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export const CARD_PURCHASES_PATH = "/api/v2/card-purchases";
const PARAMETERS = [
  "offset",
  "period",
  "eventId",
  "view",
  "usageMonth",
  "account",
  "sort",
  "cursor",
];
/** The line view's own parameters, refused beside any other view. */
const LINE_PARAMETERS = ["account", "sort", "cursor"];

/**
 * `?view=lines` (ADR 0125 amendment): the line answer
 * `kogane.purchases.explain` returns as `data` for `view: lines`, from the
 * same `queryCardPurchaseLines`. Exactly one of a statement `period` and a
 * `usageMonth`, optionally an `account`, a `sort` and the previous page's
 * `cursor`; no `offset` or `eventId`.
 */
async function linesView(env: Env, params: URLSearchParams): Promise<Response> {
  if (params.has("offset") || params.has("eventId")) throw new HttpError(400, "invalid_query");
  const period = params.get("period");
  const usageMonth = params.get("usageMonth");
  if ((period === null) === (usageMonth === null)) throw new HttpError(400, "invalid_query");
  for (const value of [period, usageMonth])
    if (value !== null && !CARD_PURCHASE_PERIOD.test(value))
      throw new HttpError(400, "invalid_period");
  const account = params.get("account");
  const sort = params.get("sort");
  const cursor = params.get("cursor");
  if (
    (account !== null && !CARD_PURCHASE_ACCOUNT.test(account)) ||
    (sort !== null && !(CARD_PURCHASE_LINE_SORTS as readonly string[]).includes(sort))
  )
    throw new HttpError(400, "invalid_query");
  let page;
  try {
    page = await queryCardPurchaseLines(d1Executor(env.DB), {
      ...(period === null ? {} : { period }),
      ...(usageMonth === null ? {} : { usageMonth }),
      ...(account === null ? {} : { account }),
      ...(sort === null ? {} : { sort: sort as (typeof CARD_PURCHASE_LINE_SORTS)[number] }),
      ...(cursor === null ? {} : { cursor }),
    });
  } catch (error) {
    // A filter too large to read is refused, never partially listed.
    if (error instanceof CardPurchaseLimitError) throw new HttpError(413, "result_limit_exceeded");
    // A cursor this read did not issue for this request.
    if (error instanceof Error && error.message === "invalid_cursor")
      throw new HttpError(400, "invalid_query");
    throw error;
  }
  return json({ apiVersion: 2, ...page });
}

/**
 * `?view=cards` (ADR 0125): the per-card answer `kogane.purchases.explain`
 * returns as `data` for `view: cards`, from the same `queryCardPurchaseCards`.
 * Exactly one of a statement `period` and a `usageMonth`; no `offset` or
 * `eventId`.
 */
async function cardsView(env: Env, params: URLSearchParams): Promise<Response> {
  if (params.has("offset") || params.has("eventId")) throw new HttpError(400, "invalid_query");
  const period = params.get("period");
  const usageMonth = params.get("usageMonth");
  if ((period === null) === (usageMonth === null)) throw new HttpError(400, "invalid_query");
  for (const value of [period, usageMonth])
    if (value !== null && !CARD_PURCHASE_PERIOD.test(value))
      throw new HttpError(400, "invalid_period");
  let page;
  try {
    page = await queryCardPurchaseCards(d1Executor(env.DB), {
      ...(period === null ? {} : { period }),
      ...(usageMonth === null ? {} : { usageMonth }),
    });
  } catch (error) {
    // A filter too large to total is refused, never partially summed.
    if (error instanceof CardPurchaseLimitError) throw new HttpError(413, "result_limit_exceeded");
    throw error;
  }
  return json({ apiVersion: 2, ...page });
}

/**
 * Served only where CORE 0047 is applied, so a build deployed ahead of the
 * migration neither advertises nor serves it.
 */
export async function cardPurchasesAvailable(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "cardPurchases");
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
      value.length > (key === "cursor" ? CARD_PURCHASE_LINES_CURSOR_MAX : 128)
    )
      throw new HttpError(400, "invalid_query");
  const view = url.searchParams.get("view") ?? "events";
  if (view !== "events" && view !== "cards" && view !== "lines")
    throw new HttpError(400, "invalid_query");
  if (view === "lines") return linesView(env, url.searchParams);
  if (LINE_PARAMETERS.some((key) => url.searchParams.has(key)))
    throw new HttpError(400, "invalid_query");
  if (view === "cards") return cardsView(env, url.searchParams);
  if (url.searchParams.has("usageMonth")) throw new HttpError(400, "invalid_query");
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
