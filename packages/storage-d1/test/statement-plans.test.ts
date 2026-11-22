// Plans of the ingest path's CORE accessors and of every READ statement this
// package exports, without table statistics (D1 never runs `ANALYZE`).
//
// The CORE accessors (`src/core/`) are what every collector upload runs, one
// statement each, against tables that grow with every capture: runs, units,
// artifacts, inventories, raw objects. Each is called once on a database that
// runs nothing (`preparedStatements`), so the statement checked is the one the
// accessor prepares, and explained on every CORE migration. The READ
// statements are the exported constants of `src/read/`, explained on the READ
// baseline. No statement may read a growing table from end to end.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { fullCoreDatabase } from "./sqlite.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";
import { planOf, preparedStatements, tableScans } from "./plan-check.ts";
import type { D1Like } from "../src/d1.ts";
import {
  insertRawObjectIfAbsent,
  readRawObjectLocation,
  readRawObjectSize,
  runCataloguesObject,
} from "../src/core/raw-objects.ts";
import {
  insertPageGroupIfAbsent,
  insertRunRangeIfAbsent,
  insertUnitIfAbsent,
  insertUnitReportIfAbsent,
  readPageGroup,
  readRunRange,
  readRunRangeKeys,
  readRunUnitReportKeys,
  readRunUnits,
  readUnit,
  readUnitById,
  readUnitReport,
  unitBelongsToRun,
} from "../src/core/structure.ts";
import {
  insertAcquisitionSessionIfAbsent,
  insertFetchRunIfAbsent,
  insertRunReportIfAbsent,
  readAcquisitionSession,
  readFetchRunByKey,
  readFetchRunSessionId,
} from "../src/core/fetch-runs.ts";
import {
  countEarlierCompleteAttempts,
  insertInventoryIfAbsent,
  inventoryBelongsToRun,
  readAttempt,
  readFailedAttempt,
  readInventoryByDigest,
  readInventoryCapacity,
  readInventoryDeclaration,
  readInventoryItem,
  readInventoryItems,
  readInventoryStatus,
  readSeal,
  readSealInventoryId,
  runSealed,
} from "../src/core/inventories.ts";
import {
  readArtifact,
  readArtifactDigests,
  readArtifactForeignActors,
  readArtifactOriginCount,
  readArtifactRanges,
  readArtifactRelations,
  readArtifactSource,
  readArtifactTransformSteps,
} from "../src/core/artifacts.ts";
import { ingestRouteActive, sourceDeclared } from "../src/core/ingest-registry.ts";
import * as readSql from "../src/read/sql.ts";
import * as rewardSql from "../src/read/rewards.ts";
import { projectionMeasureSql } from "../../read-model/src/balance-projection-sql.ts";
import type { CollectionScope } from "../../read-model/src/scope.ts";
import { writeRowChunk, writeScopeRelations } from "../src/read/writer.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

