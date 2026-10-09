// The collector execution of an operation (issue #544, ADR 0048): the 0068
// guards that keep one start per operation, the trail's reading of a set of
// runs, and the cost of that read on a store without table statistics (D1 is
// never analyzed). Real CORE migrations in `bun:sqlite`; synthetic ids only.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  claimCollectorStart,
  collectorExecution,
  collectorRunTrails,
  type CollectorRunTrail,
  trailOutcome,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

let db: Database;
beforeAll(() => {
  db = migratedDatabase();
}, 60_000);
afterAll(() => db.close());

const OP = `op_${"b".repeat(64)}`;
const NOW = "2026-09-11T00:00:00Z";

function seedRequest(target: Database, operationId = OP, kind = "collection"): void {
  target.run(
    `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,source_id,
      request_json,status,dispatch_state,dispatch_attempts,available_at_ms,created_at,updated_at)
     VALUES(?,?,'operator-1',?,?,'sony-bank','{}','accepted','dispatch_pending',0,0,?,?)`,
    [operationId, kind, operationId, "c".repeat(64), NOW, NOW],
  );
}

describe("0068 keeps one start per operation and moves forward only", () => {
  test("a row is born before any start", () => {
    const local = migratedDatabase();
    seedRequest(local);
    expect(() =>
      local.run(
        `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
          starts,started_at,accepted_at,expires_at,updated_at)
         VALUES(?,'sony-bank','collect','sony-bank','started',1,?,?,?,?)`,
        [OP, NOW, NOW, NOW, NOW],
      ),
    ).toThrow(/recorded before it starts/u);
    local.close();
  });

  test("started never returns to waiting, terminal is never reopened, runs are written once", () => {
    const local = migratedDatabase();
    seedRequest(local);
    local.run(
      `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
        accepted_at,expires_at,updated_at) VALUES(?,'sony-bank','collect','sony-bank','waiting',?,?,?)`,
      [OP, NOW, NOW, NOW],
    );
    local.run(
      "UPDATE ops_collector_dispatches SET state='started',starts=1,started_at=? WHERE operation_id=?",
      [NOW, OP],
    );
    for (const sql of [
      "UPDATE ops_collector_dispatches SET state='waiting',starts=0,started_at=NULL WHERE operation_id=?",
      "UPDATE ops_collector_dispatches SET started_at='2026-09-11T00:00:01Z' WHERE operation_id=?",
      "UPDATE ops_collector_dispatches SET state='published',published_at='x' WHERE operation_id=?",
      "DELETE FROM ops_collector_dispatches WHERE operation_id=?",
    ])
      expect(() => local.run(sql, [OP])).toThrow();
    local.run(
      `UPDATE ops_collector_dispatches SET state='collected',run_ids_json='["r1"]',collected_at=?
        WHERE operation_id=?`,
      [NOW, OP],
    );
    expect(() =>
      local.run(
        "UPDATE ops_collector_dispatches SET run_ids_json='[\"r2\"]' WHERE operation_id=?",
        [OP],
      ),
    ).toThrow(/only moves forward/u);
    local.run(
      "UPDATE ops_collector_dispatches SET state='unpublished',reason_code='parse_failed' WHERE operation_id=?",
      [OP],
    );
    expect(() =>
      local.run("UPDATE ops_collector_dispatches SET state='collected' WHERE operation_id=?", [OP]),
    ).toThrow(/only moves forward/u);
    // Codes are closed: no provider text fits the column.
    const other = `op_${"d".repeat(64)}`;
    seedRequest(local, other);
    expect(() =>
      local.run(
        `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
          reason_code,accepted_at,expires_at,updated_at)
         VALUES(?,'sony-bank','collect','sony-bank','waiting','Provider said: try later',?,?,?)`,
        [other, NOW, NOW, NOW],
      ),
    ).toThrow();
    local.close();
  });
});

describe("0068 never starts or reopens an execution that ended", () => {
  // Each terminal state, reached through the legal transitions only.
  const paths: readonly [string, string, readonly string[]][] = [
    ["expired", "collect", ["state='expired',reason_code='operation_expired',finished_at=?2"]],
    ["unsupported", "collect", ["state='unsupported',reason_code='collection_unsupported'"]],
    [
      "failed",
      "collect",
      [
        "state='started',starts=1,started_at=?2",
        "state='failed',reason_code='collection_failed',finished_at=?2",
      ],
    ],
    [
      "uncertain",
      "collect",
      [
        "state='started',starts=1,started_at=?2",
        "state='uncertain',reason_code='dispatch_uncertain',finished_at=?2",
      ],
    ],
    [
      "refreshed",
      "refresh-session",
      ["state='started',starts=1,started_at=?2", "state='refreshed',finished_at=?2"],
    ],
    [
      "published",
      "collect",
      [
        "state='started',starts=1,started_at=?2",
        "state='collected',collected_at=?2,run_ids_json='[\"r1\"]'",
        "state='published',published_at=?2,finished_at=?2",
      ],
    ],
  ];

  for (const [state, action, steps] of paths)
    test(`${state} is never claimed, restarted or put back in the queue`, async () => {
      const local = migratedDatabase();
      const operationId = `op_${"e".repeat(63)}${paths.findIndex(([name]) => name === state)}`;
      seedRequest(local, operationId, action === "collect" ? "collection" : "session-refresh");
      local.run(
        `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
          accepted_at,expires_at,updated_at) VALUES(?1,'sony-bank',?2,'sony-bank','waiting',?3,?3,?3)`,
        [operationId, action, NOW],
      );
      for (const step of steps)
        local.run(
          `UPDATE ops_collector_dispatches SET ${step},updated_at=?2 WHERE operation_id=?1`,
          [operationId, NOW],
        );
      expect(
        local
          .query("SELECT state FROM ops_collector_dispatches WHERE operation_id=?")
          .get(operationId),
      ).toEqual({ state });
      // The service's guarded start finds nothing to claim.
      expect(
        await claimCollectorStart({
          store: sqliteCommandStore(local),
          operationId,
          action: action as "collect" | "refresh-session",
          acceptedAt: NOW,
          expiresAt: NOW,
          now: "2026-09-11T01:00:00Z",
          binding: { connectionId: "sony-bank", terminalSource: "sony-bank" },
        }),
      ).toBe(false);
      // And no direct write can restart or reopen it.
      for (const sql of [
        "UPDATE ops_collector_dispatches SET state='waiting',reason_code=NULL WHERE operation_id=?",
        "UPDATE ops_collector_dispatches SET state='started',starts=1,started_at='2026-09-11T02:00:00Z' WHERE operation_id=?",
        "UPDATE ops_collector_dispatches SET starts=2 WHERE operation_id=?",
        "UPDATE ops_collector_dispatches SET updated_at='2026-09-11T03:00:00Z' WHERE operation_id=?",
      ])
        expect(() => local.run(sql, [operationId])).toThrow();
      expect(
        local
          .query("SELECT state,starts FROM ops_collector_dispatches WHERE operation_id=?")
          .get(operationId),
      ).toEqual({ state, starts: state === "expired" || state === "unsupported" ? 0 : 1 });
      local.close();
    });
});

