import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { encryptJson } from "../src/crypto";
import { isResumable } from "../src/progress";
import { DirectProfile } from "../src/smbc";
import type { BackfillProgress } from "../src/types";

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
  } as unknown as Env);
  await session.alarm();
  expect(alarms).toHaveLength(1);
  expect(values.get("progress")).toMatchObject({
    phase: "running",
    retryCount: 1,
    lastErrorCode: "transactions_service_time_unavailable",
  });
  expect(alarms[0]).toBeGreaterThan(Date.now());
});

test("a normalized write fault preserves raw evidence and the next alarm repairs the pair", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const runId = "00000000-0000-4000-8000-000000000002";
  const prefix = `raw/smbc-direct/2026/09/01/${runId}`;
  const values = new Map<string, unknown>([
    [
      "progress",
      {
        phase: "running",
        from: "2026-08-01",
        to: "2026-08-31",
        startedAt: "2026-09-01T00:00:00.000Z",
        runId,
        completedChunks: 0,
        totalChunks: 1,
        transactionCount: 0,
        artifactCount: 2,
        retryCount: 0,
      },
    ],
    [
      "artifacts",
      [
        {
          dataset: "balance-raw",
          key: `${prefix}/balance.raw.json.sjis`,
          mediaType: "application/json;charset=Shift_JIS",
          bytes: 1,
          sha256: "a".repeat(64),
        },
        {
          dataset: "balance-normalized",
          key: `${prefix}/balance.normalized.json`,
          mediaType: "application/json; charset=utf-8",
          bytes: 1,
          sha256: "b".repeat(64),
        },
      ],
    ],
    ["failureCodes", []],
    ["session", await encryptJson({}, key)],
  ]);
  const alarms: number[] = [];
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => {
        values.delete(name);
      },
      setAlarm: async (time: number) => {
        alarms.push(time);
      },
      deleteAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState;

  const writes = new Map<string, Uint8Array>();
  let normalizedFaultsRemaining = 1;
  const bucket = {
    put: async (objectKey: string, bytes: Uint8Array) => {
      if (objectKey.endsWith(".normalized.json") && normalizedFaultsRemaining > 0) {
        normalizedFaultsRemaining -= 1;
        throw new Error("normalized_write_failed");
      }
      writes.set(objectKey, new Uint8Array(bytes));
      return {};
    },
  } as unknown as R2Bucket;
  const profile = spyOn(DirectProfile, "import").mockReturnValue({
    getTransactions: async () => ({
      range: { start: "2026-08-01", end: "2026-08-31" },
      depositsTotal: 0,
      withdrawalsTotal: 100,
      transactions: [
        {
          id: "fixture-0",
          date: "2026-08-01T00:00:00+09:00",
          amount: 100,
          balanceAfter: 900,
          description: "fixture",
          direction: "debit" as const,
        },
      ],
      rawBytes: new TextEncoder().encode('{"fixture":true}'),
      rawContentType: "application/json;charset=Shift_JIS",
    }),
    export: () => ({}),
    logout: async () => undefined,
  } as unknown as DirectProfile);
  restores.push(() => profile.mockRestore());
  const session = new SmbcBackfillSession(state, {
    SESSION_ENCRYPTION_KEY: key,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
    DATA: bucket,
  } as unknown as Env);

  await session.alarm();
  expect(values.get("progress")).toMatchObject({ phase: "running", retryCount: 1 });
  expect(values.get("artifacts")).toEqual(
    expect.arrayContaining([expect.objectContaining({ dataset: "transactions-raw" })]),
  );
  expect(writes.has(`${prefix}/transactions/20260801-20260831.raw.json.sjis`)).toBeTrue();
  expect(writes.has(`${prefix}/transactions/20260801-20260831.normalized.json`)).toBeFalse();
  expect(alarms).toHaveLength(1);

  await session.alarm();
  expect(values.get("progress")).toMatchObject({
    phase: "success",
    completedChunks: 1,
    retryCount: 0,
  });
  expect(values.get("artifacts")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ dataset: "transactions-raw" }),
      expect.objectContaining({ dataset: "transactions-normalized" }),
    ]),
  );
  expect(writes.has(`${prefix}/transactions/20260801-20260831.normalized.json`)).toBeTrue();
  expect(writes.has(`${prefix}/manifest.json`)).toBeTrue();
});

