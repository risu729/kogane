import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CollectionLeaseAbort,
  LEASE_RELEASE_ATTEMPTS,
  withCollectionLease,
  type LeaseTiming,
  type ScheduleLeaseDatabase,
} from "../src/schedule-lease";
import { scheduledFailure } from "../src/schedule-result";

/**
 * One source's lease row in memory, with the three statements the lease uses.
 * `failClaimAfterCommit` writes the claim and then loses its answer;
 * `failReleases` rejects that many release statements before one runs.
 */
function leaseStore() {
  const state = {
    ref: null as string | null,
    startedAt: null as string | null,
    releaseCalls: 0,
    heartbeats: 0,
    failHeartbeats: false,
    /** Heartbeats that are sent but never answered. */
    hangHeartbeats: false,
    /** How long a heartbeat takes to run; it reads the lease when it runs. */
    heartbeatDelayMs: 0,
    heartbeatSql: [] as string[],
    failClaimAfterCommit: false,
    failClaimBeforeCommit: false,
    failReleases: 0,
  };
  const db: ScheduleLeaseDatabase = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (sql.startsWith("INSERT")) return { meta: { changes: 0 } };
              if (sql.includes("SET heartbeat_at=")) {
                state.heartbeatSql.push(sql);
                if (state.hangHeartbeats) return new Promise<never>(() => undefined);
                if (state.heartbeatDelayMs > 0)
                  await new Promise((resolve) => setTimeout(resolve, state.heartbeatDelayMs));
                if (state.failHeartbeats) throw new Error("synthetic d1 failure");
                if (state.ref !== values[1]) return { meta: { changes: 0 } };
                state.heartbeats += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("lease_ref IS NULL")) {
                if (state.failClaimBeforeCommit) throw new Error("synthetic d1 failure");
                if (state.ref !== null) return { meta: { changes: 0 } };
                state.ref = String(values[0]);
                state.startedAt = String(values[1]);
                if (state.failClaimAfterCommit) throw new Error("synthetic lost answer");
                return { meta: { changes: 1 } };
              }
              state.releaseCalls += 1;
              if (state.failReleases > 0) {
                state.failReleases -= 1;
                throw new Error("synthetic d1 failure");
              }
              if (state.ref === values[1]) {
                state.ref = null;
                state.startedAt = null;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { db, state };
}

let logged: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = [];
  errorSpy = spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});
afterEach(() => errorSpy.mockRestore());

test("a claim whose answer is lost clears its own lease and contacts nobody", async () => {
  const { db, state } = leaseStore();
  state.failClaimAfterCommit = true;
  let calls = 0;
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
      calls += 1;
    }),
  ).rejects.toThrow("synthetic lost answer");
  expect(calls).toBe(0);
  expect(state.ref).toBeNull();
  expect(logged).toEqual([]);
  // The next execution is not refused as busy.
  state.failClaimAfterCommit = false;
  await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
    calls += 1;
  });
  expect(calls).toBe(1);
  expect(state.ref).toBeNull();
});

test("a lost claim answer is a failed collection, not a busy source", async () => {
  const { db, state } = leaseStore();
  state.failClaimAfterCommit = true;
  const error = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    async () => undefined,
  ).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(scheduledFailure(error).failureCode).toBe("collection_failed");
});

test("a lost claim answer whose clearing fails every attempt reports the claim's error and logs", async () => {
  const { db, state } = leaseStore();
  state.failClaimAfterCommit = true;
  state.failReleases = LEASE_RELEASE_ATTEMPTS;
  let calls = 0;
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
      calls += 1;
    }),
  ).rejects.toThrow("synthetic lost answer");
  expect(calls).toBe(0);
  expect(state.ref).not.toBeNull();
  expect(state.releaseCalls).toBe(LEASE_RELEASE_ATTEMPTS);
  expect(logged.map((line) => JSON.parse(line))).toEqual([
    {
      event: "collection_lease_release_failed",
      source: "synthetic",
      attempts: LEASE_RELEASE_ATTEMPTS,
    },
  ]);
});

test("a claim that failed before writing leaves another execution's lease intact", async () => {
  const { db, state } = leaseStore();
  state.ref = "other-execution";
  state.startedAt = "2026-01-01T00:00:00.000Z";
  state.failClaimBeforeCommit = true;
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => undefined),
  ).rejects.toThrow("synthetic d1 failure");
  expect(state.ref).toBe("other-execution");
  expect(state.startedAt).toBe("2026-01-01T00:00:00.000Z");
});

