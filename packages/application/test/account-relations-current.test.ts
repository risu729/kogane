// The account candidates' relation read (`ACCOUNT_RELATIONS_SQL`,
// packages/read-model/src/account-candidates.ts) under ADR 0077's amendment of
// 2026-11-08: a pair's current relation is its newest decision, and a
// proposal recorded after it does not replace it (the rule of ADR 0001's and
// ADR 0017's amendments of 2026-11-06).
//
// What is proved here, against the text that shipped
// (./account-relations-legacy-sql.ts); the failing case on the candidate
// review itself is in account-candidates.test.ts:
// - on random stores the current read equals a model written without SQL, the
//   shipped read equals the old rule's model, and the two differ only on the
//   pairs whose newest row is a proposal recorded after a decision, where the
//   shipped read said `proposed`;
// - on a scaled store past the row bound with no proposal after a decision
//   both reads return the same rows in the same order;
// - without table statistics (D1 never runs ANALYZE) the plan is the shipped
//   plan: one keyed range of an `entity_relations` index per kind, never a scan.
// Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ACCOUNT_RELATIONS_SQL } from "../../read-model/src/account-candidates.ts";
import {
  BY_CREATED_ID,
  binary,
  decisionsFirst,
  insertHistory,
  newestByTriple,
  proposalHidesDecision,
  randomHistory,
  type HistoryRow,
  type Order,
  type StoredHistoryRow,
} from "../../read-model/test/relation-history.ts";
import {
  LEGACY_ACCOUNT_RELATIONS_SQL,
  LEGACY_ACCOUNT_RELATIONS_SQL_SHA256,
} from "./account-relations-legacy-sql.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

interface RelationRow {
  kind: string;
  fromRef: string;
  toRef: string;
  status: string;
  createdAt: string;
  id: string;
}
const read = (db: Database, sql: string): RelationRow[] => db.query(sql).all() as RelationRow[];

/** The rows the read covers: containment from a connection, and same_account between source accounts. */
function covered(rows: readonly StoredHistoryRow[]): StoredHistoryRow[] {
  return rows.filter(
    (row) =>
      (row.kind === "connection_contains" &&
        row.from_ref.startsWith("connection:") &&
        row.to_ref.startsWith("source_account:")) ||
      (row.kind === "same_account" &&
        row.from_ref.startsWith("source_account:") &&
        row.to_ref.startsWith("source_account:")),
  );
}

/** The model, without SQL: per (kind, from, to), its newest row by `order`. */
function model(rows: readonly StoredHistoryRow[], order: Order): RelationRow[] {
  return [...newestByTriple(covered(rows), order).values()]
    .map((row) => ({
      kind: row.kind,
      fromRef: row.from_ref,
      toRef: row.to_ref,
      status: row.status,
      createdAt: row.created_at,
      id: row.id,
    }))
    .sort(
      (a, b) => binary(a.kind, b.kind) || binary(a.fromRef, b.fromRef) || binary(a.toRef, b.toRef),
    );
}

describe("the current read against the shipped text", () => {
  test("the frozen text is the text that shipped", () => {
    expect(createHash("sha256").update(LEGACY_ACCOUNT_RELATIONS_SQL).digest("hex")).toBe(
      LEGACY_ACCOUNT_RELATIONS_SQL_SHA256,
    );
  });

  const KINDS = ["connection_contains", "same_account", "same_account", "listed_as"];
  const FROM_REFS = [
    "connection:synthetic-mf/key-a",
    "source_account:sa-a",
    "source_account:sa-b",
    "instrument:x",
  ];
  const TO_REFS = ["source_account:sa-a", "source_account:sa-c", "connection:synthetic-mf/key-a"];

  test("on random stores: the rule's model, and the shipped read only where a proposal hides a decision", () => {
    let hidden = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const db = migratedDatabase();
      const rows = insertHistory(
        db,
        randomHistory(seed, {
          kinds: KINDS,
          fromRefs: FROM_REFS,
          toRefs: TO_REFS,
          rows: 1 + (seed % 30),
        }),
      );
      const current = read(db, ACCOUNT_RELATIONS_SQL);
      const shipped = read(db, LEGACY_ACCOUNT_RELATIONS_SQL);
      expect(current).toEqual(model(rows, decisionsFirst(BY_CREATED_ID)));
      expect(shipped).toEqual(model(rows, BY_CREATED_ID));
      const differs = proposalHidesDecision(covered(rows), BY_CREATED_ID);
      hidden += differs.size;
      // The same pairs in the same order; a row differs only where a proposal
      // hides a decision, and there the shipped read said `proposed`.
      expect(current.map((row) => [row.kind, row.fromRef, row.toRef])).toEqual(
        shipped.map((row) => [row.kind, row.fromRef, row.toRef]),
      );
      current.forEach((row, index) => {
        const key = JSON.stringify([row.kind, row.fromRef, row.toRef]);
        if (differs.has(key)) {
          expect(shipped[index]!.status).toBe("proposed");
          expect(row.status).not.toBe("proposed");
        } else expect(row).toEqual(shipped[index]!);
      });
      db.close();
    }
    expect(hidden).toBeGreaterThan(50);
  }, 120_000);

  test("a scaled store past the bound with no proposal after a decision reads exactly what the shipped text read", () => {
    const db = migratedDatabase();
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 12_400; i += 1) {
      const base =
        i % 7 === 6
          ? { kind: "listed_as", from_ref: `instrument:scale-${i % 37}`, to_ref: `identifier:${i}` }
          : i % 3 === 0
            ? {
                kind: "connection_contains",
                from_ref: `connection:synthetic-mf/scale-${i % 53}`,
                to_ref: `source_account:scale-${i}`,
              }
            : {
                kind: "same_account",
                from_ref: `source_account:scale-${i % 41}`,
                to_ref: `source_account:scale-other-${i}`,
              };
      const statuses: HistoryRow["status"][] =
        i % 5 === 0
          ? ["proposed", "rejected", ...(i % 10 === 0 ? (["accepted"] as const) : [])]
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
    const stored = insertHistory(db, rows);
    expect(proposalHidesDecision(covered(stored), BY_CREATED_ID).size).toBe(0);
    const shipped = read(db, LEGACY_ACCOUNT_RELATIONS_SQL);
    // One row past the domain bound, so the caller refuses rather than cuts.
    expect(shipped).toHaveLength(10_001);
    expect(read(db, ACCOUNT_RELATIONS_SQL)).toEqual(shipped);
    db.close();
  }, 120_000);

  test("without table statistics the plan is the shipped plan, a keyed range per kind", () => {
    const db = migratedDatabase();
    insertHistory(
      db,
      randomHistory(11, { kinds: KINDS, fromRefs: FROM_REFS, toRefs: TO_REFS, rows: 60 }),
    );
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const plan = (sql: string): string[] =>
      (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
        (step) => step.detail,
      );
    const current = plan(ACCOUNT_RELATIONS_SQL);
    expect(current).toEqual(plan(LEGACY_ACCOUNT_RELATIONS_SQL));
    expect(current.join("\n")).not.toMatch(/SCAN r\b/u);
    expect(current.join("\n")).toContain("MULTI-INDEX OR");
    expect(
      current.join("\n").match(/SEARCH r USING INDEX entity_relations_(from|to) \(kind=\? AND /gu),
    ).toHaveLength(2);
    db.close();
  });
});
