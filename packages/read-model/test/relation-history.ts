// Synthetic relation histories for the readers of `entity_relations` that pick
// one row per relation triple (ADR 0017's amendment of 2026-11-06): random
// histories with several rows per triple, every status, `created_at` ties,
// ids that disagree with time and insertion order that disagrees with both,
// written with the decision migration 0029 requires of each row; and a model
// of the triple's current row written without SQL.
//
// The rule: a triple's current row is its newest decision (`accepted`,
// `rejected` or `released`); only a triple with no decision reads its newest
// proposal. A later `proposed` row never replaces a decision. "Newest" is the
// reader's own order (`ORDER`), which this change does not alter. Every value
// is synthetic. Shared by the read-model, application and processor tests.
import type { Database } from "bun:sqlite";

export const RELATION_STATUSES = ["proposed", "accepted", "rejected", "released"] as const;
export type RelationStatus = (typeof RELATION_STATUSES)[number];

export interface HistoryRow {
  id: string;
  kind: string;
  from_ref: string;
  to_ref: string;
  status: RelationStatus;
  created_at: string;
  valid_from?: string | null;
  valid_to?: string | null;
  /** The row's decision is superseded by a later decision on the same subject. */
  superseded?: boolean;
}

/** A row as stored: `rowid` is its insertion position, 1-based. */
export interface StoredHistoryRow extends HistoryRow {
  rowid: number;
}

/** A small deterministic generator (mulberry32) so a failing store can be rebuilt from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const pick = <T>(next: () => number, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)]!;

const DECISION_KIND: Record<RelationStatus, string> = {
  proposed: "propose",
  accepted: "accept",
  rejected: "reject",
  released: "supersede",
};

/**
 * Appends `rows` in order (so `rowid` is the position in `rows` plus whatever
 * the table already held) with the decision each row names; a `superseded`
 * row's decision gets `superseded_by` a second decision on the same subject,
 * the only update migration 0029 permits. Returns the rows with their rowids.
 */
export function insertHistory(db: Database, rows: readonly HistoryRow[]): StoredHistoryRow[] {
  const decision = db.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,
      operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?1,'relation',?2,?3,?4,?5,'synthetic-operator',NULL,'Synthetic relation decision.','[]',?6,NULL,?7)`,
  );
  const relation = db.prepare(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,
      evidence_refs_json,created_at)
     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'[]',?9)`,
  );
  const supersede = db.prepare("UPDATE decision_revisions SET superseded_by=?1 WHERE id=?2");
  const stored: StoredHistoryRow[] = [];
  db.transaction(() => {
    for (const row of rows) {
      const kind = DECISION_KIND[row.status];
      decision.run(
        `dr_${row.id}`,
        row.id,
        1,
        kind,
        row.status === "proposed" ? "ai" : "manual",
        null,
        row.created_at,
      );
      const { lastInsertRowid } = relation.run(
        row.id,
        row.kind,
        row.from_ref,
        row.to_ref,
        row.valid_from ?? null,
        row.valid_to ?? null,
        row.status,
        `dr_${row.id}`,
        row.created_at,
      );
      if (row.superseded === true) {
        decision.run(`dr_${row.id}_next`, row.id, 2, "supersede", "manual", 1, row.created_at);
        supersede.run(`dr_${row.id}_next`, `dr_${row.id}`);
      }
      stored.push({ ...row, rowid: Number(lastInsertRowid) });
    }
  })();
  return stored;
}

/** SQLite's BINARY collation on the ASCII text these stores hold. */
export const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A reader's order of one triple's rows: positive when `a` is newer than `b`. */
export type Order = (a: StoredHistoryRow, b: StoredHistoryRow) => number;

/** `created_at`, then `id` (the change lifecycle's order). */
export const BY_CREATED_ID: Order = (a, b) =>
  binary(a.created_at, b.created_at) || binary(a.id, b.id);
/** `created_at`, then insertion order (the pending-to-posted readers). */
export const BY_CREATED_ROWID: Order = (a, b) =>
  binary(a.created_at, b.created_at) || a.rowid - b.rowid;
/** Insertion order alone (the ownership readers). */
export const BY_ROWID: Order = (a, b) => a.rowid - b.rowid;

/** The rule: any decision is newer than any proposal; otherwise the reader's order. */
export function decisionsFirst(order: Order): Order {
  return (a, b) => {
    const decided = Number(a.status !== "proposed") - Number(b.status !== "proposed");
    return decided !== 0 ? decided : order(a, b);
  };
}

export const tripleKey = (row: { kind: string; from_ref: string; to_ref: string }): string =>
  JSON.stringify([row.kind, row.from_ref, row.to_ref]);

/** Per triple, its newest row by `order`. */
export function newestByTriple(
  rows: readonly StoredHistoryRow[],
  order: Order,
  key: (row: StoredHistoryRow) => string = tripleKey,
): Map<string, StoredHistoryRow> {
  const newest = new Map<string, StoredHistoryRow>();
  for (const row of rows) {
    const held = newest.get(key(row));
    if (held === undefined || order(row, held) > 0) newest.set(key(row), row);
  }
  return newest;
}

/**
 * The triples where the rule and "newest row of any status" disagree: the
 * newest row is a proposal recorded after the triple's newest decision.
 */
export function proposalHidesDecision(
  rows: readonly StoredHistoryRow[],
  order: Order,
  key: (row: StoredHistoryRow) => string = tripleKey,
): Set<string> {
  const any = newestByTriple(rows, order, key);
  const rule = newestByTriple(rows, decisionsFirst(order), key);
  return new Set([...any].filter(([triple, row]) => rule.get(triple) !== row).map(([k]) => k));
}

export interface RandomHistoryOptions {
  kinds: readonly string[];
  fromRefs: readonly string[];
  toRefs: readonly string[];
  /** Rows drawn; each lands on a random triple of the pools. */
  rows: number;
  /** Chance a row carries a validity window. */
  dated?: number;
  /** Chance a row's decision is superseded. */
  superseded?: number;
}

/**
 * `rows` random rows over the pools: statuses uniform, `created_at` from five
 * instants (so ties are common) in an order unrelated to insertion, and ids
 * whose order is unrelated to both.
 */
export function randomHistory(seed: number, options: RandomHistoryOptions): HistoryRow[] {
  const next = random(seed);
  const rows: HistoryRow[] = [];
  for (let i = 0; i < options.rows; i += 1) {
    const from = pick(next, options.fromRefs);
    let to = pick(next, options.toRefs);
    if (to === from) to = `${to}-other`;
    const dated = next() < (options.dated ?? 0);
    rows.push({
      id: `rel_${Math.floor(next() * 1e9).toString(36)}_${seed}_${i}`,
      kind: pick(next, options.kinds),
      from_ref: from,
      to_ref: to,
      status: pick(next, RELATION_STATUSES),
      created_at: `2026-0${1 + Math.floor(next() * 5)}-01T00:00:00.000Z`,
      ...(dated ? { valid_from: "2026-01-01", valid_to: null } : {}),
      ...(next() < (options.superseded ?? 0) ? { superseded: true } : {}),
    });
  }
  return rows;
}
