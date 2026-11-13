import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { coreDatabase } from "./sqlite.ts";

const sql = readFileSync(
  new URL("../migrations/core/0102_vpass_authori_transition_policy.sql", import.meta.url),
  "utf8",
);
const select =
  "SELECT * FROM dataset_snapshot_policies WHERE source_id='vpass' AND dataset='credit-snapshot' AND parser_name='vpass-credit-snapshot'";
let image: Uint8Array;
beforeAll(() => {
  const db = coreDatabase("0017", "0102");
  image = db.serialize();
  db.close();
}, 60_000);

test("only the complete shipped Vpass policy advances to the normal-transition reader", () => {
  const db = Database.deserialize(image);
  const before = db.query<Record<string, unknown>, []>(select).get();
  expect(before).toMatchObject({
    required_parser_version: "1.0.1",
    updated_at_ms: 1794268800000,
  });
  const siblings = db
    .query(
      "SELECT * FROM dataset_snapshot_policies WHERE source_id<>'vpass' ORDER BY source_id,dataset,parser_name",
    )
    .all();
  db.exec(sql);
  expect(db.query(select).get()).toEqual({
    ...before,
    required_parser_version: "1.0.2",
    updated_at_ms: 1794441600000,
  });
  expect(
    db
      .query(
        "SELECT * FROM dataset_snapshot_policies WHERE source_id<>'vpass' ORDER BY source_id,dataset,parser_name",
      )
      .all(),
  ).toEqual(siblings);
  const advanced = db.query(select).get();
  db.exec(sql);
  expect(db.query(select).get()).toEqual(advanced);
  db.close();
});

test("every operator-selected policy field survives the reader advancement", () => {
  for (const [field, value] of [
    ["policy_id", "legacy-warning-compat-v1"],
    ["policy_version", 2],
    ["required_parser_version", "9.0.0"],
    ["required_parser_version", null],
    ["replaces_previous_on_complete_empty", 1],
    ["unit_scope", "run"],
    ["snapshot_selection", 0],
    ["updated_at_ms", 42],
  ] as const) {
    const db = Database.deserialize(image);
    db.query(`UPDATE dataset_snapshot_policies SET ${field}=? WHERE source_id='vpass'`).run(value);
    const before = db.query<Record<string, unknown>, []>(select).get();
    db.exec(sql);
    expect(db.query(select).get()).toEqual(before);
    db.close();
  }
});
