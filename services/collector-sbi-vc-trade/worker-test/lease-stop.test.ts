// A keepalive whose holder stopped itself (ADR 0085) does not know what the
// gateway did with its request: the stop's own code reaches the caller, which
// records the run uncertain, and the session's health record is left as it was.
import { env, applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HealthState } from "../src/types";
import type { SbiVcSessionState } from "../src/worker";

const testEnv = env as Env & { SCHEDULE_TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.SCHEDULE_DB, testEnv.SCHEDULE_TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

// Synthetic values only.
const SEED = JSON.stringify({
  cookies: {
    vctBffSid: "sid",
    jSessionId: "jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "alb",
    awsAlbCors: "cors",
  },
  secureKey: "secure",
});
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PREVIOUS: Partial<HealthState> = { lastErrorCode: null, consecutiveFailures: 0 };

test("a keepalive stopped at its deadline rejects with the code and leaves health as it was", async () => {
  const stub = env.SESSION_STATE.getByName("keepalive-deadline");
  const outcome = await runInDurableObject(stub, async (instance, state) => {
    const object = instance as unknown as SbiVcSessionState & { env: Env };
    Object.assign(object.env, { SESSION_SEED: SEED, SESSION_ENCRYPTION_KEY: KEY });
    // A grace far longer than the test: the action settles on its own, so
    // the code comes from the keepalive's rethrow, not from the forced stop.
    object.leaseTiming = {
      heartbeatMs: 60_000,
      heartbeatLossMs: 180_000,
      deadlineMs: 200,
      graceMs: 60_000,
    };
    await state.storage.put("health", PREVIOUS);
    // A gateway that never answers, until the holder's signal cuts it off.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          // Like the real fetch, a signal already aborted rejects at once.
          if (init?.signal?.aborted) return reject(new Error("aborted"));
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await object.runKeepAlive().then(
      () => null,
      (reason: unknown) => reason,
    );
    return { error, stored: await state.storage.get<HealthState>("health") };
  });
  expect(outcome.error).toBeInstanceOf(Error);
  expect((outcome.error as Error).message).toBe("collection_deadline_exceeded");
  // Loading the seed initialises the session; the attempt itself records nothing.
  expect(outcome.stored).toMatchObject({
    lastAttemptAt: null,
    lastErrorCode: null,
    lastHttpStatus: null,
    consecutiveFailures: 0,
  });
  const lease = await testEnv.SCHEDULE_DB.prepare(
    "SELECT lease_ref, heartbeat_at FROM collection_execution_leases WHERE source='sbi-vc-trade'",
  ).first<{ lease_ref: string | null; heartbeat_at: string | null }>();
  expect(lease).toEqual({ lease_ref: null, heartbeat_at: null });
});
