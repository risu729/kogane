import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { identitySweepFixture } from "./identity-sweep-fixture.ts";
import { fullCoreDatabase } from "./sqlite.ts";
import { identitySweepCandidatesSql } from "../src/core/identity-sweep-sql.ts";

const legacy = readFileSync(
  new URL("./fixtures/identity-sweep-legacy.sql", import.meta.url),
  "utf8",
);
beforeAll(() => fullCoreDatabase().close(), 30000);

for (const [size, seed] of [
  [50, 1],
  [300, 29],
  [2000, 731],
] as const) {
  test(`identity candidate SQL equals frozen text: ${size} rows, seed ${seed}`, () => {
    using db = identitySweepFixture(size, seed);
    for (const source of [null, "identity-fixture", "mizuho-bank", "vpass", "absent"]) {
      for (const limit of [1, 8, 40, 10000]) {
        const expected = db.query(legacy).all(source, limit);
        if (source === null) expect(expected.length).toBeGreaterThan(0);
        expect(db.query(identitySweepCandidatesSql(source !== null)).all(source, limit)).toEqual(
          expected,
        );
      }
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    if (size === 2000) {
      const upgrades = db
        .query<{ id: number; required_policy: number }, [string, number]>(
          identitySweepCandidatesSql(true),
        )
        .all("mizuho-bank", 10000);
      expect(upgrades.some((row) => row.id <= size - 30 && row.required_policy === 2)).toBe(true);
    }
    for (const scoped of [false, true]) {
      const plan = db
        .query<{ detail: string }, [string | null, number]>(
          "EXPLAIN QUERY PLAN " + identitySweepCandidatesSql(scoped),
        )
        .all(scoped ? "mizuho-bank" : null, 40)
        .map((row) => row.detail);
      expect(plan).toContain("MATERIALIZE identity_page");
      expect(
        plan.some((line) => /SEARCH i USING INDEX sqlite_autoindex_identity_runs_2/u.test(line)),
      ).toBe(true);
      expect(plan.filter((line) => /SEARCH empty_row/u.test(line)).length).toBe(4);
    }
  }, 30000);
}
