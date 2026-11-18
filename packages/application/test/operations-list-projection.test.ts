// The list's `status` is the one the single read answers (ADR 0086, amendment
// of 2026-11-18, projection): a stored `running` request whose `projected`
// stage READ covers is listed `completed`, as `readOperation` reads it, while
// the `status` filter keeps matching the stored status, which every row
// carries as `storedStatus` and every page names in `statusFilterMatches`.
// Real CORE and READ migrations on `bun:sqlite`; synthetic ids, epochs,
// revisions and timestamps only.
//
// Pinned here:
//   * differential: on random stores, under every state READ can be in, every
//     row of every page of every filter shape has the status `readOperation`
//     answers for that id, and the stored status the filter matched;
//   * paging by the stored status is unchanged: each shape pages to exactly
//     the store's rows of that stored shape, each once, newest first;
//   * cost: a page of any size makes at most one stage read, one CORE
//     revision read and two READ reads beyond the list itself, and none at
//     all when no row on it can be derived;
//   * the stage read's plan, without table statistics, is a primary-key
//     search of `ops_request_stages` per id.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import type { CommandStore, Principal } from "../src/command/contract.ts";
import {
  listOperations,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  type OperationKind,
  type OperationListQuery,
  type OperationStatus,
  readOperation,
  recordStatuses,
  SELECT_STAGES_OF_PAGE,
  STAGES_BY_KIND,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";
import { publishedReadDatabase, sqliteExecutor } from "./read-store.ts";
import { validOperationListPage } from "../../observation-shared/src/operation-contract.ts";

const PRINCIPAL: Principal = {
  id: "list-projection-operator",
  kind: "human",
  verification: "server",
  capabilities: [],
};
const EPOCH = "core-epoch-1";
const AT = "2026-09-11T00:00:00Z";

function hex64(value: number): string {
  return value.toString(16).padStart(64, "0");
}

/** A small deterministic generator, so a failure reproduces. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const executor = sqliteExecutor;
const readDatabase = publishedReadDatabase;

/** What a stored request's stages are, for one that can reach `projected`. */
type StageShape =
  | "none" // no stage row at all
  | "adopting" // adopted not complete
  | "unrecorded" // every stage complete but projected, which carries no requirement
  | "missing" // every stage complete, no projected row
  | "required" // every stage complete but projected, pending at a requirement
  | "other-epoch" // as required, under another CORE epoch
  | "projected"; // every stage, projected included, stored complete

interface Row {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  createdAt: string;
}

/** Inserts a request as accepted, then moves it to its status as an executor would. */
function insertRequest(db: Database, row: Row): void {
  db.run(
    `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,
      source_id,request_json,status,dispatch_state,created_at,updated_at)
     VALUES(?1,?2,?3,?1,?4,NULL,'{}','accepted','dispatched',?5,?5)`,
    [row.operationId, row.kind, PRINCIPAL.id, "0".repeat(64), row.createdAt],
  );
  if (row.status !== "accepted")
    db.run("UPDATE ops_requests SET status=?2 WHERE operation_id=?1", [
      row.operationId,
      row.status,
    ]);
}

function insertStage(
  db: Database,
  operationId: string,
  stage: string,
  state: string,
  evidenceRef: string | null,
): void {
  db.run(
    `INSERT INTO ops_request_stages(operation_id,stage,state,evidence_ref,failure_code,attempts,updated_at)
     VALUES(?1,?2,?3,?4,NULL,1,?5)`,
    [operationId, stage, state, evidenceRef, AT],
  );
}

function insertStages(db: Database, row: Row, shape: StageShape, revision: number): void {
  const stages = STAGES_BY_KIND[row.kind];
  if (shape === "none") return;
  for (const stage of stages) {
    if (stage === "projected") {
      if (shape === "missing" || shape === "adopting") continue;
      if (shape === "projected") insertStage(db, row.operationId, stage, "completed", "r_1");
      else if (shape === "unrecorded") insertStage(db, row.operationId, stage, "pending", null);
      else
        insertStage(
          db,
          row.operationId,
          stage,
          "pending",
          `core-revision:${shape === "other-epoch" ? "core-epoch-0" : EPOCH}:${revision}`,
        );
      continue;
    }
    insertStage(
      db,
      row.operationId,
      stage,
      shape === "adopting" && stage === "adopted" ? "pending" : "completed",
      "r_1",
    );
  }
}

const SHAPES: readonly StageShape[] = [
  "none",
  "adopting",
  "unrecorded",
  "missing",
  "required",
  "other-epoch",
  "projected",
];

/**
 * A random store: every kind and status, few distinct seconds, and stages of
 * every shape on requests of every status, with requirements at revisions 1
 * to 6 — so a pointer at 3 covers some and not others.
 */
function randomStore(seed: number, size: number): { db: Database; rows: Row[] } {
  const random = generator(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const db = migratedDatabase();
  const rows: Row[] = [];
  const ids = new Set<number>();
  while (rows.length < size) {
    const id = Math.floor(random() * 2 ** 31);
    if (ids.has(id)) continue;
    ids.add(id);
    // Half the rows are running, so the derivation has many candidates.
    const row: Row = {
      operationId: `op_${hex64(id)}`,
      kind: pick(OPERATION_KINDS),
      status: random() < 0.5 ? "running" : pick(OPERATION_STATUSES),
      createdAt: `2026-09-1${Math.floor(random() * 3)}T00:00:0${Math.floor(random() * 4)}Z`,
    };
    insertRequest(db, row);
    insertStages(db, row, pick(SHAPES), 1 + Math.floor(random() * 6));
    rows.push(row);
  }
  return { db, rows };
}

/** Every state READ can be in, as the record sees it. */
const READ_STATES: { name: string; read: () => { executor: SqlExecutor | null; close(): void } }[] =
  [
    { name: "no READ binding", read: () => ({ executor: null, close() {} }) },
    {
      name: "READ published nothing",
      read: () => {
        const db = readDatabase(0, EPOCH, null);
        return { executor: executor(db), close: () => db.close() };
      },
    },
    {
      name: "READ of another contract",
      read: () => {
        const db = readDatabase(6, EPOCH, "read-baseline-v0");
        return { executor: executor(db), close: () => db.close() };
      },
    },
    {
      name: "READ that cannot be read",
      read: () => ({
        executor: {
          first: async () => {
            throw new Error("synthetic READ failure");
          },
          all: async () => {
            throw new Error("synthetic READ failure");
          },
        },
        close() {},
      }),
    },
    {
      name: "READ under another epoch",
      read: () => {
        const db = readDatabase(6, "core-epoch-0", "read-baseline-v1");
        return { executor: executor(db), close: () => db.close() };
      },
    },
    {
      name: "READ covering revision 3",
      read: () => {
        const db = readDatabase(3, EPOCH, "read-baseline-v1");
        return { executor: executor(db), close: () => db.close() };
      },
    },
    {
      name: "READ covering every requirement",
      read: () => {
        const db = readDatabase(6, EPOCH, "read-baseline-v1");
        return { executor: executor(db), close: () => db.close() };
      },
    },
  ];

const FILTERS: Pick<OperationListQuery, "kind" | "status">[] = [
  { kind: null, status: null },
  { kind: null, status: "running" },
  { kind: null, status: "completed" },
  { kind: "collection", status: "running" },
  { kind: "replay", status: null },
  { kind: "projection", status: "running" },
  { kind: "session-refresh", status: null },
];

function expected(rows: readonly Row[], query: Pick<OperationListQuery, "kind" | "status">) {
  return rows
    .filter(
      (row) =>
        (query.kind === null || row.kind === query.kind) &&
        (query.status === null || row.status === query.status),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.operationId.localeCompare(a.operationId)
        : b.createdAt.localeCompare(a.createdAt),
    )
    .map((row) => row.operationId);
}

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

describe("the listed status is the single read's", () => {
  test("every row of every page agrees with readOperation, under every READ state", async () => {
    for (const seed of [11, 12]) {
      const { db, rows } = randomStore(seed, 120);
      const store = sqliteCommandStore(db);
      const stored = new Map(rows.map((row) => [row.operationId, row.status]));
      for (const state of READ_STATES) {
        const read = state.read();
        // The status each id's single read answers under this READ state.
        const single = new Map<string, OperationStatus>();
        for (const row of rows) {
          const outcome = await readOperation({
            store,
            readStore: read.executor,
            principal: PRINCIPAL,
            now: AT,
            operationId: row.operationId,
          });
          if (!outcome.ok) throw new Error(outcome.error);
          single.set(row.operationId, outcome.receipt.status);
        }
        let derived = 0;
        for (const filter of FILTERS)
          for (const limit of [1, 7, 50]) {
            const ids: string[] = [];
            let cursor: string | null = null;
            for (;;) {
              const outcome = await listOperations({
                store,
                principal: PRINCIPAL,
                readStore: read.executor,
                query: { ...filter, cursor, limit },
              });
              if (!outcome.ok) throw new Error(outcome.error);
              const page = outcome.page;
              expect(page.statusFilterMatches).toBe("storedStatus");
              expect(
                validOperationListPage(page, {
                  kind: filter.kind ?? undefined,
                  status: filter.status ?? undefined,
                }),
              ).toBe(true);
              for (const summary of page.operations) {
                expect([state.name, summary.operationId, summary.status]).toEqual([
                  state.name,
                  summary.operationId,
                  single.get(summary.operationId)!,
                ]);
                expect(summary.storedStatus).toBe(stored.get(summary.operationId)!);
                if (summary.status !== summary.storedStatus) derived++;
              }
              ids.push(...page.operations.map((summary) => summary.operationId));
              if (page.nextCursor === null) break;
              cursor = page.nextCursor;
            }
            // The filter and the paging read the stored status, as before.
            expect(ids).toEqual(expected(rows, filter));
          }
        // Only a READ that covers a stored requirement of this epoch moves a status.
        if (state.name.startsWith("READ covering")) expect(derived).toBeGreaterThan(0);
        else expect(derived).toBe(0);
        read.close();
      }
      db.close();
    }
  }, 120_000);

  test("a running filter shows the completed record of a covered collection, and says what it matched", async () => {
    const db = migratedDatabase();
    const read = readDatabase(5, EPOCH, "read-baseline-v1");
    const covered: Row = {
      operationId: `op_${hex64(2)}`,
      kind: "collection",
      status: "running",
      createdAt: "2026-09-11T00:00:02Z",
    };
    const behind: Row = { ...covered, operationId: `op_${hex64(1)}`, createdAt: AT };
    insertRequest(db, covered);
    insertStages(db, covered, "required", 5);
    insertRequest(db, behind);
    insertStages(db, behind, "required", 6);
    const list = (status: OperationStatus) =>
      listOperations({
        store: sqliteCommandStore(db),
        principal: PRINCIPAL,
        readStore: executor(read),
        query: { kind: null, status, cursor: null, limit: 20 },
      });
    expect(await list("running")).toEqual({
      ok: true,
      page: {
        schemaVersion: "kogane-operation-list-v2",
        statusFilterMatches: "storedStatus",
        operations: [
          {
            operationId: covered.operationId,
            kind: "collection",
            status: "completed",
            storedStatus: "running",
            source: null,
            dispatch: { state: "dispatched", attempts: 0 },
            failureCode: null,
            acceptedAt: covered.createdAt,
            updatedAt: covered.createdAt,
          },
          {
            operationId: behind.operationId,
            kind: "collection",
            status: "running",
            storedStatus: "running",
            source: null,
            dispatch: { state: "dispatched", attempts: 0 },
            failureCode: null,
            acceptedAt: AT,
            updatedAt: AT,
          },
        ],
        nextCursor: null,
      },
    });
    // The completed filter matches the stored status: neither is stored completed.
    const completed = await list("completed");
    if (!completed.ok) throw new Error(completed.error);
    expect(completed.page.operations).toEqual([]);
    db.close();
    read.close();
  });
});

describe("the derivation's cost per page", () => {
  /** Counts each statement a store or READ executor is asked to run. */
  function counting<T extends Pick<CommandStore, "first" | "all">>(inner: T, calls: string[]): T {
    return {
      ...inner,
      first: (sql: string, binds?: readonly unknown[]) => {
        calls.push(sql);
        return inner.first(sql, binds);
      },
      all: (sql: string, binds?: readonly unknown[]) => {
        calls.push(sql);
        return inner.all(sql, binds);
      },
    } as T;
  }

  test("a fixed number of reads whatever the page holds, and none when no row can be derived", async () => {
    const db = migratedDatabase();
    const read = readDatabase(9, EPOCH, "read-baseline-v1");
    // Fifty derivable collections, then fifty that cannot be derived.
    for (let index = 1; index <= 100; index++) {
      const row: Row = {
        operationId: `op_${hex64(index)}`,
        kind: index > 50 ? "collection" : "projection",
        status: index > 50 ? "running" : "accepted",
        createdAt: `2026-09-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
      };
      insertRequest(db, row);
      if (index > 50) insertStages(db, row, "required", 1 + (index % 9));
    }
    for (const limit of [1, 50]) {
      const core: string[] = [];
      const reads: string[] = [];
      const outcome = await listOperations({
        store: counting(sqliteCommandStore(db), core) as CommandStore,
        principal: PRINCIPAL,
        readStore: counting(executor(read), reads),
        query: { kind: null, status: null, cursor: null, limit },
      });
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.page.operations.every((row) => row.status === "completed")).toBe(true);
      // The list, the page's stages in one read, CORE's epoch; READ's instance and pointer.
      expect(core).toHaveLength(3);
      expect(core.filter((sql) => sql === SELECT_STAGES_OF_PAGE)).toHaveLength(1);
      expect(reads).toHaveLength(2);
      // The next page of fifty is the requests that cannot be derived: the list read alone, and the cursor.
      if (limit === 50) {
        const after: string[] = [];
        const afterReads: string[] = [];
        const next = await listOperations({
          store: counting(sqliteCommandStore(db), after) as CommandStore,
          principal: PRINCIPAL,
          readStore: counting(executor(read), afterReads),
          query: { kind: null, status: null, cursor: outcome.page.nextCursor, limit },
        });
        if (!next.ok) throw new Error(next.error);
        expect(next.page.operations).toHaveLength(50);
        expect(next.page.operations.every((row) => row.status === row.storedStatus)).toBe(true);
        expect(after).toHaveLength(2);
        expect(afterReads).toHaveLength(0);
      }
    }
    db.close();
    read.close();
  });

  test("refuses to derive more rows than one page holds", async () => {
    const db = migratedDatabase();
    const rows = Array.from({ length: 51 }, (_, index) => ({
      operationId: `op_${hex64(index + 1)}`,
      kind: "collection" as const,
      status: "running" as const,
    }));
    await expect(recordStatuses(sqliteCommandStore(db), null, rows)).rejects.toThrow();
    expect((await recordStatuses(sqliteCommandStore(db), null, rows.slice(0, 50))).size).toBe(50);
    db.close();
  });

  test("the stage read is a primary-key search per id, without table statistics", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN ${SELECT_STAGES_OF_PAGE}`)
        .all(JSON.stringify([`op_${hex64(1)}`, `op_${hex64(2)}`])) as { detail: string }[]
    ).map((row) => row.detail);
    const stages = plan.filter((line) => /\bops_request_stages\b/u.test(line));
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatch(
      /^SEARCH ops_request_stages USING INDEX sqlite_autoindex_ops_request_stages_1 \(operation_id=\?\)$/u,
    );
    expect(plan.join("\n")).not.toMatch(/SCAN ops_request_stages/u);
    db.close();
  });
});
