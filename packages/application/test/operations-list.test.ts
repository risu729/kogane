// The operator's list of its own operations requests (ADR 0086), against the
// real CORE migrations on `bun:sqlite`. Synthetic only: the rows are made-up
// operation ids, principals and timestamps, with no source, payload text,
// amount or provider value.
//
// Three properties are pinned here:
//   * paging every filter shape to its end returns exactly the principal's
//     rows of that shape, newest first by (created_at, operation_id), each
//     once — checked against a plain in-memory reference on a random store
//     with many timestamp ties and a second principal;
//   * a cursor of another principal, or of no operation, is
//     `receipt_not_found`, the answer of one that does not exist;
//   * without table statistics, every shape reads `ops_requests` through an
//     index of migration 0040 (no table scan), each arm limited to the page.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Principal } from "../src/command/contract.ts";
import {
  listOperations,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  operationListArms,
  operationListSql,
  type OperationKind,
  type OperationListQuery,
  type OperationStatus,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const OPERATOR: Principal = {
  id: "list-operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const OTHER = "list-other-operator";

interface Row {
  operationId: string;
  principal: string;
  kind: OperationKind;
  status: OperationStatus;
  createdAt: string;
}

/** A small deterministic generator, so a failure reproduces. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function hex64(value: number): string {
  return value.toString(16).padStart(64, "0");
}

/** Inserts a request as accepted, then moves it to its status as an executor would. */
function insert(db: Database, row: Row): void {
  db.run(
    `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,
      source_id,request_json,status,dispatch_state,created_at,updated_at)
     VALUES(?1,?2,?3,?1,?4,NULL,'{}','accepted','dispatch_pending',?5,?5)`,
    [row.operationId, row.kind, row.principal, "0".repeat(64), row.createdAt],
  );
  if (row.status !== "accepted")
    db.run("UPDATE ops_requests SET status=?2 WHERE operation_id=?1", [
      row.operationId,
      row.status,
    ]);
}

/** A random store: few distinct seconds, so many rows share a `created_at`. */
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
    const row: Row = {
      operationId: `op_${hex64(id)}`,
      principal: random() < 0.75 ? OPERATOR.id : OTHER,
      kind: pick(OPERATION_KINDS),
      status: pick(OPERATION_STATUSES),
      createdAt: `2026-09-${String(10 + Math.floor(random() * 3)).padStart(2, "0")}T00:00:0${Math.floor(random() * 4)}Z`,
    };
    insert(db, row);
    rows.push(row);
  }
  return { db, rows };
}

