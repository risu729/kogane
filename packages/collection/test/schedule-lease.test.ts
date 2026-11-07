import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  LEASE_RELEASE_ATTEMPTS,
  withCollectionLease,
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
