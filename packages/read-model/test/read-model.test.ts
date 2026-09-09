import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_SNAPSHOT_RELATIONS,
  SNAPSHOT_CTES,
  snapshotCtes,
} from "../../../poc/observation-pipeline/src/snapshot-query";
import {
  activeStateProjection,
  CANDIDATE_LIMIT,
  completeSnapshotCandidates,
  createD1ObservationReader,
  createObservationReader,
  economicallySummable,
  evidenceExists,
  legacyPublishedParses,
  type ObservationReader,
  PAGE_LIMIT,
  parseWarnings,
  publishedParses,
  recordedParses,
  ResultLimitExceededError,
  scopePredicates,
  snapshotAdoptable,
  snapshotPolicyComparison,
  type SqlExecutor,
  successfulFetchRuns,
  unitParseable,
  visibleEvidence,
} from "../src/index";
import * as sql from "../src/sql";

const MIGRATIONS = join(import.meta.dir, "../../../services/raw-evidence/migrations");

/** The production schema, views included, on an in-memory SQLite. */
function migratedDatabase(): Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

/** A second implementation of the executor contract: the reader is not tied to D1. */
function sqliteExecutor(db: Database): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as never[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as never[])) as T | null) ?? null,
  };
}

const NO_FILTER = { offset: 0 } as const;
const FULL_TRANSACTION_SCOPE = {
  source: "s",
  account: "a",
  from: "2026-01-01",
  to: "2026-12-31",
  q: "parse_runs",
  offset: 5,
} as const;

/** Every read the API can run, with every accepted scope key exercised. */
function everyRead(reader: ObservationReader): Promise<unknown>[] {
  return [
    reader.overview(),
    reader.parsingHealth(),
    reader.listTransactions(NO_FILTER),
    reader.listTransactions(FULL_TRANSACTION_SCOPE),
    reader.listLatestBalances({ ...NO_FILTER, limit: CANDIDATE_LIMIT }),
    reader.listLatestBalances({
      source: "s",
      account: "a",
      instrument: "JPY",
      metric: "cash",
      measureView: "summaries",
      offset: 0,
      limit: PAGE_LIMIT,
    }),
    reader.listLatestBalances({ measureView: "balances", offset: 0, limit: PAGE_LIMIT }),
    reader.listBalanceHistory(NO_FILTER),
    reader.listBalanceHistory({
      source: "s",
      account: "a",
      instrument: "JPY",
      metric: "cash",
      measureView: "balances",
      offset: 500,
    }),
    reader.listPositions(NO_FILTER),
    reader.listPositions({ source: "s", account: "a", offset: 0 }),
    reader.listArtifacts({ before: Number.MAX_SAFE_INTEGER }),
    reader.listArtifacts({ before: 10, source: "s" }),
    reader.filterOptions({ kind: "transactions" }),
    reader.filterOptions({ kind: "positions" }),
    reader.filterOptions({ kind: "artifacts" }),
    reader.filterOptions({ kind: "balances" }),
    reader.filterOptions({ kind: "balances", measureView: "balances" }),
    reader.filterOptions({ kind: "balances", measureView: "summaries" }),
    reader.getArtifact(1),
    reader.getObservation({ kind: "transaction", id: 1 }),
    reader.getObservation({ kind: "balance", id: 1 }),
    reader.getObservation({ kind: "position", id: 1 }),
    reader.getObservation({ kind: "valuation", id: 1 }),
    reader.getRawDownload({ sha256: "a".repeat(64) }),
  ];
}