/** One call of each accessor; the arguments are placeholders, never read back. */
const ACCESSORS: Record<string, (db: D1Like) => Promise<unknown>> = {
  insertRawObjectIfAbsent: (db) => insertRawObjectIfAbsent(db, "a".repeat(64), 1, "k", 0),
  readRawObjectLocation: (db) => readRawObjectLocation(db, "a".repeat(64)),
  readRawObjectSize: (db) => readRawObjectSize(db, "a".repeat(64)),
  runCataloguesObject: (db) => runCataloguesObject(db, 1, "a".repeat(64)),
  insertRunRangeIfAbsent: (db) => insertRunRangeIfAbsent(db, 1, "r", {} as never, "c", 0),
  readRunRange: (db) => readRunRange(db, 1, "r"),
  insertPageGroupIfAbsent: (db) => insertPageGroupIfAbsent(db, 1, "g", 1, "c", 0),
  readPageGroup: (db) => readPageGroup(db, 1, "g"),
  unitBelongsToRun: (db) => unitBelongsToRun(db, 1, 1),
  insertUnitIfAbsent: (db) => insertUnitIfAbsent(db, 1, null, "card", "u", 1, "c", 0),
  readUnit: (db) => readUnit(db, 1, "card", "u", null),
  readUnitById: (db) => readUnitById(db, 1),
  insertUnitReportIfAbsent: (db) => insertUnitReportIfAbsent(db, 1, "r", {} as never, "c", 0),
  readUnitReport: (db) => readUnitReport(db, 1, "r"),
  readRunUnits: (db) => readRunUnits(db, 1),
  readRunRangeKeys: (db) => readRunRangeKeys(db, 1),
  readRunUnitReportKeys: (db) => readRunUnitReportKeys(db, 1),
  insertAcquisitionSessionIfAbsent: (db) =>
    insertAcquisitionSessionIfAbsent(db, "p", "c", "n", "s", 0),
  readFetchRunSessionId: (db) => readFetchRunSessionId(db, 1),
  readAcquisitionSession: (db) => readAcquisitionSession(db, "p", "n", "s"),
  insertFetchRunIfAbsent: (db) => insertFetchRunIfAbsent(db, 1, "p", "s", "c", "k", 0),
  readFetchRunByKey: (db) => readFetchRunByKey(db, 1, "s", "k"),
  insertRunReportIfAbsent: (db) =>
    insertRunReportIfAbsent(db, 1, "r", "terminal", "c", {} as never, 0),
  insertInventoryIfAbsent: (db) => insertInventoryIfAbsent(db, 1, "a".repeat(64), 1, "b", 0, "c"),
  readInventoryByDigest: (db) => readInventoryByDigest(db, 1, "a".repeat(64)),
  inventoryBelongsToRun: (db) => inventoryBelongsToRun(db, 1, 1),
  readInventoryDeclaration: (db) => readInventoryDeclaration(db, 1, 1),
  readInventoryItem: (db) => readInventoryItem(db, 1, "k"),
  readInventoryItems: (db) => readInventoryItems(db, 1),
  readInventoryCapacity: (db) => readInventoryCapacity(db, 1),
  readInventoryStatus: (db) => readInventoryStatus(db, 1, 1),
  runSealed: (db) => runSealed(db, 1),
  readSeal: (db) => readSeal(db, 1),
  readSealInventoryId: (db) => readSealInventoryId(db, 1),
  readAttempt: (db) => readAttempt(db, 1, "c", "a"),
  countEarlierCompleteAttempts: (db) => countEarlierCompleteAttempts(db, 1, 1),
  readFailedAttempt: (db) => readFailedAttempt(db, 1, "c", "a"),
  readArtifact: (db) => readArtifact(db, 1, "k"),
  readArtifactSource: (db) => readArtifactSource(db, 1, "k"),
  readArtifactRanges: (db) => readArtifactRanges(db, 1, "k"),
  readArtifactTransformSteps: (db) => readArtifactTransformSteps(db, 1, "k"),
  readArtifactRelations: (db) => readArtifactRelations(db, 1, "k"),
  readArtifactOriginCount: (db) => readArtifactOriginCount(db, 1, "k"),
  readArtifactForeignActors: (db) => readArtifactForeignActors(db, 1, "k", "c"),
  readArtifactDigests: (db) => readArtifactDigests(db, 1, "k"),
  sourceDeclared: (db) => sourceDeclared(db, "s"),
  ingestRouteActive: (db) => ingestRouteActive(db, "c", "p", "s"),
};

/** READ tables of one row each: the pointers and the physical database's identity. */
const READ_SINGLETONS = new Set([
  "read_instance",
  "balance_snapshot_pointer",
  "reward_snapshot_pointer",
]);

function wholeTableReads(db: Database, sql: string, small: ReadonlySet<string>): string[] {
  return tableScans(db, sql, planOf(db, sql))
    .filter((scan) => !scan.tables.every((table) => small.has(table)))
    .map((scan) => scan.step);
}

describe("the ingest path's CORE accessors, without table statistics", () => {
  for (const [name, call] of Object.entries(ACCESSORS))
    test(`${name} reaches its rows by key`, async () => {
      const { db, prepared } = preparedStatements();
      await call(db);
      expect(prepared.length).toBeGreaterThan(0);
      const core = fullCoreDatabase();
      for (const sql of prepared) {
        const plan = planOf(core, sql);
        expect(wholeTableReads(core, sql, new Set())).toEqual([]);
        // A read names its key: some step searches by it.
        if (/^\s*(SELECT|WITH)\b/iu.test(sql))
          expect(plan.some((step) => step.startsWith("SEARCH "))).toBe(true);
      }
      core.close();
    });
});

