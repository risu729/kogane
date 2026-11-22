// The `lanes` block of `/status` (`laneJobCounts` in worker.ts). Migration
// 0035's CHECK keeps `observation_parse_jobs.lane` to the three lanes, so the
// rows below that name another lane are ones the store refuses today; they
// pin that the tally skips them by own key instead of writing counts onto an
// inherited member such as `Object.prototype`.
import { expect, test } from "bun:test";
import { laneJobCounts } from "../src/worker.ts";

const NOW = 1_000_000;
const rows = [
  { lane: "incremental", status: "pending", count: 3, oldest: NOW - 50 },
  { lane: "incremental", status: "done", count: 7, oldest: null },
  { lane: "repair", status: "failed", count: 2, oldest: null },
  { lane: "replay", status: "running", count: 1, oldest: null },
  { lane: "replay", status: "pending", count: 4, oldest: NOW - 9 },
];
const tallied = {
  incremental: { pending: 3, running: 0, done: 7, failed: 0, oldestPendingAgeMs: 50 },
  repair: { pending: 0, running: 0, done: 0, failed: 2, oldestPendingAgeMs: null },
  replay: { pending: 4, running: 1, done: 0, failed: 0, oldestPendingAgeMs: 9 },
};

test("every lane the CHECK allows is tallied in a fixed shape and order", () => {
  const lanes = laneJobCounts(rows, NOW);
  expect(lanes).toEqual(tallied);
  expect(JSON.stringify(lanes)).toBe(JSON.stringify(tallied));
  expect(JSON.stringify(laneJobCounts([], NOW))).toBe(
    JSON.stringify({
      incremental: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
      repair: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
      replay: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
    }),
  );
});

test("a lane named like a built-in property is skipped and writes onto nothing it inherits", () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "unknown"];
  const targets = [
    Object.prototype,
    Object,
    Object.prototype.toString,
    Object.prototype.hasOwnProperty,
    Object.prototype.valueOf,
  ];
  const keys = ["pending", "oldestPendingAgeMs"];
  try {
    const stray = names.map((lane) => ({ lane, status: "pending", count: 99, oldest: NOW - 1 }));
    expect(JSON.stringify(laneJobCounts([...stray, ...rows], NOW))).toBe(JSON.stringify(tallied));
    for (const target of targets)
      for (const key of keys) expect(Object.hasOwn(target, key)).toBe(false);
  } finally {
    // A regression would leave the shared runtime polluted for later files.
    for (const target of targets) for (const key of keys) Reflect.deleteProperty(target, key);
  }
});
