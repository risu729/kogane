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
  const importer = {
    fetch: async () =>
      Response.json({
        source: "smbc-direct",
        manifestKey: `${prefix}/manifest.json`,
        status: "sealed",
        centralRunId: 1,
        artifactCount: 4,
        sealed: true,
        finalChunkAllObjectsReused: false,
      }),
  } as unknown as Fetcher;
  const session = new SmbcBackfillSession(state, {
    SESSION_ENCRYPTION_KEY: key,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
    RAW_EVIDENCE_IMPORTER: importer,
    SNAPSHOTS: bucket,
  } as Env);

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
