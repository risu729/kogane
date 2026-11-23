// One paging contract for every paged tool result and its route (ADR 0128).
//
// The MCP protocol pages only its list methods; a `tools/call` result has no
// protocol paging, so each read pages through its own arguments. This module
// is the one surface over all of them:
//
// - `next` says how to continue: `null`, or `{ arguments }`, exactly the
//   arguments to set on the same call (on a route, the same query
//   parameters). A client repeats its last call with these merged over it,
//   whatever position kind (keyset, offset, id) lies underneath.
// - `paging` says how this page ended: its `limit`, the items it `returned`,
//   whether more follow (`hasMore`) and what stopped it (`stoppedBy`).
//   It describes the page only, never whether the data behind it is complete
//   (INV05 reasons stay where each read puts them).
// - One refusal family for a continuation: `400 invalid_cursor`,
//   `400 cursor_mismatch` with `mustMatch`, `410 context_expired`, and
//   `413 result_limit_exceeded` with an optional `retryWith`.
//
// Nothing here carries a value of a row: a continuation names argument names
// and the server's own positions; a hint names argument names only.

/** The arguments a continuation may set; everything else repeats as it was. */
export const CONTINUATION_ARGUMENTS = ["cursor", "offset", "latestOffset"] as const;
export type ContinuationArgument = (typeof CONTINUATION_ARGUMENTS)[number];

/** Why a page ended before the end of its list. */
export const PAGING_STOPS = [
  // The page holds `limit` items.
  "limit",
  // The answer reached its byte bound before `limit`.
  "bytes",
  // Items follow, but this grant's row budget withholds the next page.
  "budget",
  // A scan bound ended the page before it was full (a filtered read walks at
  // most so many rows per call): `returned` is below `limit`, perhaps zero,
  // and the read continues where the walk stopped, so `hasMore` is true.
  "walk",
] as const;
export type PagingStop = (typeof PAGING_STOPS)[number];

/** One continuation value: a server-minted token or a position. */
export type ContinuationValue = string | number;

export interface Continuation {
  arguments: Partial<Record<ContinuationArgument, ContinuationValue>>;
}

export interface Paging {
  /** The most items a page holds, in the page's own unit; null when only a byte bound applies. */
  limit: number | null;
  /** Items on this page, in the same unit as `limit`. */
  returned: number;
  /** Whether items follow this page in the read's order. */
  hasMore: boolean;
  /** Why this page ended before the end; null exactly when nothing follows. */
  stoppedBy: PagingStop | null;
}

/** The two fields every paged answer carries (ADR 0128). */
export interface PagedFields {
  next: Continuation | null;
  paging: Paging;
}

/**
 * The paged fields as a client's wire type declares them until the deprecated
 * fields go (ADR 0128 slice S9): every converted read sends both, but a client
 * validator accepts an answer without them and checks them when present.
 */
export type PagedWireFields = Partial<PagedFields>;

/** The longest token any read mints (`financial.query` and the snapshot cursors allow 2,048). */
const MAX_TOKEN = 2048;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A continuation value: a non-empty token without a control character, or a position. */
function validContinuationValue(value: unknown): value is ContinuationValue {
  if (typeof value === "number") return count(value);
  return validToken(value);
}

/** A server-minted token: non-empty text without a control character. */
function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN &&
    !/[\u0000-\u001f]/u.test(value)
  );
}

/**
 * `{ arguments }` with one to three continuation arguments and nothing else.
 * A continuation never names a filter or a page size; `cursor` is always a
 * token and an offset always a position.
 */
export function validContinuation(value: unknown): value is Continuation {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.arguments)) return false;
  const entries = Object.entries(value.arguments);
  return (
    entries.length > 0 &&
    entries.every(([key, item]) =>
      key === "cursor"
        ? validToken(item)
        : (CONTINUATION_ARGUMENTS as readonly string[]).includes(key) && count(item),
    )
  );
}

/** `paging` with its own invariants: `hasMore` exactly when something stopped the page early. */
export function validPaging(value: unknown): value is Paging {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    !(value.limit === null || (count(value.limit) && value.limit > 0)) ||
    !count(value.returned) ||
    typeof value.hasMore !== "boolean" ||
    !(value.stoppedBy === null || (PAGING_STOPS as readonly unknown[]).includes(value.stoppedBy))
  )
    return false;
  if (value.limit !== null && value.returned > value.limit) return false;
  // A page the limit stopped is full.
  if (value.stoppedBy === "limit" && value.returned !== value.limit) return false;
  // A page the walk ended is not full: a full page says `limit`, whatever
  // else ended the walk at the same row.
  if (value.stoppedBy === "walk" && value.limit !== null && value.returned >= value.limit)
    return false;
  return value.hasMore === (value.stoppedBy !== null);
}

