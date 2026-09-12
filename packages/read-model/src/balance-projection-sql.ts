// Reads of the latest-balance projection (migration 0030).
//
// Every page is one keyed range scan of `current_balance_projection_order`
// inside one fixed snapshot. Nothing here re-ranks, re-groups or re-classifies
// candidates: that work happened once, when the snapshot was built. A filter
// narrows the ordered scan; it never changes the order or the grouping, so
// page N+1 cannot repeat or skip a row that page N already returned.

import { BALANCE_HISTORY_SQL } from "./sql";
import { scopePredicates, type CollectionScope, type PageSql, type ScopeKey } from "./scope";

/** Page sizes: one page plus one row, so `hasMore` needs no COUNT. */
export const PROJECTION_PAGE_LIMITS = [50, 100, 200, 500] as const;
export type ProjectionPageLimit = (typeof PROJECTION_PAGE_LIMITS)[number];
export const DEFAULT_PROJECTION_PAGE_LIMIT: ProjectionPageLimit = 100;
/** Rows the subtotal may read for one filter scope before it reports itself unavailable. */
export const SUBTOTAL_ROW_BOUND = 5000;

// The metric filter is applied over every witness of a measurement, not only
// the representative, so a filter can never split a bundled group across
// pages or hide the group because its representative used the other column.
const PROJECTION_SCOPE_KEYS: readonly ScopeKey[] = [
  "source",
  "account",
  "instrument",
  "measureView",
];
const MEMBER_METRIC_PREDICATE =
  "EXISTS (SELECT 1 FROM json_each(member_metrics_json) member WHERE member.value = ?)";

function projectionPredicates(scope: CollectionScope): { where: string; args: unknown[] } {
  const { metric, ...rest } = scope;
  const base = scopePredicates(rest, PROJECTION_SCOPE_KEYS);
  if (metric === undefined) return base;
  return { where: `${base.where} AND ${MEMBER_METRIC_PREDICATE}`, args: [...base.args, metric] };
}

/**
 * Projected columns of one page. `scope_key` is the projection's own row key;
 * it never leaves the server inside a cursor (a cursor carries `row_seq`).
 */
const PAGE_COLUMNS = `snapshot_id, scope_key, subject_scope_key, row_seq,
  representative_observation_ref, member_evidence_refs_json, member_metrics_json, evidence_count,
  metric_id, definition_release, quantity_coefficient, quantity_scale, value_status, unit_ref,
  state, reason_code, as_of_role, as_of_kind, as_of_value, temporal_json,
  freshness, freshness_reason, sort_as_of,
  source_id, source_account, metric, instrument, parser,
  observation_id, parse_run_id, fetch_artifact_id,
  amount_minor, amount_text, as_of, observed_at, measure_view, latest_in_group`;

/**
 * The view predicate. Without an explicit view the list is exactly the latest
 * witness of each group, which is what `/api/balances` returns today; the
 * summaries view additionally keeps every statement month of the newest
 * capture, so it selects on the measure column instead.
 */
function viewPredicate(scope: CollectionScope): string {
  return scope.measureView === undefined ? " AND latest_in_group = 1" : "";
}

export interface ProjectionPageRow {
  snapshot_id: string;
  scope_key: string;
  subject_scope_key: string;
  row_seq: number;
  representative_observation_ref: string;
  member_evidence_refs_json: string;
  member_metrics_json: string;
  evidence_count: number;
  metric_id: string;
  definition_release: string;
  quantity_coefficient: string | null;
  quantity_scale: number | null;
  value_status: "exact" | "missing" | "unparsed" | "conflict";
  unit_ref: string;
  state: string;
  reason_code: string | null;
  as_of_role: string;
  as_of_kind: string;
  as_of_value: string | null;
  temporal_json: string;
  freshness: string;
  freshness_reason: string | null;
  sort_as_of: string;
  source_id: string;
  source_account: string;
  metric: string;
  instrument: string;
  parser: string;
  observation_id: number;
  parse_run_id: number;
  fetch_artifact_id: number;
  amount_minor: string | null;
  amount_text: string | null;
  as_of: string | null;
  observed_at: string | null;
  measure_view: "balances" | "summaries";
  latest_in_group: number;
}

/**
 * Monitoring values of the store, in one row.
 *
 * These used to BE the snapshot identity, and they cannot carry it: moving an
 * artifact's adopted parse from 100 to 150 leaves `max(parse_run_id)` alone
 * while some unrelated run 900 exists, and two opposite changes leave a count
 * alone (01 §5). Since migration 0038 the change detector is
 * `core_source_revision` and the identity is the digest of the captured input;
 * these values stay as a cheap operational summary, and
 * `publishedHighWaterParseRunId` still pins the history window of a snapshot.
 */
export const PROJECTION_INPUTS_SQL = `SELECT
    (SELECT coalesce(max(parse_run_id),0) FROM published_parse_runs) AS published_high_water,
    (SELECT count(*) FROM observation_fetch_runs) AS visible_runs,
    (SELECT coalesce(max(id),0) FROM observation_fetch_runs) AS visible_high_water,
    (SELECT count(*) FROM entity_relations WHERE status='accepted') AS adopted_relations,
    (SELECT count(*) FROM decision_revisions) AS decision_revisions`;

