import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { encryptJson } from "../src/crypto";
import { DirectProfile } from "../src/smbc";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env,
    ) {}
  },
}));
const { SmbcBackfillSession } = await import("../src/session");
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

test("an unavailable logging sink does not suppress the existing retry alarm", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const values = new Map<string, unknown>([
    [
      "progress",
      {
        phase: "running",
        from: "2026-08-01",
        to: "2026-08-31",
        startedAt: "2026-09-01T00:00:00Z",
        runId: "00000000-0000-4000-8000-000000000001",
        completedChunks: 0,
        retryCount: 0,
      },
    ],
    ["session", await encryptJson({}, key)],
  ]);
  const alarms: number[] = [];
  const state = {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") values.set(key, value);
        else for (const [name, item] of Object.entries(key)) values.set(name, item);
      },
      setAlarm: async (time: number) => {
        alarms.push(time);
      },
    },
  } as unknown as DurableObjectState;
  const profile = spyOn(DirectProfile, "import").mockReturnValue({
    getTransactions: async () => {
      throw new Error("transactions_service_time_unavailable");
    },
    export: () => ({}),
  } as unknown as DirectProfile);
  restores.push(() => profile.mockRestore());
  for (const method of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation(() => {
      throw new Error("logging sink unavailable");
    });
    restores.push(() => spy.mockRestore());
  }
  const session = new SmbcBackfillSession(state, {
    SESSION_ENCRYPTION_KEY: key,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
  } as Env);
  await session.alarm();
  expect(alarms).toHaveLength(1);
  expect(values.get("progress")).toMatchObject({
    phase: "running",
    retryCount: 1,
    lastErrorCode: "transactions_service_time_unavailable",
  });
  expect(alarms[0]).toBeGreaterThan(Date.now());
});