/** Every exported `*_SQL` string of a module. */
function exportedStatements(module: Record<string, unknown>): [string, string][] {
  return Object.entries(module).filter(
    (entry): entry is [string, string] => entry[0].endsWith("_SQL") && typeof entry[1] === "string",
  );
}

describe("every exported READ statement, without table statistics", () => {
  const statements = [...exportedStatements(readSql), ...exportedStatements(rewardSql)];
  test("the READ modules export their statements", () => {
    expect(statements.length).toBeGreaterThan(20);
  });
  for (const [name, sql] of statements)
    test(`${name} reaches its rows by key`, () => {
      const { sqlite } = createSqliteReadDatabase();
      expect(wholeTableReads(sqlite, sql, READ_SINGLETONS)).toEqual([]);
      sqlite.close();
    });
});

// The rows a chunk writes, in both READ writers, restate that the build is
// still `building` under the chunk's lease. That condition names no column of
// the row, so it is one search of the build by its key per statement, the same
// search the chunk's checkpoint makes.
describe("the READ chunk writes, without table statistics", () => {
  test("every row and checkpoint finds its build by key", async () => {
    const { db, prepared } = preparedStatements();
    const context = { lease: "lease", fence: 1, now: "2026-01-01T00:00:00.000Z", rowsWritten: 0 };
    // Nothing runs, so a row needs only what the writer reads off it.
    const row = { row: { rowSeq: 0 } as never, digest: "digest" };
    await writeRowChunk(db, "s", [row], context);
    await writeScopeRelations(db, "s", [{ source: "decision" } as never], context);
    await rewardSql.writeRewardEstimateChunk(db, "s", [row], context);
    await rewardSql.writeRewardSimulationChunk(db, "s", [row], context);
    const inserts = prepared.filter((sql) => /^\s*INSERT\b/iu.test(sql));
    // A row statement and its checkpoint, per chunk.
    expect(inserts.length).toBe(4 * 2);
    const { sqlite } = createSqliteReadDatabase();
    for (const sql of inserts) {
      const plan = planOf(sqlite, sql);
      expect(wholeTableReads(sqlite, sql, READ_SINGLETONS)).toEqual([]);
      expect(
        plan.some((step) =>
          /^SEARCH s EXISTS USING INDEX sqlite_autoindex_\w+_snapshots_1 [(]snapshot_id=[?][)]$/u.test(
            step,
          ),
        ),
        plan.join("\n"),
      ).toBe(true);
      expect(
        plan.some((step) => step.includes("CORRELATED")),
        plan.join("\n"),
      ).toBe(false);
    }
    sqlite.close();
  });
});

// The cash read's projection scan (`measureRows`, ADR 0123 amendment of
// 2026-11-20): one fixed snapshot's latest rows, under every filter the route
// takes, reached through an index that leads with the snapshot. No plan reads
// the projection rows of every snapshot.
describe("the projection measure read, without table statistics", () => {
  const scopes: [string, CollectionScope][] = [
    ["no filter", {}],
    ["a source", { source: "s" }],
    ["an account", { account: "a" }],
    ["a unit", { instrument: "i" }],
    ["a source, an account and a unit", { source: "s", account: "a", instrument: "i" }],
  ];
  for (const [name, scope] of scopes)
    test(`${name}: searches one snapshot by key`, () => {
      const { sqlite } = createSqliteReadDatabase();
      const query = projectionMeasureSql("snapshot", scope);
      const plan = planOf(sqlite, query.sql, query.args);
      expect(wholeTableReads(sqlite, query.sql, READ_SINGLETONS)).toEqual([]);
      expect(
        plan.some(
          (step) =>
            step.startsWith("SEARCH current_balance_projection USING ") &&
            step.includes("snapshot_id=?"),
        ),
        plan.join("\n"),
      ).toBe(true);
      sqlite.close();
    });
});