export interface ProjectionInputsRow {
  published_high_water: number;
  visible_runs: number;
  visible_high_water: number;
  adopted_relations: number;
  decision_revisions: number;
}

/**
 * One page: `snapshot_id` and `row_seq > cursor` are the leading columns of
 * the unique order index, so the plan is a keyed range scan whose cost is the
 * page size plus the rows the filter rejects inside that range.
 */
export function projectionPageSql(
  snapshotId: string,
  scope: CollectionScope,
  limit: number,
  afterRowSeq: number,
): PageSql {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("read-model: projection page limit out of range");
  if (!Number.isSafeInteger(afterRowSeq) || afterRowSeq < -1)
    throw new Error("read-model: projection cursor position out of range");
  const { where, args } = projectionPredicates(scope);
  return {
    sql: `SELECT ${PAGE_COLUMNS} FROM current_balance_projection
      WHERE snapshot_id = ?1 AND row_seq > ?2 AND (${where})${viewPredicate(scope)}
      ORDER BY row_seq LIMIT ${limit + 1}`,
    args: [snapshotId, afterRowSeq, ...args],
  };
}

/**
 * The v1 `/api/balances` latest list, served from the projection. Same order
 * (`balancesByScope`), same offset paging and same 500-row window as the
 * compatibility route it replaces, so a client cannot tell the two apart.
 */
export function projectionLegacyPageSql(
  snapshotId: string,
  scope: CollectionScope,
  offset: number,
  limit: number,
): PageSql {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("read-model: legacy projection offset out of range");
  const { where, args } = projectionPredicates(scope);
  // Placeholders are positional throughout, so the bound order is the order
  // they appear in the text; mixing them with numbered ones would silently
  // reuse an argument.
  return {
    sql: `SELECT ${PAGE_COLUMNS} FROM current_balance_projection
      WHERE snapshot_id = ? AND (${where})${viewPredicate(scope)}
      ORDER BY source_id, source_account, metric, instrument, observation_id
      LIMIT ${limit} OFFSET ?`,
    args: [snapshotId, ...args, offset],
  };
}

/**
 * Adopted exact quantities of the metrics the caller declared summable, for
 * the whole filter scope rather than the page (AT67). The sum itself is done
 * in exact integer arithmetic outside SQL; SQLite never sees a financial
 * addition. One row over the bound so an oversized scope reports itself
 * unavailable instead of returning a partial subtotal (INV05).
 */
export function projectionSubtotalSql(
  snapshotId: string,
  scope: CollectionScope,
  metricIds: readonly string[],
): PageSql {
  const { where, args } = projectionPredicates(scope);
  const placeholders = metricIds.map(() => "?").join(",");
  return {
    sql: `SELECT unit_ref, subject_scope_key, source_id, source_account, metric_id,
        quantity_coefficient, quantity_scale
      FROM current_balance_projection
      WHERE snapshot_id = ?1 AND state='adopted' AND value_status='exact'
        AND metric_id IN (${placeholders || "NULL"}) AND (${where})${viewPredicate(scope)}
      ORDER BY row_seq LIMIT ${SUBTOTAL_ROW_BOUND + 1}`,
    args: [snapshotId, ...metricIds, ...args],
  };
}

/**
 * Balance history as a keyset page. History is not a projection: it is the
 * append-only record of visible parse results, and it is pinned to the
 * snapshot's published high-water parse run so a publication that lands
 * between two pages cannot insert a row into a page already read. The order
 * is the effective time descending with the observation id as the tie-break,
 * which is the order `/api/balances` history uses today.
 */
const HISTORY_SORT = "COALESCE(history.as_of, history.observed_at, '')";
export function balanceHistoryKeysetSql(
  highWaterParseRunId: number,
  scope: CollectionScope,
  limit: number,
  cursor: { sortValue: string; id: number } | null,
): PageSql {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("read-model: history page limit out of range");
  const { where, args } = scopePredicates(scope, [
    "source",
    "account",
    "instrument",
    "metric",
    "measureView",
  ]);
  // Positional placeholders throughout: the bound order is the order they
  // appear in the text, so the sort value is bound twice on purpose.
  const keyset = cursor ? " AND (sort_key < ? OR (sort_key = ? AND id < ?))" : "";
  return {
    sql: `SELECT * FROM (
        SELECT ${HISTORY_SORT} AS sort_key, history.*
        FROM (${BALANCE_HISTORY_SQL} WHERE b.parse_run_id <= ?) history
      )
      WHERE (${where})${keyset}
      ORDER BY sort_key DESC, id DESC LIMIT ${limit + 1}`,
    args: [
      highWaterParseRunId,
      ...args,
      ...(cursor ? [cursor.sortValue, cursor.sortValue, cursor.id] : []),
    ],
  };
}

/** Reason codes and freshness of the whole filter scope, for `dataCoverage`. */
export function projectionCoverageSql(snapshotId: string, scope: CollectionScope): PageSql {
  const { where, args } = projectionPredicates(scope);
  return {
    sql: `SELECT state, reason_code, freshness, count(*) AS count
      FROM current_balance_projection
      WHERE snapshot_id = ?1 AND (${where})${viewPredicate(scope)}
      GROUP BY state, reason_code, freshness`,
    args: [snapshotId, ...args],
  };
}
