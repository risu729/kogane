// The `projected` stage of an operation record (ADR 0048, amended): pending
// until the published READ snapshot covers the CORE revision stored when the
// execution was recorded published, completed after, and a closed reason —
// never completed — whenever READ cannot answer. Real CORE and READ migrations
// in `bun:sqlite`; synthetic ids, revisions and timestamps only.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { CORE_REVISION_SQL } from "../../read-model/src/source-revision.ts";
import {
  migrationFiles,
  migrationSql,
  READ_MIGRATIONS_URL,
} from "../../storage-d1/src/migrations.ts";
import { READ_INSTANCE_SQL, READ_POINTER_SQL } from "../../storage-d1/src/read/sql.ts";
import {
  claimCollectorStart,
  type OperationReceipt,
  projectionRequirement,
  projectionRequirementWrite,
  readOperation,
  recordCollectorOutcome,
  recordOperationStage,
} from "../src/index.ts";
import type { Principal } from "../src/command/contract.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

const OP = `op_${"e".repeat(64)}`;
const PRINCIPAL: Principal = {
  id: "operator-1",
  kind: "human",
  verification: "server",
  capabilities: [],
};
const ACCEPTED = "2026-09-11T00:00:00Z";
const PUBLISHED = "2026-09-11T00:20:00Z";
const SNAPSHOT = "a".repeat(64);
const INSTANCE = "instance-synthetic";

type Bind = string | number | null;

function readDatabase(): Database {
  const read = new Database(":memory:");
  for (const file of migrationFiles(READ_MIGRATIONS_URL))
    read.exec(migrationSql(READ_MIGRATIONS_URL, file));
  return read;
}

function executor(db: Database): SqlExecutor {
  return {
    first: async <T>(sql: string, args: readonly unknown[] = []) =>
      (db.query(sql).get(...(args as Bind[])) as T | null) ?? null,
    all: async <T>(sql: string, args: readonly unknown[] = []) =>
      db.query(sql).all(...(args as Bind[])) as T[],
  };
}

function coreRevision(core: Database): { source_revision: number; core_epoch: string } {
  return core.query(CORE_REVISION_SQL).get() as { source_revision: number; core_epoch: string };
}

/** Moves the CORE revision, as every write of a ledger table does (migration 0038). */
function bumpRevision(core: Database): void {
  core.run("UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1");
}

/** A READ instance of `contract`, one complete snapshot, and the pointer at `revision`. */
function publish(read: Database, revision: number, epoch: string, contract = "read-baseline-v1") {
  read.run(
    `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version)
     VALUES(1,?,?,?)`,
    [INSTANCE, ACCEPTED, contract],
  );
  read.run(
    `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,build_digest,
       contract_version,read_instance_id,source_revision,visibility_revision,core_epoch,status,
       row_count,output_digest,input_manifest_json,projection_release,created_at,completed_at)
     VALUES(?1,?1,1,?1,?1,?2,?3,?4,1,?5,'complete',0,?1,'{}','balance-projection-v1',?6,?6)`,
    [SNAPSHOT, contract, INSTANCE, revision, epoch, ACCEPTED],
  );
  read.run(
    `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
       core_epoch,read_instance_id,output_digest,switched_at) VALUES(1,?1,?2,1,?3,?4,?1,?5)`,
    [SNAPSHOT, revision, epoch, INSTANCE, ACCEPTED],
  );
}

/** Moves the pointer's watermark, as a capture that digests to the same content does. */
function verifyAt(read: Database, revision: number): void {
  read.run("UPDATE balance_snapshot_pointer SET source_revision=? WHERE id=1", [revision]);
}

/**
 * A collection through the real services up to adoption; then, when
 * `stamp` is on, the tracker's `published` batch: the guarded state move and
 * the requirement in one transaction.
 */