test.each([true, false])(
  "a retried completion retains signoff outcome without another logout (logoutSucceeded=%s)",
  async (logoutSucceeded) => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const runId = "00000000-0000-4000-8000-000000000003";
    const values = new Map<string, unknown>([
      [
        "progress",
        {
          phase: "running",
          from: "2026-08-01",
          to: "2026-08-31",
          startedAt: "2026-09-01T00:00:00.000Z",
          runId,
          completedChunks: 1,
          totalChunks: 1,
          transactionCount: 0,
          artifactCount: 0,
          retryCount: 0,
          lastErrorCode: null,
          logoutSucceeded: null,
        },
      ],
      ["artifacts", []],
      ["failureCodes", []],
      ["session", await encryptJson({}, key)],
    ]);
    const alarms: number[] = [];
    const state = {
      storage: {
        get: async (name: string) => values.get(name),
        put: async (name: string | Record<string, unknown>, value?: unknown) => {
          if (typeof name === "string") values.set(name, value);
          else for (const [field, item] of Object.entries(name)) values.set(field, item);
        },
        delete: async (name: string) => {
          values.delete(name);
        },
        setAlarm: async (time: number) => {
          alarms.push(time);
        },
        deleteAlarm: async () => undefined,
      },
    } as unknown as DurableObjectState;
    // Every month is stored; the staging manifest write after the logout fails
    // once, so the completion runs again on the next alarm.
    let manifestFaultsRemaining = 1;
    const bucket = {
      put: async (objectKey: string) => {
        if (objectKey.endsWith("/manifest.json") && manifestFaultsRemaining > 0) {
          manifestFaultsRemaining -= 1;
          throw new Error("manifest_write_failed");
        }
        return {};
      },
    } as unknown as R2Bucket;
    let logouts = 0;
    const profile = spyOn(DirectProfile, "import").mockReturnValue({
      export: () => ({}),
      // A session that already logged out cannot log out again.
      logout: async () => {
        logouts += 1;
        if (logouts > 1) throw new Error("session_already_ended");
        if (!logoutSucceeded) throw new Error("logout_unavailable");
      },
    } as unknown as DirectProfile);
    restores.push(() => profile.mockRestore());
    const session = new SmbcBackfillSession(state, {
      SESSION_ENCRYPTION_KEY: key,
      SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
      COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
      DATA: bucket,
    } as unknown as Env);

    await session.alarm();
    expect(values.get("progress")).toMatchObject({ phase: "running", retryCount: 1 });
    expect(alarms).toHaveLength(1);

    await session.alarm();
    expect(logouts).toBe(1);
    expect(values.get("progress")).toMatchObject({
      phase: "success",
      completedChunks: 1,
      logoutSucceeded,
    });
    expect(values.get("failureCodes")).toEqual([]);
  },
);

test.each([true, false])(
  "failed logout only preserves success after completed acquisition (complete=%s)",
  async (complete) => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const runId = "00000000-0000-4000-8000-000000000006";
    const values = new Map<string, unknown>([
      [
        "progress",
        {
          phase: "running",
          from: "2026-08-01",
          to: "2026-08-31",
          startedAt: "2026-09-01T00:00:00.000Z",
          runId,
          completedChunks: complete ? 1 : 0,
          totalChunks: 1,
          transactionCount: 0,
          artifactCount: 0,
          retryCount: complete ? 0 : 3,
          lastErrorCode: null,
          logoutSucceeded: null,
        },
      ],
      ["artifacts", []],
      ["failureCodes", []],
      ["session", await encryptJson({}, key)],
    ]);
    const state = {
      storage: {
        get: async (name: string) => values.get(name),
        put: async (name: string | Record<string, unknown>, value?: unknown) => {
          if (typeof name === "string") values.set(name, value);
          else for (const [field, item] of Object.entries(name)) values.set(field, item);
        },
        delete: async (name: string) => {
          values.delete(name);
        },
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
      },
    } as unknown as DurableObjectState;
    const bucket = { put: async () => ({}) } as unknown as R2Bucket;
    const profile = spyOn(DirectProfile, "import").mockReturnValue({
      export: () => ({}),
      getTransactions: async () => {
        throw new Error("transactions_service_time_unavailable");
      },
      logout: async () => {
        throw new Error("logout_unavailable");
      },
    } as unknown as DirectProfile);
    restores.push(() => profile.mockRestore());
    const session = new SmbcBackfillSession(state, {
      SESSION_ENCRYPTION_KEY: key,
      SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
      COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
      DATA: bucket,
    } as unknown as Env);

    await session.alarm();
    const progress = values.get("progress") as BackfillProgress;
    // Only completed acquisition ignores cleanup as a cause of failure.
    expect(progress).toMatchObject({
      phase: complete ? "success" : "failed",
      completedChunks: complete ? 1 : 0,
      totalChunks: 1,
      logoutSucceeded: false,
    });
    expect(values.get("failureCodes")).toEqual(
      complete ? [] : ["transactions_service_time_unavailable", "logout_failed"],
    );
    expect(values.has("session")).toBeFalse();
    expect(isResumable(progress)).toBe(!complete);
  },
);

