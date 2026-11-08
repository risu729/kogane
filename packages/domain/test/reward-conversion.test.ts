import { expect, test } from "bun:test";
import { findConversionPaths, simulateConversion } from "../src/reward-conversion.ts";
import type { ConversionOffer, MembershipState, OfferValidity } from "../src/rewards.ts";
import type { LocalDateValue, TemporalValue } from "../src/time.ts";
import { decimalLiteral, decimalToString, exactQuantity, ROUNDING_MODES } from "../src/values.ts";

const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});
const quantity = (value: number, unit = "points:a") =>
  exactQuantity(unit, decimalLiteral(String(value)));

function offer(overrides: Partial<ConversionOffer> = {}): ConversionOffer {
  return {
    offerId: "offer:a-b",
    version: "v1",
    sourceProgramRef: "program:a",
    destinationProgramRef: "program:b",
    fromUnitRef: "points:a",
    toUnitRef: "points:b",
    ratio: { numerator: "1", denominator: "1" },
    minimum: decimalLiteral("1"),
    increment: decimalLiteral("1"),
    maximumPerRequest: null,
    sharedQuotaRef: null,
    fixedFees: [],
    variableFeePolicyRef: null,
    eligibilityPolicyRef: "policy:eligibility",
    eligibleBucketKinds: ["regular"],
    eligibleRestrictionRefs: [],
    eligibleTiers: null,
    validTime: {
      kind: "period",
      start: "2026-01-01",
      end: "2026-12-31",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    },
    applicationDeadline: day("2026-12-31"),
    processingPolicyRef: "policy:processing",
    processingDays: 0,
    roundingPolicyRef: "policy:rounding",
    rounding: { scale: 0, mode: "down" },
    cancellationPolicyRef: null,
    evidenceRefs: ["evidence:synthetic"],
    verification: "verified",
    ...overrides,
  };
}

// An independent integer lattice oracle: rank the two adjacent representable
// answers by distance, direction and parity rather than running decimal arithmetic.
function rounded(n: number, d: number, mode: (typeof ROUNDING_MODES)[number]): number {
  const lower = Math.floor(n / d);
  const upper = Math.ceil(n / d);
  if (mode === "down" || mode === "floor") return lower;
  if (mode === "up" || mode === "ceiling") return upper;
  const left = n - lower * d;
  const right = upper * d - n;
  if (left < right) return lower;
  if (right < left) return upper;
  return mode === "half-up" ? upper : lower % 2 === 0 ? lower : upper;
}

test("all 24,300 bounded amount-policy combinations match the integer oracle", () => {
  let cases = 0;
  for (let balance = 0; balance <= 8; balance++)
    for (let increment = 1; increment <= 3; increment++)
      for (let minimum = 0; minimum <= 4; minimum++)
        for (const cap of [null, 0, 1, 2, 3, 4, 5, 6, 7, 8])
          for (const [numerator, denominator] of [
            [1, 1],
            [1, 2],
            [2, 3],
          ] as const)
            for (const mode of ROUNDING_MODES) {
              cases++;
              const permitted = Math.min(balance, cap ?? balance);
              // Enumerate admissible whole increments; choose the greatest.
              const uses = Array.from({ length: balance + 1 }, (_, i) => i).filter(
                (i) => i <= permitted && i % increment === 0,
              );
              const use = Math.max(...uses);
              const expectedFeasible = use >= minimum;
              const plan = simulateConversion(
                offer({
                  increment: decimalLiteral(String(increment)),
                  minimum: decimalLiteral(String(minimum)),
                  maximumPerRequest: cap === null ? null : decimalLiteral(String(cap)),
                  ratio: { numerator: String(numerator), denominator: String(denominator) },
                  rounding: { scale: 0, mode },
                }),
                quantity(balance),
              );
              expect(plan.feasible).toBe(expectedFeasible);
              for (const q of [plan.use, plan.receive, plan.remainder])
                expect(q.value.status).toBe("exact");
              if (
                plan.use.value.status !== "exact" ||
                plan.receive.value.status !== "exact" ||
                plan.remainder.value.status !== "exact"
              )
                throw new Error("expected exact plan");
              const expectedUse = expectedFeasible ? use : 0;
              expect(decimalToString(plan.use.value.value)).toBe(String(expectedUse));
              expect(decimalToString(plan.remainder.value.value)).toBe(
                String(balance - expectedUse),
              );
              expect(decimalToString(plan.receive.value.value)).toBe(
                String(expectedFeasible ? rounded(use * numerator, denominator, mode) : 0),
              );
            }
  expect(cases).toBe(24_300);
});

