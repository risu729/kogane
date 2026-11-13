import { env, runInDurableObject, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  manualAgreementPendingSince: null,
  sessionRefreshRequired: false,
};

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  const configured = env as Env & { SCHEDULE_TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(configured.SCHEDULE_DB, configured.SCHEDULE_TEST_MIGRATIONS);
});

test("alarm retries the login while an agreement is pending and keeps the reason", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put("health", health);
    vi.spyOn(instance, "runKeepAlive").mockResolvedValue(health);
    // The login stops at the provider's agreement again.
    vi.spyOn(instance, "runReauthenticate").mockResolvedValue(health);
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
    // Unforced: the Durable Object's cooldown decides whether a login happens.
    expect(instance.runReauthenticate).toHaveBeenCalledTimes(2);
    expect(instance.runReauthenticate).toHaveBeenCalledWith(false);
  });
});

test("an operator's session refresh logs in again without the cooldown, after any failed keepalive", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  // A failure the alarm would not log in for (not a 401/403/gateway refusal).
  const unavailable: HealthState = {
    ...health,
    lastHttpStatus: 500,
    lastErrorCode: "http_rejected",
    lastReauthErrorCode: null,
  };
  const renewed: HealthState = {
    ...unavailable,
    lastHttpStatus: 200,
    lastErrorCode: null,
    consecutiveFailures: 0,
    lastReauthSuccessAt: "2026-11-08T03:00:00.000Z",
  };
  await runInDurableObject(stub, async (instance) => {
    vi.spyOn(instance, "runKeepAlive")
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(renewed);
    vi.spyOn(instance, "runReauthenticate").mockResolvedValue(renewed);
  });
  // The alarm keeps its own policy: no login for this failure.
  expect(await alarmCollection(env, "*/15 * * * *", 0)).toMatchObject({ status: "failed" });
  expect(await alarmCollection(env, "*/15 * * * *", 0, { forceReauth: true })).toEqual({
    status: "completed",
    runIds: [],
    failureCode: null,
  });
  await runInDurableObject(stub, async (instance) => {
    expect(instance.runReauthenticate).toHaveBeenCalledOnce();
    expect(instance.runReauthenticate).toHaveBeenCalledWith(true);
  });
});

test("a second requested refresh within an hour keeps the alarm's login policy", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  const unavailable: HealthState = {
    ...health,
    lastHttpStatus: 500,
    lastErrorCode: "http_rejected",
    lastReauthErrorCode: null,
    lastReauthAttemptAt: null,
  };
  const forcedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put("forcedReauthAt", forcedAt);
    await state.storage.put("health", unavailable);
    vi.spyOn(instance, "runKeepAlive").mockResolvedValue(unavailable);
  });
  expect(await alarmCollection(env, "*/15 * * * *", 0, { forceReauth: true })).toMatchObject({
    status: "failed",
  });
  await runInDurableObject(stub, async (_instance, state) => {
    // A 500 is not a refused session, so the alarm's policy does not log in:
    // no attempt is recorded and the hour is not taken again.
    expect(await state.storage.get("forcedReauthAt")).toBe(forcedAt);
    expect((await state.storage.get<HealthState>("health"))?.lastReauthAttemptAt).toBeNull();
  });
});

test("a requested login takes the hour; the next request inside it gets the alarm's policy", async () => {
  const stub = env.SESSION_STATE.getByName("forced-spacing");
  const unavailable: HealthState = {
    ...health,
    lastHttpStatus: 500,
    lastErrorCode: "http_rejected",
    lastReauthErrorCode: null,
    lastReauthAttemptAt: null,
  };
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put("health", unavailable);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No passkey is bound here, so the forced login fails as a revoked one would.
    const first = await instance.runReauthenticate(true);
    expect(first.lastReauthAttemptAt).not.toBeNull();
    expect(first.lastReauthErrorCode).not.toBeNull();
    const takenAt = await state.storage.get<string>("forcedReauthAt");
    expect(takenAt).toBe(first.lastReauthAttemptAt);
    // A 500 is not a refused session and the failed login is inside its
    // cooldown, so a second request inside the hour logs in no more.
    const second = await instance.runReauthenticate(true);
    expect(second).toEqual(first);
    expect(await state.storage.get<string>("forcedReauthAt")).toBe(takenAt);
  });
});

