// G2-17: every query the Drizzle pilot took over answers exactly what its
// native-SQL twin answers, and asks the database for it the same way.
//
// The two halves run against the *same* database — the whole CORE schema with
// the synthetic rows of `core-fixture.ts` — so nothing here depends on two
// fixtures agreeing. Three things are compared for each pair:
//
// 1. **The answer.** Deep equality, which for these rows means: NULL stays
//    null (never 0, "" or `undefined`), the ordering is BINARY and its tie is
//    broken by id, and text columns come back as the exact bytes stored.
// 2. **The plan.** `EXPLAIN QUERY PLAN` of every statement each half issued,
//    compared literally. A rewrite that turns an index search into a table
//    scan is not an equivalent query even when it returns the same rows, and
//    this is the check that decides whether a call site may switch (09 §7).
// 3. **The cost.** How many statements were issued and how many values were
//    bound. One read must stay one read: an ORM that answers a single-table
//    question with two round trips has changed the query, not the syntax.
//
// The statements are not spelled out in this file. They are recorded from the
// `D1Like` each half is handed, so the plan compared is the plan of the SQL
// that actually ran, and nothing can drift between the test and the code.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import * as drizzledArtifacts from "../src/drizzle/artifacts.ts";
import * as drizzledRuns from "../src/drizzle/fetch-runs.ts";
import * as drizzledRegistry from "../src/drizzle/ingest-registry.ts";
import * as drizzledObjects from "../src/drizzle/raw-objects.ts";
import * as nativeArtifacts from "../src/core/artifacts.ts";
import * as nativeRuns from "../src/core/fetch-runs.ts";
import * as nativeRegistry from "../src/core/ingest-registry.ts";
import * as nativeObjects from "../src/core/raw-objects.ts";
import type { D1Like, D1RunResultLike, D1StatementLike } from "../src/d1.ts";
import {
  CLIENT,
  OBJECT_SHA256,
  OTHER_CLIENT,
  REVOKED_CLIENT,
  RUN_ID,
  EMPTY_RUN_ID,
  pilotDatabase,
} from "./core-fixture.ts";
import { sqliteD1 } from "./sqlite.ts";

interface Issued {
  sql: string;
  binds: unknown[];
}

/** A `D1Like` that remembers every statement it was actually asked to run. */
function recording(db: D1Like): { db: D1Like; issued: Issued[] } {
  const issued: Issued[] = [];
  const wrap = (inner: D1StatementLike, sql: string, binds: unknown[]): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(inner.bind(...values), sql, values),
    first: async <T>(): Promise<T | null> => {
      issued.push({ sql, binds });
      return await inner.first<T>();
    },
    all: async <T>(): Promise<{ results: T[] }> => {
      issued.push({ sql, binds });
      return await inner.all<T>();
    },
    raw: async <T>(): Promise<T[]> => {
      issued.push({ sql, binds });
      return await inner.raw<T>();
    },
    run: async (): Promise<D1RunResultLike> => {
      issued.push({ sql, binds });
      return await inner.run();
    },
  });
  return {
    issued,
    db: {
      prepare: (sql: string) => wrap(db.prepare(sql), sql, []),
      batch: async (statements: D1StatementLike[]) => await db.batch(statements),
    },
  };
}

let database: Database;

beforeEach(() => {
  database = pilotDatabase();
});

/** The plan of each recorded statement, as SQLite explains it. */
function plans(issued: readonly Issued[]): string[][] {
  return issued.map((statement) =>
    (
      database
        .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...(statement.binds as never[])) as { detail: string }[]
    ).map((row) => row.detail),
  );
}

/**
 * Runs both halves against the same database and reports what each answered
 * and what each asked. The native half runs first; neither writes, except in
 * the one insert case, which uses a fresh database per half.
 */
async function both<T>(
  native: (db: D1Like) => Promise<T>,
  drizzle: (db: D1Like) => Promise<T>,
): Promise<{ native: T; drizzle: T; nativeIssued: Issued[]; drizzleIssued: Issued[] }> {
  const nativeSide = recording(sqliteD1(database));
  const drizzleSide = recording(sqliteD1(database));
  return {
    native: await native(nativeSide.db),
    drizzle: await drizzle(drizzleSide.db),
    nativeIssued: nativeSide.issued,
    drizzleIssued: drizzleSide.issued,
  };
}

