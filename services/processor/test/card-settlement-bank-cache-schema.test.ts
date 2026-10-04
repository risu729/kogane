import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { randomSettlementStore } from "../../../packages/read-model/test/card-settlement-random-store.ts";
import {
  CORE_REVISION_SQL,
  type CoreRevisionRow,
} from "../../../packages/read-model/src/source-revision.ts";
import { CARD_SETTLEMENT_BANK_DEBITS_SQL } from "../src/card-settlement-job.ts";
import { createSettlementBankReader } from "../src/card-settlement-bank-cache.ts";

interface BankRow {
  id: number;
  parse_run_id: number;
  source_account: string;
  source_id: string;
  account_id: string | null;
  owner_ref: string | null;
  debit_date: string;
}

test("real source revisions invalidate bank rows, ownership, mappings and visibility on the same date", async () => {
  const store = randomSettlementStore(1, new Set());
  const db = store.db;
  try {
    const query = (date: string) =>
      db.query(CARD_SETTLEMENT_BANK_DEBITS_SQL).all(date, date, 1000) as BankRow[];
    const revision = () => db.query(CORE_REVISION_SQL).get() as CoreRevisionRow;
    let reads = 0;
    const read = createSettlementBankReader(
      async () => revision(),
      async (date) => {
        reads++;
        return query(date);
      },
    );
    const selected = store.dueDates
      .flatMap(query)
      .find((row) => row.source_id === "smbc-bank" && row.account_id !== null);
    if (!selected) throw new Error("synthetic bank fixture missing");
    const date = selected.debit_date;
    let expectedReads = 0;
    const fresh = async () => {
      expect(await read(date)).toEqual(query(date));
      expect(reads).toBe(++expectedReads);
      await read(date);
      expect(reads).toBe(expectedReads);
    };
    await fresh();
    // All quantity shapes create a decimal row, including missing/unparsed.
    // That indirect trigger is why transaction inserts invalidate this cache.
    for (const [minor, text] of [
      [-100, "-100"],
      [null, null],
      [null, "unknown"],
      [-100, "-200"],
    ] as const) {
      const before = revision().source_revision;
      db.query(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,
        amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
        VALUES(?,?,'cache-debit-'||?,'posted',?,?,0,'JPY',?,'synthetic-cache',
        '{"_kogane":{"direction":"outflow","amountSignSource":"direction"}}')`).run(
        selected.parse_run_id,
        selected.source_account,
        expectedReads,
        minor,
        text,
        date + "T00:00:00+09:00",
      );
      expect(revision().source_revision).toBeGreaterThan(before);
      await fresh();
    }
    db.query(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,
      method,actor_id,reason,evidence_refs_json,created_at)
      VALUES('cache-decision','relation','cache-relation',1,'accept','manual','synthetic','synthetic','[]','2099-01-01')`).run();
    db.query(`INSERT INTO entity_relations(id,kind,from_ref,to_ref,status,decision_revision_id,evidence_refs_json,created_at)
      VALUES('cache-relation','beneficial_owner',?,'party:cache-owner','accepted','cache-decision','[]','2099-01-01')`).run(
      "account:" + selected.account_id,
    );
    await fresh();
    const mapping = db
      .query(`SELECT m.* FROM current_account_mappings m JOIN source_accounts s ON s.id=m.source_account_id
      WHERE s.source_id=? AND json_extract(s.reference_json,'$[0]')=? LIMIT 1`)
      .get(selected.source_id, selected.source_account) as {
      source_account_id: string;
      revision: number;
      policy_version: number;
      label: string;
      status: string;
    };
    db.exec("INSERT INTO accounts VALUES('cache-account','synthetic','deposit','provider-local')");
    db.query(`INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
      VALUES('cache-mapping',?,?,'cache-account','rule','synthetic',?,'2099-01-01',?,?)`).run(
      mapping.source_account_id,
      mapping.revision + 1,
      mapping.policy_version,
      mapping.label,
      mapping.status,
    );
    await fresh();
    const beforeVisible = query(date);
    db.query(`INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms)
      SELECT a.fetch_run_id,'exclude_from_financial_views','synthetic-cache-test',0
      FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE p.id=?`).run(
      selected.parse_run_id,
    );
    await fresh();
    expect(query(date)).not.toEqual(beforeVisible);
  } finally {
    db.close();
  }
}, 60000);

test("the shared bank read is byte-identical to the query before caching", () => {
  expect(CARD_SETTLEMENT_BANK_DEBITS_SQL).toBe(
    readFileSync(
      new URL("./fixtures/card-bank-debits-before-sharing.sql", import.meta.url),
      "utf8",
    ),
  );
});