test("an operator's session refresh does not log in while the session is healthy", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  const healthy: HealthState = {
    ...health,
    lastHttpStatus: 200,
    lastErrorCode: null,
    consecutiveFailures: 0,
    lastReauthErrorCode: null,
  };
  await runInDurableObject(stub, async (instance) => {
    vi.spyOn(instance, "runKeepAlive").mockResolvedValue(healthy);
    vi.spyOn(instance, "runReauthenticate");
  });
  expect(await alarmCollection(env, "*/15 * * * *", 0, { forceReauth: true })).toMatchObject({
    status: "completed",
  });
  await runInDurableObject(stub, async (instance) => {
    expect(instance.runReauthenticate).not.toHaveBeenCalled();
  });
});

test("once the owner has agreed, the next retry resumes the collection on its own", async () => {
  const stub = env.SESSION_STATE.getByName("singleton");
  const recovered: HealthState = {
    ...health,
    lastHttpStatus: 200,
    lastErrorCode: null,
    consecutiveFailures: 0,
    lastReauthErrorCode: null,
    lastReauthSuccessAt: "2026-11-07T07:00:00.000Z",
  };
  await runInDurableObject(stub, async (instance) => {
    vi.spyOn(instance, "runKeepAlive")
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(recovered);
    vi.spyOn(instance, "runReauthenticate").mockResolvedValue(recovered);
    vi.spyOn(instance, "runCollection").mockResolvedValue({
      runId: "00000000-0000-4000-8000-000000000001",
      status: "success",
      artifactCount: 6,
      failureCount: 0,
      manifestKey: "synthetic-manifest",
    });
    vi.spyOn(instance, "recordBlockedCollection");
  });
  const result = await alarmCollection(env, "5 21 * * *", 0);
  expect(result.status).toBe("completed");
  await runInDurableObject(stub, async (instance) => {
    expect(instance.runCollection).toHaveBeenCalledOnce();
    expect(instance.recordBlockedCollection).not.toHaveBeenCalled();
  });
});