function expected(rows: readonly Row[], query: Pick<OperationListQuery, "kind" | "status">) {
  return rows
    .filter(
      (row) =>
        row.principal === OPERATOR.id &&
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

async function pageThrough(
  db: Database,
  query: Omit<OperationListQuery, "cursor">,
): Promise<{ ids: string[]; pages: number }> {
  const store = sqliteCommandStore(db);
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const outcome = await listOperations({
      store,
      principal: OPERATOR,
      query: { ...query, cursor },
    });
    if (!outcome.ok) throw new Error(outcome.error);
    pages++;
    expect(outcome.page.operations.length).toBeLessThanOrEqual(query.limit);
    ids.push(...outcome.page.operations.map((operation) => operation.operationId));
    if (outcome.page.nextCursor === null) return { ids, pages };
    expect(outcome.page.operations.length).toBe(query.limit);
    cursor = outcome.page.nextCursor;
  }
}

const SHAPES: Pick<OperationListQuery, "kind" | "status">[] = [
  { kind: null, status: null },
  ...OPERATION_KINDS.map((kind) => ({ kind, status: null })),
  ...OPERATION_STATUSES.map((status) => ({ kind: null, status })),
  { kind: "collection", status: "running" },
  { kind: "session-refresh", status: "waiting_for_human" },
];

describe("listOperations", () => {
  test("pages every filter shape to exactly the principal's rows, newest first, each once", async () => {
    for (const seed of [1, 2, 3]) {
      const { db, rows } = randomStore(seed, 160);
      for (const shape of SHAPES)
        for (const limit of [1, 7, 50]) {
          const { ids } = await pageThrough(db, { ...shape, limit });
          expect(ids).toEqual(expected(rows, shape));
        }
      db.close();
    }
  });

  test("an empty list is one page with no cursor; an exact fit does not promise another", async () => {
    const db = migratedDatabase();
    const empty = await pageThrough(db, { kind: null, status: null, limit: 20 });
    expect(empty).toEqual({ ids: [], pages: 1 });
    for (let index = 0; index < 3; index++)
      insert(db, {
        operationId: `op_${hex64(index + 1)}`,
        principal: OPERATOR.id,
        kind: "projection",
        status: "accepted",
        createdAt: "2026-09-11T00:00:00Z",
      });
    // Three rows at a page size of three: one page, and no next cursor.
    expect(await pageThrough(db, { kind: null, status: null, limit: 3 })).toEqual({
      ids: [3, 2, 1].map((index) => `op_${hex64(index)}`),
      pages: 1,
    });
    db.close();
  });

  test("a summary carries identifiers, closed codes, counts and timestamps only", async () => {
    const db = migratedDatabase();
    insert(db, {
      operationId: `op_${hex64(9)}`,
      principal: OPERATOR.id,
      kind: "projection",
      status: "accepted",
      createdAt: "2026-09-11T00:00:00Z",
    });
    const outcome = await listOperations({
      store: sqliteCommandStore(db),
      principal: OPERATOR,
      query: { kind: null, status: null, cursor: null, limit: 20 },
    });
    expect(outcome).toEqual({
      ok: true,
      page: {
        schemaVersion: "kogane-operation-list-v1",
        operations: [
          {
            operationId: `op_${hex64(9)}`,
            kind: "projection",
            status: "accepted",
            source: null,
            dispatch: { state: "dispatch_pending", attempts: 0 },
            failureCode: null,
            acceptedAt: "2026-09-11T00:00:00Z",
            updatedAt: "2026-09-11T00:00:00Z",
          },
        ],
        nextCursor: null,
      },
    });
    db.close();
  });

  test("a cursor of another principal answers like one that does not exist", async () => {
    const db = migratedDatabase();
    const foreign = `op_${hex64(5)}`;
    insert(db, {
      operationId: foreign,
      principal: OTHER,
      kind: "collection",
      status: "accepted",
      createdAt: "2026-09-11T00:00:00Z",
    });
    const store = sqliteCommandStore(db);
    for (const cursor of [foreign, `op_${hex64(6)}`])
      expect(
        await listOperations({
          store,
          principal: OPERATOR,
          query: { kind: null, status: null, cursor, limit: 20 },
        }),
      ).toEqual({ ok: false, error: "receipt_not_found", refs: ["cursor"] });
    db.close();
  });
});

describe("the list's query plans, without table statistics", () => {
  test("every shape reads ops_requests through an index of 0040, one arm per pair", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    for (const shape of SHAPES)
      for (const after of [false, true]) {
        const arms = operationListArms(shape);
        const binds: unknown[] = ["p", 21];
        for (const [status, kind] of arms ?? []) binds.push(status, kind);
        if (after) binds.push("2026-09-11T00:00:00Z", `op_${hex64(1)}`);
        const plan = (
          db
            .query(`EXPLAIN QUERY PLAN ${operationListSql(arms?.length ?? null, after)}`)
            .all(...(binds as never[])) as { detail: string }[]
        ).map((row) => row.detail);
        const reads = plan.filter((line) => /\bops_requests\b/u.test(line));
        expect(reads.length).toBe(arms?.length ?? 1);
        const range = after ? " AND created_at<?" : "";
        for (const line of reads)
          expect(line).toBe(
            arms === null
              ? `SEARCH ops_requests USING INDEX ops_requests_principal (principal=?${range})`
              : `SEARCH ops_requests USING INDEX ops_requests_open (status=? AND kind=?${range})`,
          );
        // Only ties on the last order key are sorted where the index is read;
        // the merge sorts arms that are each limited to the page.
        expect(plan.join("\n")).not.toMatch(/^SCAN ops_requests/mu);
        if (arms === null) expect(plan.join("\n")).not.toContain("TEMP B-TREE FOR ORDER BY");
      }
    db.close();
  });
});
