import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { coreDatabase } from "./sqlite.ts";
import {
  sbiIncomePayments,
  sbiRealisedGains,
} from "../../parsers/src/parsers/sbi-income-history.ts";

const sql = readFileSync(
  new URL("../migrations/core/0103_sbi_income_policy_version_0_1_3.sql", import.meta.url),
  "utf8",
);
let image: Uint8Array;
beforeAll(() => {
  const db = coreDatabase("0017", "0103");
  image = db.serialize();
  db.close();
}, 60_000);
const policies = (db: Database) =>
  db
    .query("SELECT * FROM dataset_snapshot_policies ORDER BY source_id,parser_name,dataset")
    .all() as Record<string, unknown>[];
const income = (row: Record<string, unknown>) =>
  ["sbi-income-payments", "sbi-realised-gains"].includes(String(row["parser_name"]));

test("the income pins follow the deployed parser version and nothing else moves", () => {
  const db = Database.deserialize(image);
  const before = policies(db);
  expect(before.filter(income).map((row) => row["required_parser_version"])).toEqual([
    "0.1.2",
    "0.1.2",
  ]);
  db.exec(sql);
  const after = policies(db);
  expect(after.filter(income).map((row) => row["required_parser_version"])).toEqual([
    sbiIncomePayments.version,
    sbiRealisedGains.version,
  ]);
  expect(after.filter(income).every((row) => row["updated_at_ms"] === 1795132800000)).toBe(true);
  // Every other row and every other field of the moved rows is unchanged.
  expect(after.filter((row) => !income(row))).toEqual(before.filter((row) => !income(row)));
  const strip = (row: Record<string, unknown>) => {
    const { required_parser_version: _v, updated_at_ms: _t, ...rest } = row;
    return rest;
  };
  expect(after.filter(income).map(strip)).toEqual(before.filter(income).map(strip));
  // Idempotent.
  db.exec(sql);
  expect(policies(db)).toEqual(after);
  db.close();
});

test("an operator's own pin is left alone", () => {
  const db = Database.deserialize(image);
  db.exec(
    "UPDATE dataset_snapshot_policies SET required_parser_version='operator-version' WHERE parser_name='sbi-income-payments'",
  );
  const before = policies(db);
  db.exec(sql);
  const after = policies(db);
  expect(after.find((row) => row["parser_name"] === "sbi-income-payments")).toEqual(
    before.find((row) => row["parser_name"] === "sbi-income-payments"),
  );
  expect(
    after.find((row) => row["parser_name"] === "sbi-realised-gains")!["required_parser_version"],
  ).toBe("0.1.3");
  db.close();
});
