import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { aliasClassText } from "../../domain/src/economic-contract.ts";
import { declaredAliasClass } from "../../domain/src/row-identity.ts";
import {
  ECONOMIC_ROW_READINESS_SQL,
  loadEconomicRowReadiness,
} from "../src/economic-row-readiness.ts";
import { fullCoreSchema } from "./card-usage-scale-fixture.ts";
import { randomSettlementStore } from "./card-settlement-random-store.ts";
import type { SqlExecutor } from "../src/reader.ts";
const executor = (db: Database): SqlExecutor => ({
  all: async <T>(s: string, a: readonly unknown[]) =>
    db.query(s).all(...(a as SQLQueryBindings[])) as T[],
  first: async <T>(s: string, a: readonly unknown[]) =>
    db.query(s).get(...(a as SQLQueryBindings[])) as T | null,
});
beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);
test("keyed holders equal the guard live view, including legacy settlements; ownership and alias match existing helpers", async () => {
  let legacy = 0;
  let aliases = 0;
  let compared = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { db, transactions } = randomSettlementStore(seed, new Set());
    const sql = executor(db);
    const refs = transactions.map((observationId) => ({
      observationId,
      parseRunId: (
        db
          .query("SELECT parse_run_id FROM transaction_observations WHERE id=?")
          .get(observationId) as { parse_run_id: number }
      ).parse_run_id,
    }));
    const rows = await loadEconomicRowReadiness(sql, refs, "bank-movement");
    for (const row of rows) {
      if (!row.visible) continue;
      compared++;
      const holders = db
        .query(
          `SELECT DISTINCT event_id,revision FROM live_consumption_claims WHERE book='cash-movement' AND consumption_key=? ORDER BY event_id,revision`,
        )
        .all(row.key_text) as { event_id: string; revision: number }[];
      expect(JSON.parse(row.key_holders)).toEqual(holders.map((r) => [r.event_id, r.revision]));
      legacy += Number(
        (
          db
            .query(`SELECT count(*) AS n FROM card_settlement_candidates c JOIN card_settlement_decisions d ON d.proposal_id=c.id AND d.status='accepted'
    JOIN economic_event_revisions v ON v.event_id=d.event_id AND v.revision=d.revision AND v.superseded_by IS NULL WHERE c.bank_key=?`)
            .get(row.key_text) as { n: number }
        ).n,
      );
      const expectedAliases = db
        .query(
          `SELECT DISTINCT event_id,revision FROM live_consumption_claims WHERE book='cash-movement' AND alias_class=? ORDER BY event_id,revision`,
        )
        .all(row.alias_text) as { event_id: string; revision: number }[];
      expect(JSON.parse(row.alias_holders)).toEqual(
        expectedAliases.map((r) => [r.event_id, r.revision]),
      );
      aliases += expectedAliases.length;
      const owner = db
        .query(
          "SELECT owner_ref FROM card_settlement_fact_ownership WHERE kind='transaction' AND observation_id=?",
        )
        .get(row.observation_id) as { owner_ref: string | null } | null;
      expect(row.owner_ref).toBe(owner?.owner_ref ?? null);
      let extra: unknown = null;
      try {
        extra = JSON.parse(row.extra_json ?? "null") as unknown;
      } catch {}
      const declared = declaredAliasClass({
        sourceId: row.source_id!,
        parserName: row.parser_name!,
        sourceAccount: row.source_account!,
        extra,
        accountId: row.account_id,
      });
      expect(row.alias_text).toBe(declared === null ? null : aliasClassText(declared));
    }
    db.close();
  }
  expect(compared).toBeGreaterThan(20);
  expect(legacy).toBeGreaterThan(0);
  expect(aliases).toBeGreaterThan(0);
}, 60_000);
test("unrelated transaction history does not alter the keyed row or introduce a full-history plan", async () => {
  const { db, transactions } = randomSettlementStore(1, new Set());
  const sql = executor(db);
  const id = transactions[0]!;
  const p = (
    db.query("SELECT parse_run_id FROM transaction_observations WHERE id=?").get(id) as {
      parse_run_id: number;
    }
  ).parse_run_id;
  const refs = [{ observationId: id, parseRunId: p }];
  const before = await loadEconomicRowReadiness(sql, refs, "bank-movement");
  const add = db.transaction(() => {
    for (let i = 0; i < 4000; i++)
      db.run(
        `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,extra_json,raw_locator)
  VALUES(?,?,'synthetic-unrelated',?,'posted','{}','json:$.synthetic')`,
        [900000 + i, p, `unrelated-${i}`],
      );
  });
  add();
  const start = performance.now();
  const after = await loadEconomicRowReadiness(sql, refs, "bank-movement");
  const elapsed = performance.now() - start;
  expect(after.map(({ pins: _pins, ...row }) => row)).toEqual(
    before.map(({ pins: _pins, ...row }) => row),
  );
  const plan = db
    .query(`EXPLAIN QUERY PLAN ${ECONOMIC_ROW_READINESS_SQL}`)
    .all(JSON.stringify(refs), "cash-movement") as { detail: string }[];
  expect(plan.map((r) => r.detail).filter((d) => /SCAN (?:t|c|v|d|pub)\b/u.test(d))).toEqual([]);
  expect(elapsed).toBeLessThan(2000);
  db.close();
}, 60_000);
