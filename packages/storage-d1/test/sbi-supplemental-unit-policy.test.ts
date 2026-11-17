import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { coreDatabase } from "./sqlite.ts";
const sql = readFileSync(
  new URL("../migrations/core/0100_sbi_supplemental_unit_eligibility.sql", import.meta.url),
  "utf8",
);
let image: Uint8Array;
beforeAll(() => {
  const db = coreDatabase("0017", "0100");
  image = db.serialize();
  db.close();
}, 60_000);
const rows = (db: Database) =>
  db
    .query(
      "SELECT * FROM dataset_snapshot_policies WHERE source_id='sbi-securities' ORDER BY parser_name,dataset",
    )
    .all();
test("SBI financial unit opt-ins preserve snapshot membership and are idempotent", () => {
  const db = Database.deserialize(image);
  const snapshots = db
    .query(
      "SELECT parser_name,dataset FROM dataset_snapshot_policies WHERE snapshot_selection=1 ORDER BY parser_name,dataset",
    )
    .all();
  db.exec(sql);
  expect(rows(db)).toHaveLength(12); // Eleven financial datasets plus the separate mailbox PDF.
  expect(rows(db).every((row) => (row as { unit_scope: string }).unit_scope === "unit")).toBe(true);
  expect(
    db
      .query(
        "SELECT parser_name,dataset FROM dataset_snapshot_policies WHERE snapshot_selection=1 ORDER BY parser_name,dataset",
      )
      .all(),
  ).toEqual(snapshots);
  const before = rows(db);
  db.exec(sql);
  expect(rows(db)).toEqual(before);
  db.close();
});
test("every nondefault snapshot field and existing history policy survives migration", () => {
  for (const [field, value] of [
    ["policy_id", "operator-policy"],
    ["policy_version", 2],
    ["required_parser_version", "operator-version"],
    ["replaces_previous_on_complete_empty", 0],
    ["unit_scope", "unit"],
    ["snapshot_selection", 0],
    ["updated_at_ms", 42],
  ] as const) {
    const db = Database.deserialize(image);
    // Both allowed policy ids are tested as changes from their dataset's shipped default.
    if (field === "policy_id")
      db.exec(
        "UPDATE dataset_snapshot_policies SET policy_id=CASE policy_id WHEN 'coverage-v1' THEN 'legacy-warning-compat-v1' ELSE 'coverage-v1' END WHERE source_id='sbi-securities' AND snapshot_selection=1",
      );
    else
      db.query(
        `UPDATE dataset_snapshot_policies SET ${field}=? WHERE source_id='sbi-securities' AND snapshot_selection=1`,
      ).run(value);
    db.exec(
      "INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,required_parser_version,unit_scope,snapshot_selection,updated_at_ms) VALUES('sbi-securities','foreign-cash-history','sbi-foreign-cash-history','coverage-v1','operator-version','run',0,42)",
    );
    const before = rows(db);
    db.exec(sql);
    for (const row of before) {
      const key = row as { parser_name: string; dataset: string };
      expect(
        db
          .query("SELECT * FROM dataset_snapshot_policies WHERE parser_name=? AND dataset=?")
          .get(key.parser_name, key.dataset),
      ).toEqual(row);
    }
    db.close();
  }
});
