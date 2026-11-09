// `GET /api/v2/reconciliation/card-settlements` and its `/statements` and
// `/ownership` reads: the `カード照合` pages' review list, the list grouped by
// statement, one statement's candidates, one review, the candidates a review
// competes with, and one candidate's ownership review. Operator-only. The
// answer is the application service's (`readCardSettlementsForGrant`,
// `readCardSettlementStatementsForGrant`, `readCardOwnershipForGrant`), the one
// an agent gets from `kogane.card-settlements.read`,
// `kogane.card-settlements.statements` and `kogane.card-settlements.ownership`
// (ADR 0081 point 2): request rules, refusal codes and the grant's row budget
// are decided there, once for both transports. This file only turns the query
// string into that request, under the reader grant a signed-in browser holds
// over every GET route (`readerGrant`), and the service's outcome into a
// response.
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import {
  readCardOwnershipForGrant,
  readCardSettlementStatementsForGrant,
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
 * as it refuses `{"offset": "1"}` over MCP. Built from entries, never by
 * assignment: `request["__proto__"] = value` would set the prototype, and the
 * service's key check would never see the key.
 */
function serviceRequest(params: URLSearchParams): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      const value = values[0]!;
      return [
        key,
        values.length !== 1
          ? values
          : key === "offset" && /^(0|[1-9]\d*)$/u.test(value)
            ? Number(value)
            : value,
      ];
    }),
  );
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
  const input = {
    grant: readerGrant(subject),
    sql: d1Executor(env.DB),
    request: serviceRequest(url.searchParams),
  };
  const outcome = ownership
    ? await readCardOwnershipForGrant(input)
    : grouped
      ? await readCardSettlementStatementsForGrant(input)
      : await readCardSettlementsForGrant(input);
  if (outcome.status === "refused") return json(outcome.error, ERROR_STATUS[outcome.error.code]);
  if (outcome.status === "not_found") throw new HttpError(404, "not_found");
  return json({ apiVersion: 2, ...outcome.answer });
}
