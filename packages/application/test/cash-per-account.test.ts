// Cash per account (ADR 0123, amendment 2026-11-20), on synthetic projection
// rows: one line per account entity however many provider references reach
// it, exact subtotals per unit and per source that never mix units, a unit
// with nothing counted has no value (never a zero), two adopted amounts of
// one unit on one account are never added (INV06), and every measurement
// that is not cash is counted under a closed reason. Every value is invented.
import { describe, expect, test } from "bun:test";
import {
  cashLeftOutReason,
  cashPageLines,
  cashPerAccount,
  type OrganizedMeasureRow,
} from "../src/query/cash-per-account.ts";
import {
  CASH_LEFT_OUT_REASONS,
  CASH_METRIC_IDS,
  CASH_REPORTED_TWICE,
  type CashLine,
  type CashPerAccountPage,
} from "../../observation-shared/src/api-contract.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { knownAssetMetricIds } from "../../read-model/src/index";
import { METRIC_REGISTRY } from "../../domain/src/metrics.ts";
import { DEFAULT_SUMMARY_PAGE_LIMIT } from "../../read-model/src/balance-projection-sql.ts";

let sequence = 0;
function row(fields: Partial<OrganizedMeasureRow>): OrganizedMeasureRow {
  sequence += 1;
  return {
    subject_scope_key: `source_account:synthetic-ref-${sequence}`,
    row_seq: sequence,
    observation_id: 1000 + sequence,
    source_id: "smbc-bank",
    source_account: `smbc-bank:synthetic-${sequence}`,
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

/** Every amount of a line, reference by reference. */
const amountsOf = (line: CashLine) => line.references.flatMap((reference) => reference.amounts);

/** The route's page around `cashPerAccount`, unpaged, for the validator. */
function page(rows: OrganizedMeasureRow[], behind = false): CashPerAccountPage {
  const answer = cashPerAccount(rows, behind);
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

describe("what counts as cash", () => {
  test("the cash metrics are exactly the known-assets subtotal's", () => {
    expect<string[]>([...CASH_METRIC_IDS]).toEqual(knownAssetMetricIds());
  });

  test("every other registry metric is left out under one closed reason", () => {
    const reasons = new Map<string, string[]>();
    for (const { definition } of METRIC_REGISTRY) {
      const reason = cashLeftOutReason(definition.metricId);
      if ((CASH_METRIC_IDS as readonly string[]).includes(definition.metricId)) {
        expect(reason).toBeNull();
        continue;
      }
      expect(CASH_LEFT_OUT_REASONS).toContain(reason!);
      reasons.set(reason!, [...(reasons.get(reason!) ?? []), definition.metricId]);
    }
    expect(cashLeftOutReason("unknown")).toBe("metric_unknown");
    expect(cashLeftOutReason("synthetic.not-in-the-registry")).toBe("metric_unknown");
    // The measures nearest to cash, each with the reason that keeps it out.
    expect(cashLeftOutReason("deposit.balance-after-transaction")).toBe("restates_a_balance");
    expect(cashLeftOutReason("exchange.cash-balance-after-cashflow")).toBe("restates_a_balance");
    expect(cashLeftOutReason("prestia.term-deposit-principal")).toBe("overlaps_another_measure");
    expect(cashLeftOutReason("bank.gross-asset-aggregate")).toBe("overlaps_another_measure");
    expect(cashLeftOutReason("bank.gross-loan-aggregate")).toBe("not_asset_positive");
    expect(cashLeftOutReason("deposit.available-balance")).toBe("not_a_stock");
    expect(cashLeftOutReason("broker.buying-power")).toBe("not_a_stock");
    expect(cashLeftOutReason("reward.bucket-balance")).toBe("not_currency");
    // `not_summable` describes no registry metric today; it is the closed
    // reason a later sum-disjoint-free asset stock would take.
    expect(reasons.has("not_summable")).toBe(false);
  });

  test("the scope's other measurements are counted per reason, never added", () => {
    const answer = cashPerAccount(
      [
        row({}),
        row({ metric_id: "deposit.balance-after-transaction", source_id: "sony-bank" }),
        row({ metric_id: "deposit.balance-after-transaction", source_id: "sony-bank" }),
        row({ metric_id: "broker.buying-power", source_id: "sbi-securities", unit_ref: "USD" }),
        row({ metric_id: "unknown", source_id: "vpass" }),
      ],
      false,
    );
    expect(answer.leftOut).toEqual([
      { reason: "metric_unknown", rows: 1, metrics: ["unknown"], moreMetrics: 0 },
      { reason: "not_a_stock", rows: 1, metrics: ["broker.buying-power"], moreMetrics: 0 },
      {
        reason: "restates_a_balance",
        rows: 2,
        metrics: ["deposit.balance-after-transaction"],
        moreMetrics: 0,
      },
    ]);
    expect(answer.lines).toHaveLength(1);
    expect(answer.subtotals.byUnit.map((entry) => entry.unit)).toEqual(["JPY"]);
  });
});

describe("lines and subtotals", () => {
  test("one line per account, subtotals per unit and per source, units never mixed", () => {
    const usd = row({
      source_id: "sbi-securities",
      metric_id: "broker.foreign-cash-deposit",
      unit_ref: "USD",
      quantity_coefficient: "12345",
      quantity_scale: 2,
    });
    // One broker account holds two units: it counts once in each.
    const aud = row({
      ...usd,
      row_seq: 900,
      observation_id: 9000,
      unit_ref: "AUD",
      quantity_coefficient: "5",
      quantity_scale: 1,
    });
    const deposits = [
      row({ quantity_coefficient: "100000" }),
      row({ quantity_coefficient: "2500", source_id: "mizuho-bank" }),
      row({ quantity_coefficient: "12", quantity_scale: 1 }),
    ];
    const answer = cashPerAccount([usd, aud, ...deposits], false);
    expect(answer.lines).toHaveLength(4);
    const broker = answer.lines.find((entry) => entry.line.account === usd.account)!.line;
    expect(broker.references.map((reference) => reference.source)).toEqual(["sbi-securities"]);
    expect(amountsOf(broker)).toEqual([
      expect.objectContaining({ unit: "AUD", value: "0.5", scale: 1, counted: true }),
      expect.objectContaining({ unit: "USD", value: "123.45", scale: 2, counted: true }),
    ]);
    expect(answer.subtotals.byUnit).toEqual([
      {
        unit: "AUD",
        value: "0.5",
        scale: 1,
        counted: 1,
        notCounted: 0,
        status: "complete",
        reasons: [],
      },
      {
        unit: "JPY",
        value: "102501.2",
        scale: 1,
        counted: 3,
        notCounted: 0,
        status: "complete",
        reasons: [],
      },
      {
        unit: "USD",
        value: "123.45",
        scale: 2,
        counted: 1,
        notCounted: 0,
        status: "complete",
        reasons: [],
      },
    ]);
    expect(
      answer.subtotals.bySource.map((entry) => [entry.source, entry.unit, entry.value]),
    ).toEqual([
      ["mizuho-bank", "JPY", "2500"],
      ["sbi-securities", "AUD", "0.5"],
      ["sbi-securities", "USD", "123.45"],
      ["smbc-bank", "JPY", "100001.2"],
    ]);
    // Lines are ordered by source, then label.
    expect(answer.lines.map((entry) => entry.line.references[0]!.source)).toEqual([
      "mizuho-bank",
      "sbi-securities",
      "smbc-bank",
      "smbc-bank",
    ]);
    expect(answer.dataCoverage).toEqual({ completeness: "complete", stale: false, reasons: [] });
    expect(validApiResponse("/api/v2/balances/cash", page([usd, aud, ...deposits]))).toBe(true);
  });

  test("an account reached through two provider references is one line and counts once", () => {
    const account = "acc_" + "a".repeat(64);
    const collector = row({ account, label: "合成口座", quantity_coefficient: "700" });
    // The importer's reference of the same account: the projection kept it
    // out as the same measurement through another route.
    const importer = row({
      account,
      label: "合成口座",
      quantity_coefficient: "700",
      state: "excluded",
      reason_code: "duplicate_evidence",
    });
    const answer = cashPerAccount([collector, importer], false);
    expect(answer.lines).toHaveLength(1);
    expect(
      amountsOf(answer.lines[0]!.line).map((amount) => [amount.counted, amount.reasons]),
    ).toEqual([
      [true, []],
      [false, ["adoption:duplicate_evidence"]],
    ]);
    expect(answer.subtotals.byUnit).toEqual([
      {
        unit: "JPY",
        value: "700",
        scale: 0,
        counted: 1,
        notCounted: 1,
        status: "complete",
        reasons: ["adoption:duplicate_evidence"],
      },
    ]);
  });

  test("an aggregate beside its members counts the members once", () => {
    const members = [row({ quantity_coefficient: "30" }), row({ quantity_coefficient: "70" })];
    const aggregate = row({
      quantity_coefficient: "100",
      state: "excluded",
      reason_code: "covered_by_breakdown",
    });
    const answer = cashPerAccount([...members, aggregate], false);
    expect(answer.subtotals.byUnit[0]).toMatchObject({
      value: "100",
      counted: 2,
      status: "complete",
    });
  });

  test("two adopted amounts of one unit on one account are both left uncounted, never added", () => {
    const account = "acc_" + "b".repeat(64);
    const first = row({ account, quantity_coefficient: "400" });
    const second = row({ account, quantity_coefficient: "400" });
    const other = row({ quantity_coefficient: "50" });
    const answer = cashPerAccount([first, second, other], false);
    const line = answer.lines.find((entry) => entry.line.account === account)!.line;
    expect(amountsOf(line).map((amount) => [amount.counted, amount.reasons])).toEqual([
      [false, [CASH_REPORTED_TWICE]],
      [false, [CASH_REPORTED_TWICE]],
    ]);
    expect(answer.subtotals.byUnit).toEqual([
      {
        unit: "JPY",
        value: "50",
        scale: 0,
        counted: 1,
        notCounted: 2,
        status: "partial",
        reasons: [CASH_REPORTED_TWICE],
      },
    ]);
    expect(answer.dataCoverage.completeness).toBe("partial");
    expect(answer.dataCoverage.reasons).toContain(CASH_REPORTED_TWICE);
  });

  test("one provider reference adopted twice in one unit is not added either (the subtotal's own key)", () => {
    const subject = "source_account:synthetic-shared";
    const answer = cashPerAccount(
      [
        row({ subject_scope_key: subject, account: null, label: null }),
        row({ subject_scope_key: subject, account: null, label: null }),
      ],
      false,
    );
    expect(answer.lines).toHaveLength(1);
    expect(answer.subtotals.byUnit[0]).toMatchObject({ value: null, counted: 0, notCounted: 2 });
  });

  test("a value that is not exact, an unresolved overlap or a stale one is a reason, never a zero", () => {
    const unparsed = row({
      unit_ref: "EUR",
      source_id: "sbi-securities",
      metric_id: "broker.foreign-cash-deposit",
      value_status: "unparsed",
      quantity_coefficient: null,
      quantity_scale: null,
      state: "unresolved",
      reason_code: "value_not_exact",
    });
    const overlap = row({ state: "unresolved", reason_code: "unknown_overlap" });
    const stale = row({
      state: "stale",
      reason_code: "no_new_observation",
      freshness: "stale",
      freshness_reason: "no_new_observation",
    });
    const counted = row({ quantity_coefficient: "9" });
    const answer = cashPerAccount([unparsed, overlap, stale, counted], false);
    const amounts = answer.lines.flatMap((entry) => amountsOf(entry.line));
    expect(amounts.find((amount) => amount.unit === "EUR")).toMatchObject({
      value: null,
      scale: null,
      status: "unparsed",
      adoption: "unresolved",
      counted: false,
      reasons: ["adoption:value_not_exact"],
    });
    expect(answer.subtotals.byUnit).toEqual([
      // Nothing counted: no value, never "0".
      {
        unit: "EUR",
        value: null,
        scale: null,
        counted: 0,
        notCounted: 1,
        status: "partial",
        reasons: ["adoption:value_not_exact"],
      },
      {
        unit: "JPY",
        value: "9",
        scale: 0,
        counted: 1,
        notCounted: 2,
        status: "partial",
        reasons: [
          "adoption:no_new_observation",
          "adoption:unknown_overlap",
          "freshness:no_new_observation",
        ],
      },
    ]);
    expect(answer.dataCoverage).toEqual({
      completeness: "partial",
      stale: true,
      reasons: [
        "freshness:stale",
        "stale:no_new_observation",
        "unresolved:unknown_overlap",
        "unresolved:value_not_exact",
      ],
    });
    expect(
      validApiResponse("/api/v2/balances/cash", page([unparsed, overlap, stale, counted])),
    ).toBe(true);
  });

  test("a snapshot behind CORE makes the coverage partial, as on the latest page", () => {
    const answer = cashPerAccount([row({})], true);
    expect(answer.dataCoverage).toEqual({
      completeness: "partial",
      stale: true,
      reasons: ["snapshot:behind_published_evidence"],
    });
  });

  test("an empty scope has no line, no subtotal and no zero", () => {
    const answer = cashPerAccount([], false);
    expect(answer.lines).toEqual([]);
    expect(answer.subtotals).toEqual({ byUnit: [], bySource: [] });
    expect(validApiResponse("/api/v2/balances/cash", page([]))).toBe(true);
  });
});

describe("the validator", () => {
  const valid = () => page([row({}), row({ state: "unresolved", reason_code: "unknown_overlap" })]);

  test("refuses a counted amount that is not adopted, a zero subtotal and a reasonless partial", () => {
    expect(validApiResponse("/api/v2/balances/cash", valid())).toBe(true);
    const notAdopted = valid();
    amountsOf(notAdopted.lines[1]!)[0]!.counted = true;
    expect(validApiResponse("/api/v2/balances/cash", notAdopted)).toBe(false);
    const zero = valid();
    zero.subtotals.byUnit[0] = { ...zero.subtotals.byUnit[0]!, counted: 0, value: "0", scale: 0 };
    expect(validApiResponse("/api/v2/balances/cash", zero)).toBe(false);
    const reasonless = valid();
    reasonless.subtotals.byUnit[0] = { ...reasonless.subtotals.byUnit[0]!, reasons: [] };
    expect(validApiResponse("/api/v2/balances/cash", reasonless)).toBe(false);
    const silent = valid();
    amountsOf(silent.lines[1]!)[0]!.reasons = [];
    expect(validApiResponse("/api/v2/balances/cash", silent)).toBe(false);
    const netWorth = { ...valid(), netWorth: "1" };
    expect(validApiResponse("/api/v2/balances/cash", netWorth)).toBe(false);
  });
});

describe("size", () => {
  /** The default first page (`DEFAULT_SUMMARY_PAGE_LIMIT` measurements), in bytes. */
  function firstPageBytes(rows: OrganizedMeasureRow[]): number {
    const full = page(rows);
    const lines = cashPageLines(cashPerAccount(rows, false).lines, 0, DEFAULT_SUMMARY_PAGE_LIMIT);
    const first: CashPerAccountPage = {
      ...full,
      lines: lines.map((entry) => entry.line),
      page: { ...full.page, limit: DEFAULT_SUMMARY_PAGE_LIMIT, hasMore: true, nextCursor: "c" },
    };
    expect(validApiResponse("/api/v2/balances/cash", first)).toBe(true);
    return new TextEncoder().encode(JSON.stringify(first)).length;
  }

  const SOURCES = [
    "sbi-shinsei-bank",
    "smbc-bank",
    "mizuho-bank",
    "sbi-vc-trade",
    "sbi-securities",
  ];
  const CURRENCIES = ["JPY", "USD", "AUD", "EUR"];

  /**
   * `lines` accounts, each its own (a 64-hex entity, a 20-character Japanese
   * label, a 48-character provider key), spread over five sources; one in
   * `brokerEvery` a broker account with four currencies; every other amount
   * stale with two reasons; and every registry metric that is not cash in
   * the scope.
   */
  function store(lines: number, brokerEvery: number): OrganizedMeasureRow[] {
    const rows: OrganizedMeasureRow[] = [];
    for (let index = 0; index < lines; index += 1) {
      const broker = index % brokerEvery === 0;
      const source = broker ? "sbi-securities" : SOURCES[index % 4]!;
      const base = {
        subject_scope_key: `source_account:synthetic-ref-${String(index)}`,
        source_id: source,
        source_account: `${source}:${"synthetic-ordinary-0000".padEnd(47 - source.length, "0")}`,
        account: `acc_${index.toString(16).padStart(64, "f")}`,
        label: "合成普通預金".padEnd(20, "円"),
        metric_id: broker ? "broker.foreign-cash-deposit" : "deposit.balance",
        quantity_coefficient: "123456789012",
        quantity_scale: 2,
      };
      for (const [position, unit] of (broker ? CURRENCIES : ["JPY"]).entries()) {
        const stale = (index + position) % 2 === 0;
        rows.push(
          row({
            ...base,
            unit_ref: unit,
            ...(stale
              ? {
                  state: "stale",
                  reason_code: "no_new_observation",
                  freshness: "stale",
                  freshness_reason: "no_new_observation",
                }
              : {}),
          }),
        );
      }
    }
    for (const { definition } of METRIC_REGISTRY)
      if (cashLeftOutReason(definition.metricId) !== null)
        rows.push(row({ metric_id: definition.metricId }));
    return rows;
  }

  test("a default page of the realistic store stays under the 8 KB a client shows", () => {
    // Thirty accounts, every fifth a four-currency broker account: two of
    // them on the first page, eight one-currency deposit accounts.
    const size = firstPageBytes(store(30, 5));
    console.log(`cash page, realistic store: ${String(size)} bytes`);
    expect(size).toBeLessThan(8 * 1024);
  });

  test("a page of one-unit accounts and a page of four-currency accounts both stay under it", () => {
    const deposits = firstPageBytes(store(30, 1_000));
    const brokers = firstPageBytes(store(30, 1));
    console.log(
      `cash page, deposits only: ${String(deposits)} bytes; brokers only: ${String(brokers)} bytes`,
    );
    expect(deposits).toBeLessThan(8 * 1024);
    expect(brokers).toBeLessThan(8 * 1024);
  });

  test("a page holds whole lines up to its measurements; a longer line is a page alone", () => {
    const lines = cashPerAccount(store(6, 2), false).lines;
    // Lines of 4, 1, 4, 1, 4, 1 measurements (sorted by source and label).
    const counts = lines.map((entry) =>
      entry.line.references.reduce((sum, reference) => sum + reference.amounts.length, 0),
    );
    let start = 0;
    const pages: number[][] = [];
    while (start < lines.length) {
      const taken = cashPageLines(lines, start, 5);
      pages.push(taken.map((entry) => counts[lines.indexOf(entry)]!));
      start += taken.length;
    }
    for (const taken of pages)
      expect(taken.length === 1 || taken.reduce((sum, count) => sum + count, 0) <= 5).toBe(true);
    expect(pages.flat()).toEqual(counts);
    expect(cashPageLines(lines, 0, 1)).toHaveLength(1);
  });
});
