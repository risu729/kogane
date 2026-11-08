// The grant's row budget on an offset-paged read: one rule decides both
// whether a request is refused (`budget_exceeded`) and whether an answer
// offers its next page, so an answer never names a page the same grant is
// refused. Used by the card settlement reads and the statements without a
// candidate (ADR 0081, 2026-11-08 amendment).
import type { CardSettlementNextPage } from "../../../domain/src/card-settlement-review.ts";
import type { Grant } from "../grants.ts";

/** Whether the page of `pageSize` rows starting at `offset` reaches past `maxRows`. */
export function pageBeyondBudget(offset: number, pageSize: number, grant: Grant): boolean {
  return offset + pageSize > grant.budget.maxRows;
}

/**
 * The page as `grant` may follow it: a next page the grant would be refused
 * is withheld (`nextOffset: null`) and said (`nextPage: "budget_exceeded"`),
 * never shown as the end of the list.
 */
export function withinBudget<
  T extends { nextOffset: number | null; nextPage: CardSettlementNextPage },
>(page: T, pageSize: number, grant: Grant): T {
  return page.nextOffset !== null && pageBeyondBudget(page.nextOffset, pageSize, grant)
    ? { ...page, nextOffset: null, nextPage: "budget_exceeded" }
    : page;
}
