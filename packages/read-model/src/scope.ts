// Typed query scope: allow-listed filter columns, named ordering keys and
// explicit page limits. A query declares which scope keys it accepts; a key
// outside that list is a programming error, never a silently ignored input.

export type MeasureView = "balances" | "summaries";

export interface CollectionScope {
  source?: string;
  account?: string;
  instrument?: string;
  metric?: string;
  /** ISO date `YYYY-MM-DD`, validated by the HTTP layer before it reaches here. */
  from?: string;
  to?: string;
  /** Case-insensitive substring over description, counterparty, external id, source and account. */
  q?: string;
  measureView?: MeasureView;
}
export type ScopeKey = keyof CollectionScope;

/** Every scope key maps to fixed columns of the derived row; the request never names a column. */
export const SCOPE_COLUMNS = {
  source: "source_id",
  account: "source_account",
  instrument: "instrument",
  metric: "metric",
} as const;
const TEXT_SEARCH_COLUMNS = [
  "description",
  "counterparty",
  "external_id",
  "source_id",
  "source_account",
] as const;

/** Exact audited source/parser/metric families that are period totals rather than balances. */
export function periodMeasureSql(source: string, parser: string, metric: string): string {
  return `((${source} = 'myjcb' AND ${parser} LIKE 'myjcb-credit-past-month-balances@%' AND ${metric} = 'credit_statement_payment_amount') OR (${source} = 'v-point' AND ${parser} LIKE 'v-point-smfg-point@%' AND ${metric} = 'displayed_point_balance'))`;
}

export interface Predicates {
  where: string;
  args: unknown[];
}

export function scopePredicates(scope: CollectionScope, allowed: readonly ScopeKey[]): Predicates {
  for (const key of Object.keys(scope) as ScopeKey[]) {
    if (scope[key] !== undefined && !allowed.includes(key))
      throw new Error(`read-model: scope key not allowed for this query: ${key}`);
  }
  const predicates: string[] = [];
  const args: unknown[] = [];
  if (scope.measureView) {
    const summary = periodMeasureSql("source_id", "parser", "metric");
    predicates.push(scope.measureView === "summaries" ? summary : `NOT ${summary}`);
  }
  for (const key of ["source", "account", "instrument", "metric"] as const) {
    const value = scope[key];
    if (value !== undefined) {
      predicates.push(`${SCOPE_COLUMNS[key]} = ?`);
      args.push(value);
    }
  }
  if (scope.from || scope.to) {
    // Only rows whose as_of starts with a real calendar date take part in a range.
    predicates.push("date(substr(as_of,1,10), '+0 days') = substr(as_of,1,10)");
    if (scope.from) {
      predicates.push("substr(as_of,1,10) >= ?");
      args.push(scope.from);
    }
    if (scope.to) {
      predicates.push("substr(as_of,1,10) <= ?");
      args.push(scope.to);
    }
  }
  if (scope.q) {
    predicates.push(
      "(" +
        TEXT_SEARCH_COLUMNS.map(
          (column) => `instr(lower(coalesce(${column},'')), lower(?)) > 0`,
        ).join(" OR ") +
        ")",
    );
    args.push(...Array<string>(TEXT_SEARCH_COLUMNS.length).fill(scope.q));
  }
  return { where: predicates.join(" AND ") || "1", args };
}

/** Stable, total orderings: every key ends in the row id so paging is deterministic. */
export const ORDER_KEYS = {
  transactionsByDateDesc: "COALESCE(as_of, '') DESC, id DESC",
  balancesByScope: "source_id, source_account, metric, instrument, id",
  balanceHistoryByDateDesc: "COALESCE(as_of, observed_at, '') DESC, id DESC",
  positionsByScope: "source_id, source_account, security_code, id",
  artifactsByIdDesc: "a.id DESC",
} as const;
export type OrderKey = keyof typeof ORDER_KEYS;

/** One page plus one row, so the caller can report truncation without a count query. */
export const PAGE_LIMIT = 501;
/** The complete bounded candidate set for grouping callers; one row over the bound. */
export const CANDIDATE_LIMIT = 5001;
/** No list result may exceed this many rows; larger results are refused, never silently cut. */
export const RESULT_BOUND = 5000;
export type PageLimit = typeof PAGE_LIMIT | typeof CANDIDATE_LIMIT;

export interface PageSql {
  sql: string;
  args: unknown[];
}

/**
 * Apply scope to the complete derived result, then order and page it. The
 * scope is applied after the inner query's grouping and ranking, so a filter
 * never removes a witness before its group is ranked.
 */
export function pagedCollection(
  inner: string,
  scope: CollectionScope,
  allowed: readonly ScopeKey[],
  order: OrderKey,
  limit: PageLimit,
  offset: number,
): PageSql {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("read-model: offset must be a non-negative safe integer");
  const { where, args } = scopePredicates(scope, allowed);
  return {
    sql: `SELECT * FROM (${inner})
      WHERE ${where}
      ORDER BY ${ORDER_KEYS[order]} LIMIT ${limit} OFFSET ?`,
    args: [...args, offset],
  };
}
