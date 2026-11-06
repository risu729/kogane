// The balance projection's declared relations (ADR 0001's amendment of
// 2026-11-06) on the production CORE schema: only the newest decision of each
// relation triple (kind, from_ref, to_ref), ordered by `created_at` and then
// `id`, newest first.
//
// What is proved here, against the text that shipped
// (./balance-projection-relations-legacy-sql.ts):
// - on a scaled store with one decision per triple the two reads return the
//   same rows in the same order, so the captured input is byte-identical;
// - on random stores with several decisions per triple, the current read is
//   the shipped read minus exactly the rows a later decision of the same
//   triple supersedes, and equals an independently written model;
// - the bound counts current triples and still reads one row past it;
// - without table statistics (D1 never runs ANALYZE) both the candidate rows
//   and each newer-row check are keyed searches, never a table scan.
// Every row is synthetic.
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  projectionRelationsSql,
  scopeRelationsFromEntityRelations,
  type EntityRelationRow,
} from "../src/index";
import {
  LEGACY_PROJECTION_RELATIONS_SQL,
  LEGACY_PROJECTION_RELATIONS_SQL_SHA256,
} from "./balance-projection-relations-legacy-sql";
import { fromTemplate } from "./schema-template";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
/** The bound the processor passes (`RELATION_ROW_BOUND`). */
const BOUND = 5000;
const CURRENT_SQL = projectionRelationsSql(BOUND);
const PROJECTION_KINDS = [
  "same_account",
  "connection_contains",
  "account_has_pocket",
  "statement_covers",
] as const;
/** Kinds the projection never reads; present so a filter mistake would show. */
const OTHER_KINDS = ["listed_as", "liable_party", "beneficial_owner", "pending_to_posted"] as const;
const STATUSES = ["proposed", "accepted", "rejected", "released"] as const;

function migratedDatabase(): Database {
  return fromTemplate("core", () => {
    const db = new Database(":memory:");
    for (const name of readdirSync(MIGRATIONS)
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    return db;
  });
}

// The first build of the migrated template runs every CORE migration; pay it
// here under its own budget (see ./schema-template).
beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

/** A small deterministic generator (mulberry32) so a failing store can be rebuilt from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface StoredRelation {
  id: string;
  kind: string;
  from_ref: string;
  to_ref: string;
  status: string;
  created_at: string;
}

/** Writes each relation with the decision migration 0029 requires of it. */
function insertRelations(db: Database, rows: readonly StoredRelation[]): void {
  const decision = db.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,
      operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?1,'relation',?2,1,?3,'manual','operator:synthetic',NULL,'Synthetic relation decision.','[]',NULL,NULL,?4)`,
  );
  const relation = db.prepare(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,
      evidence_refs_json,created_at)
     VALUES(?1,?2,?3,?4,NULL,NULL,?5,?6,'[]',?7)`,
  );
  db.transaction(() => {
    for (const row of rows) {
      const kind =
        row.status === "accepted"
          ? "accept"
          : row.status === "rejected"
            ? "reject"
            : row.status === "released"
              ? "supersede"
              : "propose";
      decision.run(`dr_${row.id}`, row.id, kind, row.created_at);
      relation.run(
        row.id,
        row.kind,
        row.from_ref,
        row.to_ref,
        row.status,
        `dr_${row.id}`,
        row.created_at,
      );
    }
  })();
}

const read = (db: Database, sql: string): EntityRelationRow[] =>
  db.query(sql).all() as EntityRelationRow[];

const tripleKey = (row: { kind: string; from_ref: string; to_ref: string }): string =>
  JSON.stringify([row.kind, row.from_ref, row.to_ref]);

/** SQLite's BINARY collation on the ASCII text these stores hold. */
const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether `a` is later than `b` in a triple's history: a decision is later
 * than any proposal, and otherwise (`created_at`, `id`) decides.
 */
function later(a: StoredRelation, b: StoredRelation): boolean {
  const decisionA = a.status !== "proposed";
  const decisionB = b.status !== "proposed";
  if (decisionA !== decisionB) return decisionA;
  return (
    binary(a.created_at, b.created_at) > 0 ||
    (a.created_at === b.created_at && binary(a.id, b.id) > 0)
  );
}

/**
 * The model, written without SQL: of every projection-kind triple its latest
 * row by `later`, in `id` order, one past the bound.
 */
function model(rows: readonly StoredRelation[]): EntityRelationRow[] {
  const newest = new Map<string, StoredRelation>();
  for (const row of rows) {
    if (!(PROJECTION_KINDS as readonly string[]).includes(row.kind)) continue;
    const held = newest.get(tripleKey(row));
    if (held === undefined || later(row, held)) newest.set(tripleKey(row), row);
  }
  return [...newest.values()]
    .sort((a, b) => binary(a.id, b.id))
    .slice(0, BOUND + 1)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      from_ref: row.from_ref,
      to_ref: row.to_ref,
      status: row.status,
      decision_revision_id: `dr_${row.id}`,
    }));
}

