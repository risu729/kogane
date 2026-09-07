import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobileSuicaSfHistory } from "../src/parsers/mobile-suica-sf-history.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "mobile-suica-parser-boundaries",
  "sf-history.json",
);

function artifact(
  dataset = "sf-history",
  mime = "application/json",
  runStatus = "success",
): ArtifactMeta {
  return {
    id: 1,
    sourceId: "mobile-suica",
    runStatus,
    dataset,
    url: null,
    mime,
    fetchedAt: "2026-08-30T01:00:00Z",
    sha256: "0".repeat(64),
  };
}

function fixture(): Uint8Array {
  return readFileSync(FIXTURE);
}

function value(): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture())) as Record<string, unknown>;
}

function encoded(input: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

function expectRejected(input: Record<string, unknown>, pattern: RegExp): void {
  expect(() => mobileSuicaSfHistory.parse(encoded(input), artifact())).toThrow(pattern);
}

describe("Mobile Suica canonical routing", () => {
  test("registers exactly one normalized parser and never parses HTML or summary artifacts", () => {
    expect(PARSERS.filter((candidate) => candidate === mobileSuicaSfHistory)).toHaveLength(1);
    expect(PARSERS.filter((parser) => parser.accepts(artifact()))).toEqual([mobileSuicaSfHistory]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact("sf-history-html", "text/html; charset=shift_jis")),
      ),
    ).toEqual([]);
    expect(PARSERS.filter((parser) => parser.accepts(artifact("collection-summary")))).toEqual([]);
    expect(PARSERS.filter((parser) => parser.accepts(artifact("manifest")))).toEqual([]);
  });

  test("routes only the exact source, dataset, and JSON media type", () => {
    expect(mobileSuicaSfHistory.accepts(artifact())).toBe(true);
    expect(mobileSuicaSfHistory.accepts(artifact("sf-history", "text/json"))).toBe(false);
    expect(mobileSuicaSfHistory.accepts({ ...artifact(), sourceId: "not-mobile-suica" })).toBe(
      false,
    );
  });
});

describe("Mobile Suica history semantics", () => {
  test("emits signed transactions and post-transaction balances with exact lineage", () => {
    const result = mobileSuicaSfHistory.parse(fixture(), artifact());
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(5);
    const transactions = result.observations.filter((entry) => entry.kind === "transaction");
    const balances = result.observations.filter((entry) => entry.kind === "balance");
    expect(transactions).toHaveLength(2);
    expect(balances).toHaveLength(3);
    expect(transactions.map((entry) => entry.amountMinor)).toEqual([1000, -420]);
    expect(transactions.map((entry) => entry.currency)).toEqual(["JPY", "JPY"]);
    expect(new Set(transactions.map((entry) => entry.externalId)).size).toBe(2);
    expect(balances.map((entry) => entry.amountMinor)).toEqual([2000, 3000, 2580]);
    expect(balances.map((entry) => entry.metric)).toEqual([
      "sf_balance_after_transaction",
      "sf_balance_after_transaction",
      "sf_balance_after_transaction",
    ]);
    expect(result.observations.at(-1)).toMatchObject({
      kind: "balance",
      asOf: "2026-08-29",
      rawLocator: "json:$.rows[0]",
      extra: {
        amountText: "-420",
        _kogane: {
          canonicalDataset: "sf-history",
          derivedFromDataset: "sf-history-html",
          direction: "outflow",
          currentBalanceCandidate: true,
        },
      },
    });
    expect(
      result.observations.some(
        (entry) => entry.rawLocator === "json:$.rows[2]" && entry.kind === "transaction",
      ),
    ).toBe(false);
  });

  test("uses amount sign as authoritative, independent of row kind", () => {
    const input = value();
    const rows = input.rows as Record<string, unknown>[];
    rows[0] = { ...rows[0], amountText: "+420", amount: 420 };
    const parsed = mobileSuicaSfHistory.parse(encoded(input), artifact());
    const newest = parsed.observations.find(
      (entry) => entry.kind === "transaction" && entry.rawLocator === "json:$.rows[0]",
    );
    expect(newest).toMatchObject({ amountMinor: 420, extra: { _kogane: { direction: "inflow" } } });
  });

  test("distinguishes duplicate provider rows by stable occurrence", () => {
    const input = value();
    const rows = input.rows as Record<string, unknown>[];
    input.rows = [rows[0], structuredClone(rows[0])];
    input.transactionCount = 2;
    const parsed = mobileSuicaSfHistory.parse(encoded(input), artifact());
    const ids = parsed.observations
      .filter((entry) => entry.kind === "transaction")
      .map((entry) => entry.externalId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]?.endsWith(":1")).toBe(true);
    expect(ids[1]?.endsWith(":0")).toBe(true);
  });

  test("accepts a complete empty history as an observed empty snapshot", () => {
    const input = value();
    input.rows = [];
    input.transactionCount = 0;
    expect(mobileSuicaSfHistory.parse(encoded(input), artifact())).toEqual({
      observations: [],
      warnings: [],
    });
  });

  test("accepts legacy sub-boundary history with an explicit warning", () => {
    const input = value();
    delete input.complete;
    const parsed = mobileSuicaSfHistory.parse(encoded(input), artifact());
    expect(parsed.observations).toHaveLength(5);
    expect(parsed.warnings).toEqual([
      "sf-history: legacy payload has no explicit completeness flag",
    ]);
  });

  test("preserves provider rows beyond the documented 26-week window with a warning", () => {
    const input = value();
    const rows = input.rows as Record<string, unknown>[];
    input.rows = [{ ...rows[0], date: "2026-01-01" }];
    input.transactionCount = 1;
    const parsed = mobileSuicaSfHistory.parse(encoded(input), artifact());
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.warnings).toEqual([
      "json:$.rows[0]: date exceeds the documented 26-week history window; preserved",
    ]);
  });

  test("warns and omits only the unavailable metric allowed by the normalized contract", () => {
    const input = value();
    const rows = input.rows as Record<string, unknown>[];
    rows[0] = { ...rows[0], balanceText: "", balance: null };
    const parsed = mobileSuicaSfHistory.parse(encoded(input), artifact());
    expect(parsed.observations.filter((entry) => entry.kind === "transaction")).toHaveLength(2);
    expect(parsed.observations.filter((entry) => entry.kind === "balance")).toHaveLength(2);
    expect(parsed.warnings).toContain(
      "json:$.rows[0]: post-transaction balance is unavailable; balance omitted",
    );
  });
});

