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
//   caller pages, and a next page past it is not offered (`nextPage` says
//   `budget_exceeded` instead); the page's own bound on the events one answer
//   may total is `budget_exceeded` (the route's `413 result_limit_exceeded`); an event id
//   that names nothing gets the answer an out-of-scope ref gets.
//
// `view: cards` (ADR 0125) is the route's per-card answer
// (`queryCardPurchaseCards`, `GET /api/v2/card-purchases?view=cards`) under
// the same grant rules: the whole-filter figures grouped by card for one
// statement period or one usage month, with no per-event explanation, so a
// single compact answer says how much each card was used.
//
// `view: lines` (ADR 0125 amendment) is the route's line answer
// (`queryCardPurchaseLines`, `GET /api/v2/card-purchases?view=lines`) under
// the same grant rules: one month's events, optionally of one account, as
// compact lines sorted by date or by amount, a keyset page at a time.
//
// It reads, and nothing else: no path here writes a row, and a refusal reads
// nothing at all.
import {
  CARD_PURCHASE_CARDS_MAX,
  CARD_PURCHASE_LINE_SORTS,
  CARD_PURCHASE_LINES_MAX,
  type AgentCardPurchaseCandidate,
  type AgentCardPurchasePage,
  type AgentCardPurchaseView,
  type CardPurchaseCandidate,
  type CardPurchaseCardsPage,
  type CardPurchaseLineSort,
  type CardPurchaseLinesPage,
  type CardPurchasePage,
} from "../../../domain/src/card-purchase-view.ts";
import { CARD_SETTLEMENT_NEXT_PAGE } from "../../../domain/src/card-settlement-review.ts";
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";
import {
  CARD_PURCHASE_ACCOUNT,
  CARD_PURCHASE_EVENT_ID,
  CARD_PURCHASE_LINES_CURSOR_MAX,
  CARD_PURCHASE_PAGE_SIZE,
  CARD_PURCHASE_PERIOD,
  CARD_PURCHASE_SUMMARY_LIMIT,
  CardPurchaseLimitError,
  type CardPurchaseCardsQuery,
  type CardPurchaseLinesQuery,
  type CardPurchaseQuery,
  decodeLinesCursor,
  linesCursorFits,
  queryCardPurchaseCards,
  queryCardPurchases,
  readCardPurchaseLines,
} from "./card-purchases.ts";
import { pageBeyondBudget } from "./page-budget.ts";

/** The capability the explanation needs. */
export const PURCHASES_EXPLAIN_CAPABILITY: AgentCapability = "records.read";
/** Every key a request may carry; any other key is refused, never ignored. */
export const PURCHASES_EXPLAIN_KEYS = [
  "view",
  "period",
  "usageMonth",
  "eventId",
  "offset",
  "account",
  "sort",
  "cursor",
] as const;
/**
 * `events` (the default): the page of explained events. `cards`: the same
 * whole-filter figures grouped by card, without the per-event explanation
 * (ADR 0125). `lines`: one month's events as compact lines, optionally of one
 * account, sorted by date or amount (ADR 0125 amendment).
 */
export const PURCHASES_EXPLAIN_VIEWS = ["events", "cards", "lines"] as const;
/** The per-card view's request: exactly one of a statement period and a usage month. */
type PurchasesCardsRequest = { view: "cards" } & CardPurchaseCardsQuery;
/** The line view's request: one month, optionally one account, a sort and a cursor. */
type PurchasesLinesRequest = { view: "lines" } & CardPurchaseLinesQuery;
/** A validated request: the page's own query, or the per-card or line view's. */
export type PurchasesExplainRequest =
  | CardPurchaseQuery
  | PurchasesCardsRequest
  | PurchasesLinesRequest;
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
  /**
   * Why `data.nextOffset` is what it is, in a closed code: `offered` (it
   * names the next page), `none` (no event follows this page, or the read is
   * one exact event), or `budget_exceeded` (events follow, and
   * `data.summary.events` counts them, but the next page would reach past the
   * grant's `maxRows`, so its request would be refused with that code and
   * `data.nextOffset` is null rather than a page this caller cannot fetch).
   */
  nextPage: PurchasesNextPage;
  /** The page. Provider-derived text (a counterparty) appears nowhere else. */
  data: AgentCardPurchasePage;
}

/**
 * The closed codes of `PurchasesExplanation.nextPage`: the card settlement
 * reads' list, decided by the same budget rule (ADR 0081, 2026-11-08 amendment).
 */
