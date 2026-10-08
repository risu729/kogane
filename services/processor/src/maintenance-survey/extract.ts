// Closed extraction of maintenance windows from the text of an official notice
// page (ADR 0050).
//
// chrono-node (its strict Japanese configuration) recognises single date and
// time expressions — years and eras, full-width digits, 午前/午後, 時/分, a
// stated weekday or zone — and says which components the text actually
// stated. It never sees a range: the text is cut at every range separator
// first, because chrono's own range handling fills in and reorders what a
// notice did not say. Everything that decides what a window IS stays here, as
// a closed list: which expressions start a window, how an end is joined to its
// start, the recurrences 毎週/毎日/毎月第N, how a year the page does not state
// is pinned, and which wording makes a window need review. The zone
// conversion is the schedule model's (`wallTimeInstant`), the same code the
// alarms use.
//
// Page text is data. It is matched against this grammar and nothing else; no
// part of it is returned, logged or stored. What comes out is a pattern the
// schedule model validates, and closed reason codes.
import { strict as chrono } from "chrono-node/ja";
import type { ParsedComponents } from "chrono-node";
import {
  PROPOSAL_REASONS,
  type ProposalReason,
} from "../../../../packages/collection/src/maintenance-survey-model.ts";
import {
  localCalendarDate,
  validMaintenance,
  wallTimeInstant,
  type MaintenancePattern,
} from "../../../../packages/collection/src/schedule-model.ts";

/** Recorded with every fetch: a changed grammar is a new version, and old readings stay. */
export const EXTRACTOR_VERSION = "maintenance-survey-extract-1.0.0";
/** More current windows than this on one page is `too_many_windows`, and nothing is proposed. */
export const MAX_WINDOWS = 40;
/** A dated window longer than this needs review. */
const LONG_WINDOW_MS = 3 * 86_400_000;
const DAY = 86_400_000;
const DAYS = "日月火水木金土";

export interface WindowCandidate {
  timezone: string;
  pattern: MaintenancePattern;
  /** Sorted, unique, closed. Empty means nothing on the page needs a judgement. */
  reasons: ProposalReason[];
}
export interface Extraction {
  /** Current windows: recurring ones, and dated ones that have not ended. */
  windows: WindowCandidate[];
  /** Dated windows that ended before the fetch; read, not proposed. */
  past: number;
  /** Expressions that looked like a window but could not form a valid one. */
  rejected: number;
  /** Whether any recurring / any dated window was read (current or past). */
  recurringSeen: boolean;
  datedSeen: boolean;
}

/** Wording on the same line that makes every window of that line need review. */
const LINE_REASONS: [ProposalReason, RegExp][] = [
  ["exception_stated", /除く|除き|ただし|但し|祝日|祝休日|休日|年末年始|振替/u],
  ["may_change", /延長|前後|頃|ごろ|目途|めど|目安|変更|状況により|早まる|遅れる|予告なく/u],
  ["cancellation_stated", /中止|取りやめ|取り止め|延期|キャンセル/u],
  ["partial_service", /一部/u],
];
/** Range separators (after NFKC, so ～ is ~ and － is -). */
const SEPARATOR = /~|〜|-|−|‐|―|–|から/gu;
/** An ISO-style date, whose hyphens are not range separators. */
const ISO_DATE = /\d{4}-\d{1,2}-\d{1,2}/gu;
/** A weekday written as 日曜日/日曜/(日)/(日曜日). */
const WEEKDAY_WORD = String.raw`\(([日月火水木金土])(?:曜日|曜)?\)|([日月火水木金土])(?:曜日|曜)`;
/**
 * What may open a piece before its time: 翌/翌日 or a weekday. chrono's strict
 * mode drops a weekday-and-time expression whole, so the marker is cut off
 * here and read by `RANGE_GAP` instead.
 */
