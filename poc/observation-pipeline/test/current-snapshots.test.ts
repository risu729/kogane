import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  putRawObject,
  upsertSource,
  type Store,
} from "../src/store.ts";
import {
  currentPositions,
  currentTransactions,
  currentValuations,
  latestBalances,
  positionsWithValuations,
} from "../src/queries.ts";
import { SNAPSHOT_DATASETS } from "../src/snapshot-query.ts";
import type {
  Observation,
  PositionObservation,
  ValuationObservation,
  BalanceObservation,
  TransactionObservation,
} from "../src/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function database(): Store {
  const directory = mkdtempSync(join(tmpdir(), "kogane-current-snapshots-"));
  const store = openStore(directory);
  cleanup.push(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

interface Snapshot {
  parser: string;
  dataset: string;
  source?: string;
  unit?: string;
  time?: string;
  status?: "success" | "partial" | "failed";
  failureCount?: number;
  parseStatus?: "ok" | "error" | "missing";
  warnings?: string[];
  runId?: number;
  observations: Observation[];
}
let sequence = 0;
function snapshot(store: Store, options: Snapshot) {
  const sourceId = options.source ?? "synthetic-source";
  const time = options.time ?? "2026-09-01T00:00:00.000Z";
  upsertSource(store, { id: sourceId, provider: "Synthetic", ingestion: "collector-r2" });
  const runId =
    options.runId ??
    insertFetchRun(store, {
      sourceId,
      externalRunId: `synthetic-${++sequence}`,
      tool: "synthetic-query-test",
      startedAt: time,
      completedAt: time,
      status: options.status ?? "success",
      failureCount:
        options.failureCount ??
        (options.status === undefined || options.status === "success" ? 0 : 1),
    });
  const raw = putRawObject(store, new TextEncoder().encode("{}"), "application/json");
  const artifactId = insertFetchArtifact(store, {
    sourceId,
    fetchRunId: runId,
    dataset: options.dataset,
    ...(options.unit === undefined ? {} : { fetchUnitKey: options.unit }),
    fetchedAt: time,
    mime: "application/json",
    sha256: raw.sha256,
  });
  if (options.parseStatus === "missing") return { runId, artifactId };
  const parseId = insertParseRun(store, {
    artifactId,
    parserName: options.parser,
    parserVersion: "0.1.0",
    parsedAt: time,
    status: options.parseStatus ?? "ok",
    warnings: options.warnings ?? [],
  });
  for (const observation of options.observations) insertObservation(store, parseId, observation);
  return { runId, artifactId };
}

const position = (code = "TEST"): PositionObservation => ({
  kind: "position",
  sourceAccount: "synthetic-account",
  securityCode: code,
  market: "XTEST",
  quantityText: "1",
  quantityScale: 0,
  rawLocator: "json:$.rows[0]",
  extra: {},
});
const valuation = (subject = "TEST"): ValuationObservation => ({
  kind: "valuation",
  sourceAccount: "synthetic-account",
  subject,
  metric: "value",
  amountMinor: 1,
  currency: "JPY",
  rawLocator: "json:$.rows[0]",
  extra: {},
});
const balance = (instrument = "JPY", account = "synthetic-account"): BalanceObservation => ({
  kind: "balance",
  sourceAccount: account,
  metric: "balance",
  instrument,
  amountMinor: 1,
  rawLocator: "json:$.rows[0]",
  extra: {},
});
function facts(parser: string, label: string): Observation[] {
  if (parser.includes("positions")) return [position(label), valuation(label)];
  if (parser === "sbi-vc-position-summary") return [position(label)];
  if (parser === "sbi-account-assets-current") return [valuation(label)];
  if (parser === "sony-bank-gross-balance" || parser.endsWith("top-balances-and-activity")) {
    return [balance(label), valuation(label)];
  }
  return [balance(label)];
}
function count(store: Store): number {
  return (
    currentPositions(store).length + currentValuations(store).length + latestBalances(store).length
  );
}

describe("complete container snapshots", () => {
  for (const [parser, dataset] of SNAPSHOT_DATASETS) {
    test(`${parser}: repeated, removed instrument/account, and empty snapshots replace old rows`, () => {
      const store = database();
      const old = facts(parser, "OLD");
      snapshot(store, { parser, dataset, observations: old });
      snapshot(store, { parser, dataset, observations: facts(parser, "NEW") });
      expect(count(store)).toBe(old.length);
      expect(
        JSON.stringify([currentPositions(store), currentValuations(store), latestBalances(store)]),
      ).not.toContain("OLD");
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
    insertParseRun(store, {
      artifactId: missing.artifactId,
      parserName: base.parser,
      parserVersion: "0.1.0",
      parsedAt: "2026-09-01T00:00:00.000Z",
      status: "ok",
      warnings: [],
    });
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