describe("read model over the production schema", () => {
  test("every read compiles against the migrated views and is empty on an empty store", async () => {
    const reader = createObservationReader(sqliteExecutor(migratedDatabase()));
    const results = await Promise.all(everyRead(reader));
    const [overview, health, ...rest] = results as [
      { counts: { table: string; rows: number }[]; sources: unknown[] },
      { pending: number; running: number; failed: number },
      ...unknown[],
    ];
    expect(overview.counts.map((count) => count.table)).toEqual([
      "sources",
      "fetch_runs",
      "raw_objects",
      "fetch_artifacts",
      "parse_runs",
      "transaction_observations",
      "balance_observations",
      "position_observations",
      "valuation_observations",
    ]);
    // The registry migration seeds sources; every other visible relation is empty.
    expect(overview.counts.filter((count) => count.table !== "sources")).toEqual(
      overview.counts
        .filter((count) => count.table !== "sources")
        .map((count) => ({ ...count, rows: 0 })),
    );
    expect(overview.sources.length).toBe(overview.counts[0]!.rows);
    expect(health).toEqual({ pending: 0, running: 0, failed: 0 });
    for (const result of rest) {
      if (Array.isArray(result)) expect(result).toEqual([]);
      else if (result && typeof result === "object")
        expect(result).toEqual({ sources: [], accounts: [], instruments: [], metrics: [] });
      else expect(result).toBeUndefined();
    }
  });

  test("the reader works over a plain D1-shaped binding", async () => {
    const db = migratedDatabase();
    const calls: string[] = [];
    const reader = createD1ObservationReader({
      prepare(text) {
        calls.push(text);
        return {
          bind(...values) {
            return {
              all: async () => ({ results: db.query(text).all(...(values as never[])) }),
              first: async () => db.query(text).get(...(values as never[])),
            };
          },
        };
      },
    });
    expect(await reader.listArtifacts({ before: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(await reader.getRawDownload({ sha256: "b".repeat(64) })).toBeUndefined();
    expect(calls[0]).toMatch(/^SELECT \* FROM \(SELECT a\.id, a\.source_id/);
    expect(calls[0]).toMatch(/LIMIT 5001$/);
  });
});

describe("named concepts in the final SQL", () => {
  const texts: Record<string, string> = {
    transactions: sql.transactionsSql({}, 0).sql,
    latestBalances: sql.latestBalancesSql({}, 0, CANDIDATE_LIMIT).sql,
    latestSummaries: sql.latestBalancesSql({ measureView: "summaries" }, 0, PAGE_LIMIT).sql,
    balanceHistory: sql.balanceHistorySql({}, 0).sql,
    positions: sql.positionsSql({}, 0).sql,
    positionValuations: sql.POSITION_VALUATIONS_SQL,
    artifacts: sql.ARTIFACTS_SQL,
    artifactDetail: sql.ARTIFACT_DETAIL_SQL,
    artifactParseRuns: sql.ARTIFACT_PARSE_RUNS_SQL,
    provenance: sql.PROVENANCE_SQL,
    observationDetail: sql.observationDetailSql("balance"),
    parseRunObservations: sql.parseRunObservationsSql("valuation"),
    filterSources: sql.FILTER_SOURCES_SQL,
    filterAccounts: sql.filterAccountsSql("transaction_observations", null),
    filterBalanceAccounts: sql.filterAccountsSql(
      "balance_observations",
      sql.balanceFilterScope("summaries"),
    ),
    filterDimensions: sql.filterDimensionsSql(sql.balanceFilterScope(undefined)),
    overviewSources: sql.OVERVIEW_SOURCES_SQL,
    overviewFetchRuns: sql.OVERVIEW_FETCH_RUNS_SQL,
    overviewParseRuns: sql.OVERVIEW_PARSE_RUNS_SQL,
    rawDownload: sql.RAW_DOWNLOAD_SQL,
    ...Object.fromEntries(
      sql.COUNTED_RELATIONS.map(([table, relation]) => [`count:${table}`, sql.countSql(relation)]),
    ),
  };

  test("every read names a sealed observation view and no bare Layer A table", () => {
    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).toMatch(/\bobservation_(fetch_artifacts|fetch_runs|sources)\b/);
      expect(text, name).not.toMatch(/\b(fetch_runs|fetch_artifacts|sources)\b/);
      // The download path reads the raw table only through a visible artifact.
      if (name !== "rawDownload") expect(text, name).not.toMatch(/\braw_objects\b/);
      else expect(text).toMatch(/raw_objects o JOIN observation_fetch_artifacts a ON a\.sha256/);
      // parse_runs is a base table by design; it is always bound to a visible artifact.
      if (/\bparse_runs\b/.test(text)) expect(text, name).toMatch(/observation_fetch_artifacts/);
    }
  });

  test("pending parse runs are excluded wherever recorded results are shown", () => {
    for (const name of [
      "balanceHistory",
      "artifacts",
      "artifactParseRuns",
      "provenance",
      "observationDetail",
      "parseRunObservations",
      "filterBalanceAccounts",
      "filterDimensions",
      "overviewParseRuns",
      "count:parse_runs",
      "count:balance_observations",
    ])
      expect(texts[name], name).toMatch(/p\.status <> 'pending'/);
  });

  test("current lists apply the active-state projection and snapshot membership", () => {
    const active = activeStateProjection.predicate;
    expect(active).toBe(
      "EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND f.status = 'success' AND f.failure_count = 0",
    );
    for (const name of ["transactions", "latestBalances", "positions", "positionValuations"])
      expect(texts[name], name).toContain(active);
    for (const name of ["latestBalances", "positions", "positionValuations"]) {
      expect(texts[name], name).toContain(completeSnapshotCandidates.ctes);
      expect(texts[name], name).toContain(completeSnapshotCandidates.currentMember);
    }
    expect(texts.balanceHistory).not.toContain(active);
    expect(texts.latestSummaries).toContain("rank_in_group = 1 OR (source_id = 'myjcb'");
    expect(texts.latestBalances).toMatch(/rank_in_group = 1\)\s+WHERE 1\s+ORDER BY/);
  });

  test("snapshot candidates are built over the visible views by name", () => {
    expect(snapshotCtes(LOCAL_SNAPSHOT_RELATIONS)).toBe(SNAPSHOT_CTES);
    expect(completeSnapshotCandidates.ctes).toContain("FROM observation_fetch_artifacts fa");
    expect(completeSnapshotCandidates.ctes).toContain("JOIN observation_fetch_runs f ON");
    expect(completeSnapshotCandidates.ctes).not.toMatch(/\bfetch_artifacts fa\b/);
    // A parse completes a snapshot only when it is the published run; the
    // supersession pointer no longer decides membership.
    expect(completeSnapshotCandidates.ctes).toContain(
      "EXISTS (SELECT 1 FROM published_parse_runs published\n                  WHERE published.parse_run_id = complete_parse.id)",
    );
    expect(completeSnapshotCandidates.ctes).not.toContain("superseded_by_parse_run_id");
    expect(publishedParses.predicate("x")).toBe(
      "EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = x.id)",
    );
    expect(legacyPublishedParses.predicate("x")).toBe(
      "x.superseded_by_parse_run_id IS NULL AND x.status = 'ok'",
    );
    expect(visibleEvidence.rawObjects).toContain("observation_raw_objects");
  });

  test("snapshot membership is chosen per dataset from the policy table, never from warning text alone", () => {
    const ctes = completeSnapshotCandidates.ctes;
    expect(ctes).toContain("FROM dataset_snapshot_policies");
    expect(ctes).toContain("CASE policy.policy_id");
    expect(ctes).toContain("WHEN 'coverage-v1' THEN EXISTS");
    expect(ctes).toContain("FROM parse_coverage_claims claim");
    expect(ctes).toContain("claim.membership_complete = 1");
    // The legacy adapter remains, confined to the ELSE branch.
    expect(ctes).toContain("json_each(complete_parse.warnings_json)");
    const db = migratedDatabase();
    expect(db.query("SELECT count(*) AS n FROM dataset_snapshot_policies").get()).toEqual({
      n: 11,
    });
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM dataset_snapshot_policies WHERE policy_id <> 'legacy-warning-compat-v1'",
        )
        .get(),
    ).toEqual({ n: 0 });
    // The shadow comparison compiles on the production schema and reads the views.
    expect(db.query(snapshotPolicyComparison.sql).all()).toEqual([]);
    expect(snapshotPolicyComparison.sql).toContain("FROM observation_fetch_artifacts fa");
    expect(snapshotPolicyComparison.sql).not.toMatch(/\bfetch_artifacts fa\b/);
  });

  test("D13 predicates are separate names with the documented defaults", () => {
    expect(evidenceExists.predicate("a")).toBe(
      "EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = a.sha256)",
    );
    // Parse eligibility keeps the run-level rule until unit-independent-v1 is enabled.
    expect(unitParseable.scope).toBe("run");
    expect(unitParseable.predicate("r")).toBe(successfulFetchRuns.predicate("r"));
    expect(unitParseable.predicate("r")).toBe("r.status = 'success' AND r.failure_count = 0");
    expect(snapshotAdoptable.ctes).toBe(completeSnapshotCandidates.ctes);
    expect(snapshotAdoptable.predicate).toBe(completeSnapshotCandidates.currentMember);
    // Nothing is summable until an aggregation policy exists.
    expect(economicallySummable.policy).toBeNull();
    expect(economicallySummable.predicate()).toBe("0");
    const db = migratedDatabase();
    expect(db.query(`SELECT ${economicallySummable.predicate()} AS summable`).get()).toEqual({
      summable: 0,
    });
  });

  test("the publication gate decides every current read and every recorded read", () => {
    // Current lists: the projection, never the legacy pointer rule.
    for (const name of ["transactions", "latestBalances", "positions", "positionValuations"]) {
      expect(texts[name], name).toContain(publishedParses.predicate("p"));
      expect(texts[name], name).not.toContain(legacyPublishedParses.predicate("p"));
    }
    // Recorded reads: an ok run that is neither published nor superseded (a
    // future candidate) is not a visible result anywhere, ids included.
    expect(recordedParses.predicate("p")).toBe(
      "p.status <> 'pending' AND (p.status = 'error' OR p.superseded_by_parse_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id))",
    );
    for (const name of [
      "balanceHistory",
      "artifacts",
      "artifactParseRuns",
      "provenance",
      "observationDetail",
      "parseRunObservations",
      "overviewParseRuns",
      "count:parse_runs",
      "count:transaction_observations",
    ])
      expect(texts[name], name).toContain(recordedParses.predicate("p"));
    // Health: a failure is repaired only by a newer published parse.
    expect(sql.PARSING_HEALTH_SQL).toContain("FROM published_parse_runs published");
    expect(sql.PARSING_HEALTH_SQL).not.toContain("superseded_by_parse_run_id");
  });
});