const PIECE_MARKER = new RegExp(String.raw`^\s*(?:翌日?|${WEEKDAY_WORD})`, "u");
/** Between a start and its end: one separator, then optionally 翌/翌日 or the end's weekday. */
const RANGE_GAP = new RegExp(
  String.raw`^\s*(?:~|〜|-|−|‐|―|–|から)\s*(?:(翌日?)|${WEEKDAY_WORD})?\s*$`,
  "u",
);
const RECURRENCE = /毎週|毎日|毎月/gu;
const WEEKLY = /^毎週\s*((?:[日月火水木金土](?:曜日|曜)?\s*[・、,]?\s*)+)/u;
const MONTHLY =
  /^毎月\s*第\s*([1-5])\s*([日月火水木金土])(?:曜日|曜)?(?:\s*の\s*(翌日|翌々日|([1-6])日後))?/u;

/** One date/time expression chrono recognised, at its position in the line. */
interface Token {
  index: number;
  end: number;
  at: ParsedComponents;
}
/**
 * The expressions of `text`, each recognised on its own: the text is cut at
 * the range separators and every piece is parsed separately, so chrono never
 * joins, extends or reorders a range. A piece in which chrono still finds a
 * range (a separator this grammar does not know) yields nothing.
 */
function tokens(text: string, fetchedAt: number): Token[] {
  const protectedSpans = [...text.matchAll(ISO_DATE)].map((m) => [m.index, m.index + m[0].length]);
  const cuts = [...text.matchAll(SEPARATOR)].filter(
    (m) => !protectedSpans.some(([from, to]) => m.index >= from! && m.index < to!),
  );
  const out: Token[] = [];
  let from = 0;
  for (const cut of [...cuts.map((m) => ({ index: m.index, length: m[0].length })), null]) {
    const to = cut ? cut.index : text.length;
    // A piece after a separator may open with 翌 or a weekday; `RANGE_GAP` reads it.
    const offset = from === 0 ? 0 : (PIECE_MARKER.exec(text.slice(from, to))?.[0].length ?? 0);
    const base = from + offset;
    for (const r of chrono.parse(text.slice(base, to), { instant: new Date(fetchedAt) }))
      if (!r.end)
        out.push({ index: base + r.index, end: base + r.index + r.text.length, at: r.start });
    if (cut) from = cut.index + cut.length;
  }
  return out;
}

function certain(c: ParsedComponents, ...parts: Parameters<ParsedComponents["isCertain"]>[0][]) {
  return parts.every((p) => c.isCertain(p));
}
function hhmm(c: ParsedComponents): string {
  const pad = (n: number | null) => String(n ?? 0).padStart(2, "0");
  return `${pad(c.get("hour"))}:${pad(c.get("minute"))}`;
}
function sorted(reasons: Iterable<ProposalReason>): ProposalReason[] {
  const set = new Set(reasons);
  return PROPOSAL_REASONS.filter((r) => set.has(r));
}

/**
 * The local date (UTC midnight) the components name. A stated year is used as
 * stated. Without one, the year is the one that puts the date within 92 days
 * before to 366 days after `anchor`; a stated weekday must then match, which
 * pins the year without a reason; with no weekday the year is `year_inferred`.
 */
function resolveDate(
  c: ParsedComponents,
  anchor: number,
  reasons: Set<ProposalReason>,
): number | null {
  const month = c.get("month"),
    day = c.get("day");
  if (month === null || day === null) return null;
  const valid = (year: number) => {
    const date = Date.UTC(year, month - 1, day);
    const d = new Date(date);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? date
      : null;
  };
  const weekday = c.isCertain("weekday") ? c.get("weekday") : null;
  if (c.isCertain("year")) {
    const date = valid(c.get("year")!);
    if (date !== null && weekday !== null && new Date(date).getUTCDay() !== weekday)
      reasons.add("weekday_mismatch");
    return date;
  }
  const year = new Date(anchor).getUTCFullYear();
  const candidates = [year - 1, year, year + 1]
    .map(valid)
    .filter((d): d is number => d !== null && d >= anchor - 92 * DAY && d <= anchor + 366 * DAY)
    .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
  if (weekday !== null) {
    const matching = candidates.filter((d) => new Date(d).getUTCDay() === weekday);
    if (matching.length === 1) return matching[0]!;
    reasons.add(matching.length === 0 ? "weekday_mismatch" : "year_inferred");
    return matching[0] ?? candidates[0] ?? null;
  }
  reasons.add("year_inferred");
  return candidates[0] ?? null;
}