describe("Mobile Suica strict completeness and schema boundaries", () => {
  test("refuses non-success run metadata even when called outside the pipeline", () => {
    expect(() =>
      mobileSuicaSfHistory.parse(fixture(), artifact("sf-history", "application/json", "partial")),
    ).toThrow(/successful fetch run/u);
  });

  test("refuses unknown or missing root and row fields", () => {
    const unknownRoot = value();
    unknownRoot.unexpected = true;
    expectRejected(unknownRoot, /schema drift/u);
    const missingRoot = value();
    delete missingRoot.pageCount;
    expectRejected(missingRoot, /schema drift/u);
    const unknownRow = value();
    (unknownRow.rows as Record<string, unknown>[])[0]!.unexpected = true;
    expectRejected(unknownRow, /schema drift/u);
  });

  test("refuses page, cardinality, and 100-row incompleteness contradictions", () => {
    const wrongPage = value();
    wrongPage.pageCount = 2;
    expectRejected(wrongPage, /pageCount/u);
    const wrongCount = value();
    wrongCount.transactionCount = 2;
    expectRejected(wrongCount, /rows.length/u);
    const incomplete = value();
    incomplete.complete = false;
    expectRejected(incomplete, /complete/u);
    const hundred = value();
    const row = (hundred.rows as Record<string, unknown>[])[0]!;
    hundred.rows = Array.from({ length: 100 }, () => structuredClone(row));
    hundred.transactionCount = 100;
    hundred.complete = false;
    expectRejected(hundred, /complete provider snapshot/u);
    delete hundred.complete;
    expectRejected(hundred, /legacy.*100-row/u);
  });

  test("refuses invalid row enum, semantic amount drift, and classification drift", () => {
    const kind = value();
    (kind.rows as Record<string, unknown>[])[0]!.kind = "fare";
    expectRejected(kind, /unsupported value/u);
    const amount = value();
    (amount.rows as Record<string, unknown>[])[0]!.amount = -421;
    expectRejected(amount, /display amounts/u);
    const classification = value();
    (classification.rows as Record<string, unknown>[])[0]!.kind = "bus";
    expectRejected(classification, /normalized row fields/u);
  });

  test("refuses current-day, future, and out-of-order rows", () => {
    const currentDay = value();
    (currentDay.rows as Record<string, unknown>[])[0]!.date = "2026-08-30";
    expectRejected(currentDay, /before asOfDateJst/u);
    const future = value();
    (future.rows as Record<string, unknown>[])[0]!.date = "2026-08-31";
    expectRejected(future, /before asOfDateJst/u);
    const order = value();
    const rows = order.rows as Record<string, unknown>[];
    rows[1]!.date = "2026-08-29";
    rows[2]!.date = "2026-08-30";
    expectRejected(order, /before asOfDateJst|out of provider date order/u);
  });
});
