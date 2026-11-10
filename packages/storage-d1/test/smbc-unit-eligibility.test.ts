import { expect, test } from "bun:test";
import { CORE_MIGRATIONS_URL, migrationSql } from "../src/migrations.ts";
import { coreDatabase } from "./sqlite.ts";

const sql = migrationSql(CORE_MIGRATIONS_URL, "0096_smbc_foreign_ordinary_unit_eligibility.sql");
const policies = (db: ReturnType<typeof coreDatabase>) =>
  db
    .query("SELECT * FROM dataset_snapshot_policies WHERE source_id='smbc-bank' ORDER BY dataset")
    .all();

test("SMBC defaults opt only yen datasets into independent-unit eligibility and transaction windows never become snapshots", () => {
  const db = coreDatabase("0017", "0096");
  try {
    db.exec(sql);
    expect(
      db
        .query(
          "SELECT dataset,unit_scope,snapshot_selection FROM dataset_snapshot_policies WHERE source_id='smbc-bank' ORDER BY dataset",
        )
        .all(),
    ).toEqual([
      { dataset: "balance-normalized", unit_scope: "unit", snapshot_selection: 1 },
      { dataset: "transactions-normalized", unit_scope: "unit", snapshot_selection: 0 },
    ]);
    const once = policies(db);
    db.exec(sql);
    expect(policies(db)).toEqual(once);
  } finally {
    db.close();
  }
});

test("operator overrides survive the guarded balance update and transaction default insertion", () => {
  const db = coreDatabase("0017", "0096");
  try {
    db.exec(
      "UPDATE dataset_snapshot_policies SET policy_id='coverage-v1',required_parser_version='operator-version',updated_at_ms=1 WHERE parser_name='smbc-direct-balance'",
    );
    db.exec(
      "INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,required_parser_version,unit_scope,snapshot_selection,updated_at_ms) VALUES('smbc-bank','transactions-normalized','smbc-direct-transactions','coverage-v1','operator-version','run',0,1)",
    );
    const before = policies(db);
    db.exec(sql);
    expect(policies(db)).toEqual(before);
  } finally {
    db.close();
  }
});
