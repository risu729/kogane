// The `summary` detail of the balance pages (ADR 0123), on synthetic rows:
// every line resolves to the account, label and mapping state its own row
// carries, a history line says when its row is superseded or failed, and a
// value that is not exact keeps its status with no value and no scale.
import { expect, test } from "bun:test";
import {
  balanceHistorySummary,
  latestBalanceSummary,
  readDetail,
} from "../src/query/read-detail.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";

const PAGE = {
  limit: 25,
  hasMore: false,
  nextCursor: null,
  snapshotId: "snapshot-synthetic",
  paginationVersion: "keyset-v2",
};
const COVERAGE = { completeness: "complete", stale: false, reasons: [] };

function quantity(coefficient: string | null) {
  return {
    normalized:
      coefficient === null
        ? {
            policyVersion: "decimal-v1",
            status: "unparsed",
            coefficient: null,
            scale: null,
            basis: "none",
          }
        : {
            policyVersion: "decimal-v1",
            status: "exact",
            coefficient,
            scale: 2,
            basis: "agreement",
          },
    unitReference: "JPY",
    sourceRepresentation: { amountText: null, legacyMinorUnits: null, legacyMinorUnitExponent: 0 },
  };
}

/** One history item of `synthetic-account` under the given organization. */
function item(
  id: number,
  account: { targetId: string; label: string; lineage?: "current" | "historical" } | null,
  value: string | null,
  parse: { superseded_by_parse_run_id: number | null; parse_status: string } = {
    superseded_by_parse_run_id: null,
    parse_status: "ok",
  },
) {
  return {
    observationId: id,
    row: {
      id,
      source_id: "synthetic-source",
      source_account: "synthetic-account",
      metric: "synthetic_balance",
      instrument: "JPY",
      amount_minor: null,
      amount_text: null,
      as_of: "2026-01-31",
      observed_at: null,
      parser: "synthetic-parser",
      ...parse,
      ...(account === null
        ? { organization: { state: "unavailable", lineage: null, account: null, instruments: [] } }
        : {
            organization: {
              state: "organized",
              lineage: account.lineage ?? "historical",
              account: {
                targetId: account.targetId,
                label: account.label,
                status: "identified",
                kind: "deposit",
              },
              instruments: [],
            },
          }),
    },
    quantity: quantity(value),
    metric: {
      metricId: "synthetic.balance",
      definitionRelease: "synthetic-1",
      measurementKind: "balance",
      aggregationRule: "latest",
    },
    temporal: { role: "as_of", time: {} },
  };
}

test("an absent detail is the summary, and only the two details are read", () => {
  expect(readDetail(null)).toBe("summary");
  expect(readDetail("summary")).toBe("summary");
  expect(readDetail("full")).toBe("full");
  expect(readDetail("compact")).toBeNull();
  expect(readDetail("")).toBeNull();
});

test("one provider account organized two ways on a page is two entries, each line its own", () => {
  const items = [
    item(1, { targetId: "acc_synthetic_old", label: "旧ラベル" }, "1050"),
    item(2, { targetId: "acc_synthetic_new", label: "新ラベル" }, "2075"),
    item(3, null, null),
    item(4, { targetId: "acc_synthetic_old", label: "旧ラベル" }, "3000"),
  ];
  const summary = balanceHistorySummary({
    schemaVersion: "snapshot-page-v1",
    items,
    page: PAGE,
    dataCoverage: COVERAGE,
    interpretationContext: {},
  } as never);
  expect(summary.accounts).toEqual([
    {
      ref: "a1",
      source: "synthetic-source",
      sourceAccount: "synthetic-account",
      account: "acc_synthetic_old",
      label: "旧ラベル",
      status: "identified",
      lineage: "historical",
    },
    {
      ref: "a2",
      source: "synthetic-source",
      sourceAccount: "synthetic-account",
      account: "acc_synthetic_new",
      label: "新ラベル",
      status: "identified",
      lineage: "historical",
    },
    {
      ref: "a3",
      source: "synthetic-source",
      sourceAccount: "synthetic-account",
      account: null,
      label: null,
      status: null,
      lineage: null,
    },
  ]);
  const byRef = new Map(summary.accounts.map((entry) => [entry.ref, entry]));
  for (const [index, line] of summary.items.entries()) {
    const own = items[index]!.row.organization.account;
    expect(byRef.get(line.account)).toMatchObject({
      account: own?.targetId ?? null,
      label: own?.label ?? null,
    });
  }
  expect(summary.items.map((line) => line.account)).toEqual(["a1", "a2", "a3", "a1"]);
  expect(summary.metrics).toHaveLength(1);
  // Provenance stays in the full page.
  expect(summary).not.toHaveProperty("interpretationContext");
  // A value that is not exact is its status, never a zero.
  expect(summary.items.map((line) => line.amount)).toEqual([
    { value: "10.50", unit: "JPY", status: "exact", scale: 2 },
    { value: "20.75", unit: "JPY", status: "exact", scale: 2 },
    { value: null, unit: "JPY", status: "unparsed", scale: null },
    { value: "30.00", unit: "JPY", status: "exact", scale: 2 },
  ]);
  expect(validApiResponse("/api/v2/balances/history", summary, "summary")).toBe(true);
  // A page that asked for the full rows does not take a summary for them.
  expect(validApiResponse("/api/v2/balances/history", summary, "full")).toBe(false);
  // An account listed twice under two refs is not one entry per account.
  expect(
    validApiResponse(
      "/api/v2/balances/history",
      {
        ...summary,
        accounts: [...summary.accounts, { ...summary.accounts[0]!, ref: "a4" }],
        items: [...summary.items, { ...summary.items[0]!, account: "a4" }],
      },
      "summary",
    ),
  ).toBe(false);
  // An organized entry states its mapping; an unavailable one states none.
  expect(
    validApiResponse(
      "/api/v2/balances/history",
      {
        ...summary,
        accounts: summary.accounts.map((entry) =>
          entry.ref === "a1" ? { ...entry, status: null } : entry,
        ),
      },
      "summary",
    ),
  ).toBe(false);
});

