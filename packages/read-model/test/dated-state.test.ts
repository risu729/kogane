// The reported state on a date (src/dated-state.ts) over a synthetic store:
// which snapshot a cutoff chooses, what it holds, and the statements as they
// stood. Every account, code and amount is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { reportedStateCutoff } from "../../domain/src/reported-state";
import {
  DATED_BALANCES_SQL,
  DATED_POSITIONS_SQL,
  DATED_SNAPSHOTS_SQL,
  DATED_STATEMENTS_SQL,
  type DatedBalanceRow,
  type DatedPositionRow,
  type DatedSnapshotRow,
  type DatedStatementRow,
} from "../src/dated-state";
import { DatedStore } from "./dated-state-fixture";

const SBI = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;
const SMBC = {
  source: "smbc-bank",
  dataset: "balance-normalized",
  parser: "smbc-direct-balance",
} as const;
const ST_GEORGE = {
  source: "st-george",
  dataset: "account-snapshot",
  parser: "st-george-balances",
  version: "1.0.0",
} as const;
const MIZUHO = {
  source: "mizuho-bank",
  dataset: "mizuho-account-list-html",
  parser: "mizuho-account-list",
  artifactKey: "account-list.html",
  unitKey: "account-list",
} as const;

function all<T>(store: DatedStore, sql: string, ...args: SQLQueryBindings[]): T[] {
  return store.db.query(sql).all(...args) as T[];
}
const positions = (store: DatedStore, date: string) =>
  all<DatedPositionRow>(store, DATED_POSITIONS_SQL, reportedStateCutoff(date));
const balances = (store: DatedStore, date: string) =>
  all<DatedBalanceRow>(store, DATED_BALANCES_SQL, reportedStateCutoff(date));
const snapshots = (store: DatedStore, date: string) =>
  all<DatedSnapshotRow>(store, DATED_SNAPSHOTS_SQL, reportedStateCutoff(date));
const codes = (rows: DatedPositionRow[]) => [...new Set(rows.map((row) => row.security_code))];

describe("the snapshot a cutoff chooses", () => {
  test("the cutoff is the end of the date in Asia/Tokyo, as stored UTC text", () => {
    expect(reportedStateCutoff("2026-09-10")).toBe("2026-09-10T15:00:00.000Z");
    expect(reportedStateCutoff("2026-12-31")).toBe("2026-12-31T15:00:00.000Z");
  });

  test("a snapshot captured after the cutoff is ignored", () => {
    const store = new DatedStore();
    // 23:59:59 on 9/10 in Tokyo, then 00:00:00 on 9/11.
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-10T14:59:59Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-10T15:00:00Z",
      positions: [{ account: "sbi-a", code: "2002", quantity: "5" }],
    });
    expect(codes(positions(store, "2026-09-10"))).toEqual(["1001"]);
    expect(codes(positions(store, "2026-09-11"))).toEqual(["2002"]);
    expect(positions(store, "2026-09-09")).toEqual([]);
    expect(snapshots(store, "2026-09-09").find((row) => row.parser_name === SBI.parser)).toEqual({
      perimeter_source_id: SBI.source,
      parser_name: SBI.parser,
      dataset: SBI.dataset,
      source_id: null,
      snapshot_artifact_id: null,
      captured_at: null,
    });
  });

  test("an incomplete capture is never chosen, before or after the cutoff", () => {
    const store = new DatedStore();
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-08T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    // A partial run is not a complete container.
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-09T01:00:00Z",
      outcome: "failure",
      positions: [{ account: "sbi-a", code: "3003", quantity: "1" }],
    });
    // coverage-v1: a partial claim never participates.
    store.capture({
      ...ST_GEORGE,
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "sg-a", metric: "account_balance", instrument: "AUD", minor: 100 }],
      claim: "complete",
    });
    store.capture({
      ...ST_GEORGE,
      fetchedAt: "2026-09-09T01:00:00Z",
      balances: [{ account: "sg-a", metric: "account_balance", instrument: "AUD", minor: 999 }],
      claim: "partial",
    });
    expect(codes(positions(store, "2026-09-10"))).toEqual(["1001"]);
    expect(balances(store, "2026-09-10").map((row) => row.amount_text)).toEqual(["1.00"]);
  });

  test("a complete-empty snapshot removes positions and is still a snapshot", () => {
    const store = new DatedStore();
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-08T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    const empty = store.capture({ ...SBI, fetchedAt: "2026-09-09T01:00:00Z" });
    expect(codes(positions(store, "2026-09-08"))).toEqual(["1001"]);
    expect(positions(store, "2026-09-09")).toEqual([]);
    expect(snapshots(store, "2026-09-09").filter((row) => row.parser_name === SBI.parser)).toEqual([
      {
        perimeter_source_id: SBI.source,
        parser_name: SBI.parser,
        dataset: SBI.dataset,
        source_id: SBI.source,
        snapshot_artifact_id: empty.artifact,
        captured_at: "2026-09-09T01:00:00.000Z",
      },
    ]);
  });

  test("a position missing from the later snapshot is not held", () => {
    const store = new DatedStore();
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-08T01:00:00Z",
      positions: [
        { account: "sbi-a", code: "1001", quantity: "10", value: 12_000 },
        { account: "sbi-a", code: "2002", quantity: "3", value: 4_500 },
      ],
    });
    store.capture({
      ...SBI,
      fetchedAt: "2026-09-09T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "12", value: 14_000 }],
    });
    const on8 = positions(store, "2026-09-08");
    expect(codes(on8)).toEqual(["1001", "2002"]);
    const on9 = positions(store, "2026-09-09");
    expect(
      on9.map((row) => [row.security_code, row.quantity_text, row.valuation_coefficient]),
    ).toEqual([["1001", "12", "14000"]]);
  });

  test("an artifact container (Mizuho) is chosen by the same cutoff", () => {
    const store = new DatedStore();
    for (const [fetchedAt, minor] of [
      ["2026-09-08T01:00:00Z", 100],
      ["2026-09-11T01:00:00Z", 200],
    ] as const)
      store.capture({
        ...MIZUHO,
        fetchedAt,
        balances: [{ account: "mz-a", metric: "account_balance", instrument: "JPY", minor }],
        claim: "complete",
      });
    expect(balances(store, "2026-09-10").map((row) => [row.dataset, row.coefficient])).toEqual([
      [MIZUHO.dataset, "100"],
    ]);
    expect(balances(store, "2026-09-11").map((row) => row.coefficient)).toEqual(["200"]);
  });

  test("the excluded aggregates are neither read nor expected", () => {
    const store = new DatedStore();
    store.capture({
      source: "sony-bank",
      dataset: "gross-balance",
      parser: "sony-bank-gross-balance",
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "sony", metric: "gross_asset_balance", instrument: "JPY", minor: 1 }],
    });
    expect(balances(store, "2026-09-10")).toEqual([]);
    expect(snapshots(store, "2026-09-10").map((row) => row.parser_name)).not.toContain(
      "sony-bank-gross-balance",
    );
  });
});

