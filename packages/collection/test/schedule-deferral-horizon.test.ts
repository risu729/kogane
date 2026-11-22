// Recurring maintenance windows are enumerated up to the horizon's end as an
// instant, whatever the rule's zone: a window that starts in the horizon's
// last hours on a local date that is already the next one in a zone ahead of
// UTC is still a union (ADR 0046's bound on delegated revisions). Synthetic
// rules only.
import { expect, test } from "bun:test";
import {
  deferralUnions,
  longestDeferral,
  type DeferralUnion,
  type MaintenancePattern,
  type MaintenanceRule,
} from "../src/schedule-model";

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
const ms = (value: string) => Date.parse(value);
function rule(
  timezone: string,
  pattern: Exclude<MaintenancePattern, { kind: "once" }>,
  id = "synthetic",
): MaintenanceRule {
  return {
    id,
    source: "synthetic",
    timezone,
    pattern,
    enabled: true,
    referenceUrl: "https://example.com/maintenance",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    scope: "collection",
    revision: 1,
  };
}
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

test("a Tokyo window starting in the horizon's last hours, on the next local date, is a union", () => {
  // 2026-11-02 01:00 in Tokyo is 2026-11-01T16:00Z, before the horizon's end
  // at 20:00Z, although its local date (2 November) is after that instant's
  // UTC date.
  const rules = [
    rule("Asia/Tokyo", { kind: "weekly", weekdays: EVERY_DAY, start: "01:00", end: "05:00" }),
  ];
  const from = ms("2026-11-01T00:00:00.000Z"),
    horizon = 20 * HOUR;
  expect(deferralUnions(rules, from, horizon, DAY)).toEqual([
    { start: ms("2026-11-01T16:00:00.000Z"), end: ms("2026-11-01T20:00:00.000Z") },
  ]);
  expect(longestDeferral(rules, from, horizon, DAY)).toBe(4 * HOUR);
  // One minute short of it, the window is outside the horizon.
  expect(deferralUnions(rules, from, 16 * HOUR, DAY)).toEqual([]);
});

test("a Sydney window starting in the horizon's last hours counts toward the longest deferral", () => {
  // Summer time (+11:00): 2026-11-09 00:30 in Sydney is 2026-11-08T13:30Z.
  // The long window there is the longest deferral, so missing it would
  // understate the measure the seven-day bound reads.
  const rules = [
    rule(
      "Australia/Sydney",
      { kind: "weekly", weekdays: [1], start: "00:30", end: "23:30" },
      "long",
    ),
    rule(
      "Australia/Sydney",
      { kind: "weekly", weekdays: [0], start: "12:00", end: "13:00" },
      "short",
    ),
  ];
  const from = ms("2026-11-08T00:00:00.000Z"),
    horizon = 14 * HOUR;
  expect(deferralUnions(rules, from, horizon, DAY)).toEqual([
    { start: ms("2026-11-08T01:00:00.000Z"), end: ms("2026-11-08T02:00:00.000Z") },
    { start: ms("2026-11-08T13:30:00.000Z"), end: ms("2026-11-09T12:30:00.000Z") },
  ]);
  expect(longestDeferral(rules, from, horizon, DAY)).toBe(23 * HOUR);
});

test("a UTC window on the horizon's last date is unchanged", () => {
  const rules = [
    rule("UTC", { kind: "weekly", weekdays: EVERY_DAY, start: "19:00", end: "21:00" }),
  ];
  const from = ms("2026-11-01T00:00:00.000Z");
  expect(deferralUnions(rules, from, 20 * HOUR, DAY)).toEqual([
    { start: ms("2026-11-01T19:00:00.000Z"), end: ms("2026-11-01T21:00:00.000Z") },
  ]);
  expect(deferralUnions(rules, from, 19 * HOUR, DAY)).toEqual([]);
});

