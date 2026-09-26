// `card_bank_debit_facts` as migration 0052 recreates it: a union of the SMBC
// and SBI Shinsei adapter branches. The SMBC branch must return exactly the
// rows the migration 0044 view returned (its text, frozen below), on the small
// random stores and on the scaled store with statement history; each branch
// ranks its own provider key, so no provider id is a payment twice; and
// `debit_date` is the civil date the sweep matched before (SMBC) or the
// provider posting date (SBI Shinsei). Every value is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { randomSettlementStore } from "./card-settlement-random-store";
import { STATEMENT_CI_SCALE, scaledStore } from "./card-usage-scale-fixture";

/**
 * `card_bank_debit_facts` exactly as migration 0044 created it. Verbatim; never
 * edit it by hand, and never import it outside tests.
 */
const LEGACY_0044_CARD_BANK_DEBIT_FACTS_SQL = `WITH ranked AS (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,a.source_id,t.as_of,
 t.external_id,t.status,t.extra_json,d.status AS value_status,d.coefficient,d.scale,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS bank_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM transaction_observations t
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL AND t.external_id<>''
)
SELECT * FROM ranked WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%'`;

const COLUMNS =
  "id,parse_run_id,source_account,unit_ref,source_id,as_of,external_id,status,extra_json,value_status,coefficient,scale,bank_key,position";

/** The date the sweep's SMBC regex accepted before migration 0052. */
const SMBC_DATE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T00:00:00[+]09:00$/u;

interface Row {
  id: number;
  source_id: string;
  as_of: string | null;
  bank_key: string;
  debit_date: string | null;
  adapter: string;
  unit_ref: string;
  status: string | null;
  coefficient: string | null;
  extra_json: string;
}

function checkStore(db: Database): { smbc: number; sbiShinsei: number } {
  const smbc = db
    .query(`SELECT ${COLUMNS} FROM card_bank_debit_facts WHERE adapter='smbc-bank' ORDER BY id`)
    .all();
  expect(smbc).toEqual(
    db.query(`SELECT ${COLUMNS} FROM (${LEGACY_0044_CARD_BANK_DEBIT_FACTS_SQL}) ORDER BY id`).all(),
  );
  const rows = db.query("SELECT * FROM card_bank_debit_facts ORDER BY id").all() as Row[];
  // One row per provider key, across both adapters.
  expect(new Set(rows.map((row) => row.bank_key)).size).toBe(rows.length);
  let sbiShinsei = 0;
  for (const row of rows) {
    expect(row.adapter).toBe(row.source_id);
    if (row.adapter === "smbc-bank") {
      expect(row.debit_date).toBe(row.as_of?.match(SMBC_DATE)?.[1] ?? null);
      continue;
    }
    sbiShinsei += 1;
    expect(row.adapter).toBe("sbi-shinsei-bank");
    expect(row.debit_date).toBe(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(row.as_of ?? "") ? row.as_of : null,
    );
    expect([row.unit_ref, row.status, row.coefficient?.startsWith("-")]).toEqual([
      "JPY",
      null,
      true,
    ]);
    expect(JSON.parse(row.extra_json)._kogane.amountSignSource).toBe("debit");
  }
  return { smbc: smbc.length, sbiShinsei };
}

describe("card_bank_debit_facts (migration 0052)", () => {
  test("the SMBC branch is the 0044 view on random stores; SBI Shinsei rows are the provider's own JPY debits", () => {
    let smbc = 0;
    let sbiShinsei = 0;
    for (let seed = 1; seed <= 16; seed += 1) {
      const found = checkStore(randomSettlementStore(seed, new Set()).db);
      smbc += found.smbc;
      sbiShinsei += found.sbiShinsei;
    }
    expect(smbc).toBeGreaterThan(0);
    expect(sbiShinsei).toBeGreaterThan(0);
  }, 120_000);

  describe("on the scaled store with statement history", () => {
    let db: Database;
    beforeAll(async () => {
      db = (await scaledStore(STATEMENT_CI_SCALE)).store.db;
    }, 120_000);

    test("the SMBC branch is the 0044 view and each re-observed SBI Shinsei id is one row", () => {
      const found = checkStore(db);
      expect(found.smbc).toBeGreaterThan(0);
      expect(found.sbiShinsei).toBeGreaterThan(0);
      // Every SBI Shinsei row is re-stated by the captures whose window covers
      // it: more observations than current rows, one current row per id.
      const observed = db
        .query(
          `SELECT count(*) AS n,count(DISTINCT external_id) AS ids FROM transaction_observations
           WHERE source_account LIKE 'sbi-shinsei:%' AND amount_minor<0`,
        )
        .get() as { n: number; ids: number };
      expect(observed.n).toBeGreaterThan(observed.ids);
      expect(found.sbiShinsei).toBe(observed.ids);
    });
  });
});
