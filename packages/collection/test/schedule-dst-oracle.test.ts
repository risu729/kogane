import { expect, test } from "bun:test";
import {
  afterMaintenance,
  deferralUnions,
  type MaintenancePattern,
  type MaintenanceRule,
} from "../src/schedule-model";

// A brute-force oracle for maintenance deferral across Sydney's clock changes,
// independent of `schedule-model`'s placement: zone offsets come from the
// written rules (Sydney: +11:00 from 02:00 standard time on the first Sunday of
// October to 03:00 summer time on the first Sunday of April, else +10:00), every
// window is placed by scanning minutes, and a deferral ends at the first minute
// no window covers. The placement it states is the documented one
// (docs/schedules.md, ADR 0039 amendment of 2026-11-22): a wall time shown
// once is placed there; a repeated wall time at its first occurrence; a skipped
// start at the first minute whose wall time reaches it; a skipped end on the
// clock before the change.

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
type Zone = "Asia/Tokyo" | "UTC" | "Australia/Sydney";

function firstSunday(year: number, month: number): number {
  for (let d = 1; ; d++) if (new Date(Date.UTC(year, month, d)).getUTCDay() === 0) return d;
}
// Both changes fall at 16:00Z on the Saturday before the first Sunday.
const springForward = (year: number) => Date.UTC(year, 9, firstSunday(year, 9)) - 8 * HOUR,
  fallBack = (year: number) => Date.UTC(year, 3, firstSunday(year, 3)) - 8 * HOUR;
function offset(ms: number, zone: Zone): number {
  if (zone === "UTC") return 0;
  if (zone === "Asia/Tokyo") return 9 * HOUR;
  const year = new Date(ms).getUTCFullYear();
  return ms >= springForward(year) || ms < fallBack(year) ? 11 * HOUR : 10 * HOUR;
}
/** The wall time an instant shows, as a UTC instant. */
const wall = (ms: number, zone: Zone) => ms + offset(ms, zone);

/** A wall time on a local date (UTC midnight), placed by scanning minutes. */
function place(date: number, time: string, zone: Zone, edge: "start" | "end"): number {
  const [h, m] = time.split(":").map(Number);
  const target = date + h! * HOUR + m! * MINUTE;
  let firstReach: number | null = null;
  for (let t = target - 12 * HOUR; t <= target; t += MINUTE) {
    const w = wall(t, zone);
    if (w === target) return t;
    if (w > target && firstReach === null) firstReach = t;
  }
  if (firstReach === null) throw new Error("oracle_unplaced");
  if (edge === "start") return firstReach;
  // The wall time the clock before the change would show at `firstReach`.
  const before = wall(firstReach - MINUTE, zone) + MINUTE;
  return firstReach + (target - before);
}
function startsOn(p: Exclude<MaintenancePattern, { kind: "once" }>, date: number): boolean {
  const weekday = new Date(date).getUTCDay();
  if (p.kind === "weekly") return p.weekdays.includes(weekday);
  const base = new Date(date - p.offsetDays * DAY);
  const nth = Math.floor((base.getUTCDate() - 1) / 7) + 1;
  return base.getUTCDay() === p.weekday && nth === p.nth;
}
/** Minutes in [from, from + span) that any rule's window covers. */
function covered(rules: MaintenanceRule[], from: number, span: number): Uint8Array {
  const bits = new Uint8Array(span / MINUTE);
  const mark = (s: number, e: number) => {
    for (let t = Math.max(s, from); t < Math.min(e, from + span); t += MINUTE)
      bits[(t - from) / MINUTE] = 1;
  };
  for (const rule of rules) {
    const p = rule.pattern,
      zone = rule.timezone as Zone;
    if (p.kind === "once") {
      mark(Date.parse(p.from), Date.parse(p.to));
      continue;
    }
    // Local dates as UTC midnights, from three days before `from`.
    for (let date = Math.floor(from / DAY) * DAY - 3 * DAY; date < from + span + DAY; date += DAY) {
      if (!startsOn(p, date)) continue;
      const start = place(date, p.start, zone, "start"),
        end = place(date + (p.end < p.start ? DAY : 0), p.end, zone, "end");
      mark(start, end);
    }
  }
  return bits;
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");

test("the oracle's Sydney offsets agree with the runtime's zone data", () => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const year of [2026, 2027, 2028])
    for (const change of [springForward(year), fallBack(year)])
      for (let t = change - 2 * DAY; t < change + 2 * DAY; t += 15 * MINUTE) {
        const p = Object.fromEntries(format.formatToParts(t).map((v) => [v.type, v.value]));
        const shown = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
        expect(shown).toBe(wall(t, "Australia/Sydney"));
      }
});

