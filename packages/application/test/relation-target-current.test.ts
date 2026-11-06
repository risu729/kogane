// The change lifecycle's relation target (`RELATION_SQL`,
// src/operations/targets.ts) under ADR 0017's amendment of 2026-11-06: the
// status a plan shows as a relation's current value is the triple's newest
// decision, and a proposal recorded after it (an agent's `reconcile.propose`)
// does not replace it.
//
// What is proved here, against the text that shipped
// (./relation-target-legacy-sql.ts):
// - a decision followed by a later proposal shows the decision (the shipped
//   read showed `proposed`, so a reviewer withdrawing an acceptance saw
//   `proposed → rejected`);
// - on random stores the current read equals a model written without SQL, the
//   shipped read equals the old rule's model, and the two differ only on the
//   triples whose newest row is a proposal recorded after a decision;
// - the pin (the row count) is unchanged everywhere;
// - on a scaled store with no proposal after a decision both reads agree on
//   every triple;
// - without table statistics (D1 never runs ANALYZE) both lookups are keyed
//   searches of an `entity_relations` index, never a scan.
// Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RELATION_SQL, resolveAndSimulate } from "../src/operations/targets.ts";
import {
  BY_CREATED_ID,
  decisionsFirst,
  insertHistory,
  newestByTriple,
  proposalHidesDecision,
  randomHistory,
  tripleKey,
  type HistoryRow,
  type StoredHistoryRow,
} from "../../read-model/test/relation-history.ts";
import {
  LEGACY_RELATION_TARGET_SQL,
  LEGACY_RELATION_TARGET_SQL_SHA256,
} from "./relation-target-legacy-sql.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const FROM = "statement:synthetic-a";
const TO = "statement:synthetic-b";
const KIND = "supports";

interface TargetRow {
  revision: number;
  current_status: string | null;
}
const target = (db: Database, sql: string, kind: string, from: string, to: string): TargetRow =>
  db.query(sql).get(kind, from, to) as TargetRow;

const row = (id: string, status: HistoryRow["status"], createdAt: string): HistoryRow => ({
  id,
  kind: KIND,
  from_ref: FROM,
  to_ref: TO,
  status,
  created_at: createdAt,
});

async function planned(db: Database) {
  const resolved = await resolveAndSimulate(sqliteCommandStore(db), "relation.reject", {
    relationKind: KIND,
    fromRef: FROM,
    toRef: TO,
    validFrom: null,
    validTo: null,
    evidenceRefs: ["fetch_artifact:1"],
    reason: "Synthetic review.",
  });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved));
  return resolved.resolved.targets[0]!;
}

describe("a plan's relation target", () => {
  test("a proposal recorded after an acceptance leaves the acceptance as the current status", async () => {
    const db = migratedDatabase();
    insertHistory(db, [
      row("rel_a_accept", "accepted", "2026-03-01T00:00:00.000Z"),
      row("rel_b_proposal", "proposed", "2026-04-01T00:00:00.000Z"),
    ]);
    expect(await planned(db)).toMatchObject({
      currentRevision: 2,
      currentTargetRef: "accepted",
      proposedTargetRef: "rejected",
    });
    // The shipped read showed the proposal.
    expect(target(db, LEGACY_RELATION_TARGET_SQL, KIND, FROM, TO)).toEqual({
      revision: 2,
      current_status: "proposed",
    });
  });

  test("a proposal after a rejection, at the same instant, or alone", async () => {
    const after = migratedDatabase();
    insertHistory(after, [
      row("rel_z_reject", "rejected", "2026-03-01T00:00:00.000Z"),
      row("rel_a_proposal", "proposed", "2026-04-01T00:00:00.000Z"),
    ]);
    expect((await planned(after)).currentTargetRef).toBe("rejected");
    // A tie on `created_at`: the decision wins whatever the ids say.
    const tie = migratedDatabase();
    insertHistory(tie, [
      row("rel_a_accept", "accepted", "2026-03-01T00:00:00.000Z"),
      row("rel_z_proposal", "proposed", "2026-03-01T00:00:00.000Z"),
    ]);
    expect((await planned(tie)).currentTargetRef).toBe("accepted");
    // No decision: the newest proposal, as before.
    const alone = migratedDatabase();
    insertHistory(alone, [row("rel_a_proposal", "proposed", "2026-03-01T00:00:00.000Z")]);
    expect(await planned(alone)).toMatchObject({
      currentRevision: 1,
      currentTargetRef: "proposed",
    });
    // A decision after a proposal reads as it always did.
    const decided = migratedDatabase();
    insertHistory(decided, [
      row("rel_z_proposal", "proposed", "2026-03-01T00:00:00.000Z"),
      row("rel_a_accept", "accepted", "2026-04-01T00:00:00.000Z"),
    ]);
    expect((await planned(decided)).currentTargetRef).toBe("accepted");
  });
});

