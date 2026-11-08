import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { insertCollectionRunIfAbsent, readCollectionRun } from "../src/core/collection-runs.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const base = {
  source: "synthetic",
  runId: "failed",
  terminalKey: "runs/synthetic/failed/terminal.json",
  terminalDigest: "a".repeat(64),
  registrationContractVersion: "terminal-registration-v2",
  providerOutcome: "failed",
  coverageStatus: "unknown",
  acquisitionSessionRef: null,
  firstSeenAt: "2099-01-01T00:00:00.000Z",
  blockedCode: "provider_run_failed",
};

test("migration keeps old rows unknown and enforces the whole manifest code grammar", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE collection_runs(id INTEGER PRIMARY KEY, provider_outcome TEXT)");
    db.run("INSERT INTO collection_runs VALUES(1, 'failed')");
    db.exec(
      readFileSync(
        new URL("../migrations/core/0086_collection_provider_failure_code.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(db.query("SELECT provider_failure_code FROM collection_runs WHERE id=1").get()).toEqual({
      provider_failure_code: null,
    });
    for (const code of ["login-unrecognized-page", "0", "a_b-c", "x".repeat(100), null]) {
      expect(() =>
        db.run(
          "INSERT INTO collection_runs(provider_outcome,provider_failure_code) VALUES('failed',?)",
          [code],
        ),
      ).not.toThrow();
    }
    for (const code of [
      "",
      "x".repeat(101),
      "-code",
      "_code",
      "UPPER",
      "free text",
      "é",
      "x\n",
      "x\r",
      "x\0tail",
    ]) {
      expect(() =>
        db.run(
          "INSERT INTO collection_runs(provider_outcome,provider_failure_code) VALUES('failed',?)",
          [code],
        ),
      ).toThrow();
    }
    for (const outcome of ["success", "partial", null]) {
      expect(() =>
        db.run(
          "INSERT INTO collection_runs(provider_outcome,provider_failure_code) VALUES(?, 'login_failed')",
          [outcome],
        ),
      ).toThrow();
    }
    expect(() =>
      db.run("UPDATE collection_runs SET provider_failure_code='login_failed' WHERE id=1"),
    ).toThrow("immutable");
    expect(() =>
      db.run("UPDATE collection_runs SET provider_failure_code=NULL WHERE id=2"),
    ).toThrow("immutable");
  } finally {
    db.close();
  }
});

test("storage writes only failed, closed codes and preserves the first sighting", async () => {
  const db = fullCoreDatabase();
  try {
    const adapter = sqliteD1(db);
    const cases = [
      undefined,
      "",
      "private message",
      "x\n",
      "x\0tail",
      "x".repeat(101),
      "login-unrecognized-page",
      "9valid",
      "x".repeat(100),
    ];
    for (const [index, code] of cases.entries()) {
      const sighting = {
        ...base,
        runId: `failed-${index}`,
        ...(code === undefined ? {} : { providerFailureCode: code }),
      };
      await insertCollectionRunIfAbsent(adapter, sighting);
      const expected = index < 6 ? null : code;
      expect((await readCollectionRun(adapter, sighting))!.provider_failure_code).toBe(expected);
      expect(
        await insertCollectionRunIfAbsent(adapter, {
          ...sighting,
          providerFailureCode: "replacement",
        }),
      ).toBe(0);
      expect((await readCollectionRun(adapter, sighting))!.provider_failure_code).toBe(expected);
    }
    for (const outcome of ["success", "partial"]) {
      const sighting = {
        ...base,
        runId: outcome,
        providerOutcome: outcome,
        providerFailureCode: "login_failed",
      };
      await insertCollectionRunIfAbsent(adapter, sighting);
      expect((await readCollectionRun(adapter, sighting))!.provider_failure_code).toBeNull();
    }
  } finally {
    db.close();
  }
});
