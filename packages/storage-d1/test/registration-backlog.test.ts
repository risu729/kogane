// The registration backlog reads the latest append-only stage of each open
// synthetic run, without treating a retryable refusal as a staged continuation.
import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readPendingRegistrations, readRegistrationBacklog } from "../src/core/collection-runs.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const VERSION = "terminal-registration-v2";
const NOW = "2099-01-01T00:00:00Z";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

function run(db: Database, id: number, version = VERSION, blocked: string | null = null): void {
  db.run(
    `INSERT INTO collection_runs(id,source,run_id,terminal_key,terminal_digest,
    registration_contract_version,provider_outcome,coverage_status,first_seen_at,blocked_code)
    VALUES(?,'synthetic',?,'runs/synthetic/run/terminal.json',?,?,'success','complete',?,?)`,
    [id, `run-${id}`, id.toString(16).padStart(64, "0"), version, NOW, blocked],
  );
}

function stage(db: Database, id: number, state: string, code: string | null, at: string): void {
  db.run(
    `INSERT INTO collection_run_stages(collection_run_id,stage,state,failure_code,recorded_at)
    VALUES(?,'registered',?,?,?)`,
    [id, state, code, at],
  );
}

test("backlog distinguishes latest retryable stages from pending and counts stored attempts", async () => {
  const db = fullCoreDatabase();
  try {
    run(db, 9001);
    stage(db, 9001, "pending", null, NOW);
    run(db, 9002);
    stage(db, 9002, "pending", null, NOW);
    stage(db, 9002, "retryable", "inactive_ingest_route", "2099-01-01T00:01:00Z");
    stage(db, 9002, "retryable", "inactive_ingest_route", "2099-01-01T01:01:00Z");
    run(db, 9003);
    stage(db, 9003, "retryable", "inactive_ingest_client", "2099-01-01T00:02:00Z");
    run(db, 9004);
    run(db, 9005, VERSION, "object_missing");
    stage(db, 9005, "blocked", "object_missing", NOW);
    run(db, 9006, "old-contract");
    stage(db, 9006, "retryable", "inactive_ingest_route", NOW);
    run(db, 9007);
    stage(db, 9007, "retryable", "inactive_ingest_route", NOW);
    stage(db, 9007, "pending", null, "2099-01-01T02:00:00Z");
    const adapter = sqliteD1(db);
    expect(await readRegistrationBacklog(adapter, VERSION)).toEqual({
      unregistered: 5,
      pending: 2,
      oldest_pending_first_seen_at: NOW,
      retryable: 2,
      retryable_attempts: 4,
      oldest_retryable_first_seen_at: NOW,
      latest_retryable_at: "2099-01-01T01:01:00Z",
      retryable_codes: [
        {
          code: "inactive_ingest_client",
          count: 1,
          attempts: 1,
          latest_at: "2099-01-01T00:02:00Z",
        },
        { code: "inactive_ingest_route", count: 1, attempts: 3, latest_at: "2099-01-01T01:01:00Z" },
      ],
      retryable_codes_truncated: false,
    });
    expect(await readPendingRegistrations(adapter, VERSION, 10)).toEqual([
      { source: "synthetic", run_id: "run-9001" },
      { source: "synthetic", run_id: "run-9007" },
    ]);
  } finally {
    db.close();
  }
});
