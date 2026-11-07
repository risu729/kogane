// The instrument candidates' `listed_as` read (`LISTED_AS_SQL`,
// packages/read-model/src/instrument-resolution.ts) under ADR 0017's
// amendment of 2026-11-06: a pair's current relation is its newest decision,
// and a proposal recorded after it does not replace it.
//
// What is proved here, against the text that shipped (./listed-as-legacy-sql.ts):
// - a person's keep-apart rejection followed by a later `listed_as` proposal
//   keeps the candidate `rejected` (the shipped read re-opened it as
//   `proposed`, naming the adoption again);
// - on random stores the current read equals a model written without SQL, the
//   shipped read equals the old rule's model, and the two differ only on the
//   pairs whose newest row is a proposal recorded after a decision;
// - on a scaled store with no proposal after a decision both reads return the
//   same rows in the same order;
// - without table statistics (D1 never runs ANALYZE) the plan is the shipped
//   plan: a keyed search of an `entity_relations` index, never a scan.
// Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LISTED_AS_SQL } from "../../read-model/src/instrument-resolution.ts";
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
import { queryInstrumentResolution } from "../src/query/instrument-resolution.ts";
import {
  candidateOf,
  decide,
  ids,
  OPERATOR,
  stateOf,
  stubDatabase,
  world,
} from "./instrument-resolution-world.ts";
import { LEGACY_LISTED_AS_SQL, LEGACY_LISTED_AS_SQL_SHA256 } from "./listed-as-legacy-sql.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => {
  stubDatabase().close();
  migratedDatabase().close();
}, 60_000);

interface ListedRow {
  fromRef: string;
  toRef: string;
  status: string;
}
const read = (db: Database, sql: string): ListedRow[] => db.query(sql).all() as ListedRow[];

describe("a kept-apart candidate", () => {
  test("stays rejected when a proposal is recorded after the rejection", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(await queryInstrumentResolution(w.sql), id.ric, id.foreignCode);
    const keepApart = candidate.commands!.keepApart.payload;
    const outcome = await decide(
      w,
      OPERATOR,
      "relation.reject",
      { ...keepApart, reason: "different listing, checked" },
      "op-keep-apart",
    );
    expect(outcome.result.ok).toBe(true);
    expect(candidateOf(await queryInstrumentResolution(w.sql), id.ric, id.foreignCode).status).toBe(
      "rejected",
    );
    // A later proposal of the same relation, as any proposal writer appends one.
    insertHistory(w.db, [
      {
        id: "rel_synthetic_later_proposal",
        kind: "listed_as",
        from_ref: keepApart.fromRef,
        to_ref: keepApart.toRef,
        status: "proposed",
        created_at: "2099-12-31T00:00:00.000Z",
      },
    ]);
    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, id.ric, id.foreignCode).status).toBe("rejected");
    expect(stateOf(after, id.ric)).toBe("kept-separate");
    // The shipped read took the proposal as the pair's current relation.
    expect(
      read(w.db, LEGACY_LISTED_AS_SQL).find(
        (row) => row.fromRef === keepApart.fromRef && row.toRef === keepApart.toRef,
      )?.status,
    ).toBe("proposed");
  });
});

/** The model, without SQL: per (from, to) of `listed_as`, its newest row by `order`. */
function model(rows: readonly StoredHistoryRow[], order: Order): ListedRow[] {
  const listed = rows.filter(
    (row) =>
      row.kind === "listed_as" &&
      row.from_ref.startsWith("instrument:") &&
      row.to_ref.startsWith("identifier:"),
  );
  return [...newestByTriple(listed, order).values()]
    .map((row) => ({ fromRef: row.from_ref, toRef: row.to_ref, status: row.status }))
    .sort((a, b) => binary(a.fromRef, b.fromRef) || binary(a.toRef, b.toRef));
}

describe("the current read against the shipped text", () => {
  test("the frozen text is the text that shipped", () => {
    expect(createHash("sha256").update(LEGACY_LISTED_AS_SQL).digest("hex")).toBe(
      LEGACY_LISTED_AS_SQL_SHA256,
    );
  });

  const KINDS = ["listed_as", "listed_as", "listed_as", "same_underlying"];
  const FROM_REFS = ["instrument:a", "instrument:b", "identifier:c", "instrument:d"];
  const TO_REFS = ["identifier:a", "identifier:b", "identifier:c", "instrument:e"];

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
      const current = read(db, LISTED_AS_SQL);
      const shipped = read(db, LEGACY_LISTED_AS_SQL);
      expect(current).toEqual(model(rows, decisionsFirst(BY_CREATED_ID)));
      expect(shipped).toEqual(model(rows, BY_CREATED_ID));
      const listed = rows.filter(
        (row) =>
          row.kind === "listed_as" &&
          row.from_ref.startsWith("instrument:") &&
          row.to_ref.startsWith("identifier:"),
      );
      const differs = proposalHidesDecision(listed, BY_CREATED_ID);
      hidden += differs.size;
      // Same pairs in the same order; a status differs only where a proposal
      // hides a decision, and there the shipped read said `proposed`.
      expect(current.map((row) => [row.fromRef, row.toRef])).toEqual(
        shipped.map((row) => [row.fromRef, row.toRef]),
      );
      current.forEach((row, index) => {
        const key = JSON.stringify(["listed_as", row.fromRef, row.toRef]);
        if (differs.has(key)) {
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
    for (let i = 0; i < 6000; i += 1) {
      const base = {
        kind: i % 6 === 5 ? "same_underlying" : "listed_as",
        from_ref: `instrument:scale-${i % 41}`,
        to_ref: `identifier:scale-${i}`,
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
    expect(proposalHidesDecision(stored, BY_CREATED_ID).size).toBe(0);
    const shipped = read(db, LEGACY_LISTED_AS_SQL);
    expect(shipped).toHaveLength(5000);
    expect(read(db, LISTED_AS_SQL)).toEqual(shipped);
  });

  test("without table statistics the plan is the shipped plan, a keyed search", () => {
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
    const current = plan(LISTED_AS_SQL);
    // The same steps; the window's sort of the rows the search found has one
    // more term (decisions before proposals).
    expect(current).toEqual(
      plan(LEGACY_LISTED_AS_SQL).map((detail) =>
        detail === "USE TEMP B-TREE FOR LAST 3 TERMS OF ORDER BY"
          ? "USE TEMP B-TREE FOR LAST 4 TERMS OF ORDER BY"
          : detail,
      ),
    );
    expect(current.join("\n")).not.toMatch(/SCAN r\b/u);
    expect(current.join("\n")).toMatch(/SEARCH r USING INDEX entity_relations_(from|to)/u);
  });
});
