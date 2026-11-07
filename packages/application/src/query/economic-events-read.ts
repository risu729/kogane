// The economic events read (architecture addendum A10, plan D19): one page of
// adopted economic events on one recognition basis, or of obligations with
// their settlements. `GET /api/v2/activity`, `GET /api/v2/obligations` and
// the agent tool `kogane.events.read` are adapters over `readEconomicEvents`
// (ADR 0081 point 2), so they answer the same page and the same closed
// refusal codes. This file adds no SQL: the reader is the read model's
// `createEventsReader`. Whether the projection exists is the adapters'
// question, as it decides whether the route and the tool exist at all.
//
// Every figure carries its basis and its explanation refs. The activity list
// never mixes cash-out with cost recognised at purchase: the basis is part of
// the request, `cash-movement` when absent (addendum 07 section 6).
import type { FinancialError } from "../../../domain/src/result.ts";
import {
  type ActivityBasis,
  createEventsReader,
  type EventsReader,
  isActivityBasis,
} from "../../../read-model/src/events.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";

export const ECONOMIC_EVENTS_LISTS = ["activity", "obligations"] as const;
export type EconomicEventsList = (typeof ECONOMIC_EVENTS_LISTS)[number];
/** One page; the reader asks for one row more to report `nextCursor`. */
export const ECONOMIC_EVENTS_PAGE_SIZE = 200;
export const ECONOMIC_EVENTS_MAX_OFFSET = 1_000_000;
const DEFAULT_ACTIVITY_BASIS: ActivityBasis = "cash-movement";
/** The longest parameter value either list accepts. */
const MAX_PARAMETER_LENGTH = 64;

export type EconomicEventsPage =
  | ({ apiVersion: 2; basis: ActivityBasis } & Awaited<ReturnType<EventsReader["activity"]>>)
  | ({ apiVersion: 2 } & Awaited<ReturnType<EventsReader["obligations"]>>);

/**
 * `invalid_query`: a parameter the list does not take, a repeated, empty or
 * over-long one, or an unknown basis. `invalid_offset`: an offset that is not
 * a whole number from 0 to 1,000,000.
 */
export type EconomicEventsRefusal = "invalid_query" | "invalid_offset";

export type EconomicEventsOutcome =
  | { ok: true; body: EconomicEventsPage }
  | { ok: false; refusal: EconomicEventsRefusal };

/**
 * The page the request names, or its refusal; nothing is read before the
 * request is valid. `parameters` are the routes' query parameters: `basis`
 * (activity only) and `offset`, each at most once.
 */
export async function readEconomicEvents(
  sql: SqlExecutor,
  list: EconomicEventsList,
  parameters: URLSearchParams,
): Promise<EconomicEventsOutcome> {
  const allowed = list === "activity" ? ["basis", "offset"] : ["offset"];
  for (const key of parameters.keys()) {
    const value = parameters.get(key)!;
    if (
      !allowed.includes(key) ||
      parameters.getAll(key).length !== 1 ||
      !value ||
      value.length > MAX_PARAMETER_LENGTH
    )
      return { ok: false, refusal: "invalid_query" };
  }
  const text = parameters.get("offset") ?? "0";
  const offset = Number(text);
  if (
    !/^(0|[1-9]\d*)$/u.test(text) ||
    !Number.isSafeInteger(offset) ||
    offset > ECONOMIC_EVENTS_MAX_OFFSET
  )
    return { ok: false, refusal: "invalid_offset" };
  const basisParameter = parameters.get("basis");
  if (basisParameter !== null && !isActivityBasis(basisParameter))
    return { ok: false, refusal: "invalid_query" };
  const reader = createEventsReader(sql, { pageSize: ECONOMIC_EVENTS_PAGE_SIZE });
  if (list === "obligations")
    return { ok: true, body: { apiVersion: 2, ...(await reader.obligations({ offset })) } };
  const basis = basisParameter ?? DEFAULT_ACTIVITY_BASIS;
  return {
    ok: true,
    body: { apiVersion: 2, basis, ...(await reader.activity({ basis, offset })) },
  };
}

/**
 * Why `grant` may not read the events, or null when it may: `records.read`,
 * then `"*"` on both scope axes. The projection is neither scoped nor proven
 * inside a listed scope, so a narrower grant is refused, never served a
 * filtered page (ADR 0063 decision 10). Graded before the request is read.
 */
export function economicEventsGrantRefusal(grant: Grant): FinancialError | null {
  if (!grantAllows(grant, "records.read"))
    return financialError("unauthorized", "events.read", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  return narrowed.length > 0
    ? financialError("evidence_restricted", "events.read", narrowed)
    : null;
}