test("all 64 directed three-unit graphs at depths 1..3 match simple-path enumeration", () => {
  const units = ["points:a", "points:b", "points:c"];
  const edges = units.flatMap((from) =>
    units.filter((to) => to !== from).map((to) => [from, to] as const),
  );
  let cases = 0;
  for (let mask = 0; mask < 64; mask++)
    for (let depth = 1; depth <= 3; depth++) {
      cases++;
      const graph = edges.filter((_, index) => (mask & (1 << index)) !== 0);
      const offers = graph.map(([from, to]) =>
        offer({ offerId: from + "->" + to, fromUnitRef: from, toUnitRef: to }),
      );
      // With three distinct units, a simple a->c path is direct or via b.
      const has = (from: string, to: string) => graph.some(([a, b]) => a === from && b === to);
      const expected: string[] = [];
      if (has(units[0]!, units[2]!)) expected.push("points:a->points:c@v1");
      if (depth >= 2 && has(units[0]!, units[1]!) && has(units[1]!, units[2]!))
        expected.push("points:a->points:b@v1|points:b->points:c@v1");
      const result = findConversionPaths(
        offers,
        { quantity: quantity(4), clock: day("2026-09-09") },
        units[2]!,
        { maxDepth: depth, maxCandidates: 100, maxExpansions: 1000, requiredCompletionBy: null },
      );
      expect(result.paths.map((p) => p.hops.map((h) => h.offerRef).join("|")).sort()).toEqual(
        expected.sort(),
      );
      expect(result.stoppedBy).toEqual([]);
      expect(result.expansions).toBeLessThanOrEqual(1000);
      for (const path of result.paths) {
        expect(path.hops.length).toBeLessThanOrEqual(depth);
        expect(new Set(path.hops.map((h) => h.offerRef)).size).toBe(path.hops.length);
      }
    }
  expect(cases).toBe(192);
});

