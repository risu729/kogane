// The balance pages' exact amounts as the browser's validator reads them
// (INV03, INV05). An exact value is decimal text whose fraction has exactly
// its scale, as `decimalToString` writes a decimal-v1 coefficient, and a
// subtotal is an integer coefficient at its scale; text that is not a decimal
// is refused, never shown as an amount. A subtotal the server leaves out
// names its reason. Every value here is synthetic.
import { describe, expect, test } from "bun:test";
import {
  cashPerAccount,
  type OrganizedMeasureRow,
} from "../../application/src/query/cash-per-account.ts";
import type {
  CashPerAccountPage,
  KnownAssetsSubtotals,
  LatestBalanceSummaryPage,
  SummaryAmount,
} from "../src/api-contract.ts";
import { decimalToString } from "../../domain/src/values.ts";
import { validApiResponse } from "../src/api-validation.ts";

const LATEST = "/api/v2/balances/latest";
const CASH = "/api/v2/balances/cash";

function subtotals(overrides: Partial<KnownAssetsSubtotals> = {}): KnownAssetsSubtotals {
  return {
    policyRelease: "known-assets-subtotal-v1",
    knownAssetsSubtotal: [
      { unitRef: "JPY", coefficient: "1234567", scale: 0, adoptedCount: 2 },
      { unitRef: "USD", coefficient: "-1205", scale: 2, adoptedCount: 1 },
    ],
    liabilitiesCoverage: "unknown",
    reasonCode: null,
    ...overrides,
  };
}

function latestSummary(
  amount: SummaryAmount,
  overrides: Partial<KnownAssetsSubtotals> = {},
): LatestBalanceSummaryPage {
  return {
    schemaVersion: "snapshot-page-v1",
    detail: "summary",
    accounts: [
      {
        ref: "a1",
        source: "synthetic-bank",
        sourceAccount: "synthetic-bank:ordinary",
        account: null,
        label: null,
        status: null,
        lineage: null,
      },
    ],
    metrics: [
      {
        ref: "m1",
        source: "synthetic-bank",
        metric: "deposit.balance",
        providerMetric: "balance",
      },
    ],
    items: [
      {
        observationId: 7,
        account: "a1",
        metric: "m1",
        amount,
        asOf: "2026-11-18",
        freshness: "current",
        adoption: "adopted",
        reasons: [],
      },
    ],
    page: {
      limit: 10,
      hasMore: false,
      nextCursor: null,
      snapshotId: "snapshot-synthetic",
      paginationVersion: "keyset-v2",
    },
    dataCoverage: { completeness: "complete", stale: false, reasons: [] },
    subtotals: subtotals(overrides),
  };
}

const exact = (value: string, scale: number): SummaryAmount => ({
  value,
  unit: "JPY",
  status: "exact",
  scale,
});

describe("a summary line's exact amount", () => {
  test("accepts decimal text whose fraction is its scale, as decimal-v1 writes it", () => {
    for (const [value, scale] of [
      ["0", 0],
      ["1234", 0],
      ["-1234", 0],
      ["12.34", 2],
      ["10.50", 2],
      ["0.05", 2],
      ["-0.005", 3],
    ] as const)
      expect(validApiResponse(LATEST, latestSummary(exact(value, scale)), "summary")).toBe(true);
  });

  test("accepts the longest text decimal-v1 writes, and refuses a longer coefficient", () => {
    for (const decimal of [
      { coefficient: "-1", scale: 4096 },
      { coefficient: `-${"9".repeat(4096)}`, scale: 4096 },
      { coefficient: `-${"9".repeat(4096)}`, scale: 0 },
    ])
      expect(
        validApiResponse(
          LATEST,
          latestSummary(exact(decimalToString(decimal), decimal.scale)),
          "summary",
        ),
      ).toBe(true);
    for (const [value, scale] of [
      [`-${"9".repeat(4097)}`, 0],
      [`-0.${"0".repeat(4096)}1`, 4097],
    ] as const)
      expect(validApiResponse(LATEST, latestSummary(exact(value, scale)), "summary")).toBe(false);
  });

  test("refuses text that is not a decimal, or whose fraction is not its scale", () => {
    for (const [value, scale] of [
      ["abc", 0],
      ["", 0],
      ["1e3", 0],
      ["1,234", 0],
      [" 12", 0],
      ["+12", 0],
      ["012", 0],
      ["-0", 0],
      ["0.00", 2],
      ["12.3", 2],
      ["12.34", 0],
      ["12.", 0],
      [".5", 1],
      ["Infinity", 0],
    ] as const)
      expect(validApiResponse(LATEST, latestSummary(exact(value, scale)), "summary")).toBe(false);
  });
});

