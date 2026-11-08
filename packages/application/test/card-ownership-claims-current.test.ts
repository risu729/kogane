// The card ownership review's claims read (`CARD_OWNERSHIP_CLAIMS_SQL`,
// src/query/card-ownership.ts) under ADR 0017's amendment of 2026-11-06: per
// owner of an account (through either alias), its newest decision in
// insertion order, or its newest proposal when it has none. The scenario on
// the review's own fixture is in card-ownership-query.test.ts.
//
// What is proved here, against the text that shipped
// (./card-ownership-claims-legacy-sql.ts):
// - on random stores (both aliases, other accounts and roles, superseded
//   decisions, dated claims, a pin below the newest row) the current read
//   equals a model written without SQL, the shipped read equals the old rule's
//   model, and the two differ only for owners whose newest row is a proposal
//   recorded after a decision;
// - on a scaled store with no proposal after a decision both reads return the
//   same claims;
// - without table statistics (D1 never runs ANALYZE) both the claims and each
//   newer-row check are keyed searches of an `entity_relations` index.
// Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BY_ROWID,
  decisionsFirst,
  insertHistory,
  newestByTriple,
  random,
  randomHistory,
  type HistoryRow,
  type Order,
  type StoredHistoryRow,
} from "../../read-model/test/relation-history.ts";
import { CARD_OWNERSHIP_CLAIMS_SQL } from "../src/query/card-ownership.ts";
import {
  LEGACY_CARD_OWNERSHIP_CLAIMS_SQL,
  LEGACY_CARD_OWNERSHIP_CLAIMS_SQL_SHA256,
} from "./card-ownership-claims-legacy-sql.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

interface ClaimRow {
  id: string;
  to_ref: string;
  status: string;
}
const read = (db: Database, sql: string, role: string, account: string, last: number) =>
  (db.query(sql).all(role, account, last) as ClaimRow[]).map(({ id, to_ref, status }) => ({
    id,
    to_ref,
    status,
  }));

const ACCOUNT = "acct-1";
const ALIASES = [ACCOUNT, `account:${ACCOUNT}`];

/** The model, without SQL: per owner of `role` on the account, at or below `last`. */
function model(
  rows: readonly StoredHistoryRow[],
  role: string,
  last: number,
  order: Order,
): ClaimRow[] {
  const mine = rows.filter(
    (row) => row.kind === role && ALIASES.includes(row.from_ref) && row.rowid <= last,
  );
  return [...newestByTriple(mine, order, (row) => row.to_ref).values()]
    .filter((row) => row.superseded !== true)
    .sort((a, b) => b.rowid - a.rowid)
    .slice(0, 51)
    .map((row) => ({ id: row.id, to_ref: row.to_ref, status: row.status }));
}

/** Owners whose newest row (as the shipped read ordered them) is a proposal after a decision. */
function hidden(rows: readonly StoredHistoryRow[], role: string, last: number): Set<string> {
  const mine = rows.filter(
    (row) => row.kind === role && ALIASES.includes(row.from_ref) && row.rowid <= last,
  );
  const any = newestByTriple(mine, BY_ROWID, (row) => row.to_ref);
  const rule = newestByTriple(mine, decisionsFirst(BY_ROWID), (row) => row.to_ref);
  return new Set([...any].filter(([owner, row]) => rule.get(owner) !== row).map(([k]) => k));
}