/** The three comparisons, for a pair that must be indistinguishable. */
async function equivalent<T>(
  native: (db: D1Like) => Promise<T>,
  drizzle: (db: D1Like) => Promise<T>,
): Promise<T> {
  const run = await both(native, drizzle);
  expect(run.drizzle).toEqual(run.native);
  expect(plans(run.drizzleIssued)).toEqual(plans(run.nativeIssued));
  expect(run.drizzleIssued.length).toBe(run.nativeIssued.length);
  // Drizzle parameterises what the native statements write as literals — the
  // row limit, and the `1` of `active = 1` — so a statement may bind up to
  // two more values. It must never bind *fewer*: that would mean a filter the
  // native query applies has been dropped.
  for (const [index, statement] of run.drizzleIssued.entries()) {
    const extra = statement.binds.length - (run.nativeIssued[index]?.binds.length ?? 0);
    expect(extra, `${statement.sql} binds`).toBeGreaterThanOrEqual(0);
    expect(extra, `${statement.sql} binds`).toBeLessThanOrEqual(2);
  }
  return run.native;
}

describe("the pilot reads answer what the native reads answer (G2-17)", () => {
  test("raw_objects: the record of a stored object, and of one that is not", async () => {
    const found = await equivalent(
      (db) => nativeObjects.readRawObjectRecord(db, OBJECT_SHA256),
      (db) => drizzledObjects.readRawObjectRecord(db, OBJECT_SHA256),
    );
    expect(found).toEqual({
      sha256: OBJECT_SHA256,
      byte_size: 3,
      blob_key: `objects/aa/${OBJECT_SHA256}`,
    });
    // A miss is null on both sides — not undefined, not an empty object.
    const missing = await equivalent(
      (db) => nativeObjects.readRawObjectRecord(db, "f".repeat(64)),
      (db) => drizzledObjects.readRawObjectRecord(db, "f".repeat(64)),
    );
    expect(missing).toBeNull();
  });

  test("raw_objects: a zero byte size is a size, not an absence", async () => {
    // `byte_size` 0 is the value most easily lost to a `|| null`.
    const empty = await equivalent(
      (db) => nativeObjects.readRawObjectRecord(db, "b".repeat(64)),
      (db) => drizzledObjects.readRawObjectRecord(db, "b".repeat(64)),
    );
    expect(empty?.byte_size).toBe(0);
  });

  test("verification events: 'most recent' keeps its ordering and its tie", async () => {
    // Two events share 2000 ms; the later id wins on both sides.
    const recent = await equivalent(
      (db) => nativeObjects.readRecentVerification(db, OBJECT_SHA256, CLIENT, 0),
      (db) => drizzledObjects.readRecentVerification(db, OBJECT_SHA256, CLIENT, 0),
    );
    expect(recent).toEqual({ id: 3, result: "read_error" });
  });

  test("verification events: the window and the client both filter", async () => {
    const window = await equivalent(
      (db) => nativeObjects.readRecentVerification(db, OBJECT_SHA256, CLIENT, 2_500),
      (db) => drizzledObjects.readRecentVerification(db, OBJECT_SHA256, CLIENT, 2_500),
    );
    expect(window).toBeNull();
    const other = await equivalent(
      (db) => nativeObjects.readRecentVerification(db, OBJECT_SHA256, OTHER_CLIENT, 0),
      (db) => drizzledObjects.readRecentVerification(db, OBJECT_SHA256, OTHER_CLIENT, 0),
    );
    expect(other).toEqual({ id: 4, result: "missing" });
  });

  test("ingest_clients: an inactive client is not active on either path", async () => {
    expect(
      await equivalent(
        (db) => nativeRegistry.ingestClientActive(db, CLIENT),
        (db) => drizzledRegistry.ingestClientActive(db, CLIENT),
      ),
    ).toBe(true);
    expect(
      await equivalent(
        (db) => nativeRegistry.ingestClientActive(db, REVOKED_CLIENT),
        (db) => drizzledRegistry.ingestClientActive(db, REVOKED_CLIENT),
      ),
    ).toBe(false);
    expect(
      await equivalent(
        (db) => nativeRegistry.ingestClientActive(db, "never-registered"),
        (db) => drizzledRegistry.ingestClientActive(db, "never-registered"),
      ),
    ).toBe(false);
  });

  test("fetch_runs: the run behind an id, and nothing for an unknown one", async () => {
    expect(
      await equivalent(
        (db) => nativeRegistry.readFetchRun(db, RUN_ID),
        (db) => drizzledRegistry.readFetchRun(db, RUN_ID),
      ),
    ).toEqual({ id: RUN_ID, producer_id: "pilot-producer", source_id: "pilot-source" });
    expect(
      await equivalent(
        (db) => nativeRegistry.readFetchRun(db, 9_999),
        (db) => drizzledRegistry.readFetchRun(db, 9_999),
      ),
    ).toBeNull();
  });

  test("fetch_artifacts: the catalogue keeps its BINARY order", async () => {
    const catalogue = await equivalent(
      (db) => nativeArtifacts.readRunCatalogue(db, RUN_ID),
      (db) => drizzledArtifacts.readRunCatalogue(db, RUN_ID),
    );
    // "B.json" before "a.json": uppercase sorts first under BINARY, last under
    // NOCASE. An ORM that dropped the collation would return the other order.
    expect(catalogue.map((row) => row.artifact_key)).toEqual(["B.json", "a.json"]);
    const empty = await equivalent(
      (db) => nativeArtifacts.readRunCatalogue(db, EMPTY_RUN_ID),
      (db) => drizzledArtifacts.readRunCatalogue(db, EMPTY_RUN_ID),
    );
    expect(empty).toEqual([]);
  });

  test("fetch_run_reports: eleven NULL columns stay NULL", async () => {
    const terminal = await equivalent(
      (db) => nativeRuns.readRunReport(db, RUN_ID, "terminal"),
      (db) => drizzledRuns.readRunReport(db, RUN_ID, "terminal"),
    );
    expect(terminal).toEqual({
      id: 2,
      report_kind: "terminal",
      recorded_by_client_id: CLIENT,
      producer_version: null,
      producer_revision: null,
      manifest_schema_version: null,
      producer_status: null,
      normalized_outcome: "success",
      started_at_ms: null,
      started_at_basis: null,
      completed_at_ms: null,
      completed_at_basis: null,
      declared_artifact_count: null,
      artifact_count_scope: null,
    });
    const progress = await equivalent(
      (db) => nativeRuns.readRunReport(db, RUN_ID, "progress-1"),
      (db) => drizzledRuns.readRunReport(db, RUN_ID, "progress-1"),
    );
    expect(progress).toEqual({
      id: 1,
      report_kind: "progress",
      recorded_by_client_id: CLIENT,
      producer_version: "v1",
      producer_revision: "rev1",
      manifest_schema_version: "manifest-v1",
      producer_status: "running",
      normalized_outcome: "running",
      started_at_ms: 900,
      started_at_basis: "manifest",
      completed_at_ms: null,
      completed_at_basis: null,
      declared_artifact_count: 2,
      artifact_count_scope: "all_catalogued",
    });
  });
});

