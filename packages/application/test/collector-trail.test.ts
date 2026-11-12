// The collector execution of an operation (issue #544, ADR 0048): the 0068
// guards that keep one start per operation, the trail's reading of a set of
// runs, and the cost of that read on a store without table statistics (D1 is
// never analyzed). Real CORE migrations in `bun:sqlite`; synthetic ids only.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { validOperationRecord } from "../../observation-shared/src/operation-contract.ts";
import {
  claimCollectorStart,
  collectorExecution,
  collectorRunTrails,
  type CollectorRunTrail,
  readOperation,
  trackCollectorPublication,
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

function seedCollectionRun(
  target: Database,
  id: number,
  runId: string,
  blockedCode: string | null = null,
): void {
  target.run(
    `INSERT INTO collection_runs(id,source,run_id,terminal_key,terminal_digest,
      registration_contract_version,provider_outcome,coverage_status,first_seen_at,blocked_code)
     VALUES(?,'synthetic',?,'runs/synthetic/run/terminal.json',?,
      'terminal-registration-v2','success','complete',?,?)`,
    [id, runId, id.toString(16).padStart(64, "0"), NOW, blockedCode],
  );
}

function seedRegistrationStage(
  target: Database,
  id: number,
  state: string,
  code: string | null,
  at: string,
): void {
  target.run(
    `INSERT INTO collection_run_stages(collection_run_id,stage,state,failure_code,recorded_at)
     VALUES(?,'registered',?,?,?)`,
    [id, state, code, at],
  );
}

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
    registration: { state: "completed", failureCode: null, attempts: 1, updatedAt: NOW },
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
        registration: { state: "pending", failureCode: null, attempts: 0, updatedAt: null },
        artifacts: null,
      },
    ]);
  });

  test("latest retryable registration is visible, stays unsettled, and keeps its recorded attempts", async () => {
    const local = migratedDatabase();
    seedCollectionRun(local, 9001, "retryable");
    seedRegistrationStage(local, 9001, "pending", null, NOW);
    seedRegistrationStage(
      local,
      9001,
      "retryable",
      "inactive_ingest_route",
      "2026-09-11T00:01:00Z",
    );
    seedRegistrationStage(
      local,
      9001,
      "retryable",
      "inactive_ingest_route",
      "2026-09-11T01:01:00Z",
    );
    const runs = await collectorRunTrails(sqliteCommandStore(local), "synthetic", ["retryable"]);
    expect(runs[0]).toMatchObject({
      state: "retryable",
      reasonCode: "inactive_ingest_route",
      registration: {
        state: "retryable",
        failureCode: "inactive_ingest_route",
        attempts: 3,
        updatedAt: "2026-09-11T01:01:00Z",
      },
    });
    expect(trailOutcome(runs)).toMatchObject({
      settled: false,
      registered: { state: "retryable", failureCode: "inactive_ingest_route" },
      adopted: { state: "pending" },
    });
    seedRequest(local);
    local.run(
      `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
        accepted_at,expires_at,updated_at) VALUES(?,'synthetic','collect','synthetic','waiting',?,?,?)`,
      [OP, NOW, NOW, NOW],
    );
    local.run(
      "UPDATE ops_collector_dispatches SET state='started',starts=1,started_at=? WHERE operation_id=?",
      [NOW, OP],
    );
    local.run(
      `UPDATE ops_collector_dispatches SET state='collected',collected_at=?,
      run_ids_json='["retryable"]' WHERE operation_id=?`,
      [NOW, OP],
    );
    const result = await readOperation({
      store: sqliteCommandStore(local),
      operationId: OP,
      principal: { id: "operator-1", kind: "human", verification: "server", capabilities: [] },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validOperationRecord(result.receipt, OP)).toBe(true);
      expect(result.receipt.stages.find((stage) => stage.stage === "registered")).toMatchObject({
        state: "retryable",
        failureCode: "inactive_ingest_route",
        attempts: 3,
        updatedAt: "2026-09-11T01:01:00Z",
      });
    }
    for (const minute of [2, 3])
      expect(
        await trackCollectorPublication({
          store: sqliteCommandStore(local),
          operationId: OP,
          now: `2026-09-11T01:0${minute}:00Z`,
          nowMs: Date.parse(`2026-09-11T01:0${minute}:00Z`),
          checkIntervalMs: 300_000,
        }),
      ).toBe("pending");
    expect(
      local
        .query(`SELECT state,failure_code,attempts FROM ops_request_stages
      WHERE operation_id=? AND stage='registered'`)
        .get(OP),
    ).toEqual({
      state: "retryable",
      failure_code: "inactive_ingest_route",
      attempts: 1,
    });
    local.close();
  });

  test("legacy free-text registration failures are reduced to a closed code", async () => {
    const runs = await collectorRunTrails(
      {
        first: async () => null,
        all: async <T>(): Promise<T[]> =>
          [
            {
              run_id: "synthetic",
              blocked_code: null,
              provider_outcome: "success",
              fetch_run_id: null,
              registered_at: null,
              processed_at_ms: null,
              registration_state: "retryable",
              registration_failure_code: "Provider said: try again",
              registration_updated_at: NOW,
              registration_attempts: 1,
            },
          ] as T[],
        batch: async () => [],
      },
      "synthetic",
      ["synthetic"],
    );
    expect(runs[0]).toMatchObject({
      state: "retryable",
      reasonCode: "unclassified",
      registration: { failureCode: "unclassified" },
    });
  });

  test("registered revision wins over retryable history; blocked and absent runs stay distinct", async () => {
    const local = migratedDatabase();
    seedCollectionRun(local, 9010, "same");
    seedRegistrationStage(local, 9010, "retryable", "inactive_ingest_route", NOW);
    seedCollectionRun(local, 9011, "blocked", "object_missing");
    seedRegistrationStage(local, 9011, "blocked", "object_missing", NOW);
    seedCollectionRun(local, 9012, "same");
    seedRegistrationStage(local, 9012, "pending", null, NOW);
    seedCollectionRun(local, 9013, "unstaged");
    local.run(
      "INSERT INTO sources(id,provider,display_name) VALUES('synthetic','synthetic','Synthetic')",
    );
    local.run(
      "INSERT INTO producers(id,kind,display_name) VALUES('synthetic','collector','Synthetic')",
    );
    local.run(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('synthetic','synthetic')",
    );
    local.run("INSERT INTO ingest_clients(id,display_name) VALUES('synthetic','Synthetic')");
    local.run(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES('synthetic','synthetic')",
    );
    local.run(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('synthetic','synthetic','synthetic')",
    );
    local.run(`INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,
      external_id_namespace,external_session_id,first_recorded_at_ms)
      VALUES(9012,'synthetic','synthetic','synthetic','synthetic-session',0)`);
    local.run(`INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,
      first_recorded_by_client_id,first_recorded_at_ms)
      VALUES(9012,9012,'synthetic','synthetic','synthetic',0)`);
    local.run("UPDATE collection_runs SET fetch_run_id=9012,registered_at=? WHERE id=9012", [NOW]);
    seedRegistrationStage(local, 9012, "completed", null, NOW);
    const runs = await collectorRunTrails(sqliteCommandStore(local), "synthetic", [
      "same",
      "blocked",
      "unstaged",
      "absent",
    ]);
    expect(
      runs.map((run) => [run.state, run.registration.state, run.registration.attempts]),
    ).toEqual([
      ["parsing", "completed", 2],
      ["blocked", "blocked", 1],
      ["registering", "pending", 0],
      ["not_registered", "pending", 0],
    ]);
    expect(runs[0]?.evidenceRunId).toBe("r_9012");
    expect(runs[1]?.registration.failureCode).toBe("object_missing");
    seedRequest(local);
    local.run(
      `INSERT INTO ops_collector_dispatches(operation_id,connection_id,action,terminal_source,state,
        accepted_at,expires_at,updated_at) VALUES(?,'synthetic','collect','synthetic','waiting',?,?,?)`,
      [OP, NOW, NOW, NOW],
    );
    local.run(
      "UPDATE ops_collector_dispatches SET state='started',starts=1,started_at=? WHERE operation_id=?",
      [NOW, OP],
    );
    local.run(
      `UPDATE ops_collector_dispatches SET state='collected',collected_at=?,
      run_ids_json='["same"]' WHERE operation_id=?`,
      [NOW, OP],
    );
    const result = await readOperation({
      store: sqliteCommandStore(local),
      operationId: OP,
      principal: { id: "operator-1", kind: "human", verification: "server", capabilities: [] },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.receipt.stages.find((stage) => stage.stage === "registered")).toMatchObject({
        state: "completed",
        evidenceRef: "r_9012",
        failureCode: null,
        attempts: 2,
      });
    local.close();
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
                  registration_state: "completed",
                  registration_failure_code: null,
                  registration_updated_at: NOW,
                  registration_attempts: 1,
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
