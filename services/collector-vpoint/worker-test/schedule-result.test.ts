import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { alarmCollection } from "../src/worker";

afterEach(() => vi.restoreAllMocks());

function pendingEnv(): Env {
  return {
    ...env,
    // No network, challenge creation, OTP or email processing in these fixtures.
    SCHEDULE_DB: undefined,
    VPOINT_SESSION: {
      idFromName: () => "synthetic",
      get: () => ({
        getSession: async () => null,
        ensureEmailChallenge: async () => ({ status: "pending" }),
      }),
    },
  } as unknown as Env;
}

test("an R2 HEAD exception is a persistence failure, not reauthentication pending", async () => {
  const head = vi
    .spyOn(env.DATA, "head")
    .mockRejectedValue(new Error("synthetic_private_storage_detail"));
  expect(await alarmCollection(pendingEnv(), "unused", 0)).toEqual({
    status: "failed",
    runIds: [],
    failureCode: "terminal_persistence_failed",
  });
  expect(head).toHaveBeenCalledOnce();
});

test("a pending challenge with a persisted terminal retains its pending classification", async () => {
  const result = await alarmCollection(pendingEnv(), "unused", 0);
  expect(result).toMatchObject({ status: "failed", failureCode: "reauthentication_pending" });
  expect(result.runIds).toHaveLength(1);
});

test("a non-writer exception with the same message remains generic", async () => {
  const configured = pendingEnv();
  vi.spyOn(configured.VPOINT_SESSION, "idFromName").mockImplementation(() => {
    throw new Error("terminal_persistence_failed");
  });
  expect(await alarmCollection(configured, "unused", 0)).toEqual({
    status: "failed",
    runIds: [],
    failureCode: "collection_failed",
  });
});
