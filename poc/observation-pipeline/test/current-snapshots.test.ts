import { afterEach, describe, expect, test } from "bun:test";
import { insertParseRun, listArtifacts, publishParseRun, type Store } from "../src/store.ts";
import {
  currentPositions,
  currentTransactions,
  currentValuations,
  latestBalances,
  positionsWithValuations,
} from "../src/queries.ts";
import {
  COVERAGE_SNAPSHOT_POLICY,
  FOREIGN_POSITION_SNAPSHOT_VERSION,
  LEGACY_SNAPSHOT_POLICY,
  SNAPSHOT_DATASETS,
} from "../src/snapshot-query.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import type { Observation, Parser, TransactionObservation } from "../src/types.ts";
import {
  activatePolicy,
  balance,
  closeStores,
  count,
  currentText,
  database,
  facts,
  position,
  snapshot,
  valuation,
} from "./snapshot-fixture.ts";

afterEach(closeStores);

describe("complete container snapshots", () => {
  test("the foreign snapshot version tracks the registered pagination-validating parser", () => {
    expect(PARSERS.find((parser) => parser.name === "sbi-foreign-cash-positions")?.version).toBe(
      FOREIGN_POSITION_SNAPSHOT_VERSION,
    );
  });

  test("legacy foreign position success cannot survive a rejected pagination reparse", () => {
    const store = database();
    const base = { parser: "sbi-foreign-cash-positions", dataset: "foreign-cash-positions" };
    const legacy = snapshot(store, {
      ...base,
      parserVersion: "0.2.0",
      observations: [position("OLD")],
    });
    expect(currentPositions(store)).toEqual([]);
    insertParseRun(store, {
      artifactId: legacy.artifactId,
      parserName: base.parser,
      parserVersion: FOREIGN_POSITION_SNAPSHOT_VERSION,
      parsedAt: "2026-09-02T00:00:00.000Z",
      status: "error",
      warnings: [],
    });
    expect(currentPositions(store)).toEqual([]);
    snapshot(store, { ...base, observations: [position("NEW")] });
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["NEW"]);
    expect(store.db.query("SELECT COUNT(*) AS n FROM position_observations").get()).toEqual({
      n: 2,
    });
  });

  test("complete foreign snapshots with exact text and extra fields replace older rows", () => {
    const store = database();
    const cases = [
      {
        parser: sbiForeignCashPositions,
        dataset: "foreign-cash-positions",
        old: [position("OLD")],
        body: {
          listSecuritiesBalances: {
            page: { hasNextPage: false, pageNum: 1, pageSize: 999 },
            securitiesBalances: [
              {
                securities: { securitiesCode: "NEW" },
                securitiesQuantity: "1",
                currencyCode: "USD",
                evaluationProfitLoss: { evaluationAmount: "1.5" },
              },
            ],
          },
        },
      },
      {
        parser: sbiForeignCashBalances,
        dataset: "foreign-cash-balances",
        old: [balance("OLD")],
        body: {
          listForeignScheduleCashBalances: {
            foreignCashBalances: [
              {
                currencyCashBalances: [
                  {
                    currencyCode: "USD",
                    foreignScheduleCashBalances: [{ keepCash: "1.001", totalBalance: "2" }],
                  },
                ],
              },
            ],
          },
        },
      },
    ];
    for (const entry of cases) {
      snapshot(store, {
        parser: entry.parser.name,
        dataset: entry.dataset,
        observations: entry.old,
      });
      const meta = listArtifacts(store).at(-1)!;
      const parsed = entry.parser.parse(new TextEncoder().encode(JSON.stringify(entry.body)), meta);
      expect(parsed.warnings.length).toBeGreaterThan(0);
      snapshot(store, {
        parser: entry.parser.name,
        dataset: entry.dataset,
        observations: parsed.observations,
        warnings: parsed.warnings,
      });
    }
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["NEW"]);
    expect(currentValuations(store).map((row) => row.amount_text)).toEqual(["1.5"]);
    expect(latestBalances(store).map((row) => row.amount_text)).toEqual(["1.001"]);
  });

  for (const [parser, dataset] of SNAPSHOT_DATASETS) {
    test(`${parser}: repeated, removed instrument/account, and empty snapshots replace old rows`, () => {
      const store = database();
      const old = facts(parser, "OLD");
      snapshot(store, { parser, dataset, observations: old });
      snapshot(store, { parser, dataset, observations: facts(parser, "NEW") });
      expect(count(store)).toBe(old.length);
      expect(currentText(store)).not.toContain("OLD");
      snapshot(store, { parser, dataset, observations: [] });
      expect(count(store)).toBe(0);
      // Historical evidence was never deleted.
      expect(store.db.query("SELECT COUNT(*) AS n FROM parse_runs").get()).toEqual({ n: 3 });
    });
  }

  test("a newer unit must finish every artifact parse before replacing the old complete snapshot", () => {
    const store = database();
    const base = { parser: "sbi-vc-position-summary", dataset: "position-summary" };
    snapshot(store, { ...base, observations: [position("OLD")] });
    const incomplete = snapshot(store, { ...base, observations: [position("NEW")] });
    const missing = snapshot(store, {
      ...base,
      runId: incomplete.runId,
      parseStatus: "missing",
      observations: [],
    });
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["OLD"]);
    insertParseRun(store, {
      artifactId: missing.artifactId,
      parserName: base.parser,
      parserVersion: "0.1.0",
      parsedAt: "2026-09-01T00:00:00.000Z",
      status: "error",
      warnings: [],
    });
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["OLD"]);
    const completed = insertParseRun(store, {
      artifactId: missing.artifactId,
      parserName: base.parser,
      parserVersion: "0.1.0",
      parsedAt: "2026-09-01T00:00:00.000Z",
      status: "ok",
      warnings: [],
    });
    publishParseRun(store, missing.artifactId, base.parser, completed);
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["NEW"]);
  });

  test("parse errors, warned tolerant containers, and failed/partial parents cannot clear balances", () => {
    const store = database();
    const base = { parser: "sbi-foreign-cash-balances", dataset: "foreign-cash-balances" };
    snapshot(store, { ...base, observations: [balance()] });
    snapshot(store, { ...base, parseStatus: "error", observations: [] });
    snapshot(store, { ...base, warnings: ["unreadable container"], observations: [] });
    snapshot(store, { ...base, status: "partial", observations: [] });
    snapshot(store, { ...base, status: "failed", observations: [] });
    const inconsistent = snapshot(store, { ...base, status: "partial", observations: [] });
    store.db.query("UPDATE fetch_runs SET status = 'success' WHERE id = ?").run(inconsistent.runId);
    expect(latestBalances(store)).toHaveLength(1);
  });

  test("fetch time wins over backfill order, and equal times use append-only artifact order", () => {
    const store = database();
    const base = { parser: "sbi-vc-position-summary", dataset: "position-summary" };
    snapshot(store, { ...base, time: "2026-09-02T00:00:00.000Z", observations: [position("NEW")] });
    snapshot(store, { ...base, observations: [position("OLD")] });
    expect(currentPositions(store).map((row) => row.security_code)).toEqual(["NEW"]);
    snapshot(store, { ...base, time: "2026-09-02T00:00:00.000Z", observations: [] });
    expect(currentPositions(store)).toEqual([]);
  });

  test("source, parser, and fetch units remain independent while removed accounts disappear", () => {
    const store = database();
    const base = { parser: "sbi-vc-cash-balances", dataset: "cash-balances" };
    snapshot(store, {
      ...base,
      source: "one",
      unit: "a",
      observations: [balance(), balance("USD", "closed")],
    });
    snapshot(store, { ...base, source: "one", unit: "b", observations: [balance()] });
    snapshot(store, { ...base, source: "two", unit: "a", observations: [balance()] });
    snapshot(store, {
      parser: "sbi-vc-account-margin",
      dataset: "account-margin",
      source: "one",
      unit: "a",
      observations: [balance()],
    });
    snapshot(store, { ...base, source: "one", unit: "a", observations: [balance()] });
    expect(latestBalances(store)).toHaveLength(4);
    expect(latestBalances(store).some((row) => row.source_account === "closed")).toBe(false);
  });
});