describe("the login cooldown while an agreement is pending", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const pending = (attemptMinutesAgo: number, sinceMinutesAgo: number): HealthState => ({
    ...health,
    lastReauthAttemptAt: minutesAgo(attemptMinutesAgo),
    manualAgreementPendingSince: minutesAgo(sinceMinutesAgo),
  });
  // The fixture's PASSKEY_CREDENTIAL is not a credential, so an attempt is
  // visible as a new attempt time and a closed error code; nothing leaves the runtime.
  test.each([
    ["an hour after the last refusal, inside 72 hours", pending(61, 120), true],
    ["half an hour after the last refusal", pending(30, 120), false],
    ["an hour after the last refusal, past 72 hours", pending(61, 73 * 60), false],
    ["six hours after the last refusal, past 72 hours", pending(6 * 60 + 1, 73 * 60), true],
  ])("%s", async (_name, stored, attempted) => {
    const stub = env.SESSION_STATE.getByName(`cooldown-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("health", stored);
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_forbidden_in_fixture"));
    const after = await stub.runReauthenticate(false);
    expect(after.lastReauthAttemptAt !== stored.lastReauthAttemptAt).toBe(attempted);
    if (!attempted) expect(after).toEqual(stored);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a login stopped at isAgreed opens the window once and keeps it until a login succeeds", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    // A synthetic key: the provider is a mock, so nothing leaves the runtime.
    const credential = JSON.stringify({
      credentialId: "00112233-4455-6677-8899-aabbccddeeff",
      keyValue: Buffer.from(pkcs8).toString("base64url"),
      rpId: "sbivc.co.jp",
      userHandle: Buffer.from([1, 2, 3, 4]).toString("base64url"),
      counter: "0",
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
    });
    const json = (body: unknown, cookies: string[] = []) => {
      const headers = new Headers({ "content-type": "application/json" });
      for (const cookie of cookies) headers.append("set-cookie", `${cookie}; Secure`);
      return new Response(JSON.stringify({ meta: { status: "OK" }, body }), {
        status: 200,
        headers,
      });
    };
    let agreed = false;
    const stub = env.SESSION_STATE.getByName(`agreement-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const bindings = (instance as unknown as { env: Env }).env;
      const original = {
        PASSKEY_CREDENTIAL: bindings.PASSKEY_CREDENTIAL,
        SESSION_ENCRYPTION_KEY: bindings.SESSION_ENCRYPTION_KEY,
      };
      Object.assign(bindings, {
        PASSKEY_CREDENTIAL: credential,
        SESSION_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      });
      try {
        const fetched = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input) =>
            String(input).endsWith("/initiateLoginWithPasskey")
              ? json(
                  { challenge: "c2ludGhldGlj", rpId: "sbivc.co.jp", userVerification: "required" },
                  ["JSESSIONID=jsession", "AWSALB=alb", "AWSALBCORS=cors"],
                )
              : json({ accountId: "synthetic", isAgreed: agreed }, [
                  "vct_bff_sid=sid",
                  ...[0, 1, 2, 3].map((index) => `AWSALBAPP-${index}=app${index}`),
                ]),
          );
        vi.spyOn(console, "error").mockImplementation(() => {});
        await state.storage.put("health", {
          ...health,
          lastReauthErrorCode: null,
          sessionRefreshRequired: true,
        });
        const first = await instance.runReauthenticate(false);
        expect(fetched).toHaveBeenCalledTimes(2);
        expect(first.lastReauthErrorCode).toBe("manual_agreement_required");
        expect(first.manualAgreementPendingSince).toBe(first.lastReauthAttemptAt);
        expect(first.sessionRefreshRequired).toBe(true);
        expect(await instance.runKeepAlive()).toEqual(first);
        // Inside the hour nothing logs in.
        expect(await instance.runReauthenticate(false)).toEqual(first);
        expect(fetched).toHaveBeenCalledTimes(2);
        await state.storage.put("health", { ...first, lastReauthAttemptAt: minutesAgo(61) });
        const second = await instance.runReauthenticate(false);
        expect(fetched).toHaveBeenCalledTimes(4);
        expect(second.lastReauthAttemptAt).not.toBe(first.lastReauthAttemptAt);
        expect(second.manualAgreementPendingSince).toBe(first.manualAgreementPendingSince);
        // Past 72 hours from the first refusal, an hour is no longer enough.
        const late = {
          ...second,
          lastReauthAttemptAt: minutesAgo(61),
          manualAgreementPendingSince: minutesAgo(73 * 60),
        };
        await state.storage.put("health", late);
        expect(await instance.runReauthenticate(false)).toEqual(late);
        expect(fetched).toHaveBeenCalledTimes(4);
        // Once the owner has agreed, a successful login closes the window.
        agreed = true;
        const resumed = await instance.runReauthenticate(true);
        expect(fetched).toHaveBeenCalledTimes(6);
        expect(resumed).toMatchObject({
          lastReauthErrorCode: null,
          manualAgreementPendingSince: null,
          sessionRefreshRequired: false,
        });
        expect(resumed.sessionRefreshRequired).toBe(false);
        expect((await instance.runKeepAlive()).lastErrorCode).toBeNull();
        expect(fetched).toHaveBeenCalledTimes(7);
      } finally {
        Object.assign(bindings, original);
      }
    });
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