describe("the known-assets subtotal", () => {
  test("accepts integer coefficients at their scale, and a reasoned null", () => {
    expect(validApiResponse(LATEST, latestSummary(exact("1", 0)), "summary")).toBe(true);
    expect(
      validApiResponse(
        LATEST,
        latestSummary(exact("1", 0), {
          knownAssetsSubtotal: null,
          reasonCode: "subject_reported_twice",
        }),
        "summary",
      ),
    ).toBe(true);
    expect(
      validApiResponse(
        LATEST,
        latestSummary(exact("1", 0), { knownAssetsSubtotal: [] }),
        "summary",
      ),
    ).toBe(true);
  });

  test("refuses a coefficient that is not an integer at its scale (INV03)", () => {
    for (const [coefficient, scale] of [
      ["12.5", 0],
      ["1e3", 0],
      ["abc", 0],
      ["", 0],
      ["0012", 0],
      ["-0", 0],
      ["0", 2],
    ] as const)
      expect(
        validApiResponse(
          LATEST,
          latestSummary(exact("1", 0), {
            knownAssetsSubtotal: [{ unitRef: "JPY", coefficient, scale, adoptedCount: 1 }],
          }),
          "summary",
        ),
      ).toBe(false);
  });

  test("refuses a missing subtotal without its reason, and a reason beside a figure (INV05)", () => {
    expect(
      validApiResponse(
        LATEST,
        latestSummary(exact("1", 0), { knownAssetsSubtotal: null, reasonCode: null }),
        "summary",
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LATEST,
        latestSummary(exact("1", 0), { reasonCode: "scope_exceeds_subtotal_bound" }),
        "summary",
      ),
    ).toBe(false);
  });
});

let sequence = 0;
function row(fields: Partial<OrganizedMeasureRow>): OrganizedMeasureRow {
  sequence += 1;
  return {
    subject_scope_key: `source_account:synthetic-ref-${sequence}`,
    row_seq: sequence,
    observation_id: 1000 + sequence,
    source_id: "synthetic-bank",
    source_account: `synthetic-bank:synthetic-${sequence}`,
    metric_id: "deposit.balance",
    unit_ref: "JPY",
    value_status: "exact",
    quantity_coefficient: String(1000 + sequence),
    quantity_scale: 0,
    state: "adopted",
    reason_code: null,
    freshness: "current",
    freshness_reason: null,
    as_of: "2026-11-18",
    account: `acc_${String(sequence).padStart(64, "0")}`,
    label: `合成普通預金 ${sequence}`,
    ...fields,
  };
}

/** The route's page around `cashPerAccount`, unpaged. */
function cashPage(rows: OrganizedMeasureRow[]): CashPerAccountPage {
  const answer = cashPerAccount(rows, false);
  return {
    schemaVersion: "snapshot-page-v1",
    collection: "cash",
    policyRelease: "known-assets-subtotal-v1",
    lines: answer.lines.map((entry) => entry.line),
    subtotals: answer.subtotals,
    leftOut: answer.leftOut,
    liabilitiesCoverage: "unknown",
    dataCoverage: answer.dataCoverage,
    page: {
      limit: 500,
      hasMore: false,
      nextCursor: null,
      snapshotId: "snapshot-synthetic",
      paginationVersion: "keyset-v2",
      lines: answer.lines.length,
    },
  };
}

describe("cash amounts and subtotals", () => {
  const valid = () =>
    cashPage([
      row({ unit_ref: "USD", quantity_coefficient: "1050", quantity_scale: 2 }),
      row({ unit_ref: "USD", quantity_coefficient: "-7", quantity_scale: 3 }),
      row({}),
    ]);

  test("the server's own page passes, trailing fraction zeros included", () => {
    const page = valid();
    expect(page.lines[0]!.references[0]!.amounts[0]).toMatchObject({ value: "10.50", scale: 2 });
    expect(validApiResponse(CASH, page)).toBe(true);
  });

  test("refuses an amount whose value is not decimal text at its scale", () => {
    for (const value of ["abc", "10.5", "1e3", "-0"]) {
      const page = valid();
      page.lines[0]!.references[0]!.amounts[0]!.value = value;
      expect(validApiResponse(CASH, page)).toBe(false);
    }
  });

  test("refuses a subtotal whose value is not decimal text at its scale", () => {
    for (const value of ["abc", "1e3", "1,000", "-0"]) {
      const byUnit = valid();
      byUnit.subtotals.byUnit[0] = { ...byUnit.subtotals.byUnit[0]!, value };
      expect(validApiResponse(CASH, byUnit)).toBe(false);
      const bySource = valid();
      bySource.subtotals.bySource[0] = { ...bySource.subtotals.bySource[0]!, value };
      expect(validApiResponse(CASH, bySource)).toBe(false);
    }
  });
});