async function adoptedCollection(core: Database, stamp = true): Promise<void> {
  core.run(
    `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,source_id,
      request_json,status,dispatch_state,dispatch_attempts,available_at_ms,created_at,updated_at)
     VALUES(?,'collection','operator-1',?,?,'sony-bank','{}','accepted','dispatch_pending',0,0,?,?)`,
    [OP, OP, "c".repeat(64), ACCEPTED, ACCEPTED],
  );
  const store = sqliteCommandStore(core);
  const context = {
    store,
    operationId: OP,
    action: "collect" as const,
    acceptedAt: ACCEPTED,
    expiresAt: "2026-09-12T00:00:00Z",
    now: "2026-09-11T00:05:00Z",
  };
  const binding = { connectionId: "sony-bank", terminalSource: "sony-bank" };
  expect(await claimCollectorStart({ ...context, binding })).toBe(true);
  await recordCollectorOutcome({
    store,
    operationId: OP,
    now: "2026-09-11T00:06:00Z",
    nowMs: Date.parse("2026-09-11T00:06:00Z"),
    outcome: { kind: "collected", runIds: ["synthetic-run"] },
  });
  for (const stage of ["registered", "parsed", "adopted"] as const)
    await recordOperationStage({
      store,
      operationId: OP,
      stage,
      state: "completed",
      now: PUBLISHED,
      evidenceRef: "r_1",
    });
  // The publication the tracker saw moved the revision before its batch.
  bumpRevision(core);
  await store.batch([
    {
      sql: `UPDATE ops_collector_dispatches SET state='published',published_at=?2,finished_at=?2,
        updated_at=?2 WHERE operation_id=?1 AND state='collected'`,
      binds: [OP, PUBLISHED],
    },
    ...(stamp ? [projectionRequirementWrite(OP, PUBLISHED)] : []),
  ]);
}

async function receipt(core: Database, read: SqlExecutor | null): Promise<OperationReceipt> {
  const outcome = await readOperation({
    store: sqliteCommandStore(core),
    readStore: read,
    principal: PRINCIPAL,
    now: PUBLISHED,
    operationId: OP,
  });
  if (!outcome.ok) throw new Error("receipt missing");
  return outcome.receipt;
}

const projectedOf = (record: OperationReceipt) =>
  record.stages.find((stage) => stage.stage === "projected")!;

let core: Database;
let read: Database;
beforeAll(async () => {
  core = migratedDatabase();
  read = readDatabase();
  await adoptedCollection(core);
}, 60_000);
afterAll(() => {
  core.close();
  read.close();
});

describe("the requirement stored with publication", () => {
  test("is the CORE revision of the publishing batch, as a pending stage with no attempts", () => {
    const row = core
      .query(
        "SELECT state,evidence_ref,failure_code,attempts FROM ops_request_stages WHERE operation_id=? AND stage='projected'",
      )
      .get(OP) as Record<string, unknown>;
    const now = coreRevision(core);
    expect(row).toEqual({
      state: "pending",
      evidence_ref: `core-revision:${now.core_epoch}:${now.source_revision}`,
      failure_code: null,
      attempts: 0,
    });
    // Parsed back exactly; nothing else is a requirement.
    expect(projectionRequirement(row["evidence_ref"] as string)).toEqual({
      coreEpoch: now.core_epoch,
      sourceRevision: now.source_revision,
    });
    for (const other of [null, "r_1", "core-revision:", "core-revision:epoch", "core-revision::5"])
      expect(projectionRequirement(other)).toBeNull();
    expect(projectionRequirement("core-revision:a:b:12")).toEqual({
      coreEpoch: "a:b",
      sourceRevision: 12,
    });
  });

  test("is written only by the batch that moved the execution, and never replaced", async () => {
    const store = sqliteCommandStore(core);
    const before = core.query("SELECT * FROM ops_request_stages WHERE stage='projected'").all();
    bumpRevision(core);
    // Another time: the row was not moved by this batch.
    expect(
      (await store.batch([projectionRequirementWrite(OP, "2026-09-11T01:00:00Z")]))[0],
    ).toEqual({ changes: 0 });
    // The same time again: the stored requirement stays.
    expect((await store.batch([projectionRequirementWrite(OP, PUBLISHED)]))[0]).toEqual({
      changes: 0,
    });
    expect(core.query("SELECT * FROM ops_request_stages WHERE stage='projected'").all()).toEqual(
      before,
    );
  });
});

