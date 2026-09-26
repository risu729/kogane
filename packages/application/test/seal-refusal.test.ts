// Which seal errors are CORE's verdict on a run (ADR 0024, amendment of
// 2026-09-26). The D1 message shape is the one workerd's D1 produces for a
// trigger RAISE; the SQLite shape is produced here by a real trigger.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { sealRefusalCode } from "../src/collection/seal-refusal.ts";

function sqliteError(raise: string, statement = "INSERT INTO t VALUES (1)"): unknown {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec(`CREATE TRIGGER tr BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, '${raise}'); END`);
  try {
    db.exec(statement);
  } catch (error) {
    return error;
  }
  throw new Error("the statement did not fail");
}

test("a D1 trigger refusal of the completeness trigger is the closed code", () => {
  const message =
    "D1_ERROR: run_inventory_incomplete: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)";
  expect(sealRefusalCode(new Error(message))).toBe("run_inventory_incomplete");
  // The cause carries the same text without the prefix; the short form too.
  expect(
    sealRefusalCode(
      new Error(
        "run_inventory_incomplete: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      ),
    ),
  ).toBe("run_inventory_incomplete");
  expect(sealRefusalCode(new Error("run_inventory_incomplete: SQLITE_CONSTRAINT_TRIGGER"))).toBe(
    "run_inventory_incomplete",
  );
});

test("SQLite's own trigger error is classified the same way", () => {
  expect(sealRefusalCode(sqliteError("run_inventory_incomplete"))).toBe("run_inventory_incomplete");
});

test("any other error is not a verdict and is left to rethrow", () => {
  // Another seal trigger's code: configuration or a race, not this run.
  expect(sealRefusalCode(sqliteError("inactive_ingest_route"))).toBeNull();
  expect(sealRefusalCode(sqliteError("immutable_duplicate_insert"))).toBeNull();
  expect(
    sealRefusalCode(
      new Error(
        "D1_ERROR: inactive_ingest_route: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      ),
    ),
  ).toBeNull();
  // A constraint that is not a trigger, a schema error, a platform error.
  expect(
    sealRefusalCode(
      new Error(
        "D1_ERROR: run_inventory_incomplete: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
      ),
    ),
  ).toBeNull();
  expect(sealRefusalCode(new Error("D1_ERROR: no such table: nope: SQLITE_ERROR"))).toBeNull();
  expect(
    sealRefusalCode(new Error("D1_ERROR: Too many API requests by single worker invocation.")),
  ).toBeNull();
  // The bare code without the trigger's extended code is not enough.
  expect(sealRefusalCode(new Error("run_inventory_incomplete"))).toBeNull();
  expect(sealRefusalCode("run_inventory_incomplete")).toBeNull();
  expect(sealRefusalCode(undefined)).toBeNull();
});