test("a failed release is retried and the action's result is kept", async () => {
  const { db, state } = leaseStore();
  state.failReleases = LEASE_RELEASE_ATTEMPTS - 1;
  const result = await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => "done");
  expect(result).toBe("done");
  expect(state.ref).toBeNull();
  expect(state.releaseCalls).toBe(LEASE_RELEASE_ATTEMPTS);
  expect(logged).toEqual([]);
});

test("a failed release after a failed action keeps the action's own error", async () => {
  const { db, state } = leaseStore();
  state.failReleases = 1;
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
      throw new Error("provider step failed");
    }),
  ).rejects.toThrow("provider step failed");
  expect(state.ref).toBeNull();
});

test("a release that fails every attempt leaves the lease held and logs a closed code only", async () => {
  const { db, state } = leaseStore();
  state.failReleases = LEASE_RELEASE_ATTEMPTS;
  const result = await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => "done");
  expect(result).toBe("done");
  expect(state.ref).not.toBeNull();
  expect(state.releaseCalls).toBe(LEASE_RELEASE_ATTEMPTS);
  expect(logged.map((line) => JSON.parse(line))).toEqual([
    {
      event: "collection_lease_release_failed",
      source: "synthetic",
      attempts: LEASE_RELEASE_ATTEMPTS,
    },
  ]);
});

test("a retried release never clears a lease another execution acquired", async () => {
  const { db, state } = leaseStore();
  await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", async () => {
    // The operator released this execution's lease and another one claimed it.
    state.ref = "newer-execution";
    state.failReleases = 1;
  });
  expect(state.ref).toBe("newer-execution");
});

/** Short clocks: heartbeat 10 ms, self-stop after 35 ms without one, deadline 60 ms, grace 30 ms. */
const FAST: LeaseTiming = { heartbeatMs: 10, heartbeatLossMs: 35, deadlineMs: 60, graceMs: 30 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a holder writes its heartbeat on D1's clock while its action runs, and stops when it settles", async () => {
  const { db, state } = leaseStore();
  await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    async () => {
      await sleep(45);
    },
    { timing: FAST },
  );
  expect(state.heartbeats).toBeGreaterThanOrEqual(2);
  expect(
    state.heartbeatSql.every((sql) => sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now')")),
  ).toBe(true);
  expect(state.ref).toBeNull();
  const after = state.heartbeats;
  await sleep(30);
  expect(state.heartbeats).toBe(after);
});

test("at the deadline the action is aborted and the call reports collection_deadline_exceeded", async () => {
  const { db, state } = leaseStore();
  let seen: unknown;
  const failure = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          seen = signal.reason;
          // An action that wraps the abort in its own error still reports the stop.
          reject(new Error("provider step aborted"));
        });
      }),
    { timing: FAST },
  ).catch((error: unknown) => error);
  expect(seen).toBeInstanceOf(CollectionLeaseAbort);
  expect(failure).toBeInstanceOf(CollectionLeaseAbort);
  expect((failure as CollectionLeaseAbort).code).toBe("collection_deadline_exceeded");
  expect(scheduledFailure(failure).failureCode).toBe("collection_deadline_exceeded");
  expect(state.ref).toBeNull();
});

test("an action that ignores the abort is stopped by force and keeps its lease until it settles", async () => {
  const { db, state } = leaseStore();
  let forced = 0;
  let finish!: () => void;
  const stuck = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", () => stuck, {
    timing: FAST,
    forceStop: () => {
      forced += 1;
    },
  }).catch((error: unknown) => error);
  expect(forced).toBe(1);
  expect((failure as CollectionLeaseAbort).code).toBe("collection_deadline_exceeded");
  // Still alive, so still held and still beating: nobody may take it over.
  expect(state.ref).not.toBeNull();
  const beats = state.heartbeats;
  await sleep(25);
  expect(state.heartbeats).toBeGreaterThan(beats);
  finish();
  await sleep(5);
  expect(state.ref).toBeNull();
});

test("a heartbeat that finds the lease gone aborts the action with collection_lease_lost", async () => {
  const { db, state } = leaseStore();
  const failure = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    (signal) =>
      new Promise((_, reject) => {
        // The operator released this lease and another execution claimed it.
        state.ref = "newer-execution";
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    { timing: FAST },
  ).catch((error: unknown) => error);
  expect((failure as CollectionLeaseAbort).code).toBe("collection_lease_lost");
  expect(state.ref).toBe("newer-execution");
});

test("a holder that cannot write its heartbeat stops itself before anyone may call it stale", async () => {
  const { db, state } = leaseStore();
  state.failHeartbeats = true;
  const started = Date.now();
  const failure = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    { timing: FAST },
  ).catch((error: unknown) => error);
  expect((failure as CollectionLeaseAbort).code).toBe("collection_lease_lost");
  // Lost after heartbeatLossMs, before the deadline.
  expect(Date.now() - started).toBeLessThan(FAST.deadlineMs);
  expect(state.ref).toBeNull();
});

