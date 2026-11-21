// `parseQueryInstant` replaced two copies of one rule: `instantOf` in
// services/app/src/events-api.ts (the activity list's `since` and `before`)
// and `checkedSince` in packages/application/src/query/changes-since.ts
// (`kogane.changes.since`). Both are frozen here as they shipped, beside
// their rewrites, and compared on seeded random strings, well formed and
// not. The one difference allowed is the documented `changes.since` fix: a
// real time written in the years 0 to 99 was `since:format`, because
// `Date.UTC` read its year as 1900 to 1999, and is now `since:too_old`.
import { describe, expect, test } from "bun:test";
import { parseQueryInstant } from "../src/query-instant.ts";
import { between, pad2, pick, seededRandom, type Random } from "./property.ts";

type Checked = { since: string } | { refusal: string };
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 31;

// Frozen: events-api.ts `instantOf` before it called `parseQueryInstant`.
const LEGACY_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
function legacyInstantOf(text: string): string | null {
  const parts = LEGACY_INSTANT.exec(text);
  const at = Date.parse(text);
  if (parts === null || !Number.isFinite(at)) return null;
  const [, year, month, day, hour, minute, second = "0"] = parts;
  const civil = new Date(0);
  civil.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  civil.setUTCHours(Number(hour), Number(minute), Number(second));
  if (
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    civil.getUTCHours() !== Number(hour) ||
    civil.getUTCMinutes() !== Number(minute) ||
    civil.getUTCSeconds() !== Number(second)
  )
    return null;
  const iso = new Date(at).toISOString();
  return /^\d{4}-/u.test(iso) ? iso : null;
}

// Frozen: changes-since.ts `checkedSince` before it called `parseQueryInstant`.
const LEGACY_SINCE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
function legacyCheckedSince(value: unknown, now: number): Checked {
  if (typeof value !== "string" || !LEGACY_SINCE.test(value)) return { refusal: "since:format" };
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return { refusal: "since:format" };
  const [, year, month, day, hour, minute, second = "0"] =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(value)!;
  const civil = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  if (
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    civil.getUTCHours() !== Number(hour) ||
    civil.getUTCMinutes() !== Number(minute) ||
    civil.getUTCSeconds() !== Number(second)
  )
    return { refusal: "since:format" };
  if (at > now) return { refusal: "since:future" };
  if (at < now - MAX_DAYS * DAY_MS) return { refusal: "since:too_old" };
  return { since: new Date(at).toISOString() };
}