// Contract v2 selection (design review D01, PR-07): under coverage-v1 the
// stored claim decides membership; warning text is not read at all.
describe("coverage-v1 policy", () => {
  const FOREIGN = { parser: "sbi-foreign-cash-balances", dataset: "foreign-cash-balances" };
  const body = {
    listForeignScheduleCashBalances: {
      foreignCashBalances: [
        {
          currencyCashBalances: [
            {
              currencyCode: "USD",
              foreignScheduleCashBalances: [{ keepCash: "1.001", totalBalance: "2" }],
            },
          ],
        },
      ],
    },
  };
  /** The real parser with every warning reworded, as a translation would. */
  const reworded: Parser = {
    ...sbiForeignCashBalances,
    parse: (bytes, artifact) => {
      const result = sbiForeignCashBalances.parse(bytes, artifact);
      return {
        ...result,
        warnings: result.warnings.map((text, index) => `警告 ${index}: 表現変更`),
      };
    },
  };
  function parseInto(store: Store, parser: Parser, old: Observation[]) {
    snapshot(store, { ...FOREIGN, observations: old, coverage: {} });
    const meta = listArtifacts(store).at(-1)!;
    const parsed = parser.parse(new TextEncoder().encode(JSON.stringify(body)), meta);
    expect(parsed.warnings).toHaveLength(2);
    const result = snapshot(store, {
      ...FOREIGN,
      observations: parsed.observations,
      warnings: parsed.warnings,
      issues: parsed.issues!,
      coverage: parsed.coverage![0]!,
    });
    return { ...result, parsed };
  }

  test("changing warning text does not change the selected snapshot", () => {
    const original = database();
    const translated = database();
    activatePolicy(original, FOREIGN.parser, COVERAGE_SNAPSHOT_POLICY);
    activatePolicy(translated, FOREIGN.parser, COVERAGE_SNAPSHOT_POLICY);
    const a = parseInto(original, sbiForeignCashBalances, [balance("OLD")]);
    const b = parseInto(translated, reworded, [balance("OLD")]);
    expect(a.parsed.warnings).not.toEqual(b.parsed.warnings);
    expect(a.parsed.coverage).toEqual(b.parsed.coverage);
    expect(latestBalances(original)).toEqual(latestBalances(translated));
    expect(latestBalances(original).map((row) => row.amount_text)).toEqual(["1.001"]);
  });

  test("the legacy adapter, by contrast, is changed by the same rewording", () => {
    const translated = database();
    activatePolicy(translated, FOREIGN.parser, LEGACY_SNAPSHOT_POLICY);
    parseInto(translated, reworded, [balance("OLD")]);
    expect(latestBalances(translated).map((row) => row.instrument)).toEqual(["OLD"]);
  });

  test("a complete-empty claim supersedes; partial-empty, unknown and claimless parses do not", () => {
    const store = database();
    activatePolicy(store, FOREIGN.parser, COVERAGE_SNAPSHOT_POLICY);
    snapshot(store, { ...FOREIGN, observations: [balance("OLD")], coverage: {} });
    const old = () => latestBalances(store).map((row) => row.instrument);
    expect(old()).toEqual(["OLD"]);
    // Pages missing: zero readable rows, membership incomplete.
    snapshot(store, {
      ...FOREIGN,
      observations: [],
      coverage: {
        completeness: "partial",
        membershipComplete: false,
        failureCause: "container_unreadable",
        absenceMeaning: "not-observed",
      },
    });
    expect(old()).toEqual(["OLD"]);
    // The scope of the container is not known.
    snapshot(store, {
      ...FOREIGN,
      observations: [],
      coverage: { completeness: "unknown", membershipComplete: false, absenceMeaning: "unknown" },
    });
    expect(old()).toEqual(["OLD"]);
    // A claim about some other scope says nothing about this dataset.
    snapshot(store, { ...FOREIGN, observations: [], coverage: { scopeKey: "elsewhere/other" } });
    expect(old()).toEqual(["OLD"]);
    // A parse with no claim at all (a legacy parser) is never adopted under coverage-v1.
    snapshot(store, { ...FOREIGN, observations: [balance("LEGACY")] });
    expect(old()).toEqual(["OLD"]);
    // A complete container observed to be empty replaces the previous holdings.
    snapshot(store, { ...FOREIGN, observations: [], coverage: {} });
    expect(old()).toEqual([]);
    expect(store.db.query("SELECT COUNT(*) AS n FROM parse_runs").get()).toEqual({ n: 6 });
  });

  test("a policy row may keep the previous snapshot on a complete-empty claim", () => {
    const store = database();
    activatePolicy(store, FOREIGN.parser, COVERAGE_SNAPSHOT_POLICY);
    store.db
      .query(
        "UPDATE dataset_snapshot_policies SET replaces_previous_on_complete_empty = 0 WHERE parser_name = ?",
      )
      .run(FOREIGN.parser);
    snapshot(store, { ...FOREIGN, observations: [balance("OLD")], coverage: {} });
    snapshot(store, { ...FOREIGN, observations: [], coverage: {} });
    expect(latestBalances(store).map((row) => row.instrument)).toEqual(["OLD"]);
    snapshot(store, { ...FOREIGN, observations: [balance("NEW")], coverage: {} });
    expect(latestBalances(store).map((row) => row.instrument)).toEqual(["NEW"]);
  });

  test("a warning with membership impact hides its own rows but never the older complete snapshot", () => {
    const store = database();
    activatePolicy(store, FOREIGN.parser, COVERAGE_SNAPSHOT_POLICY);
    snapshot(store, { ...FOREIGN, observations: [balance("OLD")], coverage: {} });
    snapshot(store, {
      ...FOREIGN,
      observations: [balance("PARTIAL")],
      warnings: ["json:$.x: fields not modelled as metrics were kept only in extra: y"],
      coverage: {
        completeness: "partial",
        membershipComplete: false,
        failureCause: "row_unreadable",
      },
    });
    expect(latestBalances(store).map((row) => row.instrument)).toEqual(["OLD"]);
  });

  for (const [parser, dataset] of SNAPSHOT_DATASETS) {
    test(`${parser}: repeated, removed and empty claimed snapshots replace old rows under coverage-v1`, () => {
      const store = database();
      activatePolicy(store, parser, COVERAGE_SNAPSHOT_POLICY);
      const old = facts(parser, "OLD");
      snapshot(store, { parser, dataset, observations: old, coverage: {} });
      snapshot(store, { parser, dataset, observations: facts(parser, "NEW"), coverage: {} });
      expect(count(store)).toBe(old.length);
      expect(currentText(store)).not.toContain("OLD");
      snapshot(store, { parser, dataset, observations: [], coverage: {} });
      expect(count(store)).toBe(0);
      expect(store.db.query("SELECT COUNT(*) AS n FROM parse_coverage_claims").get()).toEqual({
        n: 3,
      });
    });
  }
});