export const PURCHASES_NEXT_PAGE = CARD_SETTLEMENT_NEXT_PAGE;
export type PurchasesNextPage = (typeof PURCHASES_NEXT_PAGE)[number];

/**
 * The per-card view (ADR 0125): the operator page's per-card answer
 * (`queryCardPurchaseCards`, the route's `?view=cards`) as `data`, unchanged.
 * It is one bounded answer, never paged: at most `CARD_PURCHASE_CARDS_MAX`
 * cards, and `data.cardsTruncated` says when more exist.
 */
export interface PurchasesCardsAnswer {
  schemaVersion: "kogane-card-purchases-cards-v1";
  query: { view: "cards"; period: string | null; usageMonth: string | null };
  decisions: "operator-only";
  data: CardPurchaseCardsPage;
}

/**
 * The line view (ADR 0125 amendment): the route's line answer
 * (`queryCardPurchaseLines`, `?view=lines`) as `data`, except that a next
 * page this grant would be refused is withheld (`data.nextCursor` null) and
 * said (`nextPage: "budget_exceeded"`), as on the page of events.
 */
export interface PurchasesLinesAnswer {
  schemaVersion: "kogane-card-purchases-lines-v1";
  /** The request as the server resolved it; the cursor is not repeated. */
  query: {
    view: "lines";
    account: string | null;
    period: string | null;
    usageMonth: string | null;
    sort: CardPurchaseLineSort;
  };
  decisions: "operator-only";
  /** `offered`, `none` or `budget_exceeded`, as on the page of events. */
  nextPage: PurchasesNextPage;
  data: CardPurchaseLinesPage;
}

export type PurchasesExplainOutcome<
  Answer extends PurchasesExplanation | PurchasesCardsAnswer | PurchasesLinesAnswer =
    PurchasesExplanation,
> = { ok: true; explanation: Answer } | { ok: false; error: FinancialError };

