// `next` and `paging` (ADR 0128 slice S7) of a `kogane.financial.query`
// answer. Only the row intents page (`activity`, `reported-state`: a page of
// at most `limit` rows and a cursor bound to the context's paging basis and
// the query digest); `coverage` and `holdings` answer whole, with a null
// `nextCursor`, and carry neither field.
//
// Both fields sit at the top level of the answer the route and the tool
// serve (`kogane-query-response-v1`), beside `result`, never inside it:
// `financial-result-v1` is a versioned shape with exact keys, and whether it
// (with `financial-error-v1`) changes in place or moves to a v2 is the
// owner's open decision (ADR 0128, "S7: open decision"). They say exactly
// what `result.nextCursor` says, so nothing here decides anything new: the
// cursor is the same token, and a page that has one is full.
import { PAGED_QUERY_INTENTS, type FinancialResult } from "../../../domain/src/result.ts";
import { pagedFields, type PagedFields } from "../../../observation-shared/src/paging-contract.ts";

/**
 * The `next` and `paging` of one answer, or null for an intent that does not
 * page. `limit` is the resolved page size and `returned` the rows listed; a
 * page with a `nextCursor` continues by that cursor, and one without is the
 * last. Throws when a row page's resolved limit is missing, which the context
 * never builds.
 */
export function financialQueryPaging(result: FinancialResult<unknown>): PagedFields | null {
  const intent = result.resolvedQuery.intent;
  if (!(PAGED_QUERY_INTENTS as readonly string[]).includes(intent)) return null;
  const data = result.data as { rows?: unknown };
  if (!Array.isArray(data.rows)) throw new RangeError("a row intent answers rows");
  return pagedFields({
    limit: result.resolvedQuery.limit,
    returned: data.rows.length,
    next: result.nextCursor === null ? null : { cursor: result.nextCursor },
  });
}
