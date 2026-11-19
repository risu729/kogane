// The `summary` detail of the balance pages (ADR 0123), on synthetic rows:
// every line resolves to the account and label its own row carries, and a
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
  account: { targetId: string; label: string } | null,
  value: string | null,
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
      ...(account === null
        ? { organization: { state: "unavailable", lineage: null, account: null, instruments: [] } }
        : {
            organization: {
              state: "organized",
              lineage: "historical",
              account: { ...account, kind: "deposit" },
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
    },
    {
      ref: "a2",
      source: "synthetic-source",
      sourceAccount: "synthetic-account",
      account: "acc_synthetic_new",
      label: "新ラベル",
    },
    {
      ref: "a3",
      source: "synthetic-source",
      sourceAccount: "synthetic-account",
      account: null,
      label: null,
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
