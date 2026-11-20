// The reward expiry window and summary (src/query/reward-expiry-window.ts,
// ADR 0049 amendment of 2026-11-19) over synthetic READ rows and provider
// sections. Every programme, holding, bucket, amount and date is invented.
import { describe, expect, test } from "bun:test";
import type { RewardProviderExpirySection } from "../../domain/src/reward-expiry-observations.ts";
import type { Quantity } from "../../domain/src/values.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import type { RewardExpirySummary } from "../../observation-shared/src/reward-contract.ts";
import {
  parseRewardExpiryWindow,
  REWARD_EXPIRY_SUMMARY_BUCKET_LINES,
  REWARD_EXPIRY_SUMMARY_DISPLAY_LINES,
  type RewardExpiryWindowRow,
  rewardExpirySummary,
  rowsInRewardExpiryWindow,
  tokyoToday,
  windowPlace,
} from "../src/query/reward-expiry-window.ts";

const SNAPSHOT: RewardExpirySummary["snapshot"] = {
  snapshotId: "a".repeat(64),
  evaluatedAt: "2026-11-10T00:00:00.000Z",
  evaluationCalendar: "UTC:start-of-day:assumed",
  ruleSetDigest: "b".repeat(64),
  ruleCount: 4,
  claimsRelease: "synthetic-claims",
  claimsHighWater: 7,
  release: "synthetic-release",
};

/** Noon in Tokyo on a synthetic day. */
const NOON_20 = Date.parse("2026-11-20T03:00:00.000Z");

function exact(unitRef: string, coefficient: string, scale = 0): Quantity {
  return {
    unitRef,
    value: { status: "exact", value: { coefficient, scale }, normalizationVersion: "decimal-v1" },
  };
}

function unparsed(unitRef: string): Quantity {
  return { unitRef, value: { status: "unparsed", reasonCode: "decimal-v1:unparsed" } };
}

let sequence = 0;
function row(
  bucketRef: string,
  expiresOn: string | null,
  quantity: Quantity,
  options: Partial<RewardExpiryWindowRow> = {},
): RewardExpiryWindowRow {
  return {
    rowSeq: sequence++,
    programId: "program:synthetic-a",
    holdingRef: "program:synthetic-a:member",
    bucketRef,
    bucketKind: "restricted",
    basis: expiresOn === null ? "unknown" : "provider-observed",
    expiresOn,
    quantity,
    ...options,
  };
}

/** The same bucket under the programme's two rules, as the READ build writes it. */
function twoRules(bucketRef: string, expiresOn: string | null, quantity: Quantity) {
  return [row(bucketRef, expiresOn, quantity), row(bucketRef, expiresOn, quantity)];
}

function window(from: string | null, before: string | null, now = NOON_20) {
  const parsed = parseRewardExpiryWindow(from, before, now);
  if (!parsed.ok || parsed.window === null) throw new Error("synthetic window refused");
  return parsed.window;
}

function section(
  holdingRef: string,
  metadata: Pick<RewardProviderExpirySection, "coverage" | "reasonCode" | "displays">,
): RewardProviderExpirySection {
  return {
    ...metadata,
    programId: "program:synthetic-b",
    holdingRef,
    parentBucketRef: `${holdingRef}:total`,
    unitRef: "points:synthetic-b",
    observedAt: { kind: "instant", value: "2026-11-09T00:00:00Z", basis: "provider" } as never,
    sourceFactRefs: ["balance:1"],
  };
}

function display(displayRef: string, date: string | null, quantity: Quantity) {
  return {
    displayRef,
    scope: "holding-subset" as const,
    quantity,
    expires:
      date === null
        ? ({ kind: "unknown", reasonCode: "provider_expiry_unparsed" } as never)
        : ({ kind: "local-date", value: date, zone: "Asia/Tokyo", basis: "provider" } as never),
    rawLocator: "json:$.synthetic",
  };
}

