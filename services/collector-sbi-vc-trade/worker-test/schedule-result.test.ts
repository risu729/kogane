import { env, runInDurableObject, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alarmCollection } from "../src/worker";
import type { HealthState } from "../src/types";

const health: HealthState = {
  initializedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastHttpStatus: 403,
  lastGatewayStatus: null,
  lastCookieUpdateCount: 0,
  consecutiveFailures: 1,
  lastErrorCode: "http_rejected",
  lastReauthAttemptAt: null,
  lastReauthSuccessAt: null,
  lastReauthErrorCode: "manual_agreement_required",
};

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  const configured = env as Env & { SCHEDULE_TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(configured.SCHEDULE_DB, configured.SCHEDULE_TEST_MIGRATIONS);
});

test("alarm preserves the blocked run and human-agreement reason without another login", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put("health", health);
    vi.spyOn(instance, "runKeepAlive").mockResolvedValue(health);
    vi.spyOn(instance, "runReauthenticate");
    vi.spyOn(instance, "runCollection");
    vi.spyOn(instance, "recordBlockedCollection");
  });
  const result = await alarmCollection(env, "5 21 * * *", 0);
  expect(result).toMatchObject({ status: "failed", failureCode: "manual_agreement_required" });
  expect(result.runIds).toHaveLength(1);
  expect(await alarmCollection(env, "*/15 * * * *", 0)).toEqual({
    status: "failed",
    runIds: [],
    failureCode: "manual_agreement_required",
  });
  await runInDurableObject(stub, async (instance) => {
    expect(instance.recordBlockedCollection).toHaveBeenCalledOnce();
    expect(instance.runCollection).not.toHaveBeenCalled();
    expect(instance.runReauthenticate).not.toHaveBeenCalled();
  });
});

test.each([true, false])(
  "R2 HEAD throws remain persistence failures across DO RPC (blocked=%s)",
  async (blocked) => {
    const stub = env.SESSION_STATE.getByName("singleton");
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("health", health);
      vi.spyOn(instance, "runKeepAlive").mockResolvedValue(
        blocked
          ? health
          : {
              ...health,
              lastErrorCode: null,
              lastHttpStatus: null,
              lastReauthErrorCode: null,
            },
      );
      // Without session material the real collection produces a failed manifest locally.
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_forbidden_in_fixture"));
      vi.spyOn(Object.getPrototypeOf(env.DATA), "head").mockRejectedValue(
        new Error("synthetic_private_storage_detail"),
      );
    });
    expect(await alarmCollection(env, "5 21 * * *", 0)).toEqual({
      status: "failed",
      runIds: [],
      failureCode: "terminal_persistence_failed",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  },
);

test.each(["state_failure", "terminal_persistence_failed", "collection_busy_or_uncertain"])(
  "non-writer failure %s cannot impersonate a persistence exception",
  async (message) => {
    const stub = env.SESSION_STATE.getByName("singleton");
    await runInDurableObject(stub, async (instance) => {
      vi.spyOn(instance, "runKeepAlive").mockRejectedValue(new Error(message));
    });
    expect(await alarmCollection(env, "5 21 * * *", 0)).toEqual({
      status: "failed",
      runIds: [],
      failureCode:
        message === "collection_busy_or_uncertain" ? "collection_busy" : "collection_failed",
    });
  },
);