/**
 * The `next` and `paging` of one answer, and how they agree: a continuation
 * exactly when items follow and the grant may read them.
 */
export function validPagedFields(value: unknown): value is PagedFields {
  if (!record(value) || !Object.hasOwn(value, "next") || !validPaging(value.paging)) return false;
  const paging = value.paging;
  if (value.next === null) return !paging.hasMore || paging.stoppedBy === "budget";
  return validContinuation(value.next) && paging.hasMore && paging.stoppedBy !== "budget";
}

/**
 * Whether an answer either carries no paged fields or carries valid ones.
 * Until the deprecated fields go (ADR 0128 slice S9) a client validator
 * checks the new fields when an answer has them and their agreement with the
 * old ones; the server sends both on every converted read.
 */
export function pagedFieldsAbsentOrValid(value: Record<string, unknown>): boolean {
  const has = Object.hasOwn(value, "next") || Object.hasOwn(value, "paging");
  return !has || validPagedFields(value);
}

/**
 * Whether an answer's `next` and `paging`, when it has them, say exactly what
 * its deprecated fields say (ADR 0128, until S9): the same continuation
 * arguments and no other, rows following exactly when the old fields continue
 * or withhold, a withheld page as `stoppedBy: "budget"`, and the same count
 * and page size where the old fields state them. An answer without either
 * field passes; one with only one of them, or with invalid ones, does not.
 */
export function pagedFieldsSay(
  value: Record<string, unknown>,
  expected: {
    next: Continuation["arguments"] | null;
    returned?: number;
    limit?: number | null;
    withheld?: boolean;
  },
): boolean {
  if (!Object.hasOwn(value, "next") && !Object.hasOwn(value, "paging")) return true;
  if (!validPagedFields(value)) return false;
  const { next, paging } = value;
  const withheld = expected.withheld === true;
  if (expected.next === null) {
    if (next !== null) return false;
  } else {
    if (next === null) return false;
    const want = Object.entries(expected.next);
    const have = next.arguments as Record<string, unknown>;
    if (
      Object.keys(have).length !== want.length ||
      !want.every(([key, item]) => Object.hasOwn(have, key) && have[key] === item)
    )
      return false;
  }
  return (
    paging.hasMore === (expected.next !== null || withheld) &&
    (paging.stoppedBy === "budget") === withheld &&
    (expected.returned === undefined || paging.returned === expected.returned) &&
    (expected.limit === undefined || paging.limit === expected.limit)
  );
}

/** The continuation an answer names, or null; for a validator comparing it with an old field. */
export function continuationOf(
  value: Record<string, unknown>,
  name: ContinuationArgument,
): ContinuationValue | null {
  const next = value.next;
  if (!record(next) || !record(next.arguments)) return null;
  const item = next.arguments[name];
  return item === undefined ? null : (item as ContinuationValue);
}

/**
 * The `next` and `paging` of one page.
 *
 * - `next`: the continuation arguments when items follow, else null.
 * - `withheld`: items follow but the grant's row budget refuses the next page;
 *   `next` must then be null, and the page says `stoppedBy: "budget"`.
 * - `stoppedBy`: what ended a page that has a continuation (`limit` unless
 *   the byte bound (`bytes`) or a scan bound (`walk`) ended it first).
 */
export function pagedFields(input: {
  limit: number | null;
  returned: number;
  next: Continuation["arguments"] | null;
  withheld?: boolean;
  stoppedBy?: "limit" | "bytes" | "walk";
}): PagedFields {
  if (input.withheld && input.next !== null)
    throw new RangeError("a withheld page has no continuation");
  const hasMore = input.withheld === true || input.next !== null;
  const fields: PagedFields = {
    next: input.next === null ? null : { arguments: { ...input.next } },
    paging: {
      limit: input.limit,
      returned: input.returned,
      hasMore,
      stoppedBy: input.withheld ? "budget" : hasMore ? (input.stoppedBy ?? "limit") : null,
    },
  };
  if (!validPagedFields(fields)) throw new RangeError("invalid_paging");
  return fields;
}

/**
 * The `next` and `paging` of an offset page: a full page with rows after it
 * continues at the offset after its last row; `withheld` says rows follow
 * that the grant's row budget refuses.
 */
