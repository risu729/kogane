// The payable window's due-date check (`DATED_STATEMENTS_SQL` and
// `DATED_STATEMENTS_BEFORE_WINDOW_SQL`) against the reads as shipped before it
// checked a calendar date (dated-state-statements-legacy-sql.ts). A due date
// is readable only when `payableStatus` reads it (`parseLocalDate`): a
// `YYYY-MM-DD` text that names a real day. The frozen text took any text of
// that shape, so an impossible day such as 2026-02-30 was placed by its text
// (listed, or counted as due before the window) while the code reads it as no
// due date (INV05). On random and scaled synthetic stores the shipped reads
// return exactly the frozen rows and counts for every other due date, and move
// only the impossible days to the undated side; without table statistics
// their plans are the frozen ones step for step. Synthetic values only.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  payableStatus,
  payablesFromPaymentDate,
  reportedStateCutoff,
  UNDATED_STATEMENT_WINDOW_DAYS,
} from "../../domain/src/reported-state";
import { parseLocalDate } from "../../domain/src/time";
import {
  DATED_STATEMENTS_BEFORE_WINDOW_SQL,
  DATED_STATEMENTS_SQL,
  type DatedStatementRow,
  type DatedStatementsBeforeWindowRow,
} from "../src/dated-state";
import { STATEMENT_CI_SCALE, scaledStore } from "./card-usage-scale-fixture";
import { DatedStore } from "./dated-state-fixture";
import {
  LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL,
  LEGACY_DATED_STATEMENTS_SHA256,
  LEGACY_DATED_STATEMENTS_SQL,
} from "./dated-state-statements-legacy-sql";

const SHAPE = "payment_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
const CALENDAR = `${SHAPE} AND date(payment_date,'+0 days')=payment_date`;

/** mulberry32: a small seeded generator, so a failing seed replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A due date the code reads: `payableStatus` gives it no `payment_date_unknown`. */
const readable = (paymentDate: string | null): boolean =>
  paymentDate !== null && parseLocalDate(paymentDate) !== null;

/**
 * A due date the frozen text took as readable and the code does not: the
 * `YYYY-MM-DD` shape as SQLite's GLOB sees it (it stops at a NUL), not a day.
 */
const impossible = (paymentDate: string | null): boolean =>
  paymentDate !== null &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(paymentDate.split("\0")[0]!) &&
  !readable(paymentDate);

/** Days of the shape that name no day, in every way a field can miss one. */
const IMPOSSIBLE = [
  "2026-02-30",
  "2026-02-29",
  "2025-02-29",
  "1900-02-29",
  "2026-04-31",
  "2026-06-31",
  "2026-09-31",
  "2026-11-31",
  "2026-08-32",
  "2026-09-00",
  "2026-00-15",
  "2026-13-01",
  "2026-99-99",
  "2026-09-26\0x",
] as const;
/** Due-date text of another shape, which both texts read as none. */
const UNSHAPED = ["unknown", "2026/09/26", "2026-9-26", "2026-09-26T00:00", " 2026-09-26"] as const;

/** The bounds the query layer passes for `date` (queryDatedState). */
function window(date: string): { date: string; cutoff: string; from: string; undated: string } {
  const cutoff = reportedStateCutoff(date);
  return {
    date,
    cutoff,
    from: payablesFromPaymentDate(date),
    undated: new Date(
      Date.parse(cutoff) - UNDATED_STATEMENT_WINDOW_DAYS * 86_400_000,
    ).toISOString(),
  };
}
const WINDOWS = ["2026-09-10", "2026-05-20", "2026-11-01"].map(window);

const dayBefore = (date: string): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * 30 statements over four Vpass cards, each due on a real day (a window's
 * first listed due date and the day before among them), on none, on text of
 * another shape, or (with `withImpossible`) on an impossible day, captured
 * across 2026 or on a window's undated bound.
 */
