import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { coreDatabase } from "./sqlite.ts";

const migration = readFileSync(
  new URL("../migrations/core/0095_sbi_vc_classic_unit_eligibility.sql", import.meta.url),
  "utf8",
);
const snapshots = [
  ["sbi-vc-account-margin", "account-margin"],
  ["sbi-vc-cash-balances", "cash-balances"],
  ["sbi-vc-position-summary", "position-summary"],
] as const;
let image: Uint8Array;
beforeAll(() => {
  const db = coreDatabase("0017", "0095");
  image = db.serialize();
  db.close();
}, 60_000);

describe("SBI VC classic-unit eligibility migration", () => {
  test("opts in exactly the three snapshots and 201 bounded classic transaction datasets", () => {
    const db = Database.deserialize(image);
    const selected = db
      .query(
        "SELECT parser_name,dataset FROM dataset_snapshot_policies WHERE snapshot_selection=1 ORDER BY parser_name,dataset",
      )
      .all();
    db.exec(migration);
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' AND unit_scope='unit'",
        )
        .get(),
    ).toEqual({ n: 204 });
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' AND snapshot_selection=0",
        )
        .get(),
    ).toEqual({ n: 201 });
    expect(
      db
        .query(
          "SELECT parser_name,dataset FROM dataset_snapshot_policies WHERE snapshot_selection=1 ORDER BY parser_name,dataset",
        )
        .all(),
    ).toEqual(selected);
    for (const dataset of [
      "executions-recent-page-0002",
      "executions-historical-page-0101",
      "cashflows-historical-page-0101",
      "cashflows-all-recent-page-0001",
      "cashflows-all-historical-page-0001",
    ]) {
      expect(
        db
          .query(
            "SELECT * FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' AND dataset=?",
          )
          .get(dataset),
      ).toBeNull();
    }
    const before = db
      .query("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset")
      .all();
    db.exec(migration);
    expect(
      db.query("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name,dataset").all(),
    ).toEqual(before);
    db.close();
  });

  test("preserves each nondefault policy field and preexisting transaction configuration", () => {
    for (const [field, value] of [
      ["policy_id", "coverage-v1"],
      ["required_parser_version", "9.0.0"],
      ["policy_version", 2],
      ["replaces_previous_on_complete_empty", 0],
      ["unit_scope", "unit"],
      ["snapshot_selection", 0],
      ["updated_at_ms", 42],
    ] as const) {
      const db = Database.deserialize(image);
      for (const [parser, dataset] of snapshots) {
        db.query(
          `UPDATE dataset_snapshot_policies SET ${field}=? WHERE parser_name=? AND dataset=?`,
        ).run(value, parser, dataset);
      }
      db.exec(
        "INSERT INTO dataset_snapshot_policies(source_id,parser_name,dataset,policy_id,unit_scope,snapshot_selection,required_parser_version,updated_at_ms) VALUES('sbi-vc-trade','sbi-vc-executions','executions-historical-page-0001','coverage-v1','run',1,'9.0.0',42)",
      );
      const before = db
        .query(
          "SELECT * FROM dataset_snapshot_policies WHERE source_id='sbi-vc-trade' ORDER BY parser_name,dataset",
        )
        .all();
      db.exec(migration);
      for (const row of before) {
        expect(
          db
            .query("SELECT * FROM dataset_snapshot_policies WHERE parser_name=? AND dataset=?")
            .get(
              (row as { parser_name: string }).parser_name,
              (row as { dataset: string }).dataset,
            ),
        ).toEqual(row);
      }
      db.close();
    }
  });
});
