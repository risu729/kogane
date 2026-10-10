import { expect, test } from "bun:test";
import {
  afterMaintenance,
  deferralUnions,
  longestDeferral,
  nextNominal,
  validMaintenance,
  type MaintenanceRule,
} from "../src/schedule-model";
import { scheduledResult } from "../src/schedule-result";
import { withCollectionLease, type ScheduleLeaseDatabase } from "../src/schedule-lease";
const ms = (value: string) => Date.parse(value);
function rule(pattern: MaintenanceRule["pattern"]): MaintenanceRule {
  return {
    id: "synthetic",
    source: "synthetic",
    timezone: "Asia/Tokyo",
    pattern,
    enabled: true,
    referenceUrl: "https://example.com/maintenance",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    scope: "collection",
    revision: 1,
  };
}
test("monthly maintenance has exactly the declared six fields", () => {
  const pattern = {
    kind: "monthly",
    weekday: 6,
    nth: 3,
    offsetDays: 1,
    start: "01:00",
    end: "05:00",
  };
  expect(validMaintenance(pattern)).toBe(true);
  expect(validMaintenance({ ...pattern, extra: true })).toBe(false);
});
test("third Saturday's following Sunday is not the third Sunday", () => {
  const rules = [
    rule({ kind: "monthly", weekday: 6, nth: 3, offsetDays: 1, start: "01:00", end: "05:00" }),
  ];
  expect(afterMaintenance(ms("2026-11-21T17:00:00.000Z"), rules)).toBe(
    ms("2026-11-21T20:00:00.000Z"),
  );
  expect(afterMaintenance(ms("2026-11-14T17:00:00.000Z"), rules)).toBe(
    ms("2026-11-14T17:00:00.000Z"),
  );
});
test("cross-midnight and adjacent maintenance close to their union's end", () => {
  const rules = [
    rule({ kind: "weekly", weekdays: [6], start: "22:00", end: "08:00" }),
    rule({ kind: "weekly", weekdays: [0], start: "08:00", end: "09:00" }),
  ];
  expect(afterMaintenance(ms("2026-10-03T21:25:00.000Z"), rules)).toBe(
    ms("2026-10-04T00:00:00.000Z"),
  );
  expect(afterMaintenance(ms("2026-10-04T00:00:00.000Z"), rules)).toBe(
    ms("2026-10-04T00:00:00.000Z"),
  );
});
test("nonexistent Sydney wall time skips one day; repeated time executes once", () => {
  const daily = { kind: "daily" as const, time: "02:30", weekdays: [0, 1, 2, 3, 4, 5, 6] };
  expect(nextNominal(daily, "Australia/Sydney", ms("2026-10-03T14:00:00.000Z"))).toBe(
    ms("2026-10-04T15:30:00.000Z"),
  );
  const first = nextNominal(daily, "Australia/Sydney", ms("2026-04-04T14:00:00.000Z"));
  expect(first).toBe(ms("2026-04-04T15:30:00.000Z"));
  expect(nextNominal(daily, "Australia/Sydney", first)).toBe(ms("2026-04-05T16:30:00.000Z"));
});
test("nested VPoint manifests retain failed status and exact safe run reference", () => {
  expect(
    scheduledResult({
      manifest: { status: "failed", runId: "synthetic-run" },
      terminal: { persisted: true },
    }),
  ).toEqual({ status: "failed", runIds: ["synthetic-run"], failureCode: "collection_failed" });
  expect(
    scheduledResult({
      manifest: { status: "success", runId: "synthetic-run" },
      terminal: { persisted: false },
    }).status,
  ).toBe("failed");
  expect(scheduledResult(null).status).toBe("failed");
  expect(
    scheduledResult({
      status: "success",
      runIds: ["session-card-001", "session-card-002", "session-card-001", "unsafe value"],
    }).runIds,
  ).toEqual(["session-card-001", "session-card-002"]);
});
test("a persistent active lease blocks provider entry; no time expiry is consulted", async () => {
  let ref: string | null = "interrupted",
    calls = 0;
  const db: ScheduleLeaseDatabase = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT")) return { meta: { changes: 0 } };
              if (sql.includes("lease_ref IS NULL")) {
                if (ref !== null) return { meta: { changes: 0 } };
                ref = String(values[0]);
                return { meta: { changes: 1 } };
              }
              if (ref === values[1]) ref = null;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
      calls++;
    }),
  ).rejects.toThrow("collection_busy_or_uncertain");
  expect(calls).toBe(0);
  expect(ref).toBe("interrupted");
  ref = null;
  await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
    calls++;
  });
  expect(calls).toBe(1);
  expect(ref).toBeNull();
});
test("the longest joined deferral is measured from each union's own start", () => {
  const hour = 3_600_000,
    day = 24 * hour,
    from = ms("2026-11-01T00:00:00.000Z");
  const dated = (start: number, end: number) =>
    rule({ kind: "once", from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  // Two adjacent dated windows join; a later short one stays its own union.
  const joined = [
    dated(from + day, from + 4 * day),
    dated(from + 4 * day, from + 6 * day),
    dated(from + 20 * day, from + 20 * day + hour),
  ];
  expect(longestDeferral(joined, from, 92 * day, 92 * day)).toBe(5 * day);
  // A window already running at `from` counts only what remains of it.
  expect(longestDeferral([dated(from - day, from + hour)], from, 92 * day, 92 * day)).toBe(hour);
  // A cross-midnight weekly window is measured from its start, not from `from`.
  const weekly = [rule({ kind: "weekly", weekdays: [6], start: "22:00", end: "08:00" })];
  expect(longestDeferral(weekly, from, 92 * day, 92 * day)).toBe(10 * hour);
  // Windows that cover every minute never end: the answer is "more than cap".
  const endless = [
    rule({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "12:00" }),
    rule({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], start: "12:00", end: "00:00" }),
  ];
  expect(longestDeferral(endless, from, 92 * day, 7 * day)).toBeGreaterThan(7 * day);
  expect(() => afterMaintenance(from, endless)).toThrow("maintenance_unavailable");
  // Disabled and feature-only rules defer nothing.
  expect(
    longestDeferral(
      [
        { ...dated(from, from + 30 * day), enabled: false },
        { ...weekly[0]!, scope: "feature-only" },
      ],
      from,
      92 * day,
      92 * day,
    ),
  ).toBe(0);
});
test("each joined deferral is reported with its own start and end", () => {
  const hour = 3_600_000,
    day = 24 * hour,
    from = ms("2026-11-01T00:00:00.000Z");
  const dated = (start: number, end: number) =>
    rule({ kind: "once", from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  // Separate unions stay separate, so a long one never hides another.
  const rules = [
    dated(from - day, from + hour),
    dated(from + day, from + 11 * day),
    dated(from + 30 * day, from + 38 * day),
    dated(from + 38 * day, from + 39 * day),
  ];
  expect(deferralUnions(rules, from, 92 * day, 92 * day)).toEqual([
    { start: from, end: from + hour },
    { start: from + day, end: from + 11 * day },
    { start: from + 30 * day, end: from + 39 * day },
  ]);
  expect(longestDeferral(rules, from, 92 * day, 92 * day)).toBe(10 * day);
  expect(deferralUnions([], from, 92 * day, 92 * day)).toEqual([]);
});
