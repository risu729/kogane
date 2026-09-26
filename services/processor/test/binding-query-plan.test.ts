import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

test("trusted binding lookup flattens to artifact primary key with the complete production schema", () => {
  const db = new Database(":memory:");
  const dir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
  const query =
    "EXPLAIN QUERY PLAN SELECT * FROM trusted_vpass_card_bindings WHERE financial_artifact_id=123";
  const correlated =
    "EXPLAIN QUERY PLAN SELECT p.id FROM parse_runs p WHERE EXISTS(SELECT 1 FROM trusted_vpass_card_bindings b WHERE b.financial_artifact_id=p.fetch_artifact_id) LIMIT 40";
  try {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      // 0021 is applied below; 0055 recreates the view again and is checked
      // after it (ADR 0023).
      if (file.startsWith("0021_") || file.startsWith("0055_")) continue;
      db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    const before = db
      .query<{ detail: string }, []>(query)
      .all()
      .map((r) => r.detail);
    const correlatedBefore = db
      .prepare<{ detail: string }, []>(correlated)
      .all()
      .map((r) => r.detail);
    expect(before.some((s) => s.includes("CO-ROUTINE"))).toBe(true);
    db.exec(readFileSync(new URL("0021_vpass_binding_lookup_plan.sql", dir), "utf8"));
    const after = db
      .prepare<{ detail: string }, []>(query)
      .all()
      .map((r) => r.detail);
    const correlatedAfter = db
      .prepare<{ detail: string }, []>(correlated)
      .all()
      .map((r) => r.detail);
    expect(correlatedBefore.some((s) => s.includes("CO-ROUTINE candidates"))).toBe(true);
    expect(correlatedBefore.some((s) => s.includes("SEARCH fa") && s.includes("source_id=?"))).toBe(
      true,
    );
    expect(correlatedAfter.some((s) => s.includes("CO-ROUTINE"))).toBe(false);
    expect(
      correlatedAfter.some((s) => s.includes("SEARCH fa USING INTEGER PRIMARY KEY (rowid=?)")),
    ).toBe(true);
    for (const view of ["eligible_identity_runs", "current_identity_observations"]) {
      const plan = db
        .prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT * FROM ${view} LIMIT 40`)
        .all()
        .map((r) => r.detail);
      expect(plan.some((s) => s.includes("CO-ROUTINE candidates"))).toBe(false);
      expect(plan.some((s) => s.startsWith("SEARCH fa USING ") && s.includes("rowid=?"))).toBe(
        true,
      );
    }
    expect(after.some((s) => s.includes("CO-ROUTINE"))).toBe(false);
    expect(after.some((s) => s.includes("SEARCH fa USING INTEGER PRIMARY KEY (rowid=?)"))).toBe(
      true,
    );
    expect(after.some((s) => s.startsWith("SCAN "))).toBe(false);

    // Migration 0055 recreates the view as one select for both producers
    // (ADR 0023). Every read of it keeps the plan 0021 gave it: the lookup by
    // artifact, the correlated lookup, and the identity views that join it,
    // step for step, without table statistics. A UNION ALL form was
    // materialized whole behind an automatic index inside
    // `eligible_identity_runs`; the shipped view must never be.
    const reads = [
      query,
      correlated,
      "EXPLAIN QUERY PLAN SELECT * FROM eligible_identity_runs LIMIT 40",
      "EXPLAIN QUERY PLAN SELECT * FROM current_identity_observations LIMIT 40",
      "EXPLAIN QUERY PLAN SELECT financial_unit_id,financial_unit_key,binding_artifact_id,card_token FROM trusted_vpass_card_bindings WHERE financial_artifact_id=? LIMIT 2",
    ];
    const plans = () =>
      reads.map((sql) =>
        db
          .prepare<{ detail: string }, []>(sql)
          .all()
          .map((r) => r.detail),
      );
    const with0021 = plans();
    db.exec(readFileSync(new URL("0055_vpass_collector_card_binding.sql", dir), "utf8"));
    const with0055 = plans();
    // The same steps as with 0021, in any order, except that a step 0021 took
    // may be replaced by another keyed search (the identity views reach the
    // binding run by its unique key instead of its row id); never by a scan,
    // an automatic index or a co-routine.
    const steps = (plan: string[]) =>
      plan.filter((s) => !/^CORRELATED SCALAR SUBQUERY \d+$/u.test(s)).sort();
    with0055.forEach((plan, index) => {
      const before = steps(with0021[index]!);
      const after = steps(plan);
      expect(after).toHaveLength(before.length);
      const added = after.filter((step) => !before.includes(step));
      for (const step of added) {
        expect(step).toMatch(/^SEARCH (?:binding|bu) USING (?:INDEX|INTEGER PRIMARY KEY) .*=\?/u);
      }
      expect(after.filter((step) => step.startsWith("SCAN "))).toEqual(
        before.filter((step) => step.startsWith("SCAN ")),
      );
    });
    for (const plan of with0055) {
      expect(plan.some((s) => s.includes("CO-ROUTINE"))).toBe(false);
      expect(plan.some((s) => /^SEARCH (?:b|binding|fa|bu|ba) USING AUTOMATIC/u.test(s))).toBe(
        false,
      );
      expect(plan.some((s) => /^SCAN (?:fa|b|binding|bu|ba)\b/u.test(s))).toBe(false);
    }
  } finally {
    db.close();
  }
});