test("the frozen text is the text that shipped", () => {
  expect(createHash("sha256").update(LEGACY_PROJECTION_RELATIONS_SQL).digest("hex")).toBe(
    LEGACY_PROJECTION_RELATIONS_SQL_SHA256,
  );
});

test("a scaled store with one decision per triple reads exactly what the shipped text read", () => {
  const db = migratedDatabase();
  const next = random(20_261_106);
  const rows: StoredRelation[] = [];
  // 4,800 projection triples under the bound, plus 1,200 rows of other kinds.
  for (let i = 0; i < 6000; i += 1) {
    const kind =
      i < 4800
        ? PROJECTION_KINDS[i % PROJECTION_KINDS.length]!
        : OTHER_KINDS[i % OTHER_KINDS.length]!;
    rows.push({
      // Ids in no particular order relative to the insertion order.
      id: `rel_${Math.floor(next() * 1e9).toString(36)}_${i}`,
      kind,
      from_ref: `connection:scale/${i % 37}`,
      to_ref: `source_account:scale:${i}`,
      status: STATUSES[Math.floor(next() * STATUSES.length)]!,
      created_at: `2026-${String(1 + Math.floor(next() * 9)).padStart(2, "0")}-01T00:00:00.000Z`,
    });
  }
  insertRelations(db, rows);
  const shipped = read(db, LEGACY_PROJECTION_RELATIONS_SQL);
  const current = read(db, CURRENT_SQL);
  expect(shipped).toHaveLength(4800);
  expect(current).toEqual(shipped);
  // So the captured input, and what the projection makes of it, are unchanged.
  expect(scopeRelationsFromEntityRelations(current)).toEqual(
    scopeRelationsFromEntityRelations(shipped),
  );
  db.close();
});

test("random stores: the shipped rows minus exactly those a later row of their triple supersedes", () => {
  const drawn = new Set<string>();
  for (let seed = 1; seed <= 300; seed += 1) {
    const db = migratedDatabase();
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const rows: StoredRelation[] = [];
    const refs = ["a", "b", "c", "d"].map((name) => `source_account:r${seed}:${name}`);
    const connections = [`connection:r${seed}/x`, `connection:r${seed}/y`];
    const triples = 1 + Math.floor(next() * 12);
    for (let t = 0; t < triples; t += 1) {
      const kind = next() < 0.85 ? pick(PROJECTION_KINDS) : pick(OTHER_KINDS);
      const from = kind === "same_account" ? pick(refs) : pick([...connections, ...refs]);
      const to = pick(refs.filter((ref) => ref !== from));
      const decisions = 1 + Math.floor(next() * 4);
      for (let d = 0; d < decisions; d += 1)
        rows.push({
          // A narrow id and time alphabet forces ties and id orders that
          // disagree with time, which is what the order has to resolve.
          id: `rel_${seed}_${Math.floor(next() * 1e6).toString(36)}_${t}_${d}`,
          kind,
          from_ref: from,
          to_ref: to,
          status: pick(STATUSES),
          created_at: `2026-10-0${1 + Math.floor(next() * 3)}T00:00:00.000Z`,
        });
    }
    insertRelations(db, rows);
    const shipped = read(db, LEGACY_PROJECTION_RELATIONS_SQL);
    const current = read(db, CURRENT_SQL);
    expect(current).toEqual(model(rows));

    // Every shipped row the current read drops has a later row of its own
    // triple; every row it keeps is the shipped row, unchanged.
    const stored = new Map(rows.map((row) => [row.id, row]));
    const kept = new Set(current.map((row) => row.id));
    for (const row of shipped) {
      if (kept.has(row.id)) continue;
      const self = stored.get(row.id)!;
      const own = rows.filter((other) => tripleKey(other) === tripleKey(row));
      expect(own.some((other) => later(other, self))).toBe(true);
    }
    expect(current).toEqual(shipped.filter((row) => kept.has(row.id)));
    // What the projection makes of them differs only by acceptances a later
    // decision of the same triple withdrew: never by a proposal.
    const derived = scopeRelationsFromEntityRelations(current);
    const before = scopeRelationsFromEntityRelations(shipped);
    const withdrawn = before.filter(
      (relation) =>
        !derived.some((other) => other.decisionRevisionId === relation.decisionRevisionId),
    );
    for (const relation of withdrawn) {
      const self = stored.get(relation.decisionRevisionId!.slice(3))!;
      const own = rows.filter((other) => tripleKey(other) === tripleKey(self));
      expect(own.some((other) => other.status !== "proposed" && later(other, self))).toBe(true);
    }

    // Where no triple has a second decision, nothing changes at all.
    const counts = new Map<string, number>();
    for (const row of shipped) counts.set(tripleKey(row), (counts.get(tripleKey(row)) ?? 0) + 1);
    if ([...counts.values()].every((n) => n === 1)) {
      drawn.add("single");
      expect(current).toEqual(shipped);
    }
    // Record the supersessions this seed exercised.
    for (const row of current) {
      const self = stored.get(row.id)!;
      const earlier = rows.filter(
        (other) => tripleKey(other) === tripleKey(row) && other.id !== row.id,
      );
      if (earlier.length === 0) continue;
      if (row.status === "rejected" && earlier.some((other) => other.status === "accepted"))
        drawn.add("accept-then-reject");
      if (row.status === "accepted" && earlier.some((other) => other.status === "rejected"))
        drawn.add("reject-then-accept");
      if (
        row.status === "accepted" &&
        earlier.some(
          (other) => other.status === "proposed" && binary(other.created_at, self.created_at) > 0,
        )
      )
        drawn.add("proposal-after-acceptance");
      if (
        earlier.some((other) => other.created_at === self.created_at && other.status !== "proposed")
      )
        drawn.add("same-instant");
      if (earlier.some((other) => binary(other.id, row.id) > 0 && other.status !== "proposed"))
        drawn.add("id-against-time");
    }
    if (withdrawn.length > 0) drawn.add("acceptance-withdrawn");
    db.close();
  }
  expect([...drawn].sort()).toEqual(
    [
      "accept-then-reject",
      "acceptance-withdrawn",
      "id-against-time",
      "proposal-after-acceptance",
      "reject-then-accept",
      "same-instant",
      "single",
    ].sort(),
  );
}, 60_000);