test("all 960 offer/membership/day/hop combinations require evidence at the application day", () => {
  const period = (start: string, end: string, endExclusive = false): TemporalValue => ({
    kind: "period",
    start,
    end,
    endExclusive,
    zone: "Asia/Tokyo",
    granularity: "day",
  });
  const validityCases: { value: OfferValidity; admittedDays: number[]; unknown?: boolean }[] = [
    { value: period("2026-09-09", "2026-09-10"), admittedDays: [0, 1] },
    { value: day("2026-09-09"), admittedDays: [0] },
    { value: day("2026-09-10"), admittedDays: [1] },
    {
      value: { kind: "unknown", reasonCode: "not_observed" },
      admittedDays: [],
      unknown: true,
    },
    {
      value: {
        kind: "instant",
        value: "2026-09-09T00:00:00+09:00",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      admittedDays: [],
      unknown: true,
    },
    {
      value: { ...day("2026-09-09"), zone: "Europe/London" },
      admittedDays: [],
      unknown: true,
    },
    { value: period("2026-09-09", "2026-09-10", true), admittedDays: [0] },
    // Standing offers: no end, so every day from the first one on.
    {
      value: { kind: "open-ended", start: "2026-09-09", zone: "Asia/Tokyo" },
      admittedDays: [0, 1, 2],
    },
    { value: { kind: "open-ended", start: "2026-09-10", zone: null }, admittedDays: [1, 2] },
    {
      value: { kind: "open-ended", start: "2026-09-09", zone: "Europe/London" },
      admittedDays: [],
      unknown: true,
    },
  ];
  const claim = (overrides: Partial<MembershipState> = {}): MembershipState => ({
    programId: "program:a",
    holdingRef: "holding:a",
    tier: "gold",
    valid: period("2026-09-09", "2026-09-10"),
    source: "provider",
    evidenceRefs: ["evidence:membership"],
    ...overrides,
  });
  const membershipCases: { claims: MembershipState[]; admittedDays: number[] }[] = [
    { claims: [], admittedDays: [] },
    { claims: [claim({ valid: day("2026-09-09") })], admittedDays: [0] },
    { claims: [claim()], admittedDays: [0, 1] },
    { claims: [claim({ tier: "silver" })], admittedDays: [] },
    { claims: [claim({ programId: "program:other" })], admittedDays: [] },
    { claims: [claim({ source: "self-reported" })], admittedDays: [] },
    { claims: [claim({ valid: validityCases[4]!.value as TemporalValue })], admittedDays: [] },
    { claims: [claim({ valid: validityCases[3]!.value as TemporalValue })], admittedDays: [] },
  ];
  let cases = 0;
  for (const secondHop of [false, true])
    for (const offset of [0, 1, 2])
      for (const validity of validityCases)
        for (const tierLimited of [false, true])
          for (const membership of membershipCases) {
            cases++;
            const final = offer({
              offerId: "offer:final",
              fromUnitRef: secondHop ? "points:x" : "points:a",
              validTime: validity.value,
              eligibleTiers: tierLimited ? ["gold"] : null,
            });
            const offers = secondHop
              ? [
                  offer({
                    offerId: "offer:bridge",
                    toUnitRef: "points:x",
                    processingDays: offset,
                  }),
                  final,
                ]
              : [final];
            const result = findConversionPaths(
              offers,
              {
                quantity: quantity(4),
                clock: day(
                  secondHop ? "2026-09-09" : ["2026-09-09", "2026-09-10", "2026-09-11"][offset]!,
                ),
                membership: membership.claims,
              },
              "points:b",
              {
                maxDepth: 2,
                maxCandidates: 8,
                maxExpansions: 100,
                requiredCompletionBy: null,
              },
            );
            const permitted =
              validity.admittedDays.includes(offset) &&
              (!tierLimited || membership.admittedDays.includes(offset));
            expect(result.paths.length).toBe(permitted ? 1 : 0);
            if (!permitted) {
              const reason = validity.unknown
                ? "needs_rule_verification"
                : !validity.admittedDays.includes(offset)
                  ? "offer_not_valid_at_clock"
                  : "needs_rule_verification";
              expect(result.rejected).toContainEqual({
                offerRef: "offer:final@v1",
                reasonCode: reason,
              });
            }
            expect(result.stoppedBy).toEqual([]);
          }
  expect(cases).toBe(960);
});

test("a processing delay past the representable date range remains uncertain", () => {
  const endOfRange = day("9999-12-31");
  const bridge = offer({
    offerId: "offer:bridge",
    toUnitRef: "points:x",
    validTime: endOfRange,
    applicationDeadline: endOfRange,
    processingDays: 1,
  });
  const final = offer({
    offerId: "offer:final",
    fromUnitRef: "points:x",
  });
  const result = findConversionPaths(
    [bridge, final],
    { quantity: quantity(4), clock: endOfRange },
    "points:b",
    { maxDepth: 2, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null },
  );
  expect(result.paths).toEqual([]);
  expect(result.rejected).toContainEqual({
    offerRef: "offer:final@v1",
    reasonCode: "needs_rule_verification",
  });
});

test("a standing offer with no deadline is a route at any later day", () => {
  const standing = offer({
    validTime: { kind: "open-ended", start: "2026-04-01", zone: "Asia/Tokyo" },
    applicationDeadline: null,
  });
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  for (const clock of ["2026-04-01", "2030-01-01", "9999-12-31"]) {
    const result = findConversionPaths(
      [standing],
      { quantity: quantity(4), clock: day(clock) },
      "points:b",
      budget,
    );
    expect(result.paths).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  }
  const before = findConversionPaths(
    [standing],
    { quantity: quantity(4), clock: day("2026-03-31") },
    "points:b",
    budget,
  );
  expect(before.paths).toEqual([]);
  expect(before.rejected).toEqual([
    { offerRef: "offer:a-b@v1", reasonCode: "offer_not_valid_at_clock" },
  ]);
});

test("a malformed stored validity establishes no day, rather than refusing one", () => {
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  const malformed = [
    { kind: "open-ended", start: "2026-02-30", zone: "Asia/Tokyo" },
    { kind: "open-ended", start: "2026-04-01", zone: "Asia/Tokyo", end: "2026-12-31" },
    { ...day("2026-02-30") },
    {
      kind: "period",
      start: "2026-05-01",
      end: "2026-04-01",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    },
  ] as unknown as OfferValidity[];
  for (const validTime of malformed) {
    const result = findConversionPaths(
      [offer({ validTime, applicationDeadline: null })],
      { quantity: quantity(4), clock: day("2026-04-15") },
      "points:b",
      budget,
    );
    expect(result.paths).toEqual([]);
    expect(result.rejected).toEqual([
      { offerRef: "offer:a-b@v1", reasonCode: "needs_rule_verification" },
    ]);
  }
});

test("an unknown or malformed deadline is a review reason, never no deadline (INV05)", () => {
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  const unestablished = [
    { kind: "unknown", reasonCode: "stored_offer_time_invalid" },
    { ...day("2026-02-30") },
    {
      kind: "period",
      start: "2026-05-01",
      end: "2026-04-01",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    },
  ] as unknown as TemporalValue[];
  for (const applicationDeadline of unestablished) {
    const result = findConversionPaths(
      [offer({ applicationDeadline })],
      { quantity: quantity(4), clock: day("2026-04-15") },
      "points:b",
      budget,
    );
    expect(result.paths).toEqual([]);
    expect(result.rejected).toEqual([
      { offerRef: "offer:a-b@v1", reasonCode: "needs_rule_verification" },
    ]);
  }
});

test("a period deadline passes after the period and is unestablished inside it", () => {
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  const applicationDeadline: TemporalValue = {
    kind: "period",
    start: "2026-09",
    end: "2026-09",
    endExclusive: false,
    zone: "Asia/Tokyo",
    granularity: "month",
  };
  const at = (clock: string) =>
    findConversionPaths(
      [offer({ applicationDeadline })],
      { quantity: quantity(4), clock: day(clock) },
      "points:b",
      budget,
    );
  expect(at("2026-08-31").paths).toHaveLength(1);
  for (const clock of ["2026-09-01", "2026-09-30"]) {
    expect(at(clock).paths).toEqual([]);
    expect(at(clock).rejected).toEqual([
      { offerRef: "offer:a-b@v1", reasonCode: "needs_rule_verification" },
    ]);
  }
  expect(at("2026-10-01").paths).toEqual([]);
  expect(at("2026-10-01").rejected).toEqual([
    { offerRef: "offer:a-b@v1", reasonCode: "application_deadline_passed" },
  ]);
});

test("a deadline is judged on the application day's calendar, never an assumed zone", () => {
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  // A standing validity with no zone, so only the deadline decides.
  const validTime: OfferValidity = { kind: "open-ended", start: "2026-01-01", zone: null };
  const instant = (value: string, zone = "Asia/Tokyo"): TemporalValue => ({
    kind: "instant",
    value,
    zone,
    basis: "provider",
  });
  const at = (applicationDeadline: TemporalValue, clock: LocalDateValue): string => {
    const result = findConversionPaths(
      [offer({ validTime, applicationDeadline })],
      { quantity: quantity(4), clock },
      "points:b",
      budget,
    );
    return result.paths.length === 1 ? "route" : result.rejected[0]!.reasonCode;
  };
  const tokyo = (value: string): LocalDateValue => day(value);
  const losAngeles = (value: string): LocalDateValue => ({
    ...day(value),
    zone: "America/Los_Angeles",
  });
  const zoneless = (value: string): LocalDateValue => ({ ...day(value), zone: null });

  // Dates of two zones are not compared (`zone_mismatch`, as for validity).
  // The end of 2026-04-15 in Los Angeles is 16:00 on 2026-04-16 in Tokyo, so
  // read as one calendar a Tokyo 16th would be refused although most of it is
  // before the deadline; the end of the Tokyo 15th is 08:00 on the Los Angeles
  // 15th, which would be read as a route.
  for (const clock of ["2026-04-15", "2026-04-16"])
    expect(at({ ...losAngeles("2026-04-15"), basis: "provider" }, tokyo(clock))).toBe(
      "needs_rule_verification",
    );
  for (const clock of ["2026-04-14", "2026-04-15", "2026-04-16"])
    expect(at(tokyo("2026-04-15"), losAngeles(clock))).toBe("needs_rule_verification");
  // The same zone, and a clock whose zone was not stated, compare as days.
  expect(at(tokyo("2026-04-15"), tokyo("2026-04-15"))).toBe("route");
  expect(at(tokyo("2026-04-15"), tokyo("2026-04-16"))).toBe("application_deadline_passed");
  expect(at(tokyo("2026-04-15"), zoneless("2026-04-15"))).toBe("route");
  expect(at(tokyo("2026-04-15"), zoneless("2026-04-16"))).toBe("application_deadline_passed");

  // 2026-04-15T15:30Z is 00:30 on 2026-04-16 in Tokyo. Read by its written
  // offset it would fall on the 15th and refuse the whole 16th.
  const justAfterMidnight = instant("2026-04-15T15:30:00Z");
  expect(at(justAfterMidnight, tokyo("2026-04-15"))).toBe("route");
  expect(at(justAfterMidnight, tokyo("2026-04-16"))).toBe("needs_rule_verification");
  expect(at(justAfterMidnight, tokyo("2026-04-17"))).toBe("application_deadline_passed");
  // A day that holds the deadline instant is not established at either edge.
  const lastSecond = instant("2026-04-15T23:59:59+09:00");
  expect(at(lastSecond, tokyo("2026-04-14"))).toBe("route");
  expect(at(lastSecond, tokyo("2026-04-15"))).toBe("needs_rule_verification");
  expect(at(lastSecond, tokyo("2026-04-16"))).toBe("application_deadline_passed");
  // A Los Angeles day reads the same instant on its own calendar (07:59:59 on
  // 2026-04-15 there).
  expect(at(lastSecond, losAngeles("2026-04-14"))).toBe("route");
  expect(at(lastSecond, losAngeles("2026-04-15"))).toBe("needs_rule_verification");
  expect(at(lastSecond, losAngeles("2026-04-16"))).toBe("application_deadline_passed");
  // A clock with no zone reads the instant in the deadline's own zone.
  expect(at(justAfterMidnight, zoneless("2026-04-15"))).toBe("route");
  expect(at(justAfterMidnight, zoneless("2026-04-16"))).toBe("needs_rule_verification");
  // A zone the runtime does not know is not read as UTC.
  const unknownZone = instant("2026-04-15T12:00:00Z", "Synthetic/Nowhere");
  for (const clock of ["2026-04-01", "2026-04-15", "2026-04-30"])
    expect(at(unknownZone, zoneless(clock))).toBe("needs_rule_verification");
});

test("an instant clock starts on its civil date in its own zone", () => {
  const budget = { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy: null };
  // 2026-04-15T15:30Z is 00:30 on 2026-04-16 in Tokyo, the day after the deadline.
  const clock: TemporalValue = {
    kind: "instant",
    value: "2026-04-15T15:30:00Z",
    zone: "Asia/Tokyo",
    basis: "collector",
  };
  const result = findConversionPaths(
    [offer({ applicationDeadline: day("2026-04-15") })],
    { quantity: quantity(4), clock },
    "points:b",
    budget,
  );
  expect(result.paths).toEqual([]);
  expect(result.rejected).toEqual([
    { offerRef: "offer:a-b@v1", reasonCode: "application_deadline_passed" },
  ]);
  // A clock zone the runtime does not know establishes no day.
  const unknown = findConversionPaths(
    [offer()],
    { quantity: quantity(4), clock: { ...clock, zone: "Synthetic/Nowhere" } },
    "points:b",
    budget,
  );
  expect(unknown.rejected).toEqual([{ offerRef: "-", reasonCode: "clock_not_a_date" }]);
});

test("a required completion date follows the deadline rule on the credit day", () => {
  const at = (requiredCompletionBy: TemporalValue): string => {
    const result = findConversionPaths(
      [offer({ processingDays: 5 })],
      { quantity: quantity(4), clock: day("2026-04-10") },
      "points:b",
      { maxDepth: 1, maxCandidates: 8, maxExpansions: 100, requiredCompletionBy },
    );
    return result.paths.length === 1 ? "route" : result.rejected[0]!.reasonCode;
  };
  const instant = (value: string, zone = "Asia/Tokyo"): TemporalValue => ({
    kind: "instant",
    value,
    zone,
    basis: "provider",
  });
  // The credit is expected on 2026-04-15.
  expect(at(day("2026-04-15"))).toBe("route");
  expect(at(day("2026-04-14"))).toBe("completion_after_required_by");
  // A date of another zone and an unknown value establish nothing; neither is
  // read as no requirement (INV05).
  expect(at({ ...day("2026-04-20"), zone: "America/Los_Angeles" })).toBe("needs_rule_verification");
  expect(at({ kind: "unknown", reasonCode: "not_stated" })).toBe("needs_rule_verification");
  // An instant is one moment: its own zone, even one the runtime does not
  // know, is not needed to read it on the clock's Tokyo calendar. Before, an
  // unknown zone gave no day and the requirement was silently dropped.
  expect(at(instant("2026-04-10T00:00:00Z", "Synthetic/Nowhere"))).toBe(
    "completion_after_required_by",
  );
  // With a clock that names no zone, it is read in its own zone, and one the
  // runtime does not know is never read as UTC.
  const zoneless = findConversionPaths(
    [offer({ processingDays: 5 })],
    { quantity: quantity(4), clock: { ...day("2026-04-10"), zone: null } },
    "points:b",
    {
      maxDepth: 1,
      maxCandidates: 8,
      maxExpansions: 100,
      requiredCompletionBy: instant("2026-04-10T00:00:00Z", "Synthetic/Nowhere"),
    },
  );
  expect(zoneless.rejected).toEqual([
    { offerRef: "offer:a-b@v1", reasonCode: "needs_rule_verification" },
  ]);
  // A clock zone the runtime does not know cannot place an instant either,
  // even one in a known zone; it is not read as UTC or as the instant's zone.
  const unknownClock = findConversionPaths(
    [
      offer({
        processingDays: 5,
        validTime: { ...day("2026-04-10"), zone: null },
        applicationDeadline: null,
      }),
    ],
    { quantity: quantity(4), clock: { ...day("2026-04-10"), zone: "Synthetic/Nowhere" } },
    "points:b",
    {
      maxDepth: 1,
      maxCandidates: 8,
      maxExpansions: 100,
      requiredCompletionBy: instant("2026-04-01T00:00:00Z"),
    },
  );
  expect(unknownClock.rejected).toEqual([
    { offerRef: "offer:a-b@v1", reasonCode: "needs_rule_verification" },
  ]);
  // An instant is read on the clock's calendar: 2026-04-14T15:30Z is 00:30 on
  // the Tokyo 15th, the credit day itself, which it cannot place.
  expect(at(instant("2026-04-14T15:30:00Z"))).toBe("needs_rule_verification");
  expect(at(instant("2026-04-15T15:30:00Z"))).toBe("route");
  expect(at(instant("2026-04-13T15:30:00Z"))).toBe("completion_after_required_by");
});