describe("typed scope, ordering and paging", () => {
  test("filters apply after ranking and before ordering and paging", () => {
    const page = sql.transactionsSql(
      { source: "s", account: "a", from: "2026-01-01", to: "2026-01-31", q: "cafe" },
      10,
    );
    expect(page.sql).toMatch(
      /WHERE rank_in_identity = 1\)\s+WHERE source_id = \? AND source_account = \? AND date\(substr\(as_of,1,10\), '\+0 days'\) = substr\(as_of,1,10\) AND substr\(as_of,1,10\) >= \? AND substr\(as_of,1,10\) <= \? AND \(instr\(lower\(coalesce\(description,''\)\), lower\(\?\)\) > 0 OR .*\)\s+ORDER BY COALESCE\(as_of, ''\) DESC, id DESC LIMIT 501 OFFSET \?$/s,
    );
    expect(page.args).toEqual([
      "s",
      "a",
      "2026-01-01",
      "2026-01-31",
      "cafe",
      "cafe",
      "cafe",
      "cafe",
      "cafe",
      10,
    ]);
    const candidates = sql.latestBalancesSql(
      { source: "s", instrument: "JPY", measureView: "balances" },
      0,
      CANDIDATE_LIMIT,
    );
    expect(candidates.sql).toMatch(
      /WHERE NOT \(\(source_id = 'myjcb' AND parser LIKE .* AND source_id = \? AND instrument = \?\s+ORDER BY source_id, source_account, metric, instrument, id LIMIT 5001 OFFSET \?$/s,
    );
    expect(candidates.args).toEqual(["s", "JPY", 0]);
    expect(sql.positionsSql({ account: "a" }, 500).sql).toMatch(
      /ORDER BY source_id, source_account, security_code, id LIMIT 501 OFFSET \?$/,
    );
    expect(sql.balanceHistorySql({}, 0).sql).toMatch(
      /ORDER BY COALESCE\(as_of, observed_at, ''\) DESC, id DESC LIMIT 501 OFFSET \?$/,
    );
  });

  test("scope keys outside a query's allow-list are refused", () => {
    expect(() => scopePredicates({ metric: "cash" }, ["source"])).toThrow("not allowed");
    expect(() => sql.transactionsSql({ metric: "cash" }, 0)).toThrow("metric");
    expect(() => sql.positionsSql({ q: "text" }, 0)).toThrow("q");
    expect(() => sql.balanceHistorySql({ from: "2026-01-01" }, 0)).toThrow("from");
    expect(() => sql.transactionsSql({}, -1)).toThrow("offset");
    expect(scopePredicates({}, [])).toEqual({ where: "1", args: [] });
  });

  test("source data that looks like SQL stays a bound argument", () => {
    const literal = sql.transactionsSql({ q: "parse_runs" }, 0);
    const plain = sql.transactionsSql({ q: "cafe" }, 0);
    expect(literal.sql).toBe(plain.sql);
    expect(literal.args).toEqual([...Array<string>(5).fill("parse_runs"), 0]);
    const account = sql.latestBalancesSql({ account: "fetch_artifacts" }, 0, PAGE_LIMIT);
    expect(account.sql).toBe(sql.latestBalancesSql({ account: "x" }, 0, PAGE_LIMIT).sql);
    expect(account.args).toEqual(["fetch_artifacts", 0]);
  });

  test("a list past the bound is refused instead of truncated", async () => {
    const seen: string[] = [];
    const executor: SqlExecutor = {
      all: async <T>(text: string) => {
        seen.push(text);
        return Array.from({ length: 5001 }, (_, id) => ({ id })) as T[];
      },
      first: async () => null,
    };
    await expect(
      createObservationReader(executor).listArtifacts({ before: 1 }),
    ).rejects.toBeInstanceOf(ResultLimitExceededError);
    expect(seen[0]).toMatch(/^SELECT \* FROM \(.*\) LIMIT 5001$/s);
    class Http413 extends Error {}
    await expect(
      createObservationReader(executor, { limitExceeded: () => new Http413() }).listTransactions(
        NO_FILTER,
      ),
    ).rejects.toBeInstanceOf(Http413);
  });
});

describe("mappers", () => {
  test("unreadable warnings stay visible rather than becoming no warnings", () => {
    expect(parseWarnings(null)).toEqual({ list: [], raw: null, parsed: true });
    expect(parseWarnings("")).toEqual({ list: [], raw: "", parsed: true });
    expect(parseWarnings('["a",1]')).toEqual({ list: ["a", "1"], raw: '["a",1]', parsed: true });
    expect(parseWarnings("{}")).toEqual({ list: [], raw: "{}", parsed: false });
    expect(parseWarnings("not json")).toEqual({ list: [], raw: "not json", parsed: false });
  });
});
