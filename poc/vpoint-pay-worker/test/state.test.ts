import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { VPointPayCredentialState } = await import("../src/state");
const { default: worker } = await import("../src/worker");

const UUID = "00112233-4455-6677-8899-aabbccddeeff";

function fixture(stored: Record<string, string>, secrets: Partial<Env>) {
  let writes = 0;
  const state = Object.assign({} as DurableObjectState, {
    storage: {
      get: async (key: string) => stored[key],
      put: async () => {
        writes++;
      },
    },
  });
  const instance = new VPointPayCredentialState(state, secrets as Env);
  return { instance, writes: () => writes };
}

describe("V Point Pay readiness without credential changes", () => {
  test("diagnostic reads prefer rotated state and never reseed from old secrets", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token", "device-uuid": UUID },
      {
        VPOINT_PAY_REFRESH_TOKEN: "old-test-token",
        VPOINT_PAY_DEVICE_UUID: "invalid-old-test-device",
      },
    );
    expect(await f.instance.credentialStatus()).toEqual({
      source: "durable-object",
      structurallyReady: true,
      missingFields: [],
      invalidFields: [],
    });
    expect(f.writes()).toBe(0);
  });

  test("partial state diagnosis does not combine a token with an unpaired UUID", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token" },
      {
        VPOINT_PAY_DEVICE_UUID: UUID,
      },
    );
    expect(await f.instance.credentialStatus()).toEqual({
      source: "worker-secrets",
      structurallyReady: false,
      missingFields: ["refresh-token"],
      invalidFields: [],
    });
    expect(f.writes()).toBe(0);
  });

  test("invalid reset preserves existing credentials without writing", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token", "device-uuid": UUID },
      {
        VPOINT_PAY_REFRESH_TOKEN: "old-test-token",
        VPOINT_PAY_DEVICE_UUID: "invalid-device",
      },
    );
    await expect(f.instance.resetFromSecrets()).rejects.toThrow("invalid=device-uuid");
    expect(f.writes()).toBe(0);
  });

  test("credential diagnostics require admin authentication before reading state", async () => {
    let reads = 0;
    const env = Object.assign({} as Env, {
      ADMIN_TRIGGER_TOKEN: "admin-test-only",
      VPOINT_PAY_STATE: {
        idFromName: () => {
          reads++;
        },
      },
    });
    const response = await worker.fetch(
      new Request("https://collector.test/credential-status", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });
});

describe("retired V Point Pay app collector", () => {
  test("manual provider and credential mutation routes never touch state", async () => {
    let calls = 0;
    const env = Object.assign({} as Env, {
      ADMIN_TRIGGER_TOKEN: "admin-test-only",
      VPOINT_PAY_STATE: {
        idFromName: () => {
          calls++;
          throw new Error("must not access state");
        },
      },
    });
    for (const path of ["/trigger", "/probe", "/reset-credentials"]) {
      const response = await worker.fetch(
        new Request(`https://collector.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer admin-test-only" },
        }),
        env,
      );
      expect(response.status).toBe(410);
    }
    expect(calls).toBe(0);
  });

  test("health clearly distinguishes a disabled collector", async () => {
    const response = await worker.fetch(new Request("https://collector.test/health"), {} as Env);
    expect(await response.json()).toMatchObject({
      collectionEnabled: false,
      status: "disabled",
      reason: "email_only",
    });
  });

  test("delayed scheduled events need no environment and do not collect", async () => {
    await expect(worker.scheduled()).resolves.toBeUndefined();
  });
});