describe("the current read against the shipped text", () => {
  test("the frozen text is the text that shipped", () => {
    expect(createHash("sha256").update(LEGACY_CARD_OWNERSHIP_CLAIMS_SQL).digest("hex")).toBe(
      LEGACY_CARD_OWNERSHIP_CLAIMS_SQL_SHA256,
    );
  });

  test("on random stores: the rule's model, and the shipped read only where a proposal hides a decision", () => {
    let differing = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const db = migratedDatabase();
      const rows = insertHistory(
        db,
        randomHistory(seed, {
          kinds: ["liable_party", "liable_party", "beneficial_owner"],
          fromRefs: [...ALIASES, "acct-2"],
          toRefs: ["party:p1", "party:p2", "party:p3"],
          rows: 1 + (seed % 20),
          dated: 0.2,
          superseded: 0.15,
        }),
      );
      const next = random(seed + 1);
      for (const role of ["liable_party", "beneficial_owner"]) {
        // The pin's last row, or one below it (a row recorded after the pin).
        const max = rows.reduce((top, row) => Math.max(top, row.rowid), 0);
        const last = next() < 0.3 ? Math.max(0, max - 1) : max;
        const current = read(db, CARD_OWNERSHIP_CLAIMS_SQL, role, ACCOUNT, last);
        const shipped = read(db, LEGACY_CARD_OWNERSHIP_CLAIMS_SQL, role, ACCOUNT, last);
        expect(current).toEqual(model(rows, role, last, decisionsFirst(BY_ROWID)));
        expect(shipped).toEqual(model(rows, role, last, BY_ROWID));
        const owners = hidden(rows, role, last);
        differing += owners.size;
        const strip = (claims: ClaimRow[]) => claims.filter((claim) => !owners.has(claim.to_ref));
        expect(strip(current)).toEqual(strip(shipped));
        // Where they differ the shipped read showed the proposal, or nothing.
        for (const claim of shipped)
          if (owners.has(claim.to_ref)) expect(claim.status).toBe("proposed");
      }
      db.close();
    }
    expect(differing).toBeGreaterThan(50);
  }, 120_000);

  test("a scaled store with no proposal after a decision reads the same claims", () => {
    const db = migratedDatabase();
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const from = i % 3 === 0 ? `account:${ACCOUNT}` : i % 3 === 1 ? ACCOUNT : `acct-${i % 50}`;
      const statuses: HistoryRow["status"][] =
        i % 4 === 0 ? ["proposed", "accepted"] : [(["accepted", "rejected"] as const)[i % 2]!];
      statuses.forEach((status, step) =>
        rows.push({
          id: `rel_${i}_${step}`,
          kind: i % 5 === 0 ? "beneficial_owner" : "liable_party",
          from_ref: from,
          to_ref: `party:scale-${i % 400}`,
          status,
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    const stored = insertHistory(db, rows);
    for (const role of ["liable_party", "beneficial_owner"])
      expect(hidden(stored, role, stored.length).size).toBe(0);
    for (const role of ["liable_party", "beneficial_owner"])
      for (const last of [stored.length, 2500, 10]) {
        const shipped = read(db, LEGACY_CARD_OWNERSHIP_CLAIMS_SQL, role, ACCOUNT, last);
        expect(read(db, CARD_OWNERSHIP_CLAIMS_SQL, role, ACCOUNT, last)).toEqual(shipped);
      }
  });

  test("without table statistics the claims and each newer-row check are keyed searches", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const plan = (sql: string): string[] =>
      (
        db.query(`EXPLAIN QUERY PLAN ${sql}`).all("liable_party", ACCOUNT, 100) as {
          detail: string;
        }[]
      ).map((step) => step.detail);
    const reads = plan(CARD_OWNERSHIP_CLAIMS_SQL).filter((detail) =>
      /^(SCAN|SEARCH) (r|n)\b/u.test(detail),
    );
    expect(reads.map((detail) => detail.split(" ")[1]).sort()).toEqual(["n", "n", "r"]);
    for (const detail of reads)
      expect(detail).toMatch(/^SEARCH (r|n) USING (COVERING )?INDEX entity_relations_(from|to) /u);
    // The newer-row check is the shipped one: the same keyed rowid range.
    const shippedNewer = plan(LEGACY_CARD_OWNERSHIP_CLAIMS_SQL).filter((detail) =>
      /^SEARCH n\b/u.test(detail),
    );
    expect(shippedNewer).toHaveLength(1);
    expect(reads).toContain(shippedNewer[0]!);
  });
});