describe("the expiry window", () => {
  test("today is the Asia/Tokyo date, which changes at Tokyo midnight, not UTC midnight", () => {
    expect(tokyoToday(Date.parse("2026-11-30T14:59:59.999Z"))).toBe("2026-11-30");
    expect(tokyoToday(Date.parse("2026-11-30T15:00:00.000Z"))).toBe("2026-12-01");
    // 00:00 to 09:00 JST the UTC date is still the previous day.
    expect(tokyoToday(Date.parse("2026-12-01T08:59:59.999Z"))).toBe("2026-12-01");
  });

  test("names no window without either bound, and defaults `from` to today", () => {
    expect(parseRewardExpiryWindow(null, null, NOON_20)).toEqual({ ok: true, window: null });
    expect(parseRewardExpiryWindow(null, "2026-12-01", NOON_20)).toEqual({
      ok: true,
      window: {
        from: "2026-11-20",
        before: "2026-12-01",
        fromBasis: "today",
        today: "2026-11-20",
        calendar: "Asia/Tokyo",
      },
    });
    expect(parseRewardExpiryWindow("2026-11-01", null, NOON_20)).toEqual({
      ok: true,
      window: {
        from: "2026-11-01",
        before: null,
        fromBasis: "request",
        today: "2026-11-20",
        calendar: "Asia/Tokyo",
      },
    });
  });

  test("refuses a value that is not a calendar date, and a window with no day", () => {
    for (const bad of ["2026-02-30", "2026-1-01", "2026-11-19T00:00", "20261119", "2026-13-01"]) {
      expect(parseRewardExpiryWindow(bad, null, NOON_20)).toEqual({
        ok: false,
        refusal: "invalid_date",
      });
      expect(parseRewardExpiryWindow(null, bad, NOON_20)).toEqual({
        ok: false,
        refusal: "invalid_date",
      });
    }
    for (const [from, before] of [
      ["2026-12-01", "2026-12-01"],
      ["2026-12-02", "2026-12-01"],
      // `from` defaults to today (2026-11-20): `before` today has no day.
      [null, "2026-11-20"],
      [null, "2026-11-19"],
    ] as const)
      expect(parseRewardExpiryWindow(from, before, NOON_20)).toEqual({
        ok: false,
        refusal: "invalid_date_range",
      });
    // One day is a window.
    expect(parseRewardExpiryWindow(null, "2026-11-21", NOON_20).ok).toBe(true);
  });

  test("`from` is inclusive and `before` exclusive", () => {
    const w = window("2026-11-20", "2026-12-01");
    expect(windowPlace("2026-11-19", w)).toBe("before-window");
    expect(windowPlace("2026-11-20", w)).toBe("in-window");
    expect(windowPlace("2026-11-30", w)).toBe("in-window");
    expect(windowPlace("2026-12-01", w)).toBe("after-window");
    expect(windowPlace("2000-01-01", null)).toBe("in-window");
    expect(windowPlace("2999-12-31", window("2026-11-20", null))).toBe("in-window");
  });

  test("the default `from` moves at Tokyo midnight", () => {
    const before = window(null, "2026-12-31", Date.parse("2026-11-30T14:59:59.999Z"));
    const after = window(null, "2026-12-31", Date.parse("2026-11-30T15:00:00.000Z"));
    // A deadline on 2026-11-30 is inside the window until 23:59:59 JST that day.
    expect(windowPlace("2026-11-30", before)).toBe("in-window");
    expect(windowPlace("2026-11-30", after)).toBe("before-window");
  });

  test("a full page keeps the rows inside, in order, and counts a row with no date apart", () => {
    const rows = [
      row("a", "2026-11-19", exact("p", "1")),
      row("b", "2026-11-20", exact("p", "2")),
      row("c", null, exact("p", "3")),
      row("d", "2026-12-01", exact("p", "4")),
      row("e", "2026-11-30", exact("p", "5")),
      row("f", null, unparsed("p")),
    ];
    const result = rowsInRewardExpiryWindow(
      rows,
      window("2026-11-20", "2026-12-01"),
      (entry) => entry.expiresOn,
    );
    expect(result.rows.map((entry) => entry.bucketRef)).toEqual(["b", "e"]);
    expect(result.counts).toEqual({
      inWindow: 2,
      beforeWindow: 1,
      afterWindow: 1,
      leftOut: [{ reasonCode: "deadline_unknown", count: 2 }],
    });
  });
});