describe("identity of a dated row", () => {
  test("a resolved position and an unresolved balance", () => {
    const store = new DatedStore();
    const sbi = store.capture({
      ...SBI,
      fetchedAt: "2026-09-08T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    store.identify(sbi, SBI.source, "acct-sbi", "identified", ["inst-1001"]);
    const smbc = store.capture({
      ...SMBC,
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 500 }],
    });
    const unresolved = store.capture({
      ...ST_GEORGE,
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "sg-a", metric: "account_balance", instrument: "AUD", minor: 7 }],
      claim: "complete",
    });
    store.identify(unresolved, ST_GEORGE.source, "acct-sg", "unresolved");
    const [position] = positions(store, "2026-09-10");
    expect(position).toMatchObject({
      identity_recorded: 1,
      account_id: "acct-sbi",
      account_status: "identified",
      instrument_id: "inst-1001",
      instrument_status: "identified",
    });
    const rows = balances(store, "2026-09-10");
    expect(rows.find((row) => row.id === smbc.balances[0])).toMatchObject({
      identity_recorded: 0,
      account_id: null,
      instrument_id: null,
    });
    expect(rows.find((row) => row.id === unresolved.balances[0])).toMatchObject({
      identity_recorded: 1,
      account_id: "acct-sg",
      account_status: "unresolved",
    });
  });
});