/** A stated zone offset that is not `timezone`'s at that wall time needs review. */
function zoneReason(
  c: ParsedComponents,
  date: number,
  time: string,
  timezone: string,
  reasons: Set<ProposalReason>,
) {
  if (!c.isCertain("timezoneOffset")) return;
  const instant = wallTimeInstant(date, time, timezone);
  const [h, m] = time.split(":").map(Number);
  const offset = instant === null ? null : (date + h! * 3_600_000 + m! * 60_000 - instant) / 60_000;
  if (c.get("timezoneOffset") !== offset) reasons.add("timezone_mismatch");
}

interface Joined {
  end: ParsedComponents;
  /** 翌/翌日 was written before the end. */
  nextDay: boolean;
  /** The weekday written before the end's time, if one was. */
  weekday: number | null;
}
/** The end joined to `list[i]`: the next expression, when only a separator (and 翌 or a weekday) lies between. */
function joinRange(text: string, list: readonly Token[], i: number): Joined | null {
  const start = list[i]!,
    next = list[i + 1];
  if (!next) return null;
  const gap = RANGE_GAP.exec(text.slice(start.end, next.index));
  if (!gap) return null;
  const day = gap[2] ?? gap[3];
  return { end: next.at, nextDay: gap[1] !== undefined, weekday: day ? DAYS.indexOf(day) : null };
}

interface Accumulator {
  windows: WindowCandidate[];
  past: number;
  rejected: number;
  recurringSeen: boolean;
  datedSeen: boolean;
}

/** Dated windows: an expression stating month, day and hour starts one. */
function datedWindows(
  line: string,
  lineReasons: ProposalReason[],
  timezone: string,
  fetchedAt: number,
  acc: Accumulator,
) {
  const list = tokens(line, fetchedAt);
  const fetchedDate = localCalendarDate(fetchedAt, timezone);
  for (let i = 0; i < list.length; i++) {
    const start = list[i]!.at;
    if (!certain(start, "month", "day", "hour")) continue;
    const joined = joinRange(line, list, i);
    if (!joined || !joined.end.isCertain("hour")) {
      acc.rejected++;
      continue;
    }
    i++;
    const reasons = new Set<ProposalReason>(lineReasons);
    const startDate = resolveDate(start, fetchedDate, reasons);
    if (startDate === null) {
      acc.rejected++;
      continue;
    }
    const startTime = hhmm(start),
      endTime = hhmm(joined.end);
    let endDate: number | null;
    // Whether the text itself says on which day the window ends.
    let explicitEnd = true;
    if (certain(joined.end, "month", "day")) {
      if (joined.end.isCertain("year")) endDate = resolveDate(joined.end, fetchedDate, reasons);
      else {
        // An end without a year takes the start's year, or the next across New Year.
        const endReasons = new Set<ProposalReason>();
        endDate = resolveDate(joined.end, startDate, endReasons);
        if (endReasons.has("weekday_mismatch")) reasons.add("weekday_mismatch");
      }
    } else if (joined.weekday !== null) {
      const startDay = new Date(startDate).getUTCDay();
      endDate = startDate + ((joined.weekday - startDay + 7) % 7) * DAY;
    } else {
      endDate = startDate + (joined.nextDay ? DAY : 0);
      explicitEnd = joined.nextDay;
    }
    if (endDate === null) {
      acc.rejected++;
      continue;
    }
    const from = wallTimeInstant(startDate, startTime, timezone);
    let to = wallTimeInstant(endDate, endTime, timezone);
    if (from !== null && to !== null && to <= from && !explicitEnd) {
      // "21:00〜6:00" after a date: read as the next morning, for review.
      reasons.add("end_next_day_inferred");
      endDate += DAY;
      to = wallTimeInstant(endDate, endTime, timezone);
    }
    if (from === null || to === null || to <= from) {
      acc.rejected++;
      continue;
    }
    zoneReason(start, startDate, startTime, timezone, reasons);
    zoneReason(joined.end, endDate, endTime, timezone, reasons);
    acc.datedSeen = true;
    if (to <= fetchedAt) {
      acc.past++;
      continue;
    }
    if (to - from > LONG_WINDOW_MS) reasons.add("long_window");
    const pattern: MaintenancePattern = {
      kind: "once",
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    };
    if (!validMaintenance(pattern)) {
      acc.rejected++;
      continue;
    }
    acc.windows.push({ timezone, pattern, reasons: sorted(reasons) });
  }
}

