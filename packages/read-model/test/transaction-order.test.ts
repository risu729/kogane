// The order of `listTransactions` across the `as_of` shapes parsers write
// (docs/read-model.md, "Order of `as_of` across shapes"). The order is the
// text of `as_of`, newest text first, then id: a documented limit, not a
// chronology. These tests pin what the read does today, so the limit text
// stays true, and show that paging over mixed shapes still returns every row
// once. Everything is synthetic: placeholder accounts and amounts on a CORE
// store; the shapes are the ones the parsers write (docs/read-model.md lists
// which parser writes which).
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { QualityStore } from "./collection-quality-fixture";
import { PAGE_LIMIT, type CollectionScope } from "../src/scope";
import { transactionsSql } from "../src/sql";

interface Row {
  id: number;
  as_of: string | null;
}

/** One published parse of `parser` holding one transaction per `asOf`. */
function publish(
  store: QualityStore,
  source: string,
  parser: string,
  asOf: readonly (string | null)[],
): void {
  const run = store.run({
    source,
    at: "2026-01-01T00:00:00Z",
    artifacts: [{ key: `${parser}-synthetic`, dataset: null }],
  });
  const artifact = run.artifacts[0]!;
  const parse = store.id();
  store.db.run(
    "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1.0.0','2099-01-01','pending','[]')",
    [parse, artifact, parser],
  );
  const insert = store.db.query<unknown, SQLQueryBindings[]>(
    `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,amount_text,currency,as_of,raw_locator,extra_json)
     VALUES(?,?,?,'1','JPY',?,?,'{}')`,
  );
  asOf.forEach((value, index) =>
    insert.run(parse, `${source}:synthetic`, `synthetic-${index}`, value, `row ${index}`),
  );
  store.db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
  store.db.run(
    "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2099-01-01')",
    [artifact, parser, parse],
  );
  store.db.run(
    "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,'1.0.0','2099-01-01','normal')",
    [artifact, parser, parse],
  );
}

function page(store: QualityStore, scope: CollectionScope, offset: number): Row[] {
  const sql = transactionsSql(scope, offset);
  return store.db.query(sql.sql).all(...(sql.args as SQLQueryBindings[])) as Row[];
}

function asOfs(store: QualityStore, scope: CollectionScope = {}): (string | null)[] {
  return page(store, scope, 0).map((row) => row.as_of);
}

describe("transactions order by the text of as_of (documented limit)", () => {
  test("instants written in different offsets order by text, not by absolute time", () => {
    const store = new QualityStore();
    try {
      // 10:00 in +09:00, written in UTC (the V Point Pay shape).
      publish(store, "v-point-pay", "v-point-pay-notification-event", ["2026-03-04T01:00:00.000Z"]);
      // 05:00 in +09:00, five hours earlier, written with its offset (the PayPay shape).
      publish(store, "paypay", "paypay-csv", ["2026-03-04T05:00:00+09:00"]);
      expect(Date.parse("2026-03-04T05:00:00+09:00")).toBeLessThan(
        Date.parse("2026-03-04T01:00:00.000Z"),
      );
      // The earlier instant lists first: its text is greater.
      expect(asOfs(store)).toEqual(["2026-03-04T05:00:00+09:00", "2026-03-04T01:00:00.000Z"]);
    } finally {
      store.db.close();
    }
  });

  test("a date lists after every instant whose text starts with it, and a missing as_of lists last", () => {
    const store = new QualityStore();
    try {
      publish(store, "sbi-securities", "sbi-yen-detail-history", ["2026-03-04"]);
      publish(store, "paypay", "paypay-csv", ["2026-03-04T05:00:00+09:00", null]);
      // 08:00 in +09:00 on 2026-03-04, written on its UTC date 2026-03-03.
      publish(store, "v-point-pay", "v-point-pay-notification-event", ["2026-03-03T23:00:00.000Z"]);
      expect(asOfs(store)).toEqual([
        "2026-03-04T05:00:00+09:00",
        "2026-03-04",
        "2026-03-03T23:00:00.000Z",
        null,
      ]);
    } finally {
      store.db.close();
    }
  });

  test("from and to read the date an as_of starts with, so a UTC instant falls on its UTC date", () => {
    const store = new QualityStore();
    try {
      publish(store, "paypay", "paypay-csv", ["2026-03-04T05:00:00+09:00"]);
      publish(store, "v-point-pay", "v-point-pay-notification-event", ["2026-03-03T23:00:00.000Z"]);
      expect(asOfs(store, { from: "2026-03-04", to: "2026-03-04" })).toEqual([
        "2026-03-04T05:00:00+09:00",
      ]);
      expect(asOfs(store, { from: "2026-03-03", to: "2026-03-03" })).toEqual([
        "2026-03-03T23:00:00.000Z",
      ]);
    } finally {
      store.db.close();
    }
  });

  test("offset pages over mixed shapes return every row once, in one total order", () => {
    const store = new QualityStore();
    try {
      // Many rows share an as_of text, so ties span page boundaries and only
      // the id decides them.
      const day = (index: number): string => `2026-03-${String((index % 9) + 1).padStart(2, "0")}`;
      publish(
        store,
        "paypay",
        "paypay-csv",
        Array.from({ length: 420 }, (_, index) => `${day(index)}T05:00:00+09:00`),
      );
      publish(
        store,
        "v-point-pay",
        "v-point-pay-notification-event",
        Array.from({ length: 420 }, (_, index) => `${day(index)}T01:00:00.000Z`),
      );
      publish(
        store,
        "sbi-securities",
        "sbi-yen-detail-history",
        Array.from({ length: 420 }, (_, index) => (index % 7 === 0 ? null : day(index))),
      );
      const read: Row[] = [];
      for (let offset = 0; ; offset += PAGE_LIMIT - 1) {
        const rows = page(store, {}, offset);
        read.push(...rows.slice(0, PAGE_LIMIT - 1));
        if (rows.length < PAGE_LIMIT) break;
      }
      expect(read).toHaveLength(1260);
      expect(new Set(read.map((row) => row.id)).size).toBe(1260);
      const expected = [...read].sort((left, right) => {
        const a = left.as_of ?? "";
        const b = right.as_of ?? "";
        if (a !== b) return a < b ? 1 : -1;
        return right.id - left.id;
      });
      expect(read).toEqual(expected);
    } finally {
      store.db.close();
    }
  });
});
