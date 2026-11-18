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
    for (const source of [
      null,
      "identity-fixture",
      "mizuho-bank",
      "sbi-shinsei-bank",
      "vpass",
      "myjcb",
      "sbi-securities",
      "absent",
    ]) {
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
      for (const source of ["mizuho-bank", "sbi-shinsei-bank"]) {
        const upgrades = db
          .query<{ id: number; required_policy: number }, [string, number]>(
            identitySweepCandidatesSql(true),
          )
          .all(source, 10000);
        expect(upgrades.some((row) => row.id <= size - 30 && row.required_policy === 2)).toBe(true);
      }
    }
    // The fixed grid: a parse is a candidate only below its dataset's required
    // version, whatever the build's highest version is. An SBI Securities
    // trade, positions or cash balances parse sealed at 2 is one (ADR 0117)
    // and the cash history sealed at 1 is not; MyJCB keeps its ceiling of 2.
    const candidates = (source: string) =>
      new Set(
        db
          .query<{ id: number; required_policy: number }, [string, number]>(
            identitySweepCandidatesSql(true),
          )
          .all(source, 10000)
          .filter((row) => row.id > size)
          .map((row) => {
            const parse = db
              .query<{ dataset: string; sealed: number | null }, [number]>(
                "SELECT a.dataset,(SELECT max(i.policy_version) FROM identity_runs i WHERE i.parse_run_id=a.id) sealed FROM fetch_artifacts a WHERE a.id=?1",
              )
              .get(row.id)!;
            return `${parse.dataset}@${parse.sealed ?? "none"}->${row.required_policy}`;
          }),
      );
    // Each grid cell is there twice, empty and not.
    expect(candidates("sbi-securities")).toEqual(
      new Set([
        ...["foreign-trade-records", "foreign-cash-positions", "foreign-cash-balances"].flatMap(
          (dataset) => ["none", 1, 2].map((sealed) => `${dataset}@${sealed}->3`),
        ),
        "foreign-cash-history@none->1",
        "domestic-cash-positions@none->1",
      ]),
    );
    expect(candidates("myjcb")).toEqual(
      new Set(["jpoint-balance@none->2", "jpoint-balance@1->2", "card-statements@none->1"]),
    );
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