test("a completion that exhausts its retries after logging out keeps that logout", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const runId = "00000000-0000-4000-8000-000000000004";
  const values = new Map<string, unknown>([
    [
      "progress",
      {
        phase: "running",
        from: "2026-08-01",
        to: "2026-08-31",
        startedAt: "2026-09-01T00:00:00.000Z",
        runId,
        completedChunks: 1,
        totalChunks: 1,
        transactionCount: 0,
        artifactCount: 0,
        retryCount: 0,
        lastErrorCode: null,
        logoutSucceeded: null,
      },
    ],
    ["artifacts", []],
    ["failureCodes", []],
    ["session", await encryptJson({}, key)],
  ]);
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => {
        values.delete(name);
      },
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState;
  // The completion's manifest write fails on the first alarm and on every
  // retry; the failure path's own manifest write then succeeds.
  let manifestFaultsRemaining = 4;
  const bucket = {
    put: async (objectKey: string) => {
      if (objectKey.endsWith("/manifest.json") && manifestFaultsRemaining > 0) {
        manifestFaultsRemaining -= 1;
        throw new Error("manifest_write_failed");
      }
      return {};
    },
  } as unknown as R2Bucket;
  let logouts = 0;
  const profile = spyOn(DirectProfile, "import").mockReturnValue({
    export: () => ({}),
    // A session that already logged out cannot log out again.
    logout: async () => {
      logouts += 1;
      if (logouts > 1) throw new Error("session_already_ended");
    },
  } as unknown as DirectProfile);
  restores.push(() => profile.mockRestore());
  const silenced = spyOn(console, "error").mockImplementation(() => {});
  restores.push(() => silenced.mockRestore());
  const session = new SmbcBackfillSession(state, {
    SESSION_ENCRYPTION_KEY: key,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
    DATA: bucket,
  } as unknown as Env);

  for (let alarm = 0; alarm < 4; alarm += 1) await session.alarm();
  expect(logouts).toBe(1);
  expect(values.get("progress")).toMatchObject({ phase: "failed", logoutSucceeded: true });
  expect(values.get("failureCodes")).not.toContain("logout_failed");
});

test("a completion step that fails is retried under its own closed stage", async () => {
  // Every month is already stored, so this alarm runs only the completion.
  // Before, its failures kept the loop's initial `transactions-collection`
  // label: the retry named the wrong stage and the failure was never logged.
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const runId = "00000000-0000-4000-8000-000000000005";
  const values = new Map<string, unknown>([
    [
      "progress",
      {
        phase: "running",
        from: "2026-08-01",
        to: "2026-08-31",
        startedAt: "2026-09-01T00:00:00.000Z",
        runId,
        completedChunks: 1,
        totalChunks: 1,
        transactionCount: 0,
        artifactCount: 0,
        retryCount: 0,
        lastErrorCode: null,
      },
    ],
    ["artifacts", []],
    ["failureCodes", []],
    ["session", await encryptJson({}, key)],
  ]);
  const alarms: number[] = [];
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => {
        values.delete(name);
      },
      setAlarm: async (time: number) => {
        alarms.push(time);
      },
      deleteAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState;
  const bucket = {
    put: async (objectKey: string) => {
      if (objectKey.endsWith("/manifest.json")) throw new Error("manifest_write_failed");
      return {};
    },
  } as unknown as R2Bucket;
  const profile = spyOn(DirectProfile, "import").mockReturnValue({
    export: () => ({}),
    logout: async () => undefined,
  } as unknown as DirectProfile);
  restores.push(() => profile.mockRestore());
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(JSON.parse(String(line)));
    });
    restores.push(() => spy.mockRestore());
  }
  const session = new SmbcBackfillSession(state, {
    SESSION_ENCRYPTION_KEY: key,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
    DATA: bucket,
  } as unknown as Env);

  await session.alarm();
  expect(values.get("progress")).toMatchObject({ phase: "running", retryCount: 1 });
  expect(alarms).toHaveLength(1);
  expect(lines).toContainEqual(
    expect.objectContaining({
      event: "collector-diagnostic",
      stage: "manifest-write",
      outcome: "failed",
    }),
  );
  expect(lines).toContainEqual({
    event: "collector-retry",
    source: "smbc-direct",
    runId,
    stage: "manifest-write",
    retryCount: 1,
    retryScheduled: true,
  });
  expect(lines).not.toContainEqual(expect.objectContaining({ stage: "transactions-collection" }));
  expect(JSON.stringify(lines)).not.toContain("manifest_write_failed");
});