describe("the pilot append writes what the native append writes (G2-17)", () => {
  const EVENT = {
    sha256: OBJECT_SHA256,
    now: 4_000,
    result: "missing",
    observedSize: null,
    observedSha256: null,
    detailCode: null,
    clientId: CLIENT,
  };

  /** Every column of the appended row, on a database of its own. */
  async function append(
    insert: (db: D1Like, event: typeof EVENT) => Promise<{ id: number } | null>,
  ): Promise<{ id: number | null; row: unknown; issued: Issued[] }> {
    database = pilotDatabase();
    const side = recording(sqliteD1(database));
    const inserted = await insert(side.db, EVENT);
    const row = database
      .query("SELECT * FROM raw_object_verification_events WHERE checked_at_ms=4000")
      .all();
    return { id: inserted?.id ?? null, row, issued: side.issued };
  }

  test("a verification event lands as the same row, with the same id", async () => {
    const native = await append(nativeObjects.insertVerificationEvent);
    const drizzle = await append(drizzledObjects.insertVerificationEvent);
    expect(drizzle.row).toEqual(native.row);
    expect(drizzle.id).toBe(native.id);
    expect(drizzle.issued.length).toBe(native.issued.length);
    expect(drizzle.issued.map((statement) => statement.binds.length)).toEqual(
      native.issued.map((statement) => statement.binds.length),
    );
  });

  test("the trigger that refuses an inactive client refuses the ORM too", async () => {
    // The CHECK constraints and triggers of 0001 are not restated in the
    // table declaration; they hold because the database holds them.
    database = pilotDatabase();
    const db = sqliteD1(database);
    const failure = await drizzledObjects
      .insertVerificationEvent(db, { ...EVENT, clientId: REVOKED_CLIENT })
      .then(
        () => null,
        (error: unknown) => error as { message: string; cause?: unknown },
      );
    expect(failure).not.toBeNull();
    expect(String(failure?.cause)).toMatch(/inactive_ingest_client/u);
  });

  test("the ORM's failure message repeats every bound value", () => {
    // Recorded, not endorsed. Drizzle wraps a driver error in one whose
    // message is the SQL *and its parameters*; a native statement's error is
    // the database's own sentence. That is why the append below keeps the
    // native writer as its production path: a write's binds are the content
    // being recorded, and an error carrying them can reach a log
    // (docs/storage-d1.md, "Drizzle pilot").
    const database2 = pilotDatabase();
    const db = sqliteD1(database2);
    return drizzledObjects.insertVerificationEvent(db, { ...EVENT, clientId: REVOKED_CLIENT }).then(
      () => {
        throw new Error("the trigger should have refused this insert");
      },
      (error: unknown) => {
        expect((error as { message: string }).message).toContain("params:");
        expect((error as { message: string }).message).toContain(REVOKED_CLIENT);
      },
    );
  });
});
