// `kogane.purchases.explain`: the card purchase explanation of the operator's
// `カード利用` page, for an agent. It is not a second read: it calls the same
// `queryCardPurchases` the page's route calls, so the figures, the coverage,
// the purchase → statement → settlement → bank debit chain, the candidates and
// the `explanationRefs` are the page's own. Four things differ, and they are
// all decided here rather than in an adapter:
//
// - The grant decides, not the operator role. `records.read` is required: the
//   page is structured records (with figures computed over them), which is
//   what that capability grants. No grant here carries `interpretation.accept`,
//   so no caller of this service is ever the operator.
// - The whole store or nothing. The page is not yet computable inside a
//   narrower perimeter: its events and statements are keyed by resolved
//   account, its settlement cites a bank debit of another source, and its
//   unrecognised-row count spans every card source. A grant listed on either
//   axis is therefore refused before anything is read, never answered with a
//   page computed outside it and never with a filtered subset that would
//   still count what it hides (SC18).
// - No review affordance. A candidate's `actions` (what an operator may do
//   now) and `relation` (the exact payload a review plans) are removed; every
//   fact of the candidate stays. Merging, rejecting or withdrawing a link, like
//   accepting a settlement, stays with the operator on the purchases page.
// - The agent API's bounds and codes. The grant's `maxRows` bounds how deep a
//   caller pages; the page's own bound on the events one answer may total is
//   `budget_exceeded` (the route's `413 result_limit_exceeded`); an event id
//   that names nothing gets the answer an out-of-scope ref gets.
//
// It reads, and nothing else: no path here writes a row, and a refusal reads
// nothing at all.
import type {
  AgentCardPurchaseCandidate,
  AgentCardPurchasePage,
  AgentCardPurchaseView,
  CardPurchaseCandidate,
  CardPurchasePage,
} from "../../../domain/src/card-purchase-view.ts";
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";
import {
  CARD_PURCHASE_EVENT_ID,
  CARD_PURCHASE_PAGE_SIZE,
  CARD_PURCHASE_PERIOD,
  CARD_PURCHASE_SUMMARY_LIMIT,
  CardPurchaseLimitError,
  type CardPurchaseQuery,
  queryCardPurchases,
} from "./card-purchases.ts";

/** The capability the explanation needs. */
export const PURCHASES_EXPLAIN_CAPABILITY: AgentCapability = "records.read";
/** Every key a request may carry; any other key is refused, never ignored. */
export const PURCHASES_EXPLAIN_KEYS = ["period", "eventId", "offset"] as const;
/** The largest offset a request may ask for, as on the operator route. */
export const PURCHASES_EXPLAIN_MAX_OFFSET = 1_000_000;
/** Errors of this service carry this request id: no context is opened for it. */
const REQUEST_ID = "purchases.explain";

export interface PurchasesExplanation {
  schemaVersion: "kogane-card-purchases-v1";
  /** The request as the server resolved it. */
  query: { period: string | null; eventId: string | null; offset: number };
  /**
   * Every decision about these purchases and candidates — a link merged,
   * rejected or withdrawn, a settlement accepted — is the operator's, on the
   * purchases page. Stated, not implied: nothing in `data` offers one.
   */
  decisions: "operator-only";
  /** The page. Provider-derived text (a counterparty) appears nowhere else. */
  data: AgentCardPurchasePage;
}

export type PurchasesExplainOutcome =
  | { ok: true; explanation: PurchasesExplanation }
  | { ok: false; error: FinancialError };

type Rejection = { ok: false; code: FinancialErrorCode; refs: string[] };

/**
 * Validate an untrusted body: at most `period`, `eventId` and `offset`. An
 * unknown key is `unsupported_semantics`; a malformed value, or an event id
 * beside a period or an offset (one event is an exact read), is
 * `invalid_query`. An absent body is the first page of every period.
 */
export function parsePurchasesExplainRequest(
  value: unknown,
): { ok: true; value: CardPurchaseQuery } | Rejection {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, code: "invalid_query", refs: [] };
  const unknown = Object.keys(value).filter(
    (key) => !(PURCHASES_EXPLAIN_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    return {
      ok: false,
      code: "unsupported_semantics",
      refs: unknown.slice(0, 10).map((key) => key.slice(0, 64)),
    };
  const request: CardPurchaseQuery = {};
  const { period, eventId, offset } = value;
  if (period !== undefined) {
    if (typeof period !== "string" || !CARD_PURCHASE_PERIOD.test(period))
      return { ok: false, code: "invalid_query", refs: ["period"] };
    request.period = period;
  }
  if (eventId !== undefined) {
    if (typeof eventId !== "string" || !CARD_PURCHASE_EVENT_ID.test(eventId))
      return { ok: false, code: "invalid_query", refs: ["eventId"] };
    request.eventId = eventId;
  }
  if (offset !== undefined) {
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > PURCHASES_EXPLAIN_MAX_OFFSET
    )
      return { ok: false, code: "invalid_query", refs: ["offset"] };
    request.offset = offset;
  }
  if (request.eventId !== undefined && (period !== undefined || offset !== undefined))
    return {
      ok: false,
      code: "invalid_query",
      refs: [
        "eventId",
        ...(period === undefined ? [] : ["period"]),
        ...(offset === undefined ? [] : ["offset"]),
      ],
    };
  return { ok: true, value: request };
}

/** The candidate without what only an operator may use; every fact stays. */
function candidateFacts(candidate: CardPurchaseCandidate): AgentCardPurchaseCandidate {
  const { actions: _actions, relation: _relation, ...facts } = candidate;
  return facts;
}

/** The operator's page with each candidate's review affordances removed and nothing else changed. */
export function withoutReviewAffordances(page: CardPurchasePage): AgentCardPurchasePage {
  return {
    ...page,
    items: page.items.map((item): AgentCardPurchaseView => ({
      ...item,
      candidates: item.candidates.map(candidateFacts),
    })),
  };
}

/**
 * The explanation an agent gets for one validated request, or the typed
 * refusal. Every refusal is decided before the store is read, except the
 * two that only the read can know: a filter past the summary bound and an
 * event id that names no live event.
 */
export async function explainCardPurchases(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: CardPurchaseQuery;
}): Promise<PurchasesExplainOutcome> {
  const { grant, sql, request } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): PurchasesExplainOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, PURCHASES_EXPLAIN_CAPABILITY))
    return fail("unauthorized", [`capability:${PURCHASES_EXPLAIN_CAPABILITY}`]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  const offset = request.offset ?? 0;
  // Items this answer reaches: one for an exact read, else the page past the offset.
  const reach = request.eventId === undefined ? offset + CARD_PURCHASE_PAGE_SIZE : 1;
  if (reach > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

  let page: CardPurchasePage;
  try {
    page = await queryCardPurchases(sql, request);
  } catch (error) {
    // The figures cover the whole filter, so a larger one is refused, never
    // partially summed; a statement period narrows it.
    if (error instanceof CardPurchaseLimitError)
      return fail("budget_exceeded", [
        `budget:cardPurchaseEvents=${String(CARD_PURCHASE_SUMMARY_LIMIT)}`,
      ]);
    throw error;
  }
  // An event id that names nothing is refused like a ref outside the grant.
  if (request.eventId !== undefined && page.items.length === 0)
    return fail("evidence_restricted", ["eventId"]);
  return {
    ok: true,
    explanation: {
      schemaVersion: "kogane-card-purchases-v1",
      query: {
        period: request.period ?? null,
        eventId: request.eventId ?? null,
        offset,
      },
      decisions: "operator-only",
      data: withoutReviewAffordances(page),
    },
  };
}