type RecurrenceShape =
  | { kind: "weekly"; weekdays: number[] }
  | { kind: "monthly"; weekday: number; nth: number; offsetDays: number };
/** The recurrence a segment starts with, and how many characters state it. */
function recurrence(segment: string): { length: number; shape: RecurrenceShape } | null {
  if (segment.startsWith("毎日"))
    return { length: 2, shape: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] } };
  const weekly = WEEKLY.exec(segment);
  if (weekly) {
    const days = [...weekly[1]!.matchAll(/([日月火水木金土])(?:曜日|曜)?/gu)].map((m) =>
      DAYS.indexOf(m[1]!),
    );
    return {
      length: weekly[0].length,
      shape: { kind: "weekly", weekdays: [...new Set(days)].sort((a, b) => a - b) },
    };
  }
  const monthly = MONTHLY.exec(segment);
  if (!monthly) return null;
  const after = monthly[3];
  return {
    length: monthly[0].length,
    shape: {
      kind: "monthly",
      nth: Number(monthly[1]),
      weekday: DAYS.indexOf(monthly[2]!),
      offsetDays:
        after === undefined
          ? 0
          : after === "翌日"
            ? 1
            : after === "翌々日"
              ? 2
              : Number(monthly[4]),
    },
  };
}

/** Recurring windows: 毎週X曜日 / 毎日 / 毎月第N X曜日(の翌日) followed by a time range. */
function recurringWindows(
  line: string,
  lineReasons: ProposalReason[],
  timezone: string,
  fetchedAt: number,
  acc: Accumulator,
) {
  const starts = [...line.matchAll(RECURRENCE)].map((m) => m.index);
  starts.forEach((index, n) => {
    const segment = line.slice(index, starts[n + 1] ?? line.length);
    const stated = recurrence(segment);
    if (!stated) {
      acc.rejected++;
      return;
    }
    const { shape } = stated;
    const rest = segment.slice(stated.length);
    // Only time expressions: a date inside the segment is the dated grammar's.
    const list = tokens(rest, fetchedAt).filter(
      (t) => !t.at.isCertain("day") && !t.at.isCertain("month"),
    );
    const i = list.findIndex((t) => t.at.isCertain("hour"));
    // The time follows the recurrence directly: "毎週月曜日～金曜日 2:00～5:00"
    // is a day range this grammar does not hold, not a Monday window.
    const lead = i < 0 ? "" : rest.slice(0, list[i]!.index);
    const joined = i < 0 || !/^[\s(:の]*$/u.test(lead) ? null : joinRange(rest, list, i);
    if (!joined || !joined.end.isCertain("hour")) {
      acc.rejected++;
      return;
    }
    const start = hhmm(list[i]!.at),
      end = hhmm(joined.end);
    // The end's day: the start's, or the next when 翌 or the next weekday says so.
    let nextDay: boolean | null = joined.nextDay ? true : null;
    if (joined.weekday !== null) {
      const delta =
        shape.kind === "weekly" && shape.weekdays.length === 1
          ? (joined.weekday - shape.weekdays[0]! + 7) % 7
          : -1;
      if (delta !== 0 && delta !== 1) {
        acc.rejected++;
        return;
      }
      nextDay = delta === 1;
    }
    // Longer than a day, or a same-day end before its start: not a window the model holds.
    if (start === end || (nextDay === true && end > start) || (nextDay === false && end < start)) {
      acc.rejected++;
      return;
    }
    const reasons = new Set<ProposalReason>(lineReasons);
    if (nextDay === null && end < start) reasons.add("end_next_day_inferred");
    const date = localCalendarDate(fetchedAt, timezone);
    zoneReason(list[i]!.at, date, start, timezone, reasons);
    zoneReason(joined.end, date, end, timezone, reasons);
    const pattern: MaintenancePattern = { ...shape, start, end };
    if (!validMaintenance(pattern)) {
      acc.rejected++;
      return;
    }
    acc.recurringSeen = true;
    acc.windows.push({ timezone, pattern, reasons: sorted(reasons) });
  });
}

/** One key per window; weekday lists are compared as sets, dated windows by instant. */
export function patternKey(timezone: string, p: MaintenancePattern): string {
  if (p.kind === "once") return `once|${Date.parse(p.from)}|${Date.parse(p.to)}`;
  if (p.kind === "weekly")
    return `${timezone}|weekly|${[...p.weekdays].sort((a, b) => a - b).join(",")}|${p.start}|${p.end}`;
  return `${timezone}|monthly|${p.weekday}|${p.nth}|${p.offsetDays}|${p.start}|${p.end}`;
}

/**
 * Whether two daily time ranges ("HH:MM", an end before the start running into
 * the next day) share a minute, on the same start day.
 */
export function clockOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  const span = (r: { start: string; end: string }) => {
    const [sh, sm] = r.start.split(":").map(Number);
    const [eh, em] = r.end.split(":").map(Number);
    const start = sh! * 60 + sm!;
    const end = eh! * 60 + em!;
    return [start, end <= start ? end + 1440 : end] as const;
  };
  const [as, ae] = span(a),
    [bs, be] = span(b);
  return as < be && bs < ae;
}