test("a synchronous throw from the action still releases the lease", async () => {
  const { db, state } = leaseStore();
  await expect(
    withCollectionLease({ SCHEDULE_DB: db }, "synthetic", () => {
      throw new Error("synchronous");
    }),
  ).rejects.toThrow("synchronous");
  expect(state.ref).toBeNull();
});

test("forceStop receives the abort's code", async () => {
  const { db } = leaseStore();
  const codes: string[] = [];
  await withCollectionLease({ SCHEDULE_DB: db }, "synthetic", () => new Promise(() => undefined), {
    timing: FAST,
    forceStop: (code) => {
      codes.push(code);
    },
  }).catch(() => undefined);
  expect(codes).toEqual(["collection_deadline_exceeded"]);
});

test("a heartbeat answered after the release stops nothing", async () => {
  const { db, state } = leaseStore();
  // The heartbeat sent at 10 ms runs after the action settled at 15 ms and
  // finds the lease already released.
  state.heartbeatDelayMs = 20;
  let forced = 0;
  const result = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    async () => {
      await sleep(15);
      return "done";
    },
    {
      timing: FAST,
      forceStop: () => {
        forced += 1;
      },
    },
  );
  expect(result).toBe("done");
  expect(state.ref).toBeNull();
  // Long enough for the late answer and a whole grace period.
  await sleep(FAST.graceMs + 40);
  expect(forced).toBe(0);
});

test("a heartbeat whose answer never comes still counts as missing", async () => {
  const { db, state } = leaseStore();
  state.hangHeartbeats = true;
  const started = Date.now();
  const failure = await withCollectionLease(
    { SCHEDULE_DB: db },
    "synthetic",
    (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    { timing: FAST },
  ).catch((error: unknown) => error);
  expect((failure as CollectionLeaseAbort).code).toBe("collection_lease_lost");
  expect(Date.now() - started).toBeLessThan(FAST.deadlineMs);
  // Every tick sent a heartbeat, not only the first that stalled.
  expect(state.heartbeatSql.length).toBeGreaterThanOrEqual(3);
  expect(state.ref).toBeNull();
});

/** Every action settlement is covered both before a stop and after either stop code. */
for (const stop of ["none", "deadline", "lost"] as const) {
  for (const outcome of ["fulfilled", "rejected"] as const) {
    test(`a ${outcome} action preserves the ${stop} lease outcome`, async () => {
      const { db, state } = leaseStore();
      const actionError = new Error("synthetic action failure");
      let stopReason: unknown;
      let forced = 0;
      const result = await withCollectionLease(
        { SCHEDULE_DB: db },
        "synthetic",
        (signal) => {
          const settle = () => {
            if (outcome === "rejected") throw actionError;
            return "synthetic action value";
          };
          if (stop === "none") return Promise.resolve().then(settle);
          if (stop === "lost") state.ref = "newer-execution";
          return new Promise<string>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                stopReason = signal.reason;
                // Both resolving and wrapping the stop must preserve its code.
                if (outcome === "fulfilled") resolve("synthetic action value");
                else reject(actionError);
              },
              { once: true },
            );
          });
        },
        {
          timing: {
            heartbeatMs: stop === "lost" ? 1 : 60_000,
            heartbeatLossMs: 120_000,
            deadlineMs: stop === "deadline" ? 1 : 60_000,
            graceMs: 60_000,
          },
          forceStop: () => {
            forced += 1;
          },
        },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (stop === "none") {
        expect(result).toEqual(
          outcome === "fulfilled"
            ? { status: "fulfilled", value: "synthetic action value" }
            : { status: "rejected", error: actionError },
        );
        expect(stopReason).toBeUndefined();
      } else {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("expected lease stop");
        expect(result.error).toBe(stopReason);
        expect(result.error).toBeInstanceOf(CollectionLeaseAbort);
        expect(scheduledFailure(result.error).failureCode).toBe(
          stop === "deadline" ? "collection_deadline_exceeded" : "collection_lease_lost",
        );
      }
      expect(state.ref).toBe(stop === "lost" ? "newer-execution" : null);
      expect(forced).toBe(0);
    });
  }
}