// The oracle: scan every minute and decide from wall-clock arithmetic alone
// whether a window covers it, then read the unions off the covered runs. It
// shares no code with the model. The ranges it scans hold no clock change
// (Tokyo and UTC have none; Sydney's are on the first Sundays of April and
// October), so one offset per zone gives every minute's wall time.
const OFFSETS: Record<string, number> = { "Asia/Tokyo": 9 * HOUR, UTC: 0 };
function offsetOf(timezone: string, instant: number): number {
  if (timezone !== "Australia/Sydney") return OFFSETS[timezone]!;
  const month = new Date(instant).getUTCMonth();
  // November to February: summer time; May to August: standard time.
  if (month >= 10 || month <= 1) return 11 * HOUR;
  if (month >= 4 && month <= 7) return 10 * HOUR;
  throw new Error("oracle_range_has_clock_change");
}
const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h! * HOUR + m! * MINUTE;
};
/** Whether a window of `p` starts on the wall date whose midnight is `date` (as UTC). */
function startsOnDate(p: Exclude<MaintenancePattern, { kind: "once" }>, date: number): boolean {
  const d = new Date(date);
  if (p.kind === "weekly") return p.weekdays.includes(d.getUTCDay());
  // The nth `weekday` of its month, `offsetDays` before this date.
  const base = new Date(date - p.offsetDays * DAY);
  const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const firstMatch = 1 + ((p.weekday - first.getUTCDay() + 7) % 7);
  return base.getUTCDate() === firstMatch + (p.nth - 1) * 7;
}
function covered(rules: readonly MaintenanceRule[], t: number): boolean {
  return rules.some((r) => {
    const p = r.pattern;
    if (p.kind === "once") throw new Error("oracle_recurring_only");
    const wall = t + offsetOf(r.timezone, t);
    const today = Math.floor(wall / DAY) * DAY;
    const start = minutesOf(p.start),
      end = minutesOf(p.end) + (p.end < p.start ? DAY : 0);
    return [today, today - DAY].some(
      (date) => startsOnDate(p, date) && wall >= date + start && wall < date + end,
    );
  });
}
/** The unions `deferralUnions` must report, cap reached shown as `end: null`. */
function oracleUnions(
  rules: readonly MaintenanceRule[],
  from: number,
  horizon: number,
  cap: number,
): { start: number; end: number | null }[] {
  const out: { start: number; end: number | null }[] = [];
  const last = from + horizon + cap + DAY;
  let runStart: number | null = covered(rules, from) ? from : null;
  for (let t = from + MINUTE; t <= last; t += MINUTE) {
    const now = covered(rules, t);
    if (now && runStart === null && t < from + horizon) runStart = t;
    if (!now && runStart !== null) {
      out.push({ start: runStart, end: t - runStart <= cap ? t : null });
      runStart = null;
    }
  }
  if (runStart !== null) out.push({ start: runStart, end: null });
  return out;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test("joined deferrals match a minute-scan oracle in Tokyo, UTC and Sydney", () => {
  const random = mulberry32(0x6b6f6761);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)]!;
  const time = () =>
    `${String(int(24)).padStart(2, "0")}:${String(pick([0, 15, 30, 45])).padStart(2, "0")}`;
  // Ranges without a Sydney clock change in the scanned span.
  const ranges = [
    [ms("2026-11-02T00:00:00.000Z"), ms("2027-02-10T00:00:00.000Z")],
    [ms("2026-05-02T00:00:00.000Z"), ms("2026-08-10T00:00:00.000Z")],
  ] as const;
  for (let i = 0; i < 300; i++) {
    const timezone = pick(["Asia/Tokyo", "UTC", "Australia/Sydney"] as const);
    const rules: MaintenanceRule[] = [];
    for (let k = 1 + int(2); k > 0; k--) {
      let start = time(),
        end = time();
      while (end === start) end = time();
      const pattern: Exclude<MaintenancePattern, { kind: "once" }> =
        random() < 0.75
          ? {
              kind: "weekly",
              weekdays: EVERY_DAY.filter(() => random() < 0.4)
                .concat(int(7))
                .filter((d, j, all) => all.indexOf(d) === j),
              start,
              end,
            }
          : { kind: "monthly", weekday: int(7), nth: 1 + int(5), offsetDays: int(7), start, end };
      rules.push(rule(timezone, pattern, `rule-${k}`));
    }
    const [low, high] = pick(ranges);
    const from = low + int((high - low) / MINUTE) * MINUTE;
    const horizon = HOUR + int(5 * 96) * 15 * MINUTE,
      cap = 2 * DAY;
    const expected = oracleUnions(rules, from, horizon, cap);
    const actual = deferralUnions(rules, from, horizon, cap).map((union: DeferralUnion) => ({
      start: union.start,
      end: union.end - union.start <= cap ? union.end : null,
    }));
    // Past a union that reached the cap the model stops following that chain,
    // so a window later in it can start a union of its own: compare up to it.
    const capped = expected.findIndex((union) => union.end === null);
    if (capped >= 0) {
      expected.splice(capped + 1);
      actual.splice(capped + 1);
    }
    const context = JSON.stringify({
      from: new Date(from).toISOString(),
      horizon,
      rules: rules.map((r) => [r.timezone, r.pattern]),
    });
    expect({ context, unions: actual }).toEqual({ context, unions: expected });
  }
});
