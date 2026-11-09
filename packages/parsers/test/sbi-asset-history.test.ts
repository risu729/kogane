import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sbiAccountAssetsHistory as parser } from "../src/parsers/sbi-account-assets-history.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import {
  assetHistoryViews,
  sanitizeAssetHistory,
  type AssetHistoryPoint,
} from "../src/parsers/sbi-asset-history-schema.ts";
import type { ArtifactMeta, ValuationObservation } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sbi-securities",
  dataset: "account-assets-history",
  runStatus: "success",
  runFailureCount: 0,
  url: null,
  mime: "application/json",
  fetchedAt: "2099-01-10T01:00:00Z",
  sha256: "0".repeat(64),
};
const bytes = readFileSync(`${FIXTURES_ROOT}sbi-parser-boundaries/account-assets-history.json`);
const time = "4071049200000";
interface Fixture {
  valuationsTransitions: Record<string, Record<string, AssetHistoryPoint>>;
  valuationsTransitionsWithoutDeposit: Record<string, Record<string, AssetHistoryPoint>>;
  balances: [number, number][];
  holdCategories: string[];
  [key: string]: unknown;
}
const fixture = (): Fixture => JSON.parse(bytes.toString()) as Fixture;
const parse = (value: unknown) =>
  parser.parse(new TextEncoder().encode(JSON.stringify(value)), meta);
const key = (row: ValuationObservation) =>
  [row.sourceAccount, row.subject, row.metric, row.currency, row.asOf].join("/");

test("weekly history is registered, deterministic and limited to its own dataset", () => {
  expect(PARSERS.filter((p) => p === parser)).toHaveLength(1);
  expect(parser.accepts(meta)).toBe(true);
  expect(parser.accepts({ ...meta, dataset: "account-assets-current" })).toBe(false);
  expect(parser.parse(bytes, meta)).toEqual(parser.parse(bytes, meta));
  const value = fixture();
  expect(sanitizeAssetHistory(value)).toBe(value);
});

test("listed categories control profiles; native ALL tuples corroborate rather than duplicate points", () => {
  const result = parser.parse(bytes, meta);
  expect(result.observations).toHaveLength(48);
  const rows = result.observations as ValuationObservation[];
  expect(new Set(rows.map(key)).size).toBe(48);
  const full = rows.filter(
    (r) => r.subject === "portfolio:weekly:full:ALL" && r.metric === "valuation",
  );
  expect(full.map((r) => r.amountMinor)).toEqual([150, 155]);
  const filtered = rows.filter(
    (r) => r.subject === "portfolio:weekly:without-deposit:ALL" && r.metric === "valuation",
  );
  expect(filtered.map((r) => r.amountMinor)).toEqual([70, 72]);
  expect(rows.some((r) => r.subject === "portfolio:weekly:without-deposit:DOMESTIC_DEPOSIT")).toBe(
    false,
  );
  expect(filtered[0]!.extra).toMatchObject({
    _kogane: { role: "aggregate", residualCategories: { DOMESTIC_DEPOSIT: { valuation: 10 } } },
  });
  expect(full[0]!.asOf).toBe("2099-01-03");
  expect(full[0]!.observedAt).toBeUndefined();
  expect(result.coverage?.[0]?.completeness).toBe("partial");
  expect(result.coverage?.slice(1).map((c) => [c.mode, c.completeness, c.observedCount])).toEqual([
    ["window", "complete", 30],
    ["window", "complete", 18],
    ["evidence-only", "unknown", 0],
    ["evidence-only", "unknown", 0],
  ]);
});

test("null views and null metrics never create zero facts", () => {
  const result = parser.parse(bytes, meta);
  expect(
    result.observations.some((r) => r.kind === "valuation" && r.subject.includes("ideco")),
  ).toBe(false);
  expect(
    result.observations.some(
      (r) =>
        r.kind === "valuation" &&
        r.subject.endsWith("DOMESTIC_DEPOSIT") &&
        r.metric === "profit_loss",
    ),
  ).toBe(false);
  expect(result.issues?.filter((i) => i.impact === "membership")).toHaveLength(2);
  expect(result.issues?.filter((i) => i.impact === "field")).toHaveLength(12);
});

