// The lane audit's reads (src/lane-audit.ts) without table statistics, and
// the two `reconciliation_proposals` reads proven equal to the text #925
// shipped.
//
// D1 never runs `ANALYZE`, so its planner has no `sqlite_stat*` table. On that
// basis the shipped proposal ranges (`... GROUP BY kind`) walked the whole
// `reconciliation_proposals_kind_stage` index for the grouping order and
// checked the rowid on every entry, on every tick of `reconciliation_sweep` and
// `purchase_recognition`; the shipped reference read (`... AND kind=?3`)
// sought every proposal of the kind. Both now write `+kind` and range on the
// rowid. Every other read of the module is checked here too, so a later index
// that the planner prefers to a key range fails this test.
//
// Synthetic throughout: invented ids, digests and refs; no amount.
import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { LANE_AUDIT_SQL } from "../src/lane-audit.ts";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import {
  LEGACY_LANE_RECONCILIATION_PROPOSALS_SQL,
  LEGACY_LANE_RECONCILIATION_REF_SQL,
} from "./lane-audit-legacy-sql.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget (packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const KINDS = [
  "provider_same",
  "pending_to_posted",
  "supersedes",
  "supports",
  "contradicts",
  "funded_by",
  "statement_covers",
] as const;
const METHODS = ["rule", "manual", "ai"] as const;
const STAGES = ["A", "B", "C"] as const;

function generator(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/**
 * `size` proposals at rising rowids with random gaps (a rowid is a position,
 * not a count), of random kind, stage and method. `skew` leaves some kinds
 * out, so a range can hold no row of a kind. Foreign keys are off only so
 * that no evidence need be seeded; every trigger and index stays.
 */
function store(size: number, seed: number, skew = false): { db: Database; rowids: number[] } {
  const db = fullCoreDatabase();
  db.exec("PRAGMA foreign_keys=OFF");
  const random = generator(seed);
  const kinds = skew ? KINDS.slice(0, 1 + random(KINDS.length - 1)) : KINDS;
  const insert =
    db.prepare(`INSERT INTO reconciliation_proposals(rowid,id,kind,stage,target_refs_json,method,
    policy_release,rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,
    proposal_digest,created_at)
    VALUES(?,?,?,?,'[{"kind":"transaction","id":"synthetic:a","revision":1},{"kind":"transaction","id":"synthetic:b","revision":1}]',
      ?,'synthetic-policy','[]','[]','[]','proposed',NULL,?,'2026-11-06T00:00:00.000Z')`);
  const rowids: number[] = [];
  db.transaction(() => {
    let rowid = 0;
    for (let i = 0; i < size; i += 1) {
      rowid += 1 + (random(5) === 0 ? random(40) : 0);
      rowids.push(rowid);
      insert.run(
        rowid,
        // Ids out of rowid order, as content ids are.
        `rp_${(Math.imul(i + 1, 2_654_435_761) >>> 0).toString(16).padStart(8, "0")}_${i}`,
        kinds[random(kinds.length)]!,
        STAGES[random(STAGES.length)]!,
        // Mostly rule proposals, as the sweeps write them, with others between.
        random(4) === 0 ? METHODS[1 + random(2)]! : "rule",
        i.toString(16).padStart(64, "0"),
      );
    }
  })();
  return { db, rowids };
}

/** Marks a tick could hold: before the first row, on and between rows, at and past the end. */
function marks(rowids: readonly number[], random: (n: number) => number): number[] {
  const last = rowids.at(-1) ?? 0;
  const picked = [-1, 0, 1, last - 1, last, last + 1];
  for (let i = 0; i < 12 && rowids.length > 0; i += 1) {
    const at = rowids[random(rowids.length)]!;
    picked.push(at, at - 1);
  }
  // A tick writes a few rows past its mark.
  for (const tail of [1, 3, 25, 200]) picked.push(rowids[Math.max(0, rowids.length - tail)] ?? 0);
  return picked;
}

const planOf = (db: Database, sql: string): string[] =>
  db
    .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail);

test("the frozen texts are the texts that shipped", () => {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(digest(LEGACY_LANE_RECONCILIATION_PROPOSALS_SQL)).toBe(
    "b250168222b187fb312d5021fb204333aea3c8185f426658f5078ffa54037c15",
  );
  expect(digest(LEGACY_LANE_RECONCILIATION_REF_SQL)).toBe(
    "0176fb9361a2eb1e5991cd01f4943ae4b648f17f056a0a1cffac877b5a6e302a",
  );
});