test("deferral across Sydney's clock changes matches a minute-by-minute oracle", () => {
  const random = prng(0x5eed_d57);
  const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const time = () => {
    // Most times near the changes (01:00–04:59), some anywhere.
    const hour = random() < 0.75 ? 1 + Math.floor(random() * 4) : Math.floor(random() * 24);
    const minute = random() < 0.7 ? pick([0, 15, 30, 45]) : Math.floor(random() * 60);
    return `${pad(hour)}:${pad(minute)}`;
  };
  const changes = [2026, 2027].flatMap((y) => [springForward(y), fallBack(y)]);
  let compared = 0,
    deferred = 0;
  const sets = 100;
  for (let set = 0; set < sets; set++) {
    const change = pick(changes);
    const from = change - 6 * DAY,
      span = 14 * DAY;
    const rules: MaintenanceRule[] = [];
    for (let n = 1 + Math.floor(random() * 3); n > 0; n--) {
      const timezone = random() < 0.7 ? "Australia/Sydney" : pick(["Asia/Tokyo", "UTC"] as const);
      let start = time(),
        end = time();
      while (end === start) end = time();
      const kind = random();
      const pattern: MaintenancePattern =
        kind < 0.6
          ? {
              kind: "weekly",
              weekdays: [...new Set([0, pick([0, 1, 5, 6]), pick([0, 6])])],
              start,
              end,
            }
          : kind < 0.9
            ? {
                kind: "monthly",
                weekday: pick([0, 5, 6]),
                nth: 1,
                offsetDays: pick([0, 0, 1, 2]),
                start,
                end,
              }
            : (() => {
                const a = change + Math.floor((random() - 0.5) * 8 * 60) * MINUTE;
                const b = a + (1 + Math.floor(random() * 180)) * MINUTE;
                return {
                  kind: "once",
                  from: new Date(a).toISOString(),
                  to: new Date(b).toISOString(),
                };
              })();
      rules.push({
        id: `r${n}`,
        source: "synthetic",
        timezone,
        pattern,
        enabled: true,
        referenceUrl: "https://example.com/maintenance",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        scope: "collection",
        revision: 1,
      });
    }
    const bits = covered(rules, from, span);
    const firstFree = (t: number) => {
      let i = (t - from) / MINUTE;
      while (i < bits.length && bits[i]) i++;
      return i < bits.length - 2 * 1440 ? from + i * MINUTE : null;
    };
    // Every minute from two hours before the change to three after (wall
    // times 00:00–04:59 on the day of the change), and some further away.
    const samples: number[] = [];
    for (let t = change - 2 * HOUR; t < change + 3 * HOUR; t += MINUTE) samples.push(t);
    for (let k = 0; k < 20; k++)
      samples.push(change + Math.floor((random() - 0.5) * 4 * 1440) * MINUTE);
    for (const t of samples) {
      const expected = firstFree(t);
      if (expected === null) continue;
      const actual = afterMaintenance(t, rules);
      if (actual !== expected)
        throw new Error(
          `afterMaintenance(${new Date(t).toISOString()}) = ${new Date(actual).toISOString()}, oracle ${new Date(expected).toISOString()} for ${JSON.stringify(rules.map((r) => [r.timezone, r.pattern]))}`,
        );
      compared++;
      if (expected > t) deferred++;
    }
    // Joined deferrals from a day before the change, over two days.
    const since = change - DAY,
      horizon = 2 * DAY,
      cap = 3 * DAY;
    const oracle: { start: number; end: number }[] = [];
    const starts = new Set<number>([since]);
    // The model reads recurring starts by local date up to `since + horizon`,
    // so a start in the horizon's last hours on the next local date is not
    // listed; compare unions that start at least half a day before it.
    const compareBefore = since + horizon - 12 * HOUR;
    for (let t = since + MINUTE; t < compareBefore; t += MINUTE) {
      const i = (t - from) / MINUTE;
      // A union can only begin where a covered minute follows an uncovered
      // one; a window starting inside a union is skipped by the walk below.
      if (bits[i] && !bits[i - 1]) starts.add(t);
    }
    let reach = Number.NEGATIVE_INFINITY,
      unmeasured = false;
    for (const start of [...starts].sort((a, b) => a - b)) {
      if (start < reach) continue;
      const end = firstFree(start);
      if (end === null || end - start > cap) {
        unmeasured = true;
        break;
      }
      reach = end;
      if (end > start) oracle.push({ start, end });
    }
    if (!unmeasured) {
      const actual = deferralUnions(rules, since, horizon, cap).filter(
        (u) => u.start < compareBefore,
      );
      if (JSON.stringify(actual) !== JSON.stringify(oracle))
        throw new Error(
          `deferralUnions ${JSON.stringify(actual)} != oracle ${JSON.stringify(oracle)} for ${JSON.stringify(rules.map((r) => [r.timezone, r.pattern]))}`,
        );
    }
  }
  expect(compared).toBeGreaterThan(sets * 250);
  expect(deferred).toBeGreaterThan(sets * 25);
}, 60_000);