export function offsetPagedFields(input: {
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
  withheld?: boolean;
}): PagedFields {
  const following = input.hasMore && input.withheld !== true;
  return pagedFields({
    limit: input.limit,
    returned: input.returned,
    next: following ? { offset: input.offset + input.returned } : null,
    withheld: input.hasMore && input.withheld === true,
  });
}

/** The arguments a client sends next: its last call's, with `next.arguments` merged over them. */
export function continueCall<T extends Record<string, unknown>>(
  last: T,
  next: Continuation,
): T & Continuation["arguments"] {
  return { ...last, ...next.arguments };
}

// ── refusals ─────────────────────────────────────────────────────────────

/** The refusals of a continuation, each with its one status (ADR 0128). */
export const PAGING_REFUSAL_STATUS = {
  // Not a token this read issued: it does not decode, names no row, or lies past the list.
  invalid_cursor: 400,
  // Issued for other arguments; `mustMatch` names those that must repeat.
  cursor_mismatch: 400,
  // The fixed context the token named is gone; read again without `cursor`.
  context_expired: 410,
  // The answer would pass the read's bound; `retryWith` names another argument set when one answers.
  result_limit_exceeded: 413,
} as const;
export type PagingRefusalCode = keyof typeof PAGING_REFUSAL_STATUS;

export interface PagingRefusal {
  status: (typeof PAGING_REFUSAL_STATUS)[PagingRefusalCode];
  error: PagingRefusalCode;
  /** Argument names only, never a value (`cursor_mismatch`). */
  mustMatch?: readonly string[];
  /** The arguments to merge into the last call instead (`result_limit_exceeded`). */
  retryWith?: { arguments: Record<string, ContinuationValue> };
}

const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

export function invalidCursor(): PagingRefusal {
  return { status: 400, error: "invalid_cursor" };
}

export function cursorMismatch(mustMatch: readonly string[]): PagingRefusal {
  if (mustMatch.length === 0 || !mustMatch.every((name) => ARGUMENT_NAME.test(name)))
    throw new RangeError("mustMatch names arguments");
  return { status: 400, error: "cursor_mismatch", mustMatch: [...mustMatch] };
}

export function contextExpired(): PagingRefusal {
  return { status: 410, error: "context_expired" };
}

export function resultLimitExceeded(retryWith?: Record<string, ContinuationValue>): PagingRefusal {
  if (retryWith === undefined) return { status: 413, error: "result_limit_exceeded" };
  const entries = Object.entries(retryWith);
  if (
    entries.length === 0 ||
    !entries.every(([key, value]) => ARGUMENT_NAME.test(key) && validContinuationValue(value))
  )
    throw new RangeError("retryWith names arguments");
  return {
    status: 413,
    error: "result_limit_exceeded",
    retryWith: { arguments: { ...retryWith } },
  };
}

/**
 * A refusal body of this family as a route (`requestId`) or a tool answers
 * it: the code, optional safe refs, and only the hint its code carries.
 */
export function validPagingRefusalBody(value: unknown): boolean {
  if (!record(value) || typeof value.error !== "string") return false;
  const code = value.error;
  if (!Object.hasOwn(PAGING_REFUSAL_STATUS, code)) return false;
  for (const key of Object.keys(value))
    if (!["error", "requestId", "refs", "mustMatch", "retryWith"].includes(key)) return false;
  if (Object.hasOwn(value, "requestId") && typeof value.requestId !== "string") return false;
  if (
    Object.hasOwn(value, "refs") &&
    !(Array.isArray(value.refs) && value.refs.every((ref) => typeof ref === "string"))
  )
    return false;
  if (Object.hasOwn(value, "mustMatch")) {
    if (code !== "cursor_mismatch") return false;
    if (
      !Array.isArray(value.mustMatch) ||
      value.mustMatch.length === 0 ||
      !value.mustMatch.every((name) => typeof name === "string" && ARGUMENT_NAME.test(name))
    )
      return false;
  } else if (code === "cursor_mismatch") return false;
  if (Object.hasOwn(value, "retryWith")) {
    if (code !== "result_limit_exceeded") return false;
    const retry = value.retryWith;
    if (!record(retry) || Object.keys(retry).length !== 1 || !record(retry.arguments)) return false;
    const entries = Object.entries(retry.arguments);
    if (
      entries.length === 0 ||
      !entries.every(([key, item]) => ARGUMENT_NAME.test(key) && validContinuationValue(item))
    )
      return false;
  }
  return true;
}
