// The `summary` detail of the balance pages (ADR 0123), on synthetic rows:
// every line resolves to the account, label and mapping state its own row
// carries, a history line says when its row is superseded or failed, a
// value that is not exact keeps its status with no value and no scale, and a
// default page stays under 8 KB however many accounts it names.
import { expect, test } from "bun:test";
import {
  balanceHistorySummary,
  latestBalanceSummary,
  readDetail,
} from "../src/query/read-detail.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { DEFAULT_SUMMARY_PAGE_LIMIT } from "../../read-model/src/balance-projection-sql.ts";

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
    item(5, { targetId: "acc_synthetic", label: "ラベル", lineage: "current" }, "800", {
      superseded_by_parse_run_id: null,
      parse_status: "pending",
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
    ["parse:pending"],
  ]);
  // A row organized under a historical mapping is its own entry.
  expect(summary.items.map((line) => line.account)).toEqual(["a1", "a1", "a1", "a2", "a1"]);
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
  // Reasons are closed codes, each once: no other parse status, no repeat.
  for (const reasons of [["parse:unknown"], ["parse:error", "parse:error"]])
    expect(
      validApiResponse(
        "/api/v2/balances/history",
        { ...summary, items: summary.items.map((line) => ({ ...line, reasons })) },
        "summary",
      ),
    ).toBe(false);
  // A parse status outside the closed set is refused, never passed on as a code.
  expect(() =>
    balanceHistorySummary({
      schemaVersion: "snapshot-page-v1",
      items: [
        item(6, null, "1", { superseded_by_parse_run_id: null, parse_status: "synthetic-other" }),
      ],
      page: PAGE,
      dataCoverage: COVERAGE,
      interpretationContext: {},
    } as never),
  ).toThrow("balance_history_parse_status_unknown");
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

test("a default summary page whose every line names its own account and metric stays under 8 KB", () => {
  // The worst a page of the owner's store comes to: a source with dozens of
  // provider accounts (SBI Shinsei has 62) puts a new account, and a source
  // with many provider metrics a new metric, on every line. Each entry has a
  // 64-hex entity id, a Japanese label and a long provider metric; the cursor
  // and snapshot id are as long as the route issues them.
  const page = (limit: number) => {
    const items = Array.from({ length: limit }, (_, index) => {
      const base = item(
        10_000_000 + index,
        {
          targetId: `acc_${String(index).padStart(2, "0").repeat(32)}`,
          label: `合成普通預金口座（支店${index}）`,
          lineage: "current",
        },
        index % 3 === 0 ? null : "123456789012",
      );
      return {
        ...base,
        row: {
          ...base.row,
          source_account: `synthetic-provider-account-${String(index).padStart(4, "0")}`,
          metric: `合成お支払い予定額_synthetic_metric_${index}`,
        },
        metric: { ...base.metric, metricId: `synthetic.deposit.metric-${index}` },
        adoption: { state: "unresolved", reasonCode: "value_not_exact" },
        freshness: { state: "stale", reasonCode: "older_than_policy" },
      };
    });
    const pageInfo = {
      ...PAGE,
      limit,
      hasMore: true,
      nextCursor: "c".repeat(440),
      snapshotId: "f".repeat(64),
    };
    const coverage = {
      completeness: "partial",
      stale: true,
      reasons: ["unresolved:value_not_exact"],
    };
    return {
      history: balanceHistorySummary({
        schemaVersion: "snapshot-page-v1",
        items: items.map((entry, index) => ({
          ...entry,
          row: { ...entry.row, superseded_by_parse_run_id: index + 1, parse_status: "error" },
        })),
        page: pageInfo,
        dataCoverage: coverage,
        interpretationContext: {},
      } as never),
      latest: latestBalanceSummary({
        schemaVersion: "snapshot-page-v1",
        items,
        page: pageInfo,
        dataCoverage: coverage,
        subtotals: {
          policyRelease: "known-assets-subtotal-v1",
          knownAssetsSubtotal: [],
          liabilitiesCoverage: "unknown",
          reasonCode: null,
        },
        interpretationContext: {},
      } as never),
    };
  };
  // What a client receives: the MCP result's structured content, serialized.
  const bytes = (data: unknown) =>
    new TextEncoder().encode(JSON.stringify({ schemaVersion: "kogane-page-read-v1", data })).length;
  const fitting = page(DEFAULT_SUMMARY_PAGE_LIMIT);
  for (const summary of [fitting.history, fitting.latest]) {
    expect(summary.accounts).toHaveLength(DEFAULT_SUMMARY_PAGE_LIMIT);
    expect(summary.metrics).toHaveLength(DEFAULT_SUMMARY_PAGE_LIMIT);
    expect(bytes(summary)).toBeLessThan(8 * 1024);
  }
  // The next offered size does not fit such a page: why the default is ten.
  const wider = page(25);
  for (const summary of [wider.history, wider.latest])
    expect(bytes(summary)).toBeGreaterThan(8 * 1024);
});