for (const [size, seed, skew] of [
  [0, 3, false],
  [1, 5, false],
  [40, 11, true],
  [700, 29, false],
  [5000, 731, true],
  [20_000, 20_261_106, false],
] as const) {
  test(`the proposal ranges and references read what the shipped text read: ${size} proposals, seed ${seed}${skew ? ", some kinds absent" : ""}`, () => {
    const { db, rowids } = store(size, seed, skew);
    try {
      const random = generator(seed ^ 0x5bd1e995);
      const ranges = (sql: string, mark: number) => db.query(sql).all(mark);
      let nonEmpty = 0;
      for (const mark of marks(rowids, random)) {
        const expected = ranges(LEGACY_LANE_RECONCILIATION_PROPOSALS_SQL, mark);
        // Same rows, same columns, same order (the record lists ranges in it).
        expect(ranges(LANE_AUDIT_SQL.reconciliationProposals, mark)).toEqual(expected);
        if (expected.length > 0) nonEmpty += 1;
      }
      if (size > 0) expect(nonEmpty).toBeGreaterThan(0);
      const refs = (sql: string, from: number, to: number, kind: string) =>
        db.query(sql).all(from, to, kind);
      const last = rowids.at(-1) ?? 0;
      let named = 0;
      for (let i = 0; i < 40; i += 1) {
        const from = rowids.length > 0 ? rowids[random(rowids.length)]! - random(3) : random(5);
        const to = from + random(i % 4 === 0 ? last + 2 : 60) - (i % 9 === 0 ? 70 : 0);
        // Every closed kind, and one no row can hold.
        const kind = i % 8 === 7 ? "no_such_kind" : KINDS[random(KINDS.length)]!;
        const expected = refs(LEGACY_LANE_RECONCILIATION_REF_SQL, from, to, kind);
        expect(refs(LANE_AUDIT_SQL.reconciliationRef, from, to, kind)).toEqual(expected);
        named += expected.length;
      }
      if (size >= 700) expect(named).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
}

/** The plan of every read of the module, without table statistics. */
const PLANS: Record<keyof typeof LANE_AUDIT_SQL, RegExp[]> = {
  mark: [
    /^SEARCH e USING INTEGER PRIMARY KEY \(rowid=\?\)$/u,
    /^(?:CORRELATED )?SCALAR SUBQUERY \d+$/u,
    /^SEARCH (?:decision_revisions|reconciliation_proposals|card_settlement_candidates|maintenance_survey_proposals)$/u,
    /^SEARCH economic_commit_log USING COVERING INDEX sqlite_autoindex_economic_commit_log_\d \(core_epoch=\?\)$/u,
  ],
  decisions: [/^SEARCH decision_revisions USING INTEGER PRIMARY KEY \(rowid>\?\)$/u],
  commits: [
    /^SEARCH economic_commit_log USING INDEX sqlite_autoindex_economic_commit_log_\d \(core_epoch=\? AND commit_seq>\?\)$/u,
  ],
  reconciliationProposals: [
    /^SEARCH reconciliation_proposals USING INTEGER PRIMARY KEY \(rowid>\?\)$/u,
    /^USE TEMP B-TREE FOR GROUP BY$/u,
  ],
  settlementCandidates: [
    /^SEARCH card_settlement_candidates USING INTEGER PRIMARY KEY \(rowid>\?\)$/u,
  ],
  surveyProposals: [
    /^SEARCH maintenance_survey_proposals USING INTEGER PRIMARY KEY \(rowid>\?\)$/u,
    /^USE TEMP B-TREE FOR GROUP BY$/u,
  ],
  decisionsRef: [
    /^SEARCH decision_revisions USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/u,
  ],
  commitsRef: [
    /^SEARCH economic_commit_log USING INDEX sqlite_autoindex_economic_commit_log_\d \(core_epoch=\? AND commit_seq>\? AND commit_seq<\?\)$/u,
  ],
  reconciliationRef: [
    /^SEARCH reconciliation_proposals USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/u,
  ],
  settlementRef: [
    /^SEARCH card_settlement_candidates USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/u,
  ],
  surveyRef: [
    /^SEARCH maintenance_survey_proposals USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/u,
  ],
};

test("every read is a range on its table's key without table statistics, and the shipped proposal reads were not", () => {
  const { db } = store(5000, 97);
  try {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [name, sql] of Object.entries(LANE_AUDIT_SQL)) {
      const plan = planOf(db, sql);
      const allowed = PLANS[name as keyof typeof LANE_AUDIT_SQL];
      // Every step is one the read is allowed; each allowed step occurs; no step walks a table or an index.
      expect(
        plan.filter((step) => !allowed.some((pattern) => pattern.test(step))),
        name,
      ).toEqual([]);
      for (const pattern of allowed)
        expect(
          plan.some((step) => pattern.test(step)),
          `${name}: ${pattern}`,
        ).toBe(true);
      expect(
        plan.filter((step) => /^SCAN /u.test(step)),
        name,
      ).toEqual([]);
    }
    // The shipped texts: a walk of the whole kind index for the grouping, and
    // a seek of every proposal of the kind.
    expect(planOf(db, LEGACY_LANE_RECONCILIATION_PROPOSALS_SQL)).toEqual([
      "SCAN reconciliation_proposals USING INDEX reconciliation_proposals_kind_stage",
    ]);
    expect(planOf(db, LEGACY_LANE_RECONCILIATION_REF_SQL)).toContain(
      "SEARCH reconciliation_proposals USING INDEX reconciliation_proposals_kind_stage (kind=?)",
    );
  } finally {
    db.close();
  }
});
