import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { scaledStore, CI_SCALE } from "../../../packages/read-model/test/card-usage-scale-fixture";
import {
  factOf,
  factPageQuery,
  PROVIDER_ID_PREDICATE,
  RECONCILIATION_SLICES,
  reconciliationSweep,
  stageAFactPageQuery,
} from "../src/reconciliation-job";
import { LEGACY_FACT_PAGE_QUERY } from "./reconciliation-page-legacy-sql";
import { sweepDb } from "./sweep-cost-d1";

const NOW = "2026-10-04T00:00:00.000Z";
const statuses = JSON.stringify(["unconfirmed", "posted"]);

async function cycle(store: Database, legacy: boolean, sourceId = "vpass") {
  const db = sweepDb(store, (sql) =>
    legacy && sql === stageAFactPageQuery ? LEGACY_FACT_PAGE_QUERY : sql,
  );
  let written = 0;
  for (let tick = 0; tick < 2000; tick += 1) {
    const result = await reconciliationSweep(db, {
      slices: [{ ...RECONCILIATION_SLICES[0]!, sourceId }],
      now: NOW,
      scanLimit: 37,
      groupReadLimit: 200,
      writeLimit: 1,
    });
    written += result.written;
    const cursor = store
      .query("SELECT last_observation_id AS id FROM reconciliation_scan_cursor WHERE source_id=?")
      .get(sourceId) as { id: number } | null;
    // A held first page may also have cursor zero: run until all of its
    // proposals are known, and until the complete legacy/filtered cycle wraps.
    if ((cursor?.id ?? 0) === 0 && result.written === 0 && result.groupsDeferred === 0)
      return written;
  }
  throw new Error("cycle did not finish");
}

function seedOtherProviderRows(db: Database, count: number, unsupportedStatus = false) {
  const source = unsupportedStatus ? "vpass" : "smbc-bank";
  const template = db
    .query(`SELECT t.id FROM transaction_observations t
    JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
    WHERE a.source_id=? LIMIT 1`)
    .get(source) as { id: number };
  db.transaction(() => {
    for (let row = 0; row < count; row += 1)
      db.query(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
 SELECT parse_run_id,'synthetic-other',?,?,-100,'-100',0,'JPY',NULL,'synthetic','2026-10-01',observed_at,raw_locator,? FROM transaction_observations WHERE id=?`).run(
        `other-${row}`,
        unsupportedStatus ? "unsupported" : "posted",
        JSON.stringify({ _kogane: { identityOrigin: "provider", statementMonth: "202610" } }),
        template.id,
      );
  })();
}

function seedProviderRows(db: Database, seed: number) {
  const template = db
    .query(
      `SELECT t.id,t.parse_run_id FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.source_id='vpass' LIMIT 1`,
    )
    .get() as { id: number; parse_run_id: number };
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const origins = [
    null,
    "row-fingerprint",
    "occurrence-key",
    "provider",
    "provider-row",
    "Fingerprint",
    "",
    "x".repeat(257),
    7,
  ];
  for (let group = 0; group < 14; group += 1) {
    const n = group === 13 ? 202 : 2 + (random() % 9);
    for (let row = 0; row < n; row += 1) {
      const origin =
        group === 0 && row < 2
          ? "provider"
          : group === 13
            ? row < 2
              ? "provider"
              : "fingerprint"
            : origins[random() % origins.length];
      const extra =
        row === 5
          ? "{bad"
          : JSON.stringify({ _kogane: { statementMonth: "202610", identityOrigin: origin } });
      db.query(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
 SELECT parse_run_id,?,?,'posted',-100,'-100',0,'JPY',NULL,'synthetic','2026-10-01',observed_at,raw_locator,? FROM transaction_observations WHERE id=?`).run(
        `synthetic-${seed}-${group}`,
        row % 6 === 4 ? null : `provider-${Math.floor(row / 2)}`,
        extra,
        template.id,
      );
    }
  }
}