describe("the current read against the shipped text", () => {
  test("the frozen text is the text that shipped", () => {
    expect(createHash("sha256").update(LEGACY_RELATION_TARGET_SQL).digest("hex")).toBe(
      LEGACY_RELATION_TARGET_SQL_SHA256,
    );
  });

  const KINDS = ["supports", "same_account", "listed_as"];
  const FROM_REFS = ["statement:a", "statement:b", "source_account:c"];
  const TO_REFS = ["statement:b", "statement:d", "source_account:e"];

  test("on random stores: the rule's model, and the shipped read only where a proposal hides a decision", () => {
    let hidden = 0;
    let agreed = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const db = migratedDatabase();
      const rows = insertHistory(
        db,
        randomHistory(seed, {
          kinds: KINDS,
          fromRefs: FROM_REFS,
          toRefs: TO_REFS,
          rows: 1 + (seed % 24),
        }),
      );
      const rule = newestByTriple(rows, decisionsFirst(BY_CREATED_ID));
      const old = newestByTriple(rows, BY_CREATED_ID);
      const differs = proposalHidesDecision(rows, BY_CREATED_ID);
      const counts = new Map<string, number>();
      for (const stored of rows)
        counts.set(tripleKey(stored), (counts.get(tripleKey(stored)) ?? 0) + 1);
      for (const kind of KINDS)
        for (const from of FROM_REFS)
          for (const to of [...TO_REFS, ...TO_REFS.map((ref) => `${ref}-other`)]) {
            const key = tripleKey({ kind, from_ref: from, to_ref: to });
            const current = target(db, RELATION_SQL, kind, from, to);
            const shipped = target(db, LEGACY_RELATION_TARGET_SQL, kind, from, to);
            expect(current).toEqual({
              revision: counts.get(key) ?? 0,
              current_status: rule.get(key)?.status ?? null,
            });
            expect(shipped).toEqual({
              revision: counts.get(key) ?? 0,
              current_status: old.get(key)?.status ?? null,
            });
            if (differs.has(key)) {
              hidden += 1;
              expect(shipped.current_status).toBe("proposed");
              expect(current.current_status).not.toBe("proposed");
            } else {
              if (counts.has(key)) agreed += 1;
              expect(current).toEqual(shipped);
            }
          }
      db.close();
    }
    // The seeds drew both cases many times.
    expect(hidden).toBeGreaterThan(50);
    expect(agreed).toBeGreaterThan(500);
  }, 120_000);

  test("a scaled store with no proposal after a decision reads every triple as the shipped text did", () => {
    const db = migratedDatabase();
    const rows: HistoryRow[] = [];
    // 5,000 triples: most with one row, every fifth with a proposal and then
    // one or two decisions, all of one kind under few from_refs, so each
    // lookup has many neighbours on the index.
    for (let i = 0; i < 5000; i += 1) {
      const base = {
        kind: "supports",
        from_ref: `statement:scale-${i % 7}`,
        to_ref: `statement:to-${i}`,
      };
      const statuses: HistoryRow["status"][] =
        i % 5 === 0
          ? ["proposed", "accepted", ...(i % 10 === 0 ? (["rejected"] as const) : [])]
          : [(["proposed", "accepted", "rejected", "released"] as const)[i % 4]!];
      statuses.forEach((status, step) =>
        rows.push({
          ...base,
          id: `rel_${(7919 * i + step) % 100_003}_${i}_${step}`,
          status,
          created_at: `2026-0${1 + step}-01T00:00:00.000Z`,
        }),
      );
    }
    const stored: StoredHistoryRow[] = insertHistory(db, rows);
    expect(proposalHidesDecision(stored, BY_CREATED_ID).size).toBe(0);
    for (let i = 0; i < 5000; i += 7) {
      const args = ["supports", `statement:scale-${i % 7}`, `statement:to-${i}`] as const;
      expect(target(db, RELATION_SQL, ...args)).toEqual(
        target(db, LEGACY_RELATION_TARGET_SQL, ...args),
      );
    }
  });

  test("without table statistics both lookups are keyed searches, never a scan", () => {
    const db = migratedDatabase();
    insertHistory(
      db,
      randomHistory(7, { kinds: KINDS, fromRefs: FROM_REFS, toRefs: TO_REFS, rows: 40 }),
    );
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN ${RELATION_SQL}`)
        .all("supports", "statement:a", "statement:b") as {
        detail: string;
      }[]
    ).map((step) => step.detail);
    const reads = plan.filter(
      (detail) => /\bentity_relations\b|\br\b/u.test(detail) && /^(SCAN|SEARCH)/u.test(detail),
    );
    expect(reads).toHaveLength(2);
    for (const detail of reads)
      expect(detail).toMatch(/^SEARCH .*USING (COVERING )?INDEX entity_relations_(from|to) /u);
  });
});
