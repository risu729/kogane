// The source authority policy names sources by CORE `sources.id`. There is no
// closed list of those ids in code: the CORE migrations seed them, so the
// canonical set is what a database migrated from scratch holds. An id the
// policy names that CORE does not know would rank a real source `unreviewed`
// without any error, which is how MoneyForward did under v1 (ADR 0015).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { COLLECTOR_SOURCE_IDS } from "../../application/src/collection/descriptors.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../storage-d1/src/migrations.ts";
import {
  AUTHORITY_POLICY,
  AUTHORITY_POLICY_RELEASE,
  AUTHORITY_RANKS,
  authorityRank,
} from "../src/authority";

/** Every CORE source id, as the migrations leave the `sources` table. */
function coreSourceIds(): Set<string> {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const file of migrationFiles(CORE_MIGRATIONS_URL))
      db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    return new Set(
      db
        .query<{ id: string }, []>("SELECT id FROM sources")
        .all()
        .map((r) => r.id),
    );
  } finally {
    db.close();
  }
}

describe("source authority policy", () => {
  const core = coreSourceIds();

  test("every source the policy ranks is a CORE source id", () => {
    expect(core.size).toBeGreaterThan(0);
    const ids = AUTHORITY_POLICY.map(({ sourceId }) => sourceId);
    expect(ids.filter((id) => !core.has(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every CORE source a collector registers under has a reviewed rank", () => {
    const collected = [...new Set(Object.values(COLLECTOR_SOURCE_IDS))]
      .filter((id) => core.has(id))
      .sort();
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter((id) => authorityRank(id) === AUTHORITY_RANKS.unreviewed)).toEqual([]);
  });

  test("v2 ranks MoneyForward as the aggregator and Mizuho and St.George as direct", () => {
    expect(AUTHORITY_POLICY_RELEASE).toBe("source-authority-v2");
    expect(authorityRank("moneyforward-me")).toBe(AUTHORITY_RANKS.aggregator);
    expect(authorityRank("mizuho-bank")).toBe(AUTHORITY_RANKS.direct);
    expect(authorityRank("st-george")).toBe(AUTHORITY_RANKS.direct);
    // The v1 spelling is not a CORE id, so it is unreviewed like any unknown.
    expect(authorityRank("moneyforward")).toBe(AUTHORITY_RANKS.unreviewed);
  });
});
