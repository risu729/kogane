// The purchase lane's merge guard for a pair the reconciliation lane accepted
// by rule (`ACCEPTED_APART_GUARD_SQL`, src/card-purchase-job.ts) under ADR
// 0017's amendment of 2026-11-06: the link's current status is its newest
// decision, by creation time and then insertion order, so a proposal recorded
// after the acceptance does not hold the merge back. The scenario on D1 is in
// card-purchase-merge.test.ts.
//
// What is proved here, against the text that shipped
// (./accepted-apart-guard-legacy-sql.ts): the guard is the shipped guard's
// first conjunct (the proposal accepted by rule), unchanged, and a second
// conjunct that on random stores holds exactly when the rule's model says the
// link is accepted; it agrees with the shipped conjunct everywhere except on
// triples whose newest row is a proposal recorded after a decision. Without
// table statistics the link lookup is a keyed search. Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migratedDatabase } from "../../../packages/application/test/sqlite-store.ts";
import {
  BY_CREATED_ROWID,
  decisionsFirst,
  insertHistory,
  newestByTriple,
  proposalHidesDecision,
  randomHistory,
  tripleKey,
} from "../../../packages/read-model/test/relation-history.ts";
import { ACCEPTED_APART_GUARD_SQL } from "../src/card-purchase-job.ts";
import {
  LEGACY_ACCEPTED_APART_GUARD_SQL,
  LEGACY_ACCEPTED_APART_GUARD_SQL_SHA256,
} from "./accepted-apart-guard-legacy-sql.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

/** The guard's two conjuncts: the proposal's state, then the link's status. */
function conjuncts(sql: string): [string, string] {
  const at = sql.indexOf("\n AND (SELECT r.status");
  if (at < 0) throw new Error("guard shape changed");
  return [sql.slice(0, at), sql.slice(at + "\n AND ".length)];
}

/** 1 when `condition` holds; a triple with no row (NULL) does not hold, as in a WHERE. */
const holds = (db: Database, condition: string, from: string, to: string): number =>
  (
    db.query(`SELECT coalesce((${condition}),0) AS ok`).get("pending_to_posted", from, to) as {
      ok: number;
    }
  ).ok;

test("the frozen text is the text that shipped", () => {
  expect(createHash("sha256").update(LEGACY_ACCEPTED_APART_GUARD_SQL).digest("hex")).toBe(
    LEGACY_ACCEPTED_APART_GUARD_SQL_SHA256,
  );
});

test("the proposal's state is the shipped conjunct, unchanged", () => {
  expect(conjuncts(ACCEPTED_APART_GUARD_SQL)[0]).toBe(
    conjuncts(LEGACY_ACCEPTED_APART_GUARD_SQL)[0],
  );
});

test("on random stores the link conjunct holds exactly when the newest decision is an acceptance", () => {
  const current = conjuncts(ACCEPTED_APART_GUARD_SQL)[1];
  const shipped = conjuncts(LEGACY_ACCEPTED_APART_GUARD_SQL)[1];
  const fromRefs = ["transaction:1", "transaction:2"];
  const toRefs = ["transaction:3", "transaction:4"];
  let hidden = 0;
  let accepted = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const db = migratedDatabase();
    const rows = insertHistory(
      db,
      randomHistory(seed, {
        kinds: ["pending_to_posted", "pending_to_posted", "provider_same"],
        fromRefs,
        toRefs,
        rows: 1 + (seed % 16),
      }),
    );
    const links = rows.filter((row) => row.kind === "pending_to_posted");
    const rule = newestByTriple(links, decisionsFirst(BY_CREATED_ROWID));
    const old = newestByTriple(links, BY_CREATED_ROWID);
    const differs = proposalHidesDecision(links, BY_CREATED_ROWID);
    for (const from of fromRefs)
      for (const to of toRefs) {
        const key = tripleKey({ kind: "pending_to_posted", from_ref: from, to_ref: to });
        const now = holds(db, current, from, to);
        const then = holds(db, shipped, from, to);
        expect(now).toBe(Number(rule.get(key)?.status === "accepted"));
        expect(then).toBe(Number(old.get(key)?.status === "accepted"));
        accepted += now;
        if (differs.has(key)) {
          hidden += 1;
          // The shipped guard read the proposal, so it never held there.
          expect(then).toBe(0);
        } else expect(now).toBe(then);
      }
    db.close();
  }
  expect(hidden).toBeGreaterThan(20);
  expect(accepted).toBeGreaterThan(50);
}, 120_000);

test("without table statistics the link lookup is a keyed search", () => {
  const db = migratedDatabase();
  const details = (
    db
      .query(`EXPLAIN QUERY PLAN SELECT (${ACCEPTED_APART_GUARD_SQL}) AS ok`)
      .all("proposal", "pending_to_posted", "transaction:1", "transaction:2") as {
      detail: string;
    }[]
  ).map((step) => step.detail);
  const link = details.filter((detail) => /^(SCAN|SEARCH) r\b/u.test(detail));
  expect(link).toHaveLength(1);
  expect(link[0]).toMatch(/^SEARCH r USING (COVERING )?INDEX entity_relations_(from|to) /u);
});
