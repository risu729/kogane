// The App's reader when the projection lives in the READ database (U11).
//
// It implements the same `BalanceProjectionReader` the CORE path uses, over two
// executors, because the two databases answer different questions and cannot be
// joined (04 §1):
//
//   READ — the snapshot, its rows, its coverage and its subtotals, and which
//          snapshot is published;
//   CORE — the change detector (`core_source_revision`), the operational input
//          summary, and balance history, which is the append-only record of
//          published parses and never a projection.
//
// Two rules the CORE reader cannot state and this one must:
//
//   * a snapshot is readable only through the active pointer. There is no
//     "newest complete build" fallback, so an unfinished or unpublished build
//     is never served and an empty READ is `unavailable`, not an empty list;
//   * every row this reader returns belongs to the instance the pointer names,
//     so a cursor from a rebuilt database cannot be answered from new rows.
import {
  projectionCoverageSql,
  projectionLegacyPageSql,
  projectionPageSql,
  projectionSubtotalSql,
  SUBTOTAL_ROW_BOUND,
  type ProjectionInputsRow,
  type ProjectionPageRow,
} from "../../../read-model/src/balance-projection-sql.ts";
import {
  createBalanceProjectionReader,
  type ActivePointerRow,
  type BalanceProjectionReader,
  type BalanceSnapshotRow,
  type ProjectionCoverageRow,
  type SubtotalRow,
} from "../../../read-model/src/balance-projection-reader.ts";
import type { CollectionScope } from "../../../read-model/src/scope.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import type { CoreRevisionRow } from "../../../read-model/src/source-revision.ts";
import {
  ACTIVE_SNAPSHOT_SQL,
  READ_INSTANCE_SQL,
  READ_POINTER_DETAIL_SQL,
  READ_POINTER_SQL,
  READ_SNAPSHOT_SQL,
} from "./sql.ts";
import type { PointerRow } from "./writer.ts";

export interface ReadInstanceRow {
  read_instance_id: string;
  created_at: string;
  contract_version: string;
}

/** The reader plus the questions only a READ-backed deployment can ask. */
export interface ReadProjectionReader extends BalanceProjectionReader {
  /** The physical database's identity, or null before any build claimed it. */
  readInstance(): Promise<ReadInstanceRow | null>;
  /**
   * The pointer with the fields CORE's has no column for: the visibility
   * revision and the output digest the published content was last verified
   * against. It is the watermark a reader checks a restriction change against,
   * because a build whose content did not change still re-verifies it at the
   * new revision (05 §5, §7).
   */
  readPointer(): Promise<PointerRow | null>;
}

export function createReadProjectionReader(
  core: SqlExecutor,
  read: SqlExecutor,
): ReadProjectionReader {
  // CORE keeps answering for history, the revision and the input summary; the
  // shared implementation is reused rather than restated.
  const coreReader = createBalanceProjectionReader(core);
  return {
    async readInstance(): Promise<ReadInstanceRow | null> {
      return await read.first<ReadInstanceRow>(READ_INSTANCE_SQL, []);
    },
    async readPointer(): Promise<PointerRow | null> {
      return await read.first<PointerRow>(READ_POINTER_DETAIL_SQL, []);
    },
    async projectionInputs(): Promise<ProjectionInputsRow> {
      return await coreReader.projectionInputs();
    },
    async coreRevision(): Promise<CoreRevisionRow> {
      return await coreReader.coreRevision();
    },
    async historyPage(highWaterParseRunId, scope, limit, cursor) {
      return await coreReader.historyPage(highWaterParseRunId, scope, limit, cursor);
    },
    async activePointer(): Promise<ActivePointerRow | null> {
      return await read.first<ActivePointerRow>(READ_POINTER_SQL, []);
    },
    async currentSnapshot(): Promise<BalanceSnapshotRow | null> {
      return await read.first<BalanceSnapshotRow>(ACTIVE_SNAPSHOT_SQL, []);
    },
    async snapshot(snapshotId: string): Promise<BalanceSnapshotRow | null> {
      return await read.first<BalanceSnapshotRow>(READ_SNAPSHOT_SQL, [snapshotId]);
    },
    async latestPage(
      snapshotId: string,
      scope: CollectionScope,
      limit: number,
      afterRowSeq: number,
    ): Promise<ProjectionPageRow[]> {
      const page = projectionPageSql(snapshotId, scope, limit, afterRowSeq);
      return await read.all<ProjectionPageRow>(page.sql, page.args);
    },
    async legacyLatestPage(
      snapshotId: string,
      scope: CollectionScope,
      offset: number,
      limit: number,
    ): Promise<ProjectionPageRow[]> {
      const page = projectionLegacyPageSql(snapshotId, scope, offset, limit);
      return await read.all<ProjectionPageRow>(page.sql, page.args);
    },
    async coverage(snapshotId: string, scope: CollectionScope): Promise<ProjectionCoverageRow[]> {
      const query = projectionCoverageSql(snapshotId, scope);
      return await read.all<ProjectionCoverageRow>(query.sql, query.args);
    },
    async summableQuantities(
      snapshotId: string,
      scope: CollectionScope,
      metricIds: readonly string[],
    ): Promise<SubtotalRow[] | null> {
      if (metricIds.length === 0) return [];
      const query = projectionSubtotalSql(snapshotId, scope, metricIds);
      const rows = await read.all<SubtotalRow>(query.sql, query.args);
      // An oversized scope has no subtotal rather than a partial one (INV05).
      return rows.length > SUBTOTAL_ROW_BOUND ? null : rows;
    },
  };
}