/** The refusal of a grant that may not read the purchases, decided before anything is read. */
function grantRefusal(grant: Grant): FinancialError | null {
  if (!grantAllows(grant, PURCHASES_EXPLAIN_CAPABILITY))
    return financialError("unauthorized", REQUEST_ID, [
      `capability:${PURCHASES_EXPLAIN_CAPABILITY}`,
    ]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  return narrowed.length > 0 ? financialError("evidence_restricted", REQUEST_ID, narrowed) : null;
}

type Rejection = { ok: false; code: FinancialErrorCode; refs: string[] };

/**
 * Validate an untrusted body: at most `view`, `period`, `usageMonth`,
 * `eventId`, `offset`, `account`, `sort` and `cursor`. An unknown key is
 * `unsupported_semantics`; a malformed value, an event id beside a period or
 * an offset (one event is an exact read), a usage month outside the per-card
 * and line views, an event id or an offset inside them, not exactly one of
 * period and usage month inside them, an account, sort or cursor outside the
 * line view, or a cursor another request issued is `invalid_query`. An absent
 * body is the first page of every period; `view: "events"` is the same
 * request as no view.
 */
export function parsePurchasesExplainRequest(
  value: unknown,
): { ok: true; value: PurchasesExplainRequest } | Rejection {
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
  const { view, period, usageMonth, eventId, offset, account, sort, cursor } = value;
  if (
    view !== undefined &&
    (typeof view !== "string" || !(PURCHASES_EXPLAIN_VIEWS as readonly string[]).includes(view))
  )
    return { ok: false, code: "invalid_query", refs: ["view"] };
  if (period !== undefined && (typeof period !== "string" || !CARD_PURCHASE_PERIOD.test(period)))
    return { ok: false, code: "invalid_query", refs: ["period"] };
  if (
    usageMonth !== undefined &&
    (typeof usageMonth !== "string" || !CARD_PURCHASE_PERIOD.test(usageMonth))
  )
    return { ok: false, code: "invalid_query", refs: ["usageMonth"] };
  if (
    account !== undefined &&
    (typeof account !== "string" || !CARD_PURCHASE_ACCOUNT.test(account))
  )
    return { ok: false, code: "invalid_query", refs: ["account"] };
  if (
    sort !== undefined &&
    (typeof sort !== "string" || !(CARD_PURCHASE_LINE_SORTS as readonly string[]).includes(sort))
  )
    return { ok: false, code: "invalid_query", refs: ["sort"] };
  const resumed =
    typeof cursor === "string" && cursor.length <= CARD_PURCHASE_LINES_CURSOR_MAX
      ? decodeLinesCursor(cursor)
      : null;
  if (cursor !== undefined && resumed === null)
    return { ok: false, code: "invalid_query", refs: ["cursor"] };
  if (view !== "lines") {
    // The line view's own keys are refused beside any other view.
    const lineKeys = [
      ...(account === undefined ? [] : ["account"]),
      ...(sort === undefined ? [] : ["sort"]),
      ...(cursor === undefined ? [] : ["cursor"]),
    ];
    if (lineKeys.length > 0) return { ok: false, code: "invalid_query", refs: lineKeys };
  }
  if (view === "lines") {
    // One month, optionally one account; keyset paging by `cursor`, never an
    // offset, and no single event.
    const wrong = [
      ...((period === undefined) === (usageMonth === undefined) ? ["period", "usageMonth"] : []),
      ...(eventId === undefined ? [] : ["eventId"]),
      ...(offset === undefined ? [] : ["offset"]),
    ];
    if (wrong.length > 0) return { ok: false, code: "invalid_query", refs: wrong };
    const request: PurchasesLinesRequest = {
      view: "lines",
      ...(period === undefined ? {} : { period: period as string }),
      ...(usageMonth === undefined ? {} : { usageMonth: usageMonth as string }),
      ...(account === undefined ? {} : { account: account as string }),
      ...(sort === undefined ? {} : { sort: sort as CardPurchaseLineSort }),
      ...(cursor === undefined ? {} : { cursor: cursor as string }),
    };
    // A cursor continues only the request that issued it.
    if (request.cursor !== undefined && !linesCursorFits(request.cursor, request))
      return { ok: false, code: "invalid_query", refs: ["cursor"] };
    return { ok: true, value: request };
  }
  if (view === "cards") {
    // One bounded answer over exactly one month, a statement period or a
    // usage month: no event id and no paging.
    const wrong = [
      ...((period === undefined) === (usageMonth === undefined) ? ["period", "usageMonth"] : []),
      ...(eventId === undefined ? [] : ["eventId"]),
      ...(offset === undefined ? [] : ["offset"]),
    ];
    if (wrong.length > 0) return { ok: false, code: "invalid_query", refs: wrong };
    return {
      ok: true,
      value: {
        view: "cards",
        ...(period === undefined ? {} : { period: period as string }),
        ...(usageMonth === undefined ? {} : { usageMonth: usageMonth as string }),
      },
    };
  }
  if (usageMonth !== undefined) return { ok: false, code: "invalid_query", refs: ["usageMonth"] };
  const request: CardPurchaseQuery = {};
  if (period !== undefined) request.period = period as string;
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
 * The per-card view an agent gets (ADR 0125), or the typed refusal. The
 * capability and the whole-store perimeter are the page's; it lists up to
 * `CARD_PURCHASE_CARDS_MAX` cards, so a grant whose `maxRows` is below that
 * is refused before anything is read, as the debit-account read refuses it.
 * A filter past the summary bound is refused, never partially summed.
 */
export async function explainCardPurchaseCards(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: CardPurchaseCardsQuery;
}): Promise<PurchasesExplainOutcome<PurchasesCardsAnswer>> {
  const { grant, sql, request } = input;
  const refused = grantRefusal(grant);
  if (refused !== null) return { ok: false, error: refused };
  if (pageBeyondBudget(0, CARD_PURCHASE_CARDS_MAX, grant))
    return {
      ok: false,
      error: financialError("budget_exceeded", REQUEST_ID, [
        `budget:maxRows=${String(grant.budget.maxRows)}`,
      ]),
    };
  let data: CardPurchaseCardsPage;
  try {
    data = await queryCardPurchaseCards(sql, request);
  } catch (error) {
    if (error instanceof CardPurchaseLimitError)
      return {
        ok: false,
        error: financialError("budget_exceeded", REQUEST_ID, [
          `budget:cardPurchaseEvents=${String(CARD_PURCHASE_SUMMARY_LIMIT)}`,
        ]),
      };
    throw error;
  }
  return {
    ok: true,
    explanation: {
      schemaVersion: "kogane-card-purchases-cards-v1",
      query: {
        view: "cards",
        period: request.period ?? null,
        usageMonth: request.usageMonth ?? null,
      },
      decisions: "operator-only",
      data,
    },
  };
}

/** The line request as the server resolves it: absent filters are null, the sort defaults to date. */
function linesQuery(request: CardPurchaseLinesQuery): Pick<PurchasesLinesAnswer, "query"> {
  return {
    query: {
      view: "lines",
      account: request.account ?? null,
      period: request.period ?? null,
      usageMonth: request.usageMonth ?? null,
      sort: request.sort ?? "date",
    },
  };
}

/**
 * The line view an agent gets (ADR 0125 amendment), or the typed refusal.
 * The capability and the whole-store perimeter are the page's. The grant's
 * `maxRows` bounds how many lines a caller pages through, as it bounds the
 * page of events: a page that would reach past it (counting the lines the
 * cursor says were listed before) is refused before anything is read, and a
 * next page past it is withheld and said. A filter past the summary bound is
 * refused, never partly read.
 */
export async function explainCardPurchaseLines(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: CardPurchaseLinesQuery;
}): Promise<PurchasesExplainOutcome<PurchasesLinesAnswer>> {
  const { grant, sql, request } = input;
  const budgetRefusal = (): PurchasesExplainOutcome<PurchasesLinesAnswer> => ({
    ok: false,
    error: financialError("budget_exceeded", REQUEST_ID, [
      `budget:maxRows=${String(grant.budget.maxRows)}`,
    ]),
  });
  const refused = grantRefusal(grant);
  if (refused !== null) return { ok: false, error: refused };
  const claimed =
    request.cursor === undefined ? 0 : (decodeLinesCursor(request.cursor)?.listed ?? 0);
  if (pageBeyondBudget(claimed, CARD_PURCHASE_LINES_MAX, grant)) return budgetRefusal();
  let data: CardPurchaseLinesPage;
  let before: number;
  try {
    ({ page: data, before } = await readCardPurchaseLines(sql, request));
  } catch (error) {
    if (error instanceof CardPurchaseLimitError)
      return {
        ok: false,
        error: financialError("budget_exceeded", REQUEST_ID, [
          `budget:cardPurchaseEvents=${String(CARD_PURCHASE_SUMMARY_LIMIT)}`,
        ]),
      };
    throw error;
  }
  // The cursor's count is not signed: the depth its key really has in the
  // month counts too, so a rewritten count reads no deeper than maxRows.
  if (before > claimed && pageBeyondBudget(before, CARD_PURCHASE_LINES_MAX, grant))
    return budgetRefusal();
  const nextPage: PurchasesNextPage =
    data.nextCursor === null
      ? "none"
      : pageBeyondBudget(before + data.lines.length, CARD_PURCHASE_LINES_MAX, grant)
        ? "budget_exceeded"
        : "offered";
  return {
    ok: true,
    explanation: {
      schemaVersion: "kogane-card-purchases-lines-v1",
      ...linesQuery(request),
      decisions: "operator-only",
      nextPage,
      data: nextPage === "budget_exceeded" ? { ...data, nextCursor: null } : data,
    },
  };
}