describe("the trail", () => {
  const run = (overrides: Partial<CollectorRunTrail>): CollectorRunTrail => ({
    runId: "r1",
    state: "published",
    reasonCode: null,
    blockedCode: null,
    providerOutcome: "success",
    evidenceRunId: "r_1",
    registeredAt: NOW,
    artifacts: {
      total: 2,
      parseSelected: 1,
      published: 1,
      pending: 0,
      parseFailed: 0,
      notPublished: 0,
    },
    ...overrides,
  });

  test("no reported run is a closed reason, not an empty success", () => {
    expect(trailOutcome([])).toMatchObject({
      settled: true,
      published: false,
      reasonCode: "run_not_reported",
    });
  });

  test("published needs every run settled and one adopted", () => {
    expect(trailOutcome([run({})])).toMatchObject({
      settled: true,
      published: true,
      registered: { state: "completed", evidenceRef: "r_1" },
      parsed: { state: "completed" },
      adopted: { state: "completed" },
    });
    // One run still parsing holds the whole trail open.
    expect(
      trailOutcome([run({}), run({ runId: "r2", state: "parsing", evidenceRunId: "r_2" })]),
    ).toMatchObject({ settled: false, adopted: { state: "pending" } });
    // A blocked registration settles as a reason, and the ladder says where.
    expect(
      trailOutcome([
        run({
          state: "blocked",
          reasonCode: "registration_blocked",
          blockedCode: "object_missing",
          evidenceRunId: null,
          artifacts: null,
        }),
      ]),
    ).toMatchObject({
      settled: true,
      published: false,
      reasonCode: "registration_blocked",
      registered: { state: "blocked", failureCode: "registration_blocked" },
      adopted: { state: "blocked", failureCode: "registration_blocked" },
    });
  });

  test("a run nobody registered reads as not registered", async () => {
    const store = sqliteCommandStore(db);
    expect(await collectorRunTrails(store, "sony-bank", ["never-seen"])).toEqual([
      {
        runId: "never-seen",
        state: "not_registered",
        reasonCode: null,
        blockedCode: null,
        providerOutcome: null,
        evidenceRunId: null,
        registeredAt: null,
        artifacts: null,
      },
    ]);
  });

  test("a request handed to a person is reported as waiting for them, with no expiry", async () => {
    const local = migratedDatabase();
    const store = sqliteCommandStore(local);
    expect(
      await collectorExecution(store, {
        operationId: OP,
        kind: "session-refresh",
        status: "waiting_for_human",
        acceptedAt: NOW,
      }),
    ).toMatchObject({ action: "refresh-session", state: "waiting_for_human", expiresAt: null });
    expect(
      await collectorExecution(store, {
        operationId: OP,
        kind: "import",
        status: "accepted",
        acceptedAt: NOW,
      }),
    ).toBeNull();
    local.close();
  });
});

describe("the trail's cost on a store without statistics", () => {
  test("every lookup is keyed; no run, artifact, job, parse or publication table is scanned", async () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    // Capture the statements the trail sends, with a registered run so the
    // artifact read is sent too.
    const sent: { sql: string; args: readonly unknown[] }[] = [];
    await collectorRunTrails(
      {
        first: async () => null,
        all: async <T>(sql: string, args: readonly unknown[] = []): Promise<T[]> => {
          sent.push({ sql, args });
          return sent.length === 1
            ? ([
                {
                  run_id: "r1",
                  blocked_code: null,
                  provider_outcome: "success",
                  fetch_run_id: 1,
                  registered_at: NOW,
                  processed_at_ms: 1,
                },
              ] as T[])
            : [];
        },
        batch: async () => [],
      },
      "sony-bank",
      ["r1", "r2"],
    );
    expect(sent).toHaveLength(2);
    for (const { sql, args } of sent) {
      const steps = explain(db, sql, args);
      const scans = steps
        .filter((step) => step.detail.startsWith("SCAN "))
        .map((step) => step.detail)
        // The run-id and fetch-run-id lists themselves are the only scans.
        .filter((detail) => !/^SCAN (r|json_each)\b/u.test(detail));
      expect(scans).toEqual([]);
    }
  });
});
