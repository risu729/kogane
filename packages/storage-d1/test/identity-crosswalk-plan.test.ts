// ADR 0030: query plans of the identity crosswalk on the whole CORE schema,
// without table statistics (no ANALYZE has run on a fresh image, as on a store
// that never ran one). The resolver reads the crosswalk for every Vpass token
// and MoneyForward identity it maps, so that read must stay one indexed
// lookup. The proposal and the commit's re-measurement are one-time reads;
// they are pinned to reach observations through the identity lookup index and
// rows by key, not by scanning the observation tables.
import { expect, test } from "bun:test";
import {
  CROSSWALK_FROM_SQL,
  CROSSWALK_PAIR_SQL,
  CROSSWALK_PROPOSALS_SQL,
} from "../src/core/identity-crosswalk.ts";
import { fullCoreDatabase } from "./sqlite.ts";

function plan(sql: string): string[] {
  const db = fullCoreDatabase();
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'")
      .get()!.n,
  ).toBe(0);
  return db
    .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail);
}

test("the resolver's crosswalk read is one SEARCH of the (source, new value) unique index", () => {
  const steps = plan(CROSSWALK_FROM_SQL);
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatch(
    /^SEARCH account_identity_crosswalk USING (COVERING )?INDEX sqlite_autoindex_account_identity_crosswalk_\d+ \(source_id=\? AND to_account_ref=\?\)$/u,
  );
});

test("the proposal and the pair re-measurement read observations by index and rows by key", () => {
  for (const sql of [CROSSWALK_PROPOSALS_SQL, CROSSWALK_PAIR_SQL]) {
    const steps = plan(sql);
    expect(steps).toContain("SEARCH o USING INDEX identity_observation_lookup (kind=?)");
    expect(steps).toContain("SEARCH sa USING INDEX sqlite_autoindex_source_accounts_1 (id=?)");
    expect(steps).toContain("SEARCH t USING INTEGER PRIMARY KEY (rowid=?)");
    expect(
      steps.filter((step) =>
        /^SCAN (o|sa|identity_observations|source_accounts|transaction_observations)\b/u.test(step),
      ),
    ).toEqual([]);
  }
});