describe("position valuation membership", () => {
  test("a new position never inherits another snapshot's valuation and exposes no internal identity", () => {
    const store = database();
    const base = { parser: "sbi-foreign-cash-positions", dataset: "foreign-cash-positions" };
    const own = { ...valuation(), rawLocator: "json:$.rows[0].evaluationProfitLoss" };
    snapshot(store, { ...base, observations: [position(), own] });
    snapshot(store, { ...base, observations: [position()] });
    const result = positionsWithValuations(store);
    expect(result).toHaveLength(1);
    expect(result[0]?.valuations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("parse_run_id");
    expect(JSON.stringify(result)).not.toContain("fetch_run_id");
  });

  test("equal security codes in different foreign markets attach only their own provider row", () => {
    const store = database();
    snapshot(store, {
      parser: "sbi-foreign-cash-positions",
      dataset: "foreign-cash-positions",
      observations: [
        position(),
        { ...position(), market: "XOTHER", rawLocator: "json:$.rows[1]" },
        { ...valuation(), rawLocator: "json:$.rows[0].evaluationProfitLoss" },
        { ...valuation(), currency: "USD", rawLocator: "json:$.rows[1].evaluationProfitLoss" },
      ],
    });
    expect(
      positionsWithValuations(store).map((row) => row.valuations.map((value) => value.currency)),
    ).toEqual([["JPY"], ["USD"]]);
  });

  test("domestic fixed-width locators keep equal codes in separate market records", () => {
    const store = database();
    snapshot(store, {
      parser: "sbi-domestic-cash-positions",
      dataset: "domestic-cash-positions",
      observations: [
        { ...position(), rawLocator: "mts-shift-jis:payload-byte=34,width=423" },
        { ...position(), market: "XOTHER", rawLocator: "mts-shift-jis:payload-byte=457,width=423" },
        { ...valuation(), rawLocator: "mts-shift-jis:payload-byte=125,width=16" },
        { ...valuation(), currency: "USD", rawLocator: "mts-shift-jis:payload-byte=548,width=16" },
      ],
    });
    expect(
      positionsWithValuations(store).map((row) => row.valuations.map((value) => value.currency)),
    ).toEqual([["JPY"], ["USD"]]);
  });
});

const EVENT_PARSERS = [
  "mobile-suica-sf-history",
  "sbi-vc-cashflows",
  "sbi-yen-detail-history",
  "sbi-foreign-trade-records",
  "sbi-domestic-trade-records",
] as const;
const event = (externalId?: string): TransactionObservation => ({
  kind: "transaction",
  sourceAccount: "synthetic-account",
  amountMinor: 1,
  currency: "JPY",
  ...(externalId === undefined ? {} : { externalId }),
  rawLocator: "json:$.rows[0]",
  extra: {},
});
describe("history event identity", () => {
  for (const parser of EVENT_PARSERS) {
    test(`${parser}: replay collapses but occurrences and absent IDs survive`, () => {
      const store = database();
      const observations = [event("fingerprint:1"), event("fingerprint:2"), event()];
      snapshot(store, { parser, dataset: "history", observations });
      snapshot(store, { parser, dataset: "history", observations });
      expect(currentTransactions(store)).toHaveLength(4);
      snapshot(store, { parser, dataset: "history", observations: [] });
      expect(currentTransactions(store)).toHaveLength(4);
    });
  }
  test("event families, sources and accounts cannot collapse one another's IDs", () => {
    const store = database();
    for (const parser of ["sbi-vc-executions", "sbi-vc-cashflows"]) {
      snapshot(store, { parser, dataset: "history", observations: [event("same")] });
      snapshot(store, {
        parser,
        dataset: "history",
        source: "another-source",
        observations: [event("same")],
      });
      snapshot(store, {
        parser,
        dataset: "history",
        observations: [{ ...event("same"), sourceAccount: "another-account" }],
      });
    }
    expect(currentTransactions(store)).toHaveLength(6);
  });
});