/** Two different windows on one page that cannot both be the provider's statement. */
function contradicts(a: WindowCandidate, b: WindowCandidate): boolean {
  const p = a.pattern,
    q = b.pattern;
  if (p.kind === "weekly" && q.kind === "weekly")
    return (
      a.timezone === b.timezone &&
      p.weekdays.some((d) => q.weekdays.includes(d)) &&
      clockOverlap(p, q)
    );
  if (p.kind === "monthly" && q.kind === "monthly")
    return (
      a.timezone === b.timezone &&
      p.weekday === q.weekday &&
      p.nth === q.nth &&
      p.offsetDays === q.offsetDays &&
      clockOverlap(p, q)
    );
  if (p.kind === "once" && q.kind === "once") return p.from === q.from || p.to === q.to;
  return false;
}

/**
 * Every window the page's lines state, by the closed grammar above. Lines are
 * NFKC-normalised first (full-width digits, colons and tildes). Identical
 * windows stated twice are one; different, overlapping windows of the same
 * recurrence, or dated ones with the same start or end, are each
 * `contradictory_windows`.
 */
export function extractWindows(
  lines: readonly string[],
  options: { timezone: string; fetchedAt: number },
): Extraction {
  const acc: Accumulator = {
    windows: [],
    past: 0,
    rejected: 0,
    recurringSeen: false,
    datedSeen: false,
  };
  for (const raw of lines) {
    const line = raw.normalize("NFKC");
    if (!/\d/u.test(line)) continue;
    const lineReasons = LINE_REASONS.filter(([, pattern]) => pattern.test(line)).map(([r]) => r);
    datedWindows(line, lineReasons, options.timezone, options.fetchedAt, acc);
    recurringWindows(line, lineReasons, options.timezone, options.fetchedAt, acc);
  }
  const unique = new Map<string, WindowCandidate>();
  for (const w of acc.windows) {
    const key = patternKey(w.timezone, w.pattern);
    const seen = unique.get(key);
    unique.set(key, seen ? { ...seen, reasons: sorted([...seen.reasons, ...w.reasons]) } : w);
  }
  const windows = [...unique.values()];
  for (const a of windows)
    if (windows.some((b) => b !== a && contradicts(a, b)))
      a.reasons = sorted([...a.reasons, "contradictory_windows"]);
  return { ...acc, windows };
}
