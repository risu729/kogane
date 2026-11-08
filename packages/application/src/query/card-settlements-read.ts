// Grant boundary for the `カード照合` pages' reads (ADR 0081): the review list,
// one statement's candidates, one review or the candidates it competes with,
// and the ownership review of one candidate. The services are the pages' own
// (`queryCardSettlements`, `queryRelatedCardSettlements`,
// `queryCardOwnership`); this file
// adds no SQL and no writer. A review joins a card statement to a bank debit of
// another source and account, and its ownership side reads both accounts'
// claims, so only a whole-store grant may read it.
import type { CardOwnershipReview } from "../../../domain/src/card-ownership-review.ts";
import type { CardSettlementReviewPage } from "../../../domain/src/card-settlement-review.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";
import { queryCardOwnership } from "./card-ownership.ts";
import {
  CARD_SETTLEMENT_PAGE_SIZE,
  queryCardSettlements,
  queryRelatedCardSettlements,
} from "./card-settlements.ts";

/** The route's proposal id pattern (`services/app/src/card-settlements-api.ts`). */
export const CARD_SETTLEMENT_PROPOSAL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const CARD_SETTLEMENTS_MAX_OFFSET = 1_000_000;
/** The route's statement key bound (`statementKey` above 1024 characters is refused). */
export const CARD_SETTLEMENT_STATEMENT_KEY_MAX = 1024;

export type CardSettlementsReadOperation = "card-settlements.read" | "card-settlements.ownership";
export type CardSettlementsReadOutcome<T> =
  | { status: "ok"; answer: T }
  | { status: "not_found" }
  | { status: "refused"; error: FinancialError };

function refusal(
  grant: Grant,
  operation: CardSettlementsReadOperation,
): { status: "refused"; error: FinancialError } | null {
  const fail = (code: FinancialErrorCode, refs: string[]) => ({
    status: "refused" as const,
    error: financialError(code, operation, refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  return narrowed.length ? fail("evidence_restricted", narrowed) : null;
}

/**
 * One page of reviews (`offset`), of one statement's candidates
 * (`statementKey`), of the candidates a review competes with (`relatedTo`), or
 * one review (`proposalId`), as the pages read them. `proposalId` takes no
 * other key; `statementKey` and `relatedTo` each take `offset` only. The
 * grant's `maxRows` bounds how deep a caller pages: `offset + 50` (one for a
 * `proposalId` read) above it is `budget_exceeded`, before any read. A
 * `proposalId` or `relatedTo` that names no candidate is `not_found`.
 */
export async function readCardSettlementsForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<CardSettlementsReadOutcome<CardSettlementReviewPage>> {
  const refused = refusal(input.grant, "card-settlements.read");
  if (refused) return refused;
  const request = input.request ?? {};
  const invalid = {
    status: "refused" as const,
    error: financialError("invalid_query", "card-settlements.read", ["request"]),
  };
  if (
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => !["offset", "proposalId", "statementKey", "relatedTo"].includes(key),
    )
  )
    return invalid;
  const { offset, proposalId, statementKey, relatedTo } = request as {
    offset?: unknown;
    proposalId?: unknown;
    statementKey?: unknown;
    relatedTo?: unknown;
  };
  if (
    (offset !== undefined && typeof offset !== "number") ||
    (proposalId !== undefined && typeof proposalId !== "string") ||
    (statementKey !== undefined && typeof statementKey !== "string") ||
    (relatedTo !== undefined && typeof relatedTo !== "string")
  )
    return invalid;
  const filters = [proposalId, statementKey, relatedTo].filter((value) => value !== undefined);
  if (
    filters.length > 1 ||
    (offset !== undefined &&
      (!Number.isSafeInteger(offset) || offset < 0 || offset > CARD_SETTLEMENTS_MAX_OFFSET)) ||
    (proposalId !== undefined &&
      (!CARD_SETTLEMENT_PROPOSAL_ID.test(proposalId) || offset !== undefined)) ||
    (statementKey !== undefined &&
      (statementKey.length === 0 || statementKey.length > CARD_SETTLEMENT_STATEMENT_KEY_MAX)) ||
    (relatedTo !== undefined && !CARD_SETTLEMENT_PROPOSAL_ID.test(relatedTo))
  )
    return invalid;
  const reach = proposalId === undefined ? (offset ?? 0) + CARD_SETTLEMENT_PAGE_SIZE : 1;
  if (reach > input.grant.budget.maxRows)
    return {
      status: "refused",
      error: financialError("budget_exceeded", "card-settlements.read", [
        `budget:maxRows=${String(input.grant.budget.maxRows)}`,
      ]),
    };
  if (relatedTo !== undefined) {
    const related = await queryRelatedCardSettlements(input.sql, relatedTo, {
      offset: offset ?? 0,
    });
    return related ? { status: "ok", answer: related } : { status: "not_found" };
  }
  const page = await queryCardSettlements(input.sql, {
    offset: offset ?? 0,
    ...(proposalId === undefined ? {} : { proposalId }),
    ...(statementKey === undefined ? {} : { statementKey }),
  });
  if (proposalId !== undefined && page.items.length === 0) return { status: "not_found" };
  return { status: "ok", answer: page };
}

/** The ownership review of one candidate, as `口座の保有者と根拠を確認` reads it. */
export async function readCardOwnershipForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<CardSettlementsReadOutcome<CardOwnershipReview>> {
  const refused = refusal(input.grant, "card-settlements.ownership");
  if (refused) return refused;
  const request = input.request;
  const proposalId =
    typeof request === "object" &&
    request !== null &&
    !Array.isArray(request) &&
    Object.keys(request).length === 1 &&
    typeof (request as { proposalId?: unknown }).proposalId === "string"
      ? (request as { proposalId: string }).proposalId
      : null;
  if (proposalId === null || !CARD_SETTLEMENT_PROPOSAL_ID.test(proposalId))
    return {
      status: "refused",
      error: financialError("invalid_query", "card-settlements.ownership", ["proposalId"]),
    };
  const review = await queryCardOwnership(input.sql, proposalId);
  return review ? { status: "ok", answer: review } : { status: "not_found" };
}
