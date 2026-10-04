import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { retireReplacedJobsSql } from "../src/job-retirement-sql.ts";

const legacy = readFileSync(
  new URL("./fixtures/retire-replaced-jobs-legacy.sql", import.meta.url),
  "utf8",
);
const registry = JSON.stringify([
  { name: "fixture", version: "2.0.2", parts: [2, 0, 2] },
  { name: "other", version: "3.0.0", parts: [3, 0, 0] },
]);
const now = 1000;

function fixture(size: number, seed: number): Database {
  const db = new Database(":memory:");
  const dir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  // Only synthetic job/parse rows matter here; keep every production index
  // and trigger, with foreign keys off so unrelated evidence need not be seeded.
  db.exec("PRAGMA foreign_keys=OFF");
  let state = seed;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const job = db.prepare(`INSERT INTO observation_parse_jobs
    (fetch_artifact_id,parser_name,parser_version,status,last_error_code,lease_token,lease_until_ms)
    VALUES(?,?,?,?,?,?,?)`);
  const parse = db.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,?,?,'2026-01-01T00:00:00Z',?,'[]')`);
  const versions = [
    "1.0.0",
    "2.0.1",
    "2.0.2",
    "2.0.10",
    "3.0.0",
    "2.0.01",
    "bad",
    "2.0.2-beta",
    "9007199254740992.0.0",
  ];
  db.transaction(() => {
    for (let id = 1; id <= size; id += 1) {
      const name = id % 3 === 0 ? "other" : "fixture";
      for (const version of versions) {
        const status =
          id <= size - 30 ? "done" : ["pending", "failed", "running", "done"][random(4)]!;
        job.run(
          id,
          name,
          version,
          status,
          random(7) === 0 ? "parser_version_retired" : random(2) === 0 ? null : "parser_rejected",
          status === "running" ? "synthetic-lease" : null,
          random(2) === 0 ? 0 : now + 1,
        );
        if (random(3) !== 0) {
          const outcome = ["ok", "error", "pending"][random(3)]!;
          parse.run(id, name, version, outcome);
          if (outcome === "error") parse.run(id, name, version, "error");
        }
      }
    }
  })();
  return db;
}

for (const [size, seed] of [
  [50, 1],
  [200, 29],
  [2000, 731],
] as const) {
  test(`retirement matches frozen SQL with ${size} artifacts, seed ${seed}, without ANALYZE`, () => {
    const db = fixture(size, seed);
    try {
      const read = () =>
        db
          .query(
            "SELECT * FROM observation_parse_jobs ORDER BY fetch_artifact_id,parser_name,parser_version",
          )
          .all();
      const evidence = db.query("SELECT * FROM parse_runs ORDER BY id").all();
      for (const id of [null, size, size - 1, -1]) {
        db.exec("SAVEPOINT differential");
        const old = db.prepare(legacy).run(registry, id, now);
        if (id === null) expect(old.changes).toBeGreaterThan(0);
        const expected = read();
        db.exec("ROLLBACK TO differential");
        db.prepare(retireReplacedJobsSql(id !== null)).run(registry, id, now);
        expect(read()).toEqual(expected);
        expect(db.query("SELECT * FROM parse_runs ORDER BY id").all()).toEqual(evidence);
        db.exec("ROLLBACK TO differential; RELEASE differential");
      }
      for (const scoped of [false, true]) {
        const details = db
          .prepare<{ detail: string }, [string, number | null, number]>(
            "EXPLAIN QUERY PLAN " + retireReplacedJobsSql(scoped),
          )
          .all(registry, scoped ? size : null, now)
          .map((row) => row.detail);
        expect(details).toContain("MATERIALIZE candidates");
        expect(
          details.some((d) =>
            /SEARCH replacement USING INDEX sqlite_autoindex_observation_parse_jobs_1 \(fetch_artifact_id=\? AND parser_name=\? AND parser_version=\?\)/u.test(
              d,
            ),
          ),
        ).toBe(true);
        expect(
          details.some((d) =>
            /SCAN replacement|SEARCH replacement USING INDEX observation_jobs_ready/u.test(d),
          ),
        ).toBe(false);
        expect(
          details.some((d) => /SEARCH p(?: EXISTS)? USING INDEX idx_parse_runs_artifact/u.test(d)),
          details.join("\n"),
        ).toBe(true);
        if (scoped)
          expect(
            details.some((d) =>
              /SEARCH j USING INDEX sqlite_autoindex_observation_parse_jobs_1 \(fetch_artifact_id=\?(?: AND parser_name=\?)?\)/u.test(
                d,
              ),
            ),
          ).toBe(true);
      }
    } finally {
      db.close();
    }
  });
}
