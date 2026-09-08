import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { validNormalizedDecimal, isNormalizedZero } from "../shared/normalized-decimal.ts";
const ddl = readFileSync(
  new URL(
    "../../../services/raw-evidence/migrations/0024_observation_decimals.sql",
    import.meta.url,
  ),
  "utf8",
);
function dbBeforeMigration() {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE parse_runs(id INTEGER PRIMARY KEY); INSERT INTO parse_runs VALUES(1);",
  );
  for (const kind of ["balance", "transaction", "valuation"])
    db.exec(
      `CREATE TABLE ${kind}_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER,amount_minor INTEGER,amount_text TEXT,${kind === "balance" ? "instrument" : "currency"} TEXT);`,
    );
  db.exec(
    "CREATE TABLE position_observations(id INTEGER PRIMARY KEY,parse_run_id INTEGER,quantity_text TEXT);",
  );
  return db;
}
function value(db: Database, kind: string, id: number) {
  const result = db
    .query(
      "SELECT policy_version AS policyVersion,status,coefficient,scale,basis FROM observation_decimal_values WHERE kind=? AND observation_id=?",
    )
    .get(kind, id);
  expect(validNormalizedDecimal(result)).toBe(true);
  return result as {
    status: string;
    coefficient: string | null;
    scale: number | null;
    basis: string;
  };
}
test("DB migration backfills history and all future kinds atomically without modifying evidence", () => {
  const db = dbBeforeMigration();
  try {
    db.exec("INSERT INTO balance_observations VALUES(1,1,NULL,'-0.000','EUR');");
    db.exec(ddl);
    expect(value(db, "balance", 1)).toMatchObject({
      status: "exact",
      coefficient: "0",
      scale: 0,
      basis: "decimal_text",
    });
    const cases: Array<
      [number | null, string | null, string, string, string | null, number | null]
    > = [
      [null, "0.00", "CAD", "exact", "0", 0],
      [null, ".00000001", "BTC", "exact", "1", 8],
      [null, "-00012.3400", "EUR", "exact", "-1234", 2],
      [120, "1.20", "USD", "exact", "12", 1],
      [100, "2.00", "USD", "conflict", null, null],
      [100, "0.00", "UNKNOWN", "conflict", null, null],
      [-100, "1.00", "UNKNOWN", "conflict", null, null],
      [100, "-1.00", "UNKNOWN", "conflict", null, null],
      [
        null,
        "90071992547409931234567890.00100",
        "BTC",
        "exact",
        "90071992547409931234567890001",
        3,
      ],
      [null, `0.${"0".repeat(400)}1`, "BTC", "exact", "1", 401],
      [null, null, "EUR", "missing", null, null],
      [null, "", "EUR", "unparsed", null, null],
      [null, "1e-400", "EUR", "unparsed", null, null],
      [null, "0 EUR", "EUR", "unparsed", null, null],
      [null, "--1", "EUR", "unparsed", null, null],
      [null, "0.1.0", "EUR", "unparsed", null, null],
      [1, null, "JPY", "exact", "1", 0],
      [1, null, "USD", "exact", "1", 2],
      [1, null, "UNKNOWN", "unparsed", null, null],
    ];
    const insert = db.prepare("INSERT INTO balance_observations VALUES(?,1,?,?,?)");
    cases.forEach(([minor, text, unit, status, coefficient, scale], index) => {
      insert.run(index + 2, minor, text, unit);
      expect(value(db, "balance", index + 2)).toMatchObject({ status, coefficient, scale });
      if (status === "conflict") expect(value(db, "balance", index + 2).basis).toBe("none");
    });
    db.exec(
      "INSERT INTO transaction_observations VALUES(1,1,123,'1.23','USD'); INSERT INTO valuation_observations VALUES(1,1,NULL,'-1.000','EUR'); INSERT INTO position_observations VALUES(1,1,'0.000001');",
    );
    expect(value(db, "transaction", 1)).toMatchObject({ coefficient: "123", scale: 2 });
    expect(value(db, "valuation", 1)).toMatchObject({ coefficient: "-1", scale: 0 });
    expect(value(db, "position", 1)).toMatchObject({ coefficient: "1", scale: 6 });
    expect(db.query("SELECT amount_text FROM balance_observations WHERE id=1").get()).toEqual({
      amount_text: "-0.000",
    });
    expect(() =>
      db.exec("UPDATE observation_decimal_values SET coefficient='4' WHERE kind='balance'"),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO observation_decimal_values VALUES('balance',999,1,'decimal-v1','exact','--1',0,'decimal_text')",
      ),
    ).toThrow();
    db.exec("BEGIN; INSERT INTO balance_observations VALUES(999,1,NULL,'0','EUR'); ROLLBACK;");
    expect(
      db
        .query("SELECT count(*) AS n FROM observation_decimal_values WHERE observation_id=999")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
test("insert trigger work reads NEW only and remains bounded as history grows", () => {
  const triggers = ddl.slice(
    ddl.indexOf("-- New observations"),
    ddl.indexOf("-- Backfill all historical"),
  );
  expect(triggers).not.toContain("FROM observation_decimal_");
  const db = dbBeforeMigration();
  try {
    db.exec(ddl);
    const start = performance.now();
    const insert = db.prepare("INSERT INTO balance_observations VALUES(?,1,NULL,'0.000','EUR')");
    db.transaction(() => {
      for (let i = 1; i <= 3000; i++) insert.run(i);
    })();
    expect(db.query("SELECT count(*) AS n FROM observation_decimal_values").get()).toEqual({
      n: 3000,
    });
    expect(performance.now() - start).toBeLessThan(5000);
  } finally {
    db.close();
  }
});
test("client consumes persisted exact status, not raw financial strings", () => {
  const exact = {
    policyVersion: "decimal-v1",
    status: "exact",
    coefficient: "0",
    scale: 0,
    basis: "decimal_text",
  } as const;
  expect(validNormalizedDecimal(exact)).toBe(true);
  expect(isNormalizedZero(exact)).toBe(true);
  expect(isNormalizedZero(undefined)).toBe(false);
  for (const patch of [
    { coefficient: "--1" },
    { coefficient: "00" },
    { coefficient: "-0" },
    { scale: 1 },
    { status: ["exact"] },
    { scale: 0.5 },
    { basis: "none" },
  ])
    expect(validNormalizedDecimal({ ...exact, ...patch })).toBe(false);
});