describe("dated identity equals current_identity_observations", () => {
  // The keyed identity CTEs restrict the view's candidate runs to the chosen
  // parses; for those parses they must give the view's rows exactly: the
  // latest sealed policy version, never an unsealed run.
  const expected = (store: DatedStore, kind: "position" | "balance", ids: number[]) =>
    all<{
      id: number;
      identity_recorded: number;
      account_id: string | null;
      instrument_id: string | null;
    }>(
      store,
      `SELECT o.id,CASE WHEN io.id IS NULL THEN 0 ELSE 1 END AS identity_recorded,
         am.account_id,im.instrument_id
       FROM ${kind}_observations o
       LEFT JOIN current_identity_observations io ON io.kind='${kind}' AND io.observation_id=o.id
       LEFT JOIN current_account_mappings am ON am.source_account_id=io.source_account_id
       LEFT JOIN identity_instrument_uses u ON u.identity_observation_id=io.id
        AND u.role='${kind === "position" ? "security" : "unit"}'
       LEFT JOIN current_instrument_mappings im ON im.identifier_id=u.identifier_id
       WHERE o.id IN (SELECT value FROM json_each(?)) ORDER BY o.id`,
      JSON.stringify(ids),
    );
  const actual = (rows: (DatedPositionRow | DatedBalanceRow)[]) =>
    [
      ...new Map(
        rows.map((row) => [
          row.id,
          {
            id: row.id,
            identity_recorded: row.identity_recorded,
            account_id: row.account_id,
            instrument_id: row.instrument_id,
          },
        ]),
      ).values(),
    ].sort((a, b) => a.id - b.id);

  test("latest sealed policy version, unsealed and unidentified rows alike", () => {
    const store = new DatedStore();
    const older = store.capture({
      ...SBI,
      fetchedAt: "2026-09-08T01:00:00Z",
      positions: [
        { account: "sbi-a", code: "1001", quantity: "10" },
        { account: "sbi-a", code: "1002", quantity: "5" },
      ],
    });
    store.identify(older, SBI.source, "acct-v1", "identified", ["inst-1001"]);
    store.identify(older, SBI.source, "acct-v2", "provider-local", [undefined, "inst-1002"], {
      policyVersion: 2,
    });
    store.identify(older, SBI.source, "acct-v3", "identified", ["inst-1001"], {
      policyVersion: 3,
      sealed: false,
    });
    const newer = store.capture({
      ...SBI,
      fetchedAt: "2026-09-11T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1003", quantity: "1" }],
    });
    store.identify(newer, SBI.source, "acct-new", "identified", ["inst-1003"]);
    const smbc = store.capture({
      ...SMBC,
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 500 }],
    });
    store.identify(smbc, SMBC.source, "acct-smbc", "identified", [], { policyVersion: 2 });
    store.capture({
      ...ST_GEORGE,
      fetchedAt: "2026-09-08T01:00:00Z",
      balances: [{ account: "sg-a", metric: "account_balance", instrument: "AUD", minor: 7 }],
      claim: "complete",
    });

    for (const date of ["2026-09-10", "2026-09-30"]) {
      const positionRows = positions(store, date);
      const balanceRows = balances(store, date);
      expect(positionRows.length).toBeGreaterThan(0);
      expect(balanceRows).toHaveLength(2);
      expect(actual(positionRows)).toEqual(
        expected(
          store,
          "position",
          positionRows.map((row) => row.id),
        ),
      );
      expect(actual(balanceRows)).toEqual(
        expected(
          store,
          "balance",
          balanceRows.map((row) => row.id),
        ),
      );
    }
    // The earlier date reads the older capture under its latest sealed policy.
    expect(actual(positions(store, "2026-09-10")).map((row) => row.account_id)).toEqual([
      "acct-v2",
      "acct-v2",
    ]);
  });
});

describe("statements as of the cutoff", () => {
  const statements = (store: DatedStore, date: string, from = "0000-00-00", undated = "") =>
    all<DatedStatementRow>(store, DATED_STATEMENTS_SQL, reportedStateCutoff(date), from, undated);

  test("the newest capture before the cutoff, never a later restatement", () => {
    const store = new DatedStore();
    store.statement({
      card: "card-a",
      period: "2026-09",
      paymentDate: null,
      minor: 1_000,
      fetchedAt: "2026-09-05T01:00:00Z",
    });
    store.statement({
      card: "card-a",
      period: "2026-09",
      paymentDate: "2026-09-26",
      minor: 1_200,
      fetchedAt: "2026-09-12T01:00:00Z",
    });
    expect(
      statements(store, "2026-09-10").map((row) => [row.coefficient, row.payment_date]),
    ).toEqual([["1000", null]]);
    expect(
      statements(store, "2026-09-12").map((row) => [row.coefficient, row.payment_date]),
    ).toEqual([["1200", "2026-09-26"]]);
    expect(statements(store, "2026-09-04")).toEqual([]);
  });

  test("with a bound past every capture it is card_statement_facts, unchanged", () => {
    const store = new DatedStore();
    for (const [period, day, paymentDate] of [
      ["2026-07", "05", "2026-07-26"],
      ["2026-08", "05", null],
      ["2026-08", "06", "2026-08-26"],
      ["2026-09", "01", "2026-09-26"],
    ] as const)
      store.statement({
        card: "card-a",
        period,
        paymentDate,
        minor: 900,
        fetchedAt: `2026-09-${day}T01:00:00Z`,
      });
    const dated = statements(store, "9998-12-30").map((row) => row.id);
    const view = (
      store.db
        .query("SELECT id FROM card_statement_facts ORDER BY source_id,source_account,period,id")
        .all() as {
        id: number;
      }[]
    ).map((row) => row.id);
    expect(dated).toEqual(view);
    expect(dated).toHaveLength(3);
  });

  test("the payable window: due on or after ?2, or undated and captured on or after ?3", () => {
    const store = new DatedStore();
    store.statement({
      card: "card-a",
      period: "2026-06",
      paymentDate: "2026-06-26",
      minor: 1,
      fetchedAt: "2026-06-05T01:00:00Z",
    });
    store.statement({
      card: "card-a",
      period: "2026-09",
      paymentDate: "2026-09-26",
      minor: 2,
      fetchedAt: "2026-09-05T01:00:00Z",
    });
    store.statement({
      card: "card-b",
      period: "2026-05",
      paymentDate: null,
      minor: 3,
      fetchedAt: "2026-05-05T01:00:00Z",
    });
    store.statement({
      card: "card-b",
      period: "2026-09",
      paymentDate: null,
      minor: 4,
      fetchedAt: "2026-09-05T01:00:00Z",
    });
    expect(
      statements(store, "2026-09-10", "2026-08-10", "2026-07-27T15:00:00.000Z").map(
        (row) => row.coefficient,
      ),
    ).toEqual(["2", "4"]);
  });
});