test("overlap and a corrected amount keep the same logical point keys", () => {
  const original = parser.parse(bytes, meta).observations as ValuationObservation[];
  const changed = fixture();
  changed.valuationsTransitions[time]!["ALL"]!.profitLoss = 999;
  const revised = parse(changed).observations as ValuationObservation[];
  expect(revised.map(key)).toEqual(original.map(key));
  expect(
    revised.find(
      (r) =>
        r.subject.endsWith("full:ALL") && r.asOf === "2099-01-03" && r.metric === "profit_loss",
    )!.amountMinor,
  ).toBe(999);
});

const refusals: [string, (f: Fixture) => void, string][] = [
  [
    "unknown field",
    (f) => {
      f["credential"] = "synthetic";
    },
    "schema",
  ],
  [
    "unknown category",
    (f) => {
      f.holdCategories.push("UNKNOWN");
    },
    "category",
  ],
  [
    "duplicate category",
    (f) => {
      f.holdCategories.push(f.holdCategories[0]!);
    },
    "category",
  ],
  [
    "missing held category",
    (f) => {
      delete f.valuationsTransitions[time]!["FOREIGN_STOCK_US"];
    },
    "category",
  ],
  [
    "fractional money",
    (f) => {
      f.valuationsTransitions[time]!["ALL"]!.profitLoss = 0.1;
    },
    "money",
  ],
  [
    "unsafe money",
    (f) => {
      f.valuationsTransitions[time]!["ALL"]!.profitLoss = Number.MAX_SAFE_INTEGER + 1;
    },
    "money",
  ],
  [
    "native mismatch",
    (f) => {
      f.balances[0]![1]++;
    },
    "native_mismatch",
  ],
  [
    "duplicate native timestamp",
    (f) => {
      f.balances[1]![0] = f.balances[0]![0];
    },
    "native_mismatch",
  ],
  [
    "category total mismatch",
    (f) => {
      f.valuationsTransitions[time]!["DOMESTIC_DEPOSIT"]!.valuation++;
    },
    "total_mismatch",
  ],
  [
    "missing required field",
    (f) => {
      f.valuationsTransitions[time]!["ALL"] = { valuation: 1 } as AssetHistoryPoint;
    },
    "schema",
  ],
  [
    "unobserved positive ideco",
    (f) => {
      f["valuationsTransitionsWithoutIdeco"] = f.valuationsTransitions;
    },
    "schema",
  ],
];
for (const [name, mutate, code] of refusals)
  test(`refuses ${name} with a closed diagnosis`, () => {
    const value = fixture();
    mutate(value);
    expect(() => parse(value)).toThrow(`sbi_asset_history_${code}`);
  });

test("unlisted nonzero residual rows are retained and validated too", () => {
  const value = fixture();
  value.valuationsTransitionsWithoutDeposit[time]!["DOMESTIC_DEPOSIT"]!.valuation = 0.1;
  expect(() => parse(value)).toThrow("sbi_asset_history_money");
});

test("the calendar must remain weekly and Saturday midnight JST", () => {
  for (const delta of [86400000, 7 * 86400000]) {
    const value = fixture();
    for (const view of assetHistoryViews(value)) {
      if (view.transitions === null) continue;
      const old = Object.keys(view.transitions).sort()[1]!;
      const next = String(Number(old) + delta);
      view.transitions[next] = view.transitions[old]!;
      delete view.transitions[old];
      view.balances[1]![0] = Number(next);
      view.acquisitionCosts[1]![0] = Number(next);
    }
    expect(() => parse(value)).toThrow(
      `sbi_asset_history_${delta === 86400000 ? "timestamp" : "weekly_gap"}`,
    );
  }
});
