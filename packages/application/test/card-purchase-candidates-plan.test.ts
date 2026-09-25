// The pending-to-posted candidate read (src/query/card-purchase-candidates.ts),
// shared by the card purchase page and a pending-to-posted review plan, on
// every CORE migration and without table statistics (D1 is never analyzed),
// read from `EXPLAIN QUERY PLAN`. It selects every stage B proposal whatever
// its status, so 0032's (status, kind, stage) index cannot serve it; it must
// use 0048's (kind, stage) index and never read every proposal, the stage A
// rows the reconciliation lane wrote before it stopped pairing collector
// fingerprints included. Synthetic only: nothing is inserted.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { explain, type PlanStep } from "../../read-model/test/card-usage-plan.ts";
import { loadPendingPostedCandidates } from "../src/query/card-purchase-candidates.ts";
import { migratedDatabase } from "./sqlite-store.ts";

let db: Database;
beforeAll(() => {
  db = migratedDatabase();
});
afterAll(() => db.close());

/** The statement and arguments the loader sends, captured without a result. */
async function candidateRead(
  filter: { keys: readonly string[] } | { proposalId: string },
): Promise<{ sql: string; args: readonly unknown[] }> {
  const sent: { sql: string; args: readonly unknown[] }[] = [];
  await loadPendingPostedCandidates(
    {
      all: async <T>(sql: string, args: readonly unknown[]): Promise<T[]> => {
        sent.push({ sql, args });
        return [];
      },
    },
    filter,
  );
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

/** The steps under the node whose detail is `detail`, directly or deeper. */
function under(steps: readonly PlanStep[], detail: string): PlanStep[] {
  const roots = new Set(steps.filter((step) => step.detail === detail).map((step) => step.id));
  const found: PlanStep[] = [];
  for (const step of steps)
    if (roots.has(step.parent)) {
      roots.add(step.id);
      found.push(step);
    }
  return found;
}

describe("pending-to-posted candidates on a store without statistics", () => {
  test("select the stage B proposals by the (kind, stage) index, never by a scan", async () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query("SELECT sql FROM sqlite_master WHERE name='reconciliation_proposals_kind_stage'")
        .get(),
    ).toEqual({
      sql: "CREATE INDEX reconciliation_proposals_kind_stage ON reconciliation_proposals(kind,stage)",
    });
    const key = JSON.stringify(["vpass", "producer", null, "vpass:card-001", "row"]);
    for (const filter of [{ keys: [key] }, { proposalId: "rp_synthetic" }]) {
      const { sql, args } = await candidateRead(filter);
      const steps = explain(db, sql, args);
      // The proposals CTE reads the proposal table once, through the index.
      expect(under(steps, "MATERIALIZE proposals").map((step) => step.detail)).toEqual([
        "SEARCH p USING INDEX reconciliation_proposals_kind_stage (kind=? AND stage=?)",
      ]);
      expect(steps.filter((step) => /^SCAN reconciliation_proposals\b/u.test(step.detail))).toEqual(
        [],
      );
    }
  });
});
