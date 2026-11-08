// The pending-to-posted candidates' relation read (`CANDIDATE_RELATIONS_SQL`,
// src/query/card-purchase-candidates.ts) under ADR 0017's amendment of
// 2026-11-06: a link's current status is its newest decision, by creation
// time and then insertion order, and a proposal recorded after it does not
// replace it. The scenarios on D1 (a later proposal neither closes a merged
// link to withdrawal nor holds a rule merge back) are in
// services/processor/test/card-purchase-merge.test.ts.
//
// What is proved here, against the text that shipped
// (./pending-posted-relations-legacy-sql.ts):
// - on random stores the current read equals a model written without SQL, the
//   shipped read equals the old rule's model, the pin (row count) is the same,
//   and a status differs only on the triples whose newest row is a proposal
//   recorded after a decision;
// - on a scaled store with no proposal after a decision both reads return the
//   same rows;
// - without table statistics (D1 never runs ANALYZE) every lookup is a keyed
//   search of an `entity_relations` index, never a scan.
// Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BY_CREATED_ROWID,
  decisionsFirst,
  insertHistory,
  newestByTriple,
  proposalHidesDecision,
  randomHistory,
  tripleKey,
  type HistoryRow,
} from "../../read-model/test/relation-history.ts";
import { CANDIDATE_RELATIONS_SQL } from "../src/query/card-purchase-candidates.ts";
import {
  LEGACY_CANDIDATE_RELATIONS_SQL,
  LEGACY_CANDIDATE_RELATIONS_SQL_SHA256,
} from "./pending-posted-relations-legacy-sql.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

interface LinkRow {
  from_ref: string;
  to_ref: string;
  revision: number;
  status: string | null;
}
const read = (db: Database, sql: string, pairs: readonly (readonly [string, string])[]) =>
  db.query(sql).all(JSON.stringify(pairs)) as LinkRow[];

const KINDS = ["pending_to_posted", "pending_to_posted", "provider_same"];
const FROM_REFS = ["transaction:1", "transaction:2", "transaction:3"];
const TO_REFS = ["transaction:2", "transaction:4", "transaction:5"];
const PAIRS = FROM_REFS.flatMap((from) =>
  [...TO_REFS, ...TO_REFS.map((to) => `${to}-other`)].map((to) => [from, to] as const),
);

describe("the current read against the shipped text", () => {
  test("the frozen text is the text that shipped", () => {
    expect(createHash("sha256").update(LEGACY_CANDIDATE_RELATIONS_SQL).digest("hex")).toBe(
      LEGACY_CANDIDATE_RELATIONS_SQL_SHA256,
    );
  });

  test("on random stores: the rule's model, and the shipped read only where a proposal hides a decision", () => {
    let hidden = 0;
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
      const links = rows.filter((row) => row.kind === "pending_to_posted");
      const rule = newestByTriple(links, decisionsFirst(BY_CREATED_ROWID));
      const old = newestByTriple(links, BY_CREATED_ROWID);
      const differs = proposalHidesDecision(links, BY_CREATED_ROWID);
      const current = read(db, CANDIDATE_RELATIONS_SQL, PAIRS);
      const shipped = read(db, LEGACY_CANDIDATE_RELATIONS_SQL, PAIRS);
      expect(current).toHaveLength(PAIRS.length);
      current.forEach((row, index) => {
        const key = tripleKey({ kind: "pending_to_posted", ...row });
        const revision = links.filter((link) => tripleKey(link) === key).length;
        expect(row).toEqual({ ...row, revision, status: rule.get(key)?.status ?? null });
        expect(shipped[index]).toEqual({ ...row, status: old.get(key)?.status ?? null });
        if (differs.has(key)) {
          hidden += 1;
          expect(shipped[index]!.status).toBe("proposed");
          expect(row.status).not.toBe("proposed");
        } else expect(row).toEqual(shipped[index]!);
      });
      db.close();
    }
    expect(hidden).toBeGreaterThan(50);
  }, 120_000);

  test("a scaled store with no proposal after a decision reads exactly what the shipped text read", () => {
    const db = migratedDatabase();
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const base = {
        kind: "pending_to_posted",
        from_ref: `transaction:${i}`,
        to_ref: `transaction:${100_000 + i}`,
      };
      // A proposal, then an acceptance and for some a withdrawal, or one row.
      const statuses: HistoryRow["status"][] =
        i % 4 === 0
          ? ["proposed", "accepted", ...(i % 8 === 0 ? (["rejected"] as const) : [])]
          : [(["proposed", "accepted", "rejected", "released"] as const)[i % 4]!];
      statuses.forEach((status, step) =>
        rows.push({
          ...base,
          id: `rel_${(7919 * i + step) % 100_003}_${i}_${step}`,
          status,
          // Equal instants: insertion order breaks the tie, as it did.
          created_at: `2026-0${1 + Math.floor(step / 2)}-01T00:00:00.000Z`,
        }),
      );
    }
    const stored = insertHistory(db, rows);
    expect(proposalHidesDecision(stored, BY_CREATED_ROWID).size).toBe(0);
    const pairs = Array.from(
      { length: 500 },
      (_, n) => [`transaction:${n * 10}`, `transaction:${100_000 + n * 10}`] as const,
    );
    const shipped = read(db, LEGACY_CANDIDATE_RELATIONS_SQL, pairs);
    expect(shipped.every((row) => row.status !== null)).toBe(true);
    expect(read(db, CANDIDATE_RELATIONS_SQL, pairs)).toEqual(shipped);
  });

  test("without table statistics every lookup is a keyed search, never a scan", () => {
    const db = migratedDatabase();
    insertHistory(
      db,
      randomHistory(5, { kinds: KINDS, fromRefs: FROM_REFS, toRefs: TO_REFS, rows: 60 }),
    );
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const details = (
      db.query(`EXPLAIN QUERY PLAN ${CANDIDATE_RELATIONS_SQL}`).all(JSON.stringify(PAIRS)) as {
        detail: string;
      }[]
    ).map((step) => step.detail);
    const reads = details.filter((detail) => /^(SCAN|SEARCH) r\b/u.test(detail));
    expect(reads).toHaveLength(2);
    for (const detail of reads)
      expect(detail).toMatch(/^SEARCH r USING (COVERING )?INDEX entity_relations_(from|to) /u);
  });
});