function randomStore(seed: number, withImpossible: boolean): DatedStore {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const store = new DatedStore();
  for (let index = 0; index < 30; index += 1) {
    const at = pick(WINDOWS);
    const month = String(1 + Math.floor(next() * 12)).padStart(2, "0");
    const day = String(1 + Math.floor(next() * 28)).padStart(2, "0");
    const kind = next();
    const paymentDate =
      kind < 0.1
        ? null
        : kind < 0.2
          ? pick(UNSHAPED)
          : withImpossible && kind < 0.5
            ? pick(IMPOSSIBLE)
            : kind < 0.6
              ? pick([at.from, dayBefore(at.from), "2024-02-29", "2026-12-31"])
              : `2026-${month}-${day}`;
    const fetchedAt =
      next() < 0.2
        ? next() < 0.5
          ? at.undated
          : new Date(Date.parse(at.undated) - 1).toISOString()
        : `2026-${String(1 + Math.floor(next() * 11)).padStart(2, "0")}-${day}T0${Math.floor(next() * 10)}:00:00Z`;
    const card = `card-${Math.floor(next() * 4)}`;
    const capture = store.statement({
      card,
      // Distinct periods mostly, so most statements are the newest of their key.
      period: `${2000 + index}-${month}`,
      paymentDate,
      minor: 1 + Math.floor(next() * 9_000),
      fetchedAt,
    });
    if (next() < 0.6) store.identify(capture, "vpass", `acct-${card}`, "identified");
  }
  return store;
}

function listed(
  store: DatedStore,
  sql: string,
  w: { cutoff: string; from: string; undated: string },
): DatedStatementRow[] {
  return store.db.query(sql).all(w.cutoff, w.from, w.undated) as DatedStatementRow[];
}
function counted(
  store: DatedStore,
  sql: string,
  w: { cutoff: string; from: string; undated: string },
): Record<string, number> {
  const rows = store.db
    .query(sql)
    .all(w.cutoff, w.from, w.undated) as DatedStatementsBeforeWindowRow[];
  return Object.fromEntries(
    rows.map((row) => [
      JSON.stringify([row.source_id, row.account_id, row.reason_code]),
      row.statements,
    ]),
  );
}

describe("the frozen statement reads", () => {
  test("are the texts that shipped", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sha(LEGACY_DATED_STATEMENTS_SQL)).toBe(LEGACY_DATED_STATEMENTS_SHA256.statements);
    expect(sha(LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL)).toBe(
      LEGACY_DATED_STATEMENTS_SHA256.beforeWindow,
    );
  });

  test("differ from the shipped reads only by the calendar check on each shape test", () => {
    const withCalendar = (text: string) => text.replaceAll(`WHEN ${SHAPE}\n`, `WHEN ${CALENDAR}\n`);
    expect(LEGACY_DATED_STATEMENTS_SQL.split(SHAPE)).toHaveLength(2);
    expect(LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL.split(SHAPE)).toHaveLength(3);
    expect(withCalendar(LEGACY_DATED_STATEMENTS_SQL)).toBe(DATED_STATEMENTS_SQL);
    expect(withCalendar(LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL)).toBe(
      DATED_STATEMENTS_BEFORE_WINDOW_SQL,
    );
  });
});

describe("a due date is readable exactly when the code reads it", () => {
  // Every month 00–13 and day 00–32 of years with and without a leap day
  // (0000 and 2000 are leap years, 1900 is not), and text of other shapes.
  const candidates = [
    ...["0000", "1900", "2000", "2024", "2025", "2026", "9999"].flatMap((year) =>
      Array.from({ length: 14 * 33 }, (_, index) => {
        const month = String(Math.floor(index / 33)).padStart(2, "0");
        const day = String(index % 33).padStart(2, "0");
        return `${year}-${month}-${day}`;
      }),
    ),
    ...IMPOSSIBLE,
    ...UNSHAPED,
  ];

  test("each candidate is listed by its due date only when it names a real day", () => {
    const store = new DatedStore();
    for (const [index, paymentDate] of candidates.entries())
      store.statement({
        card: `card-${index}`,
        period: "2026-01",
        paymentDate,
        minor: 1,
        fetchedAt: "2026-01-05T01:00:00Z",
      });
    // Every readable due date is on or after "", no capture is on or after "~":
    // the listed statements are exactly those with a readable due date.
    const shown = listed(store, DATED_STATEMENTS_SQL, {
      cutoff: reportedStateCutoff("2026-09-10"),
      from: "",
      undated: "~",
    }).map((row) => row.payment_date);
    const expected = candidates.filter(readable);
    expect(shown.slice().sort()).toEqual(expected.slice().sort());
    expect(expected.length).toBeGreaterThan(2_000);
    expect(candidates.length - expected.length).toBeGreaterThan(600);
    // The frozen text listed every impossible day of the shape as well.
    const frozen = listed(store, LEGACY_DATED_STATEMENTS_SQL, {
      cutoff: reportedStateCutoff("2026-09-10"),
      from: "",
      undated: "~",
    }).map((row) => row.payment_date);
    expect(frozen.slice().sort()).toEqual(
      candidates
        .filter((date) => readable(date) || impossible(date))
        .slice()
        .sort(),
    );
  }, 60_000);
});

