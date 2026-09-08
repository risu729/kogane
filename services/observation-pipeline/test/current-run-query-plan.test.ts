import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { identityQuery } from "../../evidence-browser/src/identity-api";

test("current identities select keyed eligible run winners before observation fanout", () => {
  const db = new Database(":memory:");
  const dir = new URL("../../raw-evidence/migrations/", import.meta.url);
  const core = "SELECT count(*) FROM current_identity_observations";
  const plan = (sql: string, values: number[] = []) =>
    db
      .prepare<{ detail: string }, number[]>("EXPLAIN QUERY PLAN " + sql)
      .all(...values)
      .map((r) => r.detail);
  try {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (file.startsWith("0022_")) continue;
      db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    const before = plan(core);
    // Even without metadata joins, the old view multiplies A reports by all
    // successful B parses before it checks the artifact relationship.
    expect(
      before.some((d) => /SCAN t USING INDEX idx_fetch_run_reports_one_terminal/.test(d)),
    ).toBe(true);
    expect(before.some((d) => /SEARCH p USING AUTOMATIC.*\(status=\?\)/.test(d))).toBe(true);
    db.exec(readFileSync(new URL("0022_identity_current_run_plan.sql", dir), "utf8"));
    for (const [sql, values] of [
      [core, []],
      [identityQuery("accounts", false), [0]],
      [identityQuery("instruments", false), [0]],
    ] as const) {
      const after = plan(sql, [...values]);
      expect(after.filter((d) => d === "MATERIALIZE candidates")).toHaveLength(1);
      expect(after.filter((d) => d === "MATERIALIZE latest")).toHaveLength(1);
      expect(after.some((d) => /SCAN t\b/.test(d))).toBe(false);
      expect(after.some((d) => /SEARCH p USING AUTOMATIC.*\(status=\?\)/.test(d))).toBe(false);
      expect(
        after.some((d) =>
          /SEARCH r USING INDEX sqlite_autoindex_identity_runs_2 \(parse_run_id=\?\)/.test(d),
        ),
      ).toBe(true);
      expect(
        after.some((d) =>
          /SEARCH o USING (COVERING )?INDEX sqlite_autoindex_identity_observations_2 \(identity_run_id=\?\)/.test(
            d,
          ),
        ),
      ).toBe(true);
    }
  } finally {
    db.close();
  }
});
