import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readRecord, stateTimeoutFailureRecord, waitForState } from "../driver.mjs";

const name = "container-api-verification-state-timeout-failure.json";
const phases = ["baseline_sdk", "native", "native_unmonitored", "rollback_sdk"];
const stages = ["reader_resume_idle", "reader_cancel_idle", "signal_stop", "nonzero_exit_stop"];
const state = (phase = "baseline_sdk", startup = 3) => ({
  revision: phase === "rollback_sdk" ? "baseline_sdk" : phase,
  running: 1,
  sdkAlarmPresent: 1,
  [phase.startsWith("native") ? "starts" : "startCallbacks"]: startup,
  stops: 2,
  errors: 1,
  signaled: 0,
  exitSeven: 0,
});
const observation = (phase = "baseline_sdk", substage = stages[0]!, startup = 3) => ({
  code: "state_timeout_observation",
  phase,
  substage,
  running: 1,
  sdkAlarmPresent: 1,
  startup,
  stops: 2,
  errors: 1,
  signaled: 0,
  exitSeven: 0,
});
const directory = () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-state-timeout-"));
  chmodSync(temp, 0o700);
  return temp;
};
for (const substage of stages)
  test(`timeout ${substage} preserves the 90s/3s poll sequence and projects only its last state`, async () => {
    for (const phase of phases) {
      const temp = directory();
      let time = 0;
      const calls: string[] = [];
      let polls = 0;
      try {
        await expect(
          waitForState({
            temp,
            phase,
            substage,
            predicate: (value: { running: number }) => value.running === 0,
            now: () => time,
            sleep: async (ms: number) => {
              calls.push(`sleep:${ms}`);
              time += ms;
            },
            json: async (path: string) => {
              calls.push(path);
              polls++;
              return { ...state(phase, polls), private: "synthetic-private-provider-text" };
            },
          }),
        ).rejects.toThrow("verification_state_timeout");
        expect(time).toBe(90_000);
        expect(polls).toBe(30);
        expect(calls).toEqual(Array.from({ length: 30 }, () => ["/state", "sleep:3000"]).flat());
        expect(stateTimeoutFailureRecord(readRecord(temp, name))).toEqual(
          observation(phase, substage, 30),
        );
        expect(statSync(resolve(temp, name)).mode & 0o777).toBe(0o600);
        expect(statSync(resolve(temp, name)).size).toBeLessThanOrEqual(1024);
        expect(readFileSync(resolve(temp, name), "utf8")).not.toContain("private");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  });
test("successful polling returns immediately with no artifact, including a late existing response", async () => {
  for (const late of [false, true]) {
    const temp = directory();
    let time = 0,
      polls = 0;
    const calls: string[] = [];
    const stopped = { ...state(), running: 0 };
    try {
      const result = await waitForState({
        temp,
        phase: "baseline_sdk",
        substage: stages[0],
        predicate: (value: { running: number }) => value.running === 0,
        now: () => time,
        sleep: async (ms: number) => {
          calls.push(`sleep:${ms}`);
          time += ms;
        },
        json: async (path: string) => {
          calls.push(path);
          polls++;
          if (late) time = 95_000;
          return late || polls === 2 ? stopped : state();
        },
      });
      expect(result).toBe(stopped);
      expect(calls).toEqual(late ? ["/state"] : ["/state", "sleep:3000", "/state"]);
      expect(existsSync(resolve(temp, name))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});
test("existing request errors remain primary and create no timeout observation", async () => {
  const temp = directory();
  try {
    await expect(
      waitForState({
        temp,
        phase: "baseline_sdk",
        substage: stages[0],
        predicate: () => false,
        json: async () => {
          throw new Error("verification_http_state_outer_not_found");
        },
      }),
    ).rejects.toThrow("verification_http_state_outer_not_found");
    expect(existsSync(resolve(temp, name))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("malformed last-state projections cannot replace the original timeout or retain private text", async () => {
  for (const invalid of [
    { ...state(), revision: "native" },
    { ...state(), startCallbacks: "synthetic-secret" },
    { ...state(), stops: -1 },
    { ...state(), errors: Number.NaN },
    { ...state(), sdkAlarmPresent: 2 },
    null,
  ]) {
    const temp = directory();
    let time = 0;
    try {
      await expect(
        waitForState({
          temp,
          phase: "baseline_sdk",
          substage: stages[0],
          predicate: () => false,
          now: () => time,
          sleep: async (ms: number) => {
            time += ms;
          },
          json: async () => invalid,
        }),
      ).rejects.toThrow("verification_state_timeout");
      expect(existsSync(resolve(temp, name))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});
test("state-timeout records accept only exact closed keys and finite safe counters", () => {
  expect(stateTimeoutFailureRecord(observation())).toEqual(observation());
  for (const invalid of [
    null,
    [],
    { ...observation(), private: "synthetic-secret" },
    { ...observation(), code: "synthetic-secret" },
    { ...observation(), phase: "synthetic-secret" },
    { ...observation(), phase: "native_recovered" },
    { ...observation(), substage: "synthetic-secret" },
    { ...observation(), running: 0 },
    { ...observation(), sdkAlarmPresent: 2 },
    ...["startup", "stops", "errors", "signaled", "exitSeven"].flatMap((key) =>
      [undefined, null, "synthetic-secret", -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (value) => ({ ...observation(), [key]: value }),
      ),
    ),
  ])
    expect(() => stateTimeoutFailureRecord(invalid)).toThrow("verification_state_timeout_record");
});
test("O_EXCL retains the first observation and persistence errors preserve the primary timeout", async () => {
  const temp = directory();
  const run = async (substage: string) => {
    let time = 0;
    return waitForState({
      temp,
      phase: "baseline_sdk",
      substage,
      predicate: () => false,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      json: async () => state(),
    });
  };
  try {
    await expect(run(stages[0]!)).rejects.toThrow("verification_state_timeout");
    const first = readFileSync(resolve(temp, name), "utf8");
    await expect(run(stages[2]!)).rejects.toThrow("verification_state_timeout");
    expect(readFileSync(resolve(temp, name), "utf8")).toBe(first);
    rmSync(resolve(temp, name));
    const target = resolve(temp, "untouched.txt");
    writeFileSync(target, "synthetic-private", { mode: 0o600 });
    symlinkSync(target, resolve(temp, name));
    await expect(run(stages[1]!)).rejects.toThrow("verification_state_timeout");
    expect(readFileSync(target, "utf8")).toBe("synthetic-private");
    rmSync(resolve(temp, name));
    chmodSync(temp, 0o755);
    await expect(run(stages[3]!)).rejects.toThrow("verification_state_timeout");
    expect(existsSync(resolve(temp, name))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