test("stage A preserves full-cycle proposals on random complete-schema stores; B uses the shipped query", async () => {
  expect(factPageQuery).toBe(LEGACY_FACT_PAGE_QUERY);
  const built = await scaledStore({
    ...CI_SCALE,
    dailyDays: 2,
    monthlyMonths: 1,
    cards: 1,
    postedMonths: 1,
    pages: [1, 1],
    rowsPerPage: [3, 5],
    bankRows: 3,
  });
  try {
    for (const seed of [1, 4, 17, 91]) {
      const current = Database.deserialize(built.store.db.serialize());
      current.exec("PRAGMA foreign_keys=ON");
      seedProviderRows(current, seed);
      seedOtherProviderRows(current, 20);
      seedOtherProviderRows(current, 20, true);
      const legacy = Database.deserialize(current.serialize());
      legacy.exec("PRAGMA foreign_keys=ON");
      try {
        // Verify admitted pages independently against shipped rows + originOf.
        const rows = current
          .query(LEGACY_FACT_PAGE_QUERY)
          .all("vpass", statuses, 0, 100000) as Parameters<typeof factOf>[0][];
        const admitted = rows.filter(
          (row) =>
            row.external_id !== null &&
            factOf(row, RECONCILIATION_SLICES[0]!).identifierOrigin === "provider",
        );
        for (const after of [0, admitted[0]?.id ?? 0, admitted.at(-1)?.id ?? 0])
          expect(current.query(stageAFactPageQuery).all("vpass", statuses, after, 7)).toEqual(
            admitted.filter((row) => row.id > after).slice(0, 7),
          );
        await cycle(current, false);
        await cycle(legacy, true);
        const proposals = "SELECT * FROM reconciliation_proposals ORDER BY proposal_digest";
        expect(current.query(proposals).all()).toEqual(legacy.query(proposals).all());
        expect(current.query(proposals).all().length).toBeGreaterThan(0);
        const sent: string[] = [];
        await reconciliationSweep(
          sweepDb(current, (sql) => {
            sent.push(sql);
            return sql;
          }),
          { slices: [{ ...RECONCILIATION_SLICES[0]!, stages: ["A", "B"] }], now: NOW },
        );
        expect(sent).toContain(factPageQuery);
        expect(sent).not.toContain(stageAFactPageQuery);
      } finally {
        current.close();
        legacy.close();
      }
    }
  } finally {
    built.store.db.close();
  }
}, 60000);

test("scaled fingerprint-only A pages use the partial index without statistics, with measured read savings", async () => {
  const built = await scaledStore(CI_SCALE);
  const db = built.store.db;
  try {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const index = db
      .query("SELECT sql FROM sqlite_master WHERE name='reconciliation_provider_ids'")
      .get() as { sql: string };
    expect(index.sql.split("WHERE ")[1]).toBe(PROVIDER_ID_PREDICATE.replaceAll("t.", ""));
    const plan = db
      .query("EXPLAIN QUERY PLAN " + stageAFactPageQuery)
      .all("vpass", statuses, 0, 1000) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("reconciliation_provider_ids"))).toBe(true);
    const measure = (sql: string) => {
      const start = performance.now();
      let rows = 0;
      for (let n = 0; n < 10; n++) rows += db.query(sql).all("vpass", statuses, 0, 1000).length;
      return { ms: performance.now() - start, rows };
    };
    const shipped = measure(LEGACY_FACT_PAGE_QUERY),
      indexed = measure(stageAFactPageQuery);
    expect(shipped.rows).toBeGreaterThan(0);
    expect(indexed.rows).toBe(0);
    console.log("synthetic stage A page cost", {
      observations: built.counts.transactionObservations,
      shipped,
      indexed,
    });
    seedOtherProviderRows(db, 4000);
    seedOtherProviderRows(db, 200, true);
    const mixed = measure(stageAFactPageQuery);
    expect(mixed.rows).toBe(0);
    console.log("synthetic mixed-provider A page cost", { globallyAdmittedExtraRows: 4200, mixed });
  } finally {
    db.close();
  }
}, 60000);