describe("projected is derived at read time", () => {
  test("before adoption nothing is derived: a plain pending stage", async () => {
    const local = migratedDatabase();
    local.run(
      `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,source_id,
        request_json,status,dispatch_state,dispatch_attempts,available_at_ms,created_at,updated_at)
       VALUES(?,'collection','operator-1',?,?,'sony-bank','{}','accepted','dispatch_pending',0,0,?,?)`,
      [OP, OP, "c".repeat(64), ACCEPTED, ACCEPTED],
    );
    const record = await receipt(local, executor(read));
    expect(projectedOf(record)).toEqual({
      stage: "projected",
      state: "pending",
      evidenceRef: null,
      failureCode: null,
      attempts: 0,
      updatedAt: null,
    });
    local.close();
  });

  test("no READ binding, or nothing published in READ, is unavailable — never completed", async () => {
    for (const store of [null, executor(read)]) {
      const record = await receipt(core, store);
      expect(projectedOf(record)).toMatchObject({
        state: "pending",
        evidenceRef: null,
        failureCode: "read_model_unavailable",
      });
      expect(record.status).toBe("running");
    }
  });

  test("a snapshot verified before the requirement is behind; after it, projected completes", async () => {
    const required = projectionRequirement(
      (
        core
          .query(
            "SELECT evidence_ref FROM ops_request_stages WHERE operation_id=? AND stage='projected'",
          )
          .get(OP) as { evidence_ref: string }
      ).evidence_ref,
    )!;
    publish(read, required.sourceRevision - 1, required.coreEpoch);
    const behind = await receipt(core, executor(read));
    expect(projectedOf(behind)).toMatchObject({
      state: "pending",
      failureCode: "projection_behind",
      evidenceRef: null,
    });
    expect(behind.status).toBe("running");

    verifyAt(read, required.sourceRevision);
    const covered = await receipt(core, executor(read));
    expect(projectedOf(covered)).toMatchObject({
      state: "completed",
      evidenceRef: `read-snapshot:${SNAPSHOT}`,
      failureCode: null,
      attempts: 0,
      updatedAt: PUBLISHED,
    });
    expect(covered.stages.map((stage) => stage.state)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(covered.status).toBe("completed");
    // A later snapshot still covers it.
    verifyAt(read, required.sourceRevision + 5);
    expect(projectedOf(await receipt(core, executor(read))).state).toBe("completed");
    // Derived, not written: the stored rows did not move.
    expect(core.query("SELECT status FROM ops_requests WHERE operation_id=?").get(OP)).toEqual({
      status: "running",
    });
    expect(
      core
        .query("SELECT state FROM ops_request_stages WHERE operation_id=? AND stage='projected'")
        .get(OP),
    ).toEqual({ state: "pending" });
  });

  test("a READ store that cannot be read is unavailable", async () => {
    const failing: SqlExecutor = {
      first: () => Promise.reject(new Error("D1_ERROR: synthetic")),
      all: () => Promise.reject(new Error("D1_ERROR: synthetic")),
    };
    expect(projectedOf(await receipt(core, failing)).failureCode).toBe("read_model_unavailable");
  });

  test("another READ contract is unavailable, whatever its pointer says", async () => {
    const other = readDatabase();
    const now = coreRevision(core);
    publish(other, now.source_revision + 10, now.core_epoch, "read-baseline-v0");
    const record = await receipt(core, executor(other));
    expect(projectedOf(record)).toMatchObject({
      state: "pending",
      failureCode: "read_model_unavailable",
    });
    expect(record.status).toBe("running");
    other.close();
  });

  test("a pointer or a CORE of another epoch is a changed context", async () => {
    const now = coreRevision(core);
    const other = readDatabase();
    publish(other, now.source_revision + 10, "core-epoch-other");
    expect(projectedOf(await receipt(core, executor(other))).failureCode).toBe(
      "read_model_context_changed",
    );
    other.close();
    // CORE restored under a new epoch: the stored revision no longer orders anything.
    const restored = Database.deserialize(core.serialize());
    restored.run("UPDATE core_source_revision SET core_epoch='core-epoch-restored' WHERE id=1");
    const record = await receipt(restored, executor(read));
    expect(projectedOf(record)).toMatchObject({
      state: "pending",
      failureCode: "read_model_context_changed",
    });
    expect(record.status).toBe("running");
    restored.close();
  });

  test("an execution published without a stored requirement can never be shown projected", async () => {
    const local = migratedDatabase();
    await adoptedCollection(local, false);
    const now = coreRevision(local);
    const covering = readDatabase();
    publish(covering, now.source_revision + 10, now.core_epoch);
    const record = await receipt(local, executor(covering));
    expect(projectedOf(record)).toMatchObject({
      state: "pending",
      evidenceRef: null,
      failureCode: "projection_revision_unrecorded",
    });
    expect(record.status).toBe("running");
    covering.close();
    local.close();
  });
});

describe("the cost of the new statements on stores without statistics", () => {
  test("the requirement write and the coverage reads are singleton or primary-key lookups", () => {
    const readDb = readDatabase();
    for (const db of [core, readDb])
      expect(
        db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
      ).toEqual({ n: 0 });
    const write = projectionRequirementWrite(OP, PUBLISHED);
    const statements: [Database, string, readonly unknown[]][] = [
      [core, write.sql, write.binds],
      [core, CORE_REVISION_SQL, []],
      [readDb, READ_INSTANCE_SQL, []],
      [readDb, READ_POINTER_SQL, []],
    ];
    for (const [db, sql, args] of statements) {
      const steps = explain(db, sql, args);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((step) => step.detail.startsWith("SCAN "))).toEqual([]);
    }
    readDb.close();
  });
});
