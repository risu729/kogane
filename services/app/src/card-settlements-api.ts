// `GET /api/v2/reconciliation/card-settlements` and its `/ownership` read: the
// `カード照合` pages' review list, one statement's candidates, one review, the
// candidates a review competes with, and one candidate's ownership review.
// Operator-only. The answer is the application service's
// (`readCardSettlementsForGrant`, `readCardOwnershipForGrant`), the one an
// agent gets from `kogane.card-settlements.read` and
// `kogane.card-settlements.ownership` (ADR 0081 point 2): request rules,
// refusal codes and the grant's row budget are decided there, once for both
// transports. This file only turns the query string into that request, under
// the reader grant a signed-in browser holds over every GET route
// (`readerGrant`), and the service's outcome into a response.
//
// The `/statements` grouping has no MCP read yet (a listed gap in
// `test/ui-mcp-parity.test.ts`) and keeps its own query rules here.
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { queryCardSettlementStatements } from "../../../packages/application/src/query/card-settlements.ts";
import {
  CARD_SETTLEMENTS_MAX_OFFSET,
  readCardOwnershipForGrant,
  readCardSettlementsForGrant,
} from "../../../packages/application/src/query/card-settlements-read.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export const CARD_SETTLEMENT_PATH = "/api/v2/reconciliation/card-settlements";
export const CARD_OWNERSHIP_PATH = `${CARD_SETTLEMENT_PATH}/ownership`;
/** The list grouped by statement (docs/card-settlements.md, Candidate and decision lifecycle). */
export const CARD_SETTLEMENT_STATEMENTS_PATH = `${CARD_SETTLEMENT_PATH}/statements`;

/** A schema-ahead deployment does not advertise a route it cannot serve. */
export async function cardSettlementsAvailable(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "cardSettlements");
}

/**
 * The service's request from a query string: each key once as its text, a
 * repeated key as the list of its values (which the service refuses as it
 * refuses any non-text value), and `offset` as a number when its text is a
 * plain decimal. Any other `offset` text stays text, so the service refuses it
 * as it refuses `{"offset": "1"}` over MCP.
 */
function serviceRequest(params: URLSearchParams): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const value = values[0]!;
    request[key] =
      values.length !== 1
        ? values
        : key === "offset" && /^(0|[1-9]\d*)$/u.test(value)
          ? Number(value)
          : value;
  }
  return request;
}

/** The grouped list's page offset: `offset` alone, as the route has always taken it. */
function statementsOffset(params: URLSearchParams): number {
  for (const [key, value] of params) {
    if (
      !["offset", "proposalId", "statementKey", "relatedTo"].includes(key) ||
      params.getAll(key).length !== 1 ||
      !value
    )
      throw new HttpError(400, "invalid_query");
  }
  const text = params.get("offset") ?? "0";
  const offset = Number(text);
  if (
    !/^(0|[1-9]\d*)$/u.test(text) ||
    !Number.isSafeInteger(offset) ||
    offset > CARD_SETTLEMENTS_MAX_OFFSET
  )
    throw new HttpError(400, "invalid_offset");
  if (params.has("proposalId") || params.has("statementKey") || params.has("relatedTo"))
    throw new HttpError(400, "invalid_query");
  return offset;
}

/** Operator-only; agents read the same answers through `kogane.card-settlements.*`. */
export async function cardSettlementsApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  const ownership = url.pathname === CARD_OWNERSHIP_PATH;
  const grouped = url.pathname === CARD_SETTLEMENT_STATEMENTS_PATH;
  if (url.pathname !== CARD_SETTLEMENT_PATH && !ownership && !grouped) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardSettlementsAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  const sql = d1Executor(env.DB);
  if (grouped)
    return json({
      apiVersion: 2,
      ...(await queryCardSettlementStatements(sql, { offset: statementsOffset(url.searchParams) })),
    });
  const input = { grant: readerGrant(subject), sql, request: serviceRequest(url.searchParams) };
  const outcome = ownership
    ? await readCardOwnershipForGrant(input)
    : await readCardSettlementsForGrant(input);
  if (outcome.status === "refused") return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  if (outcome.status === "not_found") throw new HttpError(404, "not_found");
  return json({ apiVersion: 2, ...outcome.answer });
}