describe("the shipped statement reads against the frozen text", () => {
  test("on random stores without an impossible day, both reads return the frozen result", () => {
    let rows = 0;
    let counts = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const store = randomStore(seed, false);
      for (const w of WINDOWS) {
        const shipped = listed(store, DATED_STATEMENTS_SQL, w);
        expect({ seed, date: w.date, rows: shipped }).toEqual({
          seed,
          date: w.date,
          rows: listed(store, LEGACY_DATED_STATEMENTS_SQL, w),
        });
        const shippedCounts = counted(store, DATED_STATEMENTS_BEFORE_WINDOW_SQL, w);
        expect({ seed, date: w.date, counts: shippedCounts }).toEqual({
          seed,
          date: w.date,
          counts: counted(store, LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL, w),
        });
        rows += shipped.length;
        counts += Object.keys(shippedCounts).length;
      }
    }
    expect(rows).toBeGreaterThan(100);
    expect(counts).toBeGreaterThan(50);
  }, 60_000);

  test("on random stores, only the impossible days move, and to the undated side", () => {
    // Impossible days the frozen text counted as due before the window that
    // are now listed, and ones it listed that are now counted as undated.
    const moved = { toListed: 0, toUndated: 0, stayedListed: 0, stayedCounted: 0 };
    for (let seed = 1; seed <= 40; seed += 1) {
      const store = randomStore(seed, true);
      for (const w of WINDOWS) {
        const every = listed(store, DATED_STATEMENTS_SQL, { ...w, from: "", undated: "" });
        // The statements as of the cutoff are the same under both texts.
        expect(every).toEqual(
          listed(store, LEGACY_DATED_STATEMENTS_SQL, { ...w, from: "", undated: "" }),
        );
        const shipped = listed(store, DATED_STATEMENTS_SQL, w);
        const legacy = listed(store, LEGACY_DATED_STATEMENTS_SQL, w);
        const other = (row: DatedStatementRow) => !impossible(row.payment_date);
        // Every other due date is listed exactly as before, in the same order.
        expect({ seed, date: w.date, rows: shipped.filter(other) }).toEqual({
          seed,
          date: w.date,
          rows: legacy.filter(other),
        });
        // An impossible day is undated: listed when captured on or after the
        // undated bound, and then its status is payment_date_unknown.
        const impossibleRows = every.filter((row) => impossible(row.payment_date));
        expect(shipped.filter((row) => !other(row)).map((row) => row.id)).toEqual(
          impossibleRows.filter((row) => row.fetched_at >= w.undated).map((row) => row.id),
        );
        for (const row of shipped)
          if (!other(row))
            expect(payableStatus(w.date, row.payment_date, null)).toBe("payment_date_unknown");
        // The counts differ from the frozen ones by exactly those moves.
        const expected = counted(store, LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL, w);
        for (const row of impossibleRows) {
          const wasListed = row.payment_date! >= w.from;
          const isListed = row.fetched_at >= w.undated;
          const key = (reason: string) => JSON.stringify([row.source_id, row.account_id, reason]);
          if (!wasListed) {
            const before = key("due_before_window");
            expected[before] = expected[before]! - 1;
            if (expected[before] === 0) delete expected[before];
          }
          if (!isListed) {
            const after = key("undated_captured_before_window");
            expected[after] = (expected[after] ?? 0) + 1;
          }
          moved[
            wasListed
              ? isListed
                ? "stayedListed"
                : "toUndated"
              : isListed
                ? "toListed"
                : "stayedCounted"
          ] += 1;
        }
        expect({
          seed,
          date: w.date,
          counts: counted(store, DATED_STATEMENTS_BEFORE_WINDOW_SQL, w),
        }).toEqual({
          seed,
          date: w.date,
          counts: expected,
        });
      }
    }
    // Every way an impossible day can move, or stay, is exercised.
    for (const [way, count] of Object.entries(moved))
      expect({ way, count }).not.toEqual({
        way,
        count: 0,
      });
  }, 60_000);

  test("without table statistics, the shipped plans are the frozen plans step for step", () => {
    const store = randomStore(7, true);
    expect(
      store.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    const plan = (sql: string) =>
      (
        store.db
          .query(`EXPLAIN QUERY PLAN ${sql}`)
          .all(
            ...([WINDOWS[0]!.cutoff, WINDOWS[0]!.from, WINDOWS[0]!.undated] as SQLQueryBindings[]),
          ) as {
          detail: string;
        }[]
      ).map((step) => step.detail);
    for (const [shipped, legacy] of [
      [DATED_STATEMENTS_SQL, LEGACY_DATED_STATEMENTS_SQL],
      [DATED_STATEMENTS_BEFORE_WINDOW_SQL, LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL],
    ] as const) {
      const frozen = plan(legacy);
      expect(frozen.length).toBeGreaterThan(5);
      expect(plan(shipped)).toEqual(frozen);
    }
  });

  // bun:sqlite takes longer patterns than D1, which refuses a GLOB pattern over
  // 50 bytes as "too complex" and so fails the whole read.
  test("every GLOB pattern of both reads fits D1's pattern length limit", () => {
    for (const sql of [DATED_STATEMENTS_SQL, DATED_STATEMENTS_BEFORE_WINDOW_SQL]) {
      const patterns = [...sql.matchAll(/GLOB\s+'([^']*)'/gu)].map((match) => match[1]!);
      expect(patterns.length).toBeGreaterThan(0);
      expect(sql.split("GLOB").length - 1).toBe(patterns.length);
      for (const pattern of patterns)
        expect(new TextEncoder().encode(pattern).byteLength).toBeLessThanOrEqual(50);
    }
  });
});

