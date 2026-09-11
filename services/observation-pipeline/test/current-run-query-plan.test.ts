import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { identityQuery } from "../../evidence-browser/src/identity-api";

test("current identities select keyed eligible run winners before observation fanout", () => {
  const db = new Database(":memory:");
  const dir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
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
      // 0022 fixed the plan shape and 0026 (publication gate) re-defines the
      // same view over the projection; both are applied explicitly below.
      // 0036 only adds a trigger on a 0026 table, so it follows 0026, and
      // 0028 (release adoption) builds on 0026's tables too. The identity view
      // depends on neither, so 0028 is simply left out of this plan fixture.
      if (
        file.startsWith("0022_") ||
        file.startsWith("0026_") ||
        file.startsWith("0028_") ||
        file.startsWith("0036_")
      )
        continue;
      db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    const before = plan(core);
    // Even without metadata joins, the old view multiplies A reports by all
    // successful B parses before it checks the artifact relationship.
    expect(
      before.some((d) => /SCAN t USING INDEX idx_fetch_run_reports_one_terminal/.test(d)),
    ).toBe(true);
    expect(before.some((d) => /SEARCH p USING AUTOMATIC.*\(status=\?\)/.test(d))).toBe(true);
    for (const migration of [
      "0022_identity_current_run_plan.sql",
      "0026_publication_gate.sql",
      "0036_publication_event_guard.sql",
    ] as const) {
      db.exec(readFileSync(new URL(migration, dir), "utf8"));
      for (const [sql, values] of [
        [core, []],
        [identityQuery("accounts", false), [0]],
        [identityQuery("instruments", false), [0]],
      ] as const) {
        const after = plan(sql, [...values]);
        expect(
          after.filter((d) => d === "MATERIALIZE candidates"),
          migration,
        ).toHaveLength(1);
        expect(
          after.filter((d) => d === "MATERIALIZE latest"),
          migration,
        ).toHaveLength(1);
        expect(
          after.some((d) => /SCAN t\b/.test(d)),
          migration,
        ).toBe(false);
        expect(
          after.some((d) => /SEARCH p USING AUTOMATIC.*\(status=\?\)/.test(d)),
          migration,
        ).toBe(false);
        expect(
          after.some((d) =>
            /SEARCH r USING INDEX sqlite_autoindex_identity_runs_2 \(parse_run_id=\?\)/.test(d),
          ),
          migration,
        ).toBe(true);
        expect(
          after.some((d) =>
            /SEARCH o USING (COVERING )?INDEX sqlite_autoindex_identity_observations_2 \(identity_run_id=\?\)/.test(
              d,
            ),
          ),
          migration,
        ).toBe(true);
      }
    }
    // The gated view is driven by the projection: a scan of the pointer
    // table, then keyed lookups; parse_runs is never scanned by status.
    expect(
      plan(core).some((d) => /SCAN pub USING COVERING INDEX published_parse_runs_run/.test(d)),
    ).toBe(true);
  } finally {
    db.close();
  }
});