test("the bound counts current triples, and one row past it is still read", () => {
  const over = migratedDatabase();
  const rows: StoredRelation[] = [];
  for (let i = 0; i <= BOUND; i += 1)
    rows.push({
      id: `rel_over_${i}`,
      kind: "same_account",
      from_ref: `source_account:over:${i}`,
      to_ref: `source_account:over:${i}b`,
      status: "accepted",
      created_at: "2026-10-01T00:00:00.000Z",
    });
  insertRelations(over, rows);
  expect(read(over, CURRENT_SQL)).toHaveLength(BOUND + 1);
  expect(read(over, LEGACY_PROJECTION_RELATIONS_SQL)).toHaveLength(BOUND + 1);
  over.close();

  // Exactly the bound in triples, each with a superseded acceptance: the
  // shipped text counted rows and refused; the current read counts triples.
  const history = migratedDatabase();
  const decided: StoredRelation[] = [];
  for (let i = 0; i < BOUND; i += 1)
    for (const [d, status] of (["accepted", "rejected"] as const).entries())
      decided.push({
        id: `rel_hist_${i}_${d}`,
        kind: "connection_contains",
        from_ref: `connection:hist/${i % 7}`,
        to_ref: `source_account:hist:${i}`,
        status,
        created_at: `2026-10-0${1 + d}T00:00:00.000Z`,
      });
  insertRelations(history, decided);
  const current = read(history, CURRENT_SQL);
  expect(current).toHaveLength(BOUND);
  expect(current.every((row) => row.status === "rejected")).toBe(true);
  expect(scopeRelationsFromEntityRelations(current)).toEqual([]);
  expect(read(history, LEGACY_PROJECTION_RELATIONS_SQL)).toHaveLength(BOUND + 1);
  history.close();
}, 60_000);

test("without table statistics every relation read is keyed, never a scan", () => {
  const db = migratedDatabase();
  expect(
    db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
  ).toEqual({ n: 0 });
  const plan = (sql: string): string[] =>
    (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail);
  const shipped = plan(LEGACY_PROJECTION_RELATIONS_SQL);
  const current = plan(CURRENT_SQL);
  // The shipped text read the projection kinds by a range of a (kind, ref)
  // index; the current read takes the same range for its candidates...
  expect(shipped.join("\n")).toMatch(
    /SEARCH entity_relations USING INDEX entity_relations_(from|to) \(kind=\?\)/u,
  );
  expect(current.join("\n")).toMatch(
    /SEARCH r USING INDEX entity_relations_(from|to) \(kind=\?\)/u,
  );
  // ...and looks for a newer decision of each by both index columns.
  expect(current.join("\n")).toMatch(
    /SEARCH newer USING INDEX entity_relations_(from|to) \(kind=\? AND (from|to)_ref=\?\)/u,
  );
  for (const step of [...shipped, ...current]) expect(step).not.toMatch(/^SCAN /u);
  db.close();
});
