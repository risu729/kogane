// Explicit reader for the latest-balance projection. Same rule as the rest of
// this package: every read the API can run is a named method with a typed
// input, and no caller ever hands the reader SQL text.

import {
  ACTIVE_POINTER_SQL,
  balanceHistoryKeysetSql,
  CURRENT_SNAPSHOT_SQL,
  PROJECTION_INPUTS_SQL,
  projectionCoverageSql,
  projectionLegacyPageSql,
  projectionPageSql,
  projectionSubtotalSql,
  SNAPSHOT_READABLE_SQL,
  SUBTOTAL_ROW_BOUND,
  type ProjectionInputsRow,
  type ProjectionPageRow,
} from "./balance-projection-sql";
import { CORE_REVISION_SQL, type CoreRevisionRow } from "./source-revision";
import type { BalanceHistoryRow } from "../../../packages/observation-shared/src/api-contract";
import type { CollectionScope } from "./scope";
import type { SqlExecutor } from "./reader";

export interface BalanceSnapshotRow {
  snapshot_id: string;
  created_at: string;
  row_count: number;
  input_manifest_json: string;
  projection_release: string;
  /** Migration 0038; null on a snapshot built before the fixed-input protocol. */
  input_digest: string | null;
  source_revision: number | null;
  visibility_revision: number | null;
  core_epoch: string | null;
  read_instance_id: string | null;
}

export interface ActivePointerRow {
  snapshot_id: string;
  source_revision: number;
  read_instance_id: string;
  core_epoch: string;
  switched_at: string;
}

export interface ProjectionCoverageRow {
  state: string;
  reason_code: string | null;
  freshness: string;
  count: number;
}

export interface SubtotalRow {
  unit_ref: string;
  subject_scope_key: string;
  /** Carried so a caller can re-check its own scope on every row it sums. */
  source_id: string;
  source_account: string;
  metric_id: string;
  quantity_coefficient: string;
  quantity_scale: number;
}

export interface BalanceProjectionReader {
  /** Operational summary of the store; never the snapshot identity (0038). */
  projectionInputs(): Promise<ProjectionInputsRow>;
  /**
   * The CORE change detector: one integer per kind of change plus the epoch.
   * A snapshot describes the current context exactly when its recorded
   * `source_revision` still equals this one.
   */
  coreRevision(): Promise<CoreRevisionRow>;
  /** The snapshot the read model currently publishes, or null before the first switch. */
  activePointer(): Promise<ActivePointerRow | null>;
  /** The newest sealed snapshot, or null when no build has completed yet. */
  currentSnapshot(): Promise<BalanceSnapshotRow | null>;
  /** A snapshot a cursor names; null means the fixed context expired. */
  snapshot(snapshotId: string): Promise<BalanceSnapshotRow | null>;
  latestPage(
    snapshotId: string,
    scope: CollectionScope,
    limit: number,
    afterRowSeq: number,
  ): Promise<ProjectionPageRow[]>;
  /** The v1 `/api/balances` latest window, served from the same projection. */
  legacyLatestPage(
    snapshotId: string,
    scope: CollectionScope,
    offset: number,
    limit: number,
  ): Promise<ProjectionPageRow[]>;
  coverage(snapshotId: string, scope: CollectionScope): Promise<ProjectionCoverageRow[]>;
  /**
   * Adopted exact quantities of the declared summable metrics over the whole
   * filter scope. `null` when the scope holds more rows than the bound: an
   * oversized scope has no subtotal rather than a partial one.
   */
  summableQuantities(
    snapshotId: string,
    scope: CollectionScope,
    metricIds: readonly string[],
  ): Promise<SubtotalRow[] | null>;
  historyPage(
    highWaterParseRunId: number,
    scope: CollectionScope,
    limit: number,
    cursor: { sortValue: string; id: number } | null,
  ): Promise<(BalanceHistoryRow & { sort_key: string })[]>;
}

export function createBalanceProjectionReader(sql: SqlExecutor): BalanceProjectionReader {
  return {
    async projectionInputs() {
      return (
        (await sql.first<ProjectionInputsRow>(PROJECTION_INPUTS_SQL, [])) ?? {
          published_high_water: 0,
          visible_runs: 0,
          visible_high_water: 0,
          adopted_relations: 0,
          decision_revisions: 0,
        }
      );
    },
    async coreRevision() {
      // A database that has not applied migration 0038 has no revision row;
      // revision 0 is then "older than every recorded snapshot", which keeps
      // a reader honest instead of reporting a snapshot as current.
      return (
        (await sql.first<CoreRevisionRow>(CORE_REVISION_SQL, [])) ?? {
          source_revision: 0,
          visibility_revision: 0,
          core_epoch: "unknown",
        }
      );
    },
    async activePointer() {
      return await sql.first<ActivePointerRow>(ACTIVE_POINTER_SQL, []);
    },
    async currentSnapshot() {
      return await sql.first<BalanceSnapshotRow>(CURRENT_SNAPSHOT_SQL, []);
    },
    async snapshot(snapshotId) {
      return await sql.first<BalanceSnapshotRow>(SNAPSHOT_READABLE_SQL, [snapshotId]);
    },
    async latestPage(snapshotId, scope, limit, afterRowSeq) {
      const page = projectionPageSql(snapshotId, scope, limit, afterRowSeq);
      return await sql.all<ProjectionPageRow>(page.sql, page.args);
    },
    async legacyLatestPage(snapshotId, scope, offset, limit) {
      const page = projectionLegacyPageSql(snapshotId, scope, offset, limit);
      return await sql.all<ProjectionPageRow>(page.sql, page.args);
    },
    async coverage(snapshotId, scope) {
      const query = projectionCoverageSql(snapshotId, scope);
      return await sql.all<ProjectionCoverageRow>(query.sql, query.args);
    },
    async summableQuantities(snapshotId, scope, metricIds) {
      if (metricIds.length === 0) return [];
      const query = projectionSubtotalSql(snapshotId, scope, metricIds);
      const rows = await sql.all<SubtotalRow>(query.sql, query.args);
      return rows.length > SUBTOTAL_ROW_BOUND ? null : rows;
    },
    async historyPage(highWaterParseRunId, scope, limit, cursor) {
      const query = balanceHistoryKeysetSql(highWaterParseRunId, scope, limit, cursor);
      return await sql.all<BalanceHistoryRow & { sort_key: string }>(query.sql, query.args);
    },
  };
}
