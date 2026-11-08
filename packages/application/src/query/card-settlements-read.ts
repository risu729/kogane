// The `カード照合` pages' reads (ADR 0081 point 2): the review list, one
// statement's candidates, one review or the candidates it competes with, the
// list grouped by statement, and the ownership review of one candidate. Both
// the page route (`GET /api/v2/reconciliation/card-settlements` and its
// `/statements` and `/ownership` reads, under the browser's reader grant) and
// the MCP and agent HTTP tools (`kogane.card-settlements.read`,
// `kogane.card-settlements.statements`, `kogane.card-settlements.ownership`,
// under the caller's grant) are adapters over these three functions: the
// request rules, the refusal codes and the row budget are decided here, once.
// The queries are the pages' own (`queryCardSettlements`,
// `queryRelatedCardSettlements`, `queryCardSettlementStatements`,
// `queryCardOwnership`); this file adds no SQL and no writer. A review joins a
// card statement to a bank debit of another source and account, and its
// ownership side reads both accounts' claims, so only a whole-store grant may
// read it.
import type { CardOwnershipReview } from "../../../domain/src/card-ownership-review.ts";
import type {
  CardSettlementReviewPage,
  CardSettlementStatementPage,
} from "../../../domain/src/card-settlement-review.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { grantAllows, type Grant } from "../grants.ts";
import { queryCardOwnership } from "./card-ownership.ts";
import {
  CARD_SETTLEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
  queryCardSettlementStatements,
  queryCardSettlements,
  queryRelatedCardSettlements,
} from "./card-settlements.ts";

/** A proposal id, as the pages and the tools name a candidate. */
export const CARD_SETTLEMENT_PROPOSAL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const CARD_SETTLEMENTS_MAX_OFFSET = 1_000_000;
/** The statement key bound (`statementKey` above 1024 characters is refused). */
export const CARD_SETTLEMENT_STATEMENT_KEY_MAX = 1024;

export type CardSettlementsReadOperation =
  | "card-settlements.read"
  | "card-settlements.statements"
  | "card-settlements.ownership";
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
 * other key; `statementKey` and `relatedTo` each take `offset` only. Every
 * malformed request, an `offset` that is not an integer from 0 to
 * `CARD_SETTLEMENTS_MAX_OFFSET` included, is `invalid_query`. The grant's
 * `maxRows` bounds how deep a caller pages: `offset + 50` (one for a
 * `proposalId` read) above it is `budget_exceeded`, before any read. The page
 * route's reader grant and every MCP client's grant hold the same
 * `maxRows` (`GRANT_LIMITS.maxRows`), so both refuse alike. A `proposalId` or
 * `relatedTo` that names no candidate is `not_found`.
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

/**
 * One page of the review list grouped by statement (`offset`, counted in
 * statements), as the `カード照合` page reads it: `offset` is the only key.
 * Every malformed request, an `offset` that is not an integer from 0 to
 * `CARD_SETTLEMENTS_MAX_OFFSET` included, is `invalid_query`. The grant's
 * `maxRows` bounds how deep a caller pages: `offset + 10` (the statements a
 * page holds) above it is `budget_exceeded`, before any read. A page past the
 * last statement is an empty page, never `not_found`.
 */
export async function readCardSettlementStatementsForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<CardSettlementsReadOutcome<CardSettlementStatementPage>> {
  const refused = refusal(input.grant, "card-settlements.statements");
  if (refused) return refused;
  const request = input.request ?? {};
  const given =
    typeof request === "object" &&
    !Array.isArray(request) &&
    Object.keys(request).every((key) => key === "offset")
      ? (request as { offset?: unknown }).offset
      : null;
  const offset = given === undefined ? 0 : given;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > CARD_SETTLEMENTS_MAX_OFFSET
  )
    return {
      status: "refused",
      error: financialError("invalid_query", "card-settlements.statements", ["request"]),
    };
  if (offset + CARD_SETTLEMENT_STATEMENT_PAGE_SIZE > input.grant.budget.maxRows)
    return {
      status: "refused",
      error: financialError("budget_exceeded", "card-settlements.statements", [
        `budget:maxRows=${String(input.grant.budget.maxRows)}`,
      ]),
    };
  return { status: "ok", answer: await queryCardSettlementStatements(input.sql, { offset }) };
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