describe("the shipped statement reads on the scaled store", () => {
  test("every due date of a recaptured history is a real day, and both reads return the frozen result", async () => {
    const { store } = await scaledStore(STATEMENT_CI_SCALE);
    const db = store.db;
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    let rows = 0;
    let counts = 0;
    const end = Date.parse(`${STATEMENT_CI_SCALE.today}T00:00:00Z`);
    for (const offset of [0, 30, 60, 99]) {
      const w = window(new Date(end - offset * 86_400_000).toISOString().slice(0, 10));
      const args = [w.cutoff, w.from, w.undated] as SQLQueryBindings[];
      const shipped = db.query(DATED_STATEMENTS_SQL).all(...args) as DatedStatementRow[];
      expect(shipped).toEqual(
        db.query(LEGACY_DATED_STATEMENTS_SQL).all(...args) as DatedStatementRow[],
      );
      for (const row of shipped)
        if (row.payment_date !== null) expect(readable(row.payment_date)).toBe(true);
      const shippedCounts = db.query(DATED_STATEMENTS_BEFORE_WINDOW_SQL).all(...args);
      expect(shippedCounts).toEqual(
        db.query(LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL).all(...args),
      );
      rows += shipped.length;
      counts += shippedCounts.length;
      const plan = (sql: string) =>
        (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
          (step) => step.detail,
        );
      expect(plan(DATED_STATEMENTS_SQL)).toEqual(plan(LEGACY_DATED_STATEMENTS_SQL));
      expect(plan(DATED_STATEMENTS_BEFORE_WINDOW_SQL)).toEqual(
        plan(LEGACY_DATED_STATEMENTS_BEFORE_WINDOW_SQL),
      );
    }
    expect(rows).toBeGreaterThan(10);
    expect(counts).toBeGreaterThan(0);
  }, 120_000);
});