describe("the expiry summary", () => {
  test("counts a bucket once, not once per rule, and adds exact decimals", () => {
    const summary = rewardExpirySummary(
      [
        ...twoRules("slot-1", "2026-11-25", exact("points:synthetic-a", "1500")),
        ...twoRules("slot-2", "2026-11-28", exact("points:synthetic-a", "125", 1)),
        ...twoRules("slot-3", "2026-12-15", exact("points:synthetic-a", "999")),
      ],
      [],
      window(null, "2026-12-01"),
      SNAPSHOT,
    );
    expect(summary.programs).toEqual([
      {
        programId: "program:synthetic-a",
        unitRef: "points:synthetic-a",
        buckets: 2,
        // 1500 + 12.5, each bucket once (two rows each).
        total: { status: "exact", value: "1512.5" },
        lines: [
          {
            holdingRef: "program:synthetic-a:member",
            bucketRef: "slot-1",
            kind: "restricted",
            expiresOn: "2026-11-25",
            basis: "provider-observed",
            amount: { status: "exact", value: "1500" },
          },
          {
            holdingRef: "program:synthetic-a:member",
            bucketRef: "slot-2",
            kind: "restricted",
            expiresOn: "2026-11-28",
            basis: "provider-observed",
            amount: { status: "exact", value: "12.5" },
          },
        ],
      },
    ]);
    expect(summary.counts.buckets).toEqual({
      inWindow: 2,
      beforeWindow: 0,
      afterWindow: 1,
      leftOut: [],
    });
    expect(validApiResponse("/api/v2/rewards/expiry", summary)).toBe(true);
  });

  test("leaves out a bucket with no date or with different dates by rule, and says why", () => {
    const summary = rewardExpirySummary(
      [
        ...twoRules("undated-1", null, exact("points:synthetic-a", "10")),
        ...twoRules("undated-2", null, unparsed("points:synthetic-a")),
        row("split", "2026-11-25", exact("points:synthetic-a", "20")),
        row("split", null, exact("points:synthetic-a", "20"), { basis: "unknown" }),
        row("apart", "2026-11-25", exact("points:synthetic-a", "30"), {
          basis: "policy-estimated",
        }),
        row("apart", "2026-11-26", exact("points:synthetic-a", "30"), {
          basis: "policy-estimated",
        }),
        ...twoRules("kept", "2026-11-25", exact("points:synthetic-a", "40")),
      ],
      [],
      window(null, "2026-12-01"),
      SNAPSHOT,
    );
    expect(summary.counts.buckets).toEqual({
      inWindow: 1,
      beforeWindow: 0,
      afterWindow: 0,
      leftOut: [
        { reasonCode: "deadline_unknown", count: 2 },
        { reasonCode: "deadline_differs_by_rule", count: 2 },
      ],
    });
    // Only the dated bucket is added: nothing undated becomes a zero or a date.
    expect(summary.programs).toMatchObject([
      { buckets: 1, total: { status: "exact", value: "40" } },
    ]);
  });

  test("a total with an amount that is not exact has no value, never a partial sum or zero", () => {
    const summary = rewardExpirySummary(
      [
        ...twoRules("exact", "2026-11-25", exact("points:synthetic-a", "100")),
        ...twoRules("unparsed", "2026-11-26", unparsed("points:synthetic-a")),
        ...twoRules("invalid", "2026-11-27", exact("points:synthetic-a", "1.5")),
        ...twoRules("missing", "2026-11-28", {
          unitRef: "points:synthetic-a",
          value: { status: "missing", reasonCode: "decimal-v1:missing" },
        }),
      ],
      [],
      window(null, "2026-12-01"),
      SNAPSHOT,
    );
    const [program] = summary.programs;
    expect(program!.total).toEqual({
      status: "not-exact",
      value: null,
      reasonCodes: [
        "missing:decimal-v1:missing",
        "unparsed:decimal-v1:invalid",
        "unparsed:decimal-v1:unparsed",
      ],
    });
    expect(program!.lines.map((line) => line.amount)).toEqual([
      { status: "exact", value: "100" },
      { status: "unparsed", value: null, reasonCode: "decimal-v1:unparsed" },
      // "1.5" is not a decimal-v1 coefficient: never shown or added as exact.
      { status: "unparsed", value: null, reasonCode: "decimal-v1:invalid" },
      { status: "missing", value: null, reasonCode: "decimal-v1:missing" },
    ]);
    expect(validApiResponse("/api/v2/rewards/expiry", summary)).toBe(true);
  });

  test("never adds two units: a programme with two units has two totals", () => {
    const summary = rewardExpirySummary(
      [
        ...twoRules("points", "2026-11-25", exact("points:synthetic-a", "300")),
        row("yen-1", "2026-11-26", exact("JPY", "500")),
        row("yen-2", "2026-11-27", exact("JPY", "250")),
        row("other", "2026-11-25", exact("points:synthetic-c", "7"), {
          programId: "program:synthetic-c",
          holdingRef: "program:synthetic-c:member",
        }),
      ],
      [],
      window(null, "2026-12-01"),
      SNAPSHOT,
    );
    expect(
      summary.programs.map((program) => [program.programId, program.unitRef, program.total]),
    ).toEqual([
      ["program:synthetic-a", "JPY", { status: "exact", value: "750" }],
      ["program:synthetic-a", "points:synthetic-a", { status: "exact", value: "300" }],
      ["program:synthetic-c", "points:synthetic-c", { status: "exact", value: "7" }],
    ]);
  });

  test("lists the earliest lines up to the limit, and totals every bucket inside", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(
        `slot-${String(index).padStart(2, "0")}`,
        `2026-12-${String(31 - (index % 30)).padStart(2, "0")}`,
        exact("points:synthetic-a", "10"),
      ),
    );
    const summary = rewardExpirySummary(rows, [], window("2026-12-01", null), SNAPSHOT);
    const [program] = summary.programs;
    expect(program!.buckets).toBe(40);
    expect(program!.total).toEqual({ status: "exact", value: "400" });
    expect(program!.lines).toHaveLength(REWARD_EXPIRY_SUMMARY_BUCKET_LINES);
    const dates = program!.lines.map((line) => line.expiresOn);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe("2026-12-02");
    expect(summary.lineLimit).toEqual({
      buckets: REWARD_EXPIRY_SUMMARY_BUCKET_LINES,
      providerDisplays: REWARD_EXPIRY_SUMMARY_DISPLAY_LINES,
    });
  });

  test("without a window every dated bucket is inside, and undated ones are still counted", () => {
    const summary = rewardExpirySummary(
      [
        ...twoRules("past", "2020-01-01", exact("points:synthetic-a", "1")),
        ...twoRules("future", "2030-01-01", exact("points:synthetic-a", "2")),
        ...twoRules("undated", null, exact("points:synthetic-a", "3")),
      ],
      [],
      null,
      SNAPSHOT,
    );
    expect(summary.window).toBeNull();
    expect(summary.programs[0]!.total).toEqual({ status: "exact", value: "3" });
    expect(summary.counts.buckets.leftOut).toEqual([{ reasonCode: "deadline_unknown", count: 1 }]);
  });

  test("lists provider-displayed portions apart, never added, and counts the rest by reason", () => {
    const summary = rewardExpirySummary(
      [...twoRules("slot-1", "2026-11-25", exact("points:synthetic-a", "100"))],
      [
        section("program:synthetic-b:card-1", {
          coverage: "observed",
          reasonCode: null,
          displays: [
            display("expiring-1", "2026-11-30", exact("points:synthetic-b", "200")),
            display("expiring-2", "2027-03-31", exact("points:synthetic-b", "50")),
            display("expiring-3", null, exact("points:synthetic-b", "70")),
          ],
        }),
        section("program:synthetic-b:card-2", {
          coverage: "not-displayed",
          reasonCode: "provider_expiry_not_displayed",
          displays: [],
        }),
        section("program:synthetic-b:card-3", {
          coverage: "unknown",
          reasonCode: "provider_expiry_unavailable",
          displays: [],
        }),
      ],
      window(null, "2026-12-01"),
      SNAPSHOT,
    );
    expect(summary.providerDisplays).toEqual([
      {
        programId: "program:synthetic-b",
        holdingRef: "program:synthetic-b:card-1",
        parentBucketRef: "program:synthetic-b:card-1:total",
        displayRef: "expiring-1",
        unitRef: "points:synthetic-b",
        expiresOn: "2026-11-30",
        amount: { status: "exact", value: "200" },
      },
    ]);
    expect(summary.counts.providerDisplays).toEqual({
      inWindow: 1,
      beforeWindow: 0,
      afterWindow: 1,
      leftOut: [
        { reasonCode: "display_date_unknown", count: 1 },
        { reasonCode: "provider_expiry_not_displayed", count: 1 },
        { reasonCode: "provider_expiry_unavailable", count: 1 },
      ],
    });
    // The portion is a part of a displayed total: no programme total names it.
    expect(summary.programs.map((program) => program.programId)).toEqual(["program:synthetic-a"]);
    expect(validApiResponse("/api/v2/rewards/expiry", summary)).toBe(true);
  });

  test("a full window at production-shaped refs stays under 8 KB", () => {
    // Refs shaped like the promotion's (`program:<id>:<source account>`),
    // with invented slots; more lines than the limit, three programmes and
    // more displays than the display limit.
    const rows: RewardExpiryWindowRow[] = [];
    for (let index = 0; index < 60; index += 1)
      rows.push(
        ...twoRules(
          `program:v-point:v-point:store-limited:synthetic-slot-${String(index).padStart(3, "0")}`,
          `2026-12-${String((index % 28) + 1).padStart(2, "0")}`,
          exact("points:v-point", String(123_456 + index)),
        ).map((entry) => ({
          ...entry,
          programId: "program:v-point",
          holdingRef: "program:v-point:member",
          bucketKind: "unclassified",
        })),
      );
    for (const program of ["program:v-point-pay", "program:mobile-suica-sf"])
      rows.push(
        row(`${program}:synthetic-balance`, "2026-12-20", unparsed("JPY"), {
          programId: program,
          holdingRef: `${program}:synthetic-holding`,
          bucketKind: "regular",
        }),
      );
    const sections = Array.from({ length: 8 }, (_, index) =>
      section(`program:j-point:myjcb:synthetic-connection-${String(index)}:j-point:total`, {
        coverage: "observed",
        reasonCode: null,
        displays: [
          display("total-expiring-subset", "2026-12-31", exact("points:synthetic-b", "98765")),
        ],
      }),
    );
    const summary = rewardExpirySummary(
      rows,
      sections,
      window("2026-12-01", "2027-01-01"),
      SNAPSHOT,
    );
    expect(validApiResponse("/api/v2/rewards/expiry", summary)).toBe(true);
    const bytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: "kogane-page-read-v1", data: summary }),
    ).length;
    // Measured at 6,875 bytes when the limits were set (ADR 0049 amendment).
    expect(bytes).toBeLessThan(8192);
    expect(summary.programs.reduce((sum, program) => sum + program.lines.length, 0)).toBe(
      REWARD_EXPIRY_SUMMARY_BUCKET_LINES,
    );
    expect(summary.providerDisplays).toHaveLength(REWARD_EXPIRY_SUMMARY_DISPLAY_LINES);
  });
});