/**
 * `kogane.purchases.explain` for one validated request: the per-card view
 * for `view: cards`, the line view for `view: lines`, else the page of
 * explained events.
 */
export function answerPurchasesExplain(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: PurchasesExplainRequest;
}): Promise<
  PurchasesExplainOutcome<PurchasesExplanation | PurchasesCardsAnswer | PurchasesLinesAnswer>
> {
  const { grant, sql, request } = input;
  if (!("view" in request)) return explainCardPurchases({ grant, sql, request });
  return request.view === "lines"
    ? explainCardPurchaseLines({ grant, sql, request })
    : explainCardPurchaseCards({ grant, sql, request });
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
  const refused = grantRefusal(grant);
  if (refused !== null) return { ok: false, error: refused };
  const offset = request.offset ?? 0;
  // Items this answer reaches: one for an exact read, else the page past the
  // offset. The same rule withholds the next page below.
  const beyond =
    request.eventId === undefined
      ? pageBeyondBudget(offset, CARD_PURCHASE_PAGE_SIZE, grant)
      : pageBeyondBudget(0, 1, grant);
  if (beyond) return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

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
  // The next page only while there is one and this grant may read it: an
  // offset the same caller would be refused is not offered, and the answer
  // says why there is none, as the candidate reviews of this package do.
  const nextPage: PurchasesNextPage =
    page.nextOffset === null
      ? "none"
      : pageBeyondBudget(page.nextOffset, CARD_PURCHASE_PAGE_SIZE, grant)
        ? "budget_exceeded"
        : "offered";
  const agentPage = withoutReviewAffordances(page);
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
      nextPage,
      data: nextPage === "budget_exceeded" ? { ...agentPage, nextOffset: null } : agentPage,
    },
  };
}
