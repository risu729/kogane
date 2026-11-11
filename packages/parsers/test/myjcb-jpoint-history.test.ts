import { describe, expect, test } from "bun:test";
import {
  readJPointHistory,
  jpointExpiry,
  type JPointHistory,
} from "../../domain/src/myjcb-jpoint-history.ts";
import { myJcbJPointHistory as parser } from "../src/parsers/myjcb-jpoint-history.ts";
import type { ArtifactMeta } from "../src/types.ts";
const history = (): JPointHistory => ({
  schemaVersion: "myjcb-jpoint-history-v1",
  reportedTotal: "100",
  rows: [
    {
      acquiredOn: "2099-01-15",
      paymentText: "(2/10)",
      earned: "90",
      used: "-70",
      expired: "0",
      remaining: "60",
      normal: "60",
      preferential: "10",
      bonus: "20",
      expiryMonth: "2099-06",
      status: "有効",
    },
    {
      acquiredOn: "2098-12-15",
      paymentText: "(1/10)",
      earned: "80",
      used: "-20",
      expired: "-10",
      remaining: "40",
      normal: "50",
      preferential: "10",
      bonus: "20",
      expiryMonth: "2099-05",
      status: "有効",
    },
    {
      acquiredOn: "2098-11-15",
      paymentText: "(-)",
      earned: "10",
      used: "0",
      expired: "0",
      remaining: "0",
      normal: "10",
      preferential: "0",
      bonus: "0",
      expiryMonth: null,
      status: "-",
    },
  ],
});
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "myjcb",
  dataset: "jpoint-history",
  artifactKey: "synthetic/jpoint-history.json",
  fetchUnitKey: "synthetic:j-point-history",
  runStatus: "success",
  runFailureCount: 0,
  url: null,
  mime: "application/json",
  fetchedAt: "2099-02-01T00:00:00Z",
  sha256: "a".repeat(64),
};
const parse = (value: unknown = history(), overrides: Partial<ArtifactMeta> = {}) =>
  parser.parse(new TextEncoder().encode(JSON.stringify(value)), { ...meta, ...overrides });
describe("observed MyJCB acquisition-month measures", () => {
  test("keeps monthly activity apart from acquisition-stock and payment-month metadata", () => {
    const result = parse();
    expect(result.observations).toHaveLength(12);
    expect(
      result.observations
        .slice(0, 4)
        .map((row) => row.kind === "balance" && [row.metric, row.amountText]),
    ).toEqual([
      ["jpoint_acquisition_earned", "90"],
      ["jpoint_acquisition_used", "-70"],
      ["jpoint_acquisition_expired", "0"],
      ["jpoint_acquisition_remaining", "60"],
    ]);
    expect(
      result.observations.every(
        (row) => row.asOf === undefined && row.observedAt === meta.fetchedAt,
      ),
    ).toBe(true);
    expect(result.observations[3]?.extra._kogane).toMatchObject({
      paymentMonthText: "(2/10)",
      historyBucketCount: 3,
      reportedHistoryTotal: "100",
      observedExpiry: {
        kind: "period",
        start: "2099-06",
        end: "2099-06",
        endExclusive: false,
        granularity: "month",
      },
    });
  });
  test("zero remains exact without a fabricated expiry day", () => {
    expect(jpointExpiry(history().rows[2]!)).toEqual({
      kind: "unknown",
      reasonCode: "zero_bucket_expiry_not_displayed",
    });
    expect(parse().observations[11]).toMatchObject({ amountText: "0" });
  });
  test("rejects unknown fields, duplicate buckets, invalid dates, missing positive expiry and total mismatch", () => {
    const base = history();
    const mutate = (fn: (value: JPointHistory) => void) => {
      const value = history();
      fn(value);
      return value;
    };
    for (const value of [
      { ...base, extra: true },
      { ...base, rows: [] },
      mutate((v) => {
        v.reportedTotal = "101";
      }),
      mutate((v) => {
        v.rows[1]!.acquiredOn = v.rows[0]!.acquiredOn;
      }),
      mutate((v) => {
        v.rows[0]!.acquiredOn = "2099-02-30";
      }),
      mutate((v) => {
        v.rows[0]!.expiryMonth = null;
      }),
      mutate((v) => {
        v.rows[0]!.expiryMonth = "2099-13";
      }),
      mutate((v) => {
        v.rows[0]!.remaining = "-60";
      }),
      mutate((v) => {
        v.rows[0]!.status = "-";
      }),
      mutate((v) => {
        v.rows[0]!.used = "-0";
      }),
      mutate((v) => {
        v.rows[0]!.normal = "61";
      }),
    ])
      expect(() => readJPointHistory(value)).toThrow();
  });
  test("requires the independently sealed history unit and exact dataset", () => {
    expect(() => parse(history(), { fetchUnitKey: "synthetic:j-point" })).toThrow();
    expect(() => parse(history(), { runStatus: "partial" })).toThrow();
    expect(() =>
      parse(history(), { runStatus: "partial", unitScopeEligibility: "unit-independent-v1" }),
    ).not.toThrow();
    expect(() => parse(history(), { period: "2099-01" })).toThrow();
  });
});
