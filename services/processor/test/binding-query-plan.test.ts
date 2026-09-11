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
      if (file.startsWith("0021_")) continue;
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
  } finally {
    db.close();
  }
});