test("a history line says when its row is superseded or its parse failed, never as a current row", () => {
  const items = [
    item(1, { targetId: "acc_synthetic", label: "ラベル", lineage: "current" }, "1050"),
    item(2, { targetId: "acc_synthetic", label: "ラベル", lineage: "current" }, "1000", {
      superseded_by_parse_run_id: 7,
      parse_status: "ok",
    }),
    item(3, { targetId: "acc_synthetic", label: "ラベル", lineage: "current" }, null, {
      superseded_by_parse_run_id: null,
      parse_status: "error",
    }),
    item(4, { targetId: "acc_synthetic", label: "ラベル", lineage: "historical" }, "900", {
      superseded_by_parse_run_id: 8,
      parse_status: "error",
    }),
  ];
  const summary = balanceHistorySummary({
    schemaVersion: "snapshot-page-v1",
    items,
    page: PAGE,
    dataCoverage: COVERAGE,
    interpretationContext: {},
  } as never);
  expect(summary.items.map((line) => line.reasons)).toEqual([
    [],
    ["parse:superseded"],
    ["parse:error"],
    ["parse:superseded", "parse:error"],
  ]);
  // A row organized under a historical mapping is its own entry.
  expect(summary.items.map((line) => line.account)).toEqual(["a1", "a1", "a1", "a2"]);
  expect(summary.accounts.map((entry) => entry.lineage)).toEqual(["current", "historical"]);
  expect(validApiResponse("/api/v2/balances/history", summary, "summary")).toBe(true);
  // A history line without its reasons is not a summary line.
  expect(
    validApiResponse(
      "/api/v2/balances/history",
      { ...summary, items: summary.items.map(({ reasons: _reasons, ...line }) => line) },
      "summary",
    ),
  ).toBe(false);
});

test("a latest line keeps its adoption and freshness states and their reason codes", () => {
  const latest = {
    ...item(5, { targetId: "acc_synthetic_old", label: "旧ラベル" }, null),
    adoption: {
      state: "unresolved",
      reasonCode: "value_not_exact",
      memberEvidence: [],
      evidenceCount: 0,
    },
    freshness: { state: "stale", reasonCode: "older_than_policy" },
  };
  const summary = latestBalanceSummary({
    schemaVersion: "snapshot-page-v1",
    items: [latest],
    page: PAGE,
    dataCoverage: COVERAGE,
    subtotals: { policyRelease: "synthetic", knownAssetsSubtotal: null },
    interpretationContext: {},
  } as never);
  expect(summary.items).toEqual([
    {
      observationId: 5,
      account: "a1",
      metric: "m1",
      amount: { value: null, unit: "JPY", status: "unparsed", scale: null },
      asOf: "2026-01-31",
      freshness: "stale",
      adoption: "unresolved",
      reasons: ["adoption:value_not_exact", "freshness:older_than_policy"],
    },
  ]);
});