// The rewrites, as the two callers now read `parseQueryInstant`.
function instantOf(text: string): string | null {
  const parsed = parseQueryInstant(text);
  return parsed.ok ? parsed.iso : null;
}
function checkedSince(value: unknown, now: number): Checked {
  if (typeof value !== "string") return { refusal: "since:format" };
  const parsed = parseQueryInstant(value);
  if (!parsed.ok && parsed.reason === "format") return { refusal: "since:format" };
  const at = parsed.epochMs;
  if (at > now) return { refusal: "since:future" };
  if (at < now - MAX_DAYS * DAY_MS) return { refusal: "since:too_old" };
  return { since: new Date(at).toISOString() };
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const ALPHABET = "0123456789-:T.Z+ zt\n,";

function year(random: Random): number {
  return pick(random, [
    () => between(random, 0, 120),
    () => between(random, 9980, 9999),
    () => between(random, 0, 9999),
    () => between(random, 1895, 2105),
    () => pick(random, [0, 4, 99, 100, 200, 400, 1900, 2000, 2100, 9996, 9999]),
  ])();
}

/** The written form with each field mostly in range and sometimes just past it. */
function written(random: Random): string {
  const mostly = (from: number, to: number, past: number[], share = 0.85) =>
    random() < share ? between(random, from, to) : pick(random, past);
  const month = mostly(1, 12, [0, 13, 99]);
  const day = random() < 0.7 ? between(random, 1, 28) : between(random, 0, 32);
  let time = `${pad2(mostly(0, 23, [24, 25, 99]))}:${pad2(mostly(0, 59, [60, 99], 0.9))}`;
  if (random() < 0.7) {
    time += `:${pad2(mostly(0, 59, [60, 61, 99]))}`;
    if (random() < 0.5)
      time += `.${pad(between(random, 0, 9999), 4).slice(0, between(random, 1, 4))}`;
  }
  const zone =
    random() < 0.3
      ? pick(random, ["Z", "z", "", "+0900", "+09", "UTC"])
      : `${pick(random, ["+", "-"])}${pad2(mostly(0, 23, [24, 25, 99]))}:${pad2(mostly(0, 59, [60, 99], 0.9))}`;
  const separator = random() < 0.97 ? "T" : pick(random, [" ", "t"]);
  return `${pad(year(random), 4)}-${pad2(month)}-${pad2(day)}${separator}${time}${zone}`;
}

/** A time within days of `now`, in a random offset and precision, so the window is crossed. */
function nearNow(random: Random, now: number): string {
  const at = now - between(random, -2 * DAY_MS, 33 * DAY_MS);
  const offset = between(random, -(23 * 60 + 59), 23 * 60 + 59);
  const local = new Date(at + offset * 60_000).toISOString();
  const zone =
    random() < 0.3
      ? "Z"
      : `${offset < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  return `${local.slice(0, pick(random, [16, 19, 21, 23]))}${zone}`;
}

function mutated(random: Random, text: string): string {
  let out = text;
  for (let edits = between(random, 1, 3); edits > 0; edits -= 1) {
    const at = between(random, 0, out.length);
    const char = pick(random, [...ALPHABET]);
    const op = between(random, 0, 2);
    out =
      op === 0
        ? out.slice(0, at) + out.slice(at + 1)
        : op === 1
          ? out.slice(0, at) + char + out.slice(at)
          : out.slice(0, at) + char + out.slice(at + 1);
  }
  return out;
}

const NOWS = [Date.parse("2026-11-21T00:00:00.000Z"), Date.parse("2099-03-02T00:00:00.000Z"), 0];
const code = (checked: Checked) => ("since" in checked ? "ok" : checked.refusal);

describe("parseQueryInstant against the two checks it replaced", () => {
  test("seeded random strings: the same answers but the documented years 0 to 99", () => {
    const random = seededRandom(1493);
    const seen = new Map<string, number>();
    let allowed = 0;
    for (let round = 0; round < 40_000; round += 1) {
      const now = random() < 0.8 ? pick(random, NOWS) : between(random, 0, 7_258_118_400_000);
      const kind = random();
      const text =
        kind < 0.45
          ? written(random)
          : kind < 0.65
            ? nearNow(random, now)
            : kind < 0.9
              ? mutated(random, random() < 0.5 ? written(random) : nearNow(random, now))
              : Array.from({ length: between(random, 0, 30) }, () =>
                  pick(random, [...ALPHABET]),
                ).join("");
      expect({ text, iso: instantOf(text) }).toEqual({ text, iso: legacyInstantOf(text) });
      const before = legacyCheckedSince(text, now);
      const after = checkedSince(text, now);
      seen.set(code(after), (seen.get(code(after)) ?? 0) + 1);
      if (code(before) !== code(after) && Number(/^(\d{4})-/u.exec(text)?.[1] ?? 100) <= 99) {
        expect({ text, before: code(before), after: code(after) }).toEqual({
          text,
          before: "since:format",
          after: "since:too_old",
        });
        allowed += 1;
      } else expect({ text, now, after }).toEqual({ text, now, after: before });
    }
    // Every answer is reached, and the fix is exercised.
    expect([...seen.keys()].sort()).toEqual([
      "ok",
      "since:format",
      "since:future",
      "since:too_old",
    ]);
    expect(seen.get("ok")!).toBeGreaterThan(1_000);
    expect(allowed).toBeGreaterThan(100);
    for (const value of [undefined, null, 42, {}, ["2026-01-01T00:00Z"]])
      expect(checkedSince(value, NOWS[0]!)).toEqual(legacyCheckedSince(value, NOWS[0]!));
  });
});
