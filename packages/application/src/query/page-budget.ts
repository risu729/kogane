// The grant's row budget on an offset-paged read: one rule decides both
// whether a request is refused (`budget_exceeded`) and whether an answer
// offers its next page, so an answer never names a page the same grant is
// refused. Used by the card settlement reads, the statements without a
// candidate (ADR 0081, 2026-11-08 amendment) and `kogane.purchases.explain`.
import type { CardSettlementNextPage } from "../../../domain/src/card-settlement-review.ts";
import type { Grant } from "../grants.ts";
import { pagedFields, type PagedFields } from "../../../observation-shared/src/paging-contract.ts";

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

/**
 * The `next` and `paging` (ADR 0128) of a page whose `nextPage` the budget
 * already decided: `offered` continues at `nextOffset`, `none` is the end,
 * `budget_exceeded` is a withheld page (`stoppedBy: "budget"`, no `next`).
 */
export function budgetPagedFields(
  page: { nextOffset: number | null; nextPage: CardSettlementNextPage },
  pageSize: number,
  returned: number,
): PagedFields {
  return pagedFields({
    limit: pageSize,
    returned,
    next:
      page.nextPage === "offered" && page.nextOffset !== null ? { offset: page.nextOffset } : null,
    withheld: page.nextPage === "budget_exceeded",
  });
}

/** `withinBudget`, with `next` and `paging` beside the deprecated `nextOffset` and `nextPage`. */
export function pagedWithinBudget<
  T extends { nextOffset: number | null; nextPage: CardSettlementNextPage },
>(page: T, pageSize: number, grant: Grant, returned: number): T & PagedFields {
  const budgeted = withinBudget(page, pageSize, grant);
  return { ...budgeted, ...budgetPagedFields(budgeted, pageSize, returned) };
}
