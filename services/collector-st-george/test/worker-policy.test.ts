import { describe, expect, test, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  CollectionCoordinator,
  authorized,
  parseCollectionOutput,
  parseCredential,
  type StateStorage,
} from "../src/worker-policy";
import { persistSharedRun } from "../src/shared-collection";
import { snapshot } from "./fixture";

class Storage implements StateStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async transaction<T>(closure: (storage: StateStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try {
      return await closure(this);
    } catch (error) {
      this.values = before;
      throw error;
    }
  }
}
describe("durable collection policy", () => {
  test("legacy blocked state has no invented run id and never starts a bank request", async () => {
    const state = new Storage();
    await state.put("state", { kind: "blocked", reason: "login-rejected" });
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        throw new Error("must not call provider");
      },
      async () => {
        throw new Error("must not persist");
      },
    );
    expect(await coordinator.trigger()).toEqual({ status: "blocked", reason: "login-rejected" });
    expect(await coordinator.resume()).toEqual({ status: "ready" });
  });
  test("an R2 outage retries a large captured snapshot after restart without another bank request", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    const financial = snapshot();
    financial.accounts[0]!.transactions = Array.from({ length: 200 }, () => ({
      ...financial.accounts[0]!.transactions[0]!,
      description: "Synthetic purchase ".repeat(40),
    }));
    expect(new TextEncoder().encode(JSON.stringify(financial)).length).toBeGreaterThan(128 * 1024);
    let reads = 0;
    let outage = true;
    const collect = async () => {
      reads++;
      return { status: "success" as const, snapshot: financial };
    };
    const persist = async (run: Parameters<typeof persistSharedRun>[1]) => {
      if (outage) throw new Error("synthetic storage outage");
      return persistSharedRun(bucket, run);
    };
    const first = new CollectionCoordinator(state, collect, persist);
    expect(await first.trigger()).toMatchObject({
      status: "failed",
      reason: "persistence-incomplete",
    });
    expect(await first.resume()).toMatchObject({ reason: "persistence-pending" });
    const chunks = [...state.values.values()].filter(
      (value): value is Uint8Array => value instanceof Uint8Array,
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
    outage = false;
    const restarted = new CollectionCoordinator(state, collect, persist);
    expect(await restarted.trigger()).toMatchObject({ status: "stored" });
    expect(reads).toBe(1);
    expect(state.values.size).toBe(0);
  });
  test("auth and network failures remain blocked until an explicit resume", async () => {
    for (const reason of ["authentication-challenge", "bank-request-error"] as const) {
      const state = new Storage();
      const bucket = new FakeR2Bucket();
      let reads = 0;
      const create = () =>
        new CollectionCoordinator(
          state,
          async () => {
            reads++;
            return { status: "failed", reason };
          },
          (run) => persistSharedRun(bucket, run),
        );
      const first = await create().trigger();
      expect(first).toMatchObject({ status: "blocked", reason });
      expect(first.runId).toBeString();
      const restarted = create();
      expect(await restarted.trigger()).toEqual({ status: "blocked", reason, runId: first.runId! });
      expect(reads).toBe(1);
      expect(await restarted.resume()).toEqual({ status: "ready" });
      await restarted.trigger();
      expect(reads).toBe(2);
    }
  });
  test("a persisted in-flight marker blocks an uncertain login after restart", async () => {
    const state = new Storage();
    await state.put("state", { kind: "running" });
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        throw new Error("must not call provider");
      },
      async () => {
        throw new Error("must not persist");
      },
    );
    expect(await coordinator.trigger()).toEqual({
      status: "blocked",
      reason: "collection-interrupted",
    });
    expect(await coordinator.resume()).toEqual({ status: "ready" });
  });
  test("concurrent triggers and resume never start a second authentication", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        await wait;
        return { status: "success", snapshot: snapshot() };
      },
      (run) => persistSharedRun(bucket, run),
    );
    const pending = coordinator.trigger();
    expect(await coordinator.trigger()).toEqual({ status: "busy" });
    expect(await coordinator.resume()).toEqual({ status: "busy" });
    release();
    expect(await pending).toMatchObject({ status: "stored" });
    expect(reads).toBe(1);
  });
  test("credentials and error text cannot enter the safe outcome", () => {
    expect(() => parseCredential('{"password":"synthetic"}')).toThrow("invalid-credentials");
    expect(
      parseCollectionOutput({
        status: "failed",
        reason: "password=synthetic",
        cookie: "synthetic",
      }),
    ).toEqual({ status: "failed", reason: "container-failed" });
    expect(
      authorized(
        new Request("https://test", { headers: { authorization: "Bearer " + "x".repeat(32) } }),
        "x".repeat(32),
      ),
    ).toBe(true);
    expect(
      authorized(
        new Request("https://test", { headers: { authorization: "Bearer short" } }),
        "short",
      ),
    ).toBe(false);
  });
});

const savedRunId = "11111111-1111-4111-8111-111111111111";
const otherRunId = "22222222-2222-4222-8222-222222222222";
const savedMetadata = {
  runId: savedRunId,
  attemptId: "attempt-33333333-3333-4333-8333-333333333333",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
};
function savedState(reason?: "login-rejected" | "authentication-challenge"): Storage {
  const storage = new Storage();
  const bytes = reason ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(snapshot()));
  const count = Math.ceil(bytes.length / (64 * 1024));
  storage.values.set("state", {
    kind: "pending",
    run: { ...savedMetadata, ...(reason ? { reason } : {}) },
    snapshotChunks: count,
  });
  for (let index = 0; index < count; index++)
    storage.values.set(
      `pending:${savedRunId}:${index}`,
      bytes.slice(index * 64 * 1024, (index + 1) * 64 * 1024),
    );
  return storage;
}
function retryHarness(
  storage: StateStorage,
  persist: ConstructorParameters<typeof CollectionCoordinator>[2] = (run) =>
    persistSharedRun(new FakeR2Bucket(), run),
) {
  const collect = mock(async (): Promise<never> => {
    throw new Error("provider must not run");
  });
  return { coordinator: new CollectionCoordinator(storage, collect, persist), collect };
}
async function onlyRetry(
  coordinator: CollectionCoordinator,
  input: unknown = { expectedRunId: savedRunId },
) {
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("must not invent identity");
  });
  try {
    const result = await coordinator.retryPending(input);
    expect(uuid).not.toHaveBeenCalled();
    return result;
  } finally {
    uuid.mockRestore();
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("internal saved-only retry", () => {
  test("restarts existing large pending evidence and preserves identity, without collect or UUID", async () => {
    const storage = new Storage();
    const bucket = new FakeR2Bucket();
    const financial = snapshot();
    financial.accounts[0]!.transactions = Array.from({ length: 200 }, () => ({
      ...financial.accounts[0]!.transactions[0]!,
      description: "Synthetic purchase ".repeat(40),
    }));
    const first = new CollectionCoordinator(
      storage,
      async () => ({ status: "success", snapshot: financial }),
      async () => {
        throw new Error("synthetic outage");
      },
    );
    const failed = await first.trigger();
    expect(failed.status).toBe("failed");
    const metadata = await storage.get<{ run: typeof savedMetadata; snapshotChunks: number }>(
      "state",
    );
    expect(metadata!.snapshotChunks).toBeGreaterThan(2);
    const runs: Parameters<typeof persistSharedRun>[1][] = [];
    const { coordinator, collect } = retryHarness(storage, async (run) => {
      runs.push(structuredClone(run));
      return persistSharedRun(bucket, run);
    });
    expect(await onlyRetry(coordinator, { expectedRunId: failed.runId })).toMatchObject({
      status: "stored",
      runId: failed.runId,
    });
    expect(runs).toEqual([{ ...metadata!.run, snapshot: financial }]);
    expect(storage.values.size).toBe(0);
    expect(await onlyRetry(coordinator, { expectedRunId: failed.runId })).toEqual({
      status: "refused",
      reason: "not-pending",
    });
    expect(collect).not.toHaveBeenCalled();
  });

  test("a failure terminal remains blocked rather than reporting collection success", async () => {
    for (const reason of ["login-rejected", "authentication-challenge"] as const) {
      const storage = savedState(reason);
      const { coordinator, collect } = retryHarness(storage);
      expect(await onlyRetry(coordinator)).toMatchObject({
        status: "blocked",
        runId: savedRunId,
        reason,
      });
      expect(await storage.get<unknown>("state")).toEqual({
        kind: "blocked",
        reason,
        runId: savedRunId,
      });
      expect(await onlyRetry(coordinator)).toEqual({ status: "refused", reason: "not-pending" });
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("exact input refuses wrong shape, excess fields, symbols, access errors and invalid UUID", async () => {
    for (const input of [
      null,
      [],
      {},
      { expectedRunId: "bad" },
      { expectedRunId: savedRunId, force: true },
      { expectedRunId: savedRunId, [Symbol("extra")]: true },
      Object.defineProperty({}, "expectedRunId", {
        enumerable: true,
        get() {
          throw new Error("secret");
        },
      }),
    ]) {
      const storage = savedState();
      const before = structuredClone(storage.values);
      const persist = mock(async (): Promise<never> => {
        throw new Error("must not persist");
      });
      const { coordinator, collect } = retryHarness(storage, persist);
      expect(await onlyRetry(coordinator, input)).toEqual({
        status: "refused",
        reason: "invalid-request",
      });
      expect(storage.values).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("copies the input before the first await", async () => {
    const storage = savedState();
    const gate = deferred();
    const original = storage.get.bind(storage);
    storage.get = async <T>(key: string) => {
      await gate.promise;
      return original<T>(key);
    };
    const { coordinator, collect } = retryHarness(storage);
    const input = { expectedRunId: savedRunId };
    const promise = onlyRetry(coordinator, input);
    input.expectedRunId = otherRunId;
    gate.resolve();
    expect(await promise).toMatchObject({ status: "stored", runId: savedRunId });
    expect(collect).not.toHaveBeenCalled();
  });

  test("absent/running/blocked/mismatched state refuses without writes or external callbacks", async () => {
    for (const state of [
      undefined,
      { kind: "running" },
      { kind: "blocked", reason: "login-rejected" },
      { kind: "blocked", runId: savedRunId, reason: "login-rejected" },
      { kind: "pending", run: { ...savedMetadata, runId: otherRunId }, snapshotChunks: 1 },
    ]) {
      const storage = savedState();
      if (state === undefined) storage.values.delete("state");
      else storage.values.set("state", state);
      const before = structuredClone(storage.values);
      const persist = mock(async (): Promise<never> => {
        throw new Error("must not persist");
      });
      const { coordinator, collect } = retryHarness(storage, persist);
      expect(await onlyRetry(coordinator)).toMatchObject({ status: "refused" });
      expect(storage.values).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("strict pending metadata and mutually exclusive snapshot/failure shape", async () => {
    const invalid = [
      { run: { ...savedMetadata, extra: "secret" }, snapshotChunks: 1 },
      { run: { ...savedMetadata, runId: "bad" }, snapshotChunks: 1 },
      { run: { ...savedMetadata, attemptId: savedRunId }, snapshotChunks: 1 },
      { run: { ...savedMetadata, startedAt: "yesterday" }, snapshotChunks: 1 },
      { run: { ...savedMetadata, startedAt: "2026-02-30T00:00:00.000Z" }, snapshotChunks: 1 },
      { run: { ...savedMetadata, completedAt: "2025-12-31T00:00:00.000Z" }, snapshotChunks: 1 },
      { run: savedMetadata, snapshotChunks: 0 },
      { run: savedMetadata, snapshotChunks: 33 },
      { run: savedMetadata, snapshotChunks: -1 },
      { run: savedMetadata, snapshotChunks: 1.5 },
      { run: savedMetadata, snapshotChunks: "1" },
      { run: { ...savedMetadata, reason: "login-rejected" }, snapshotChunks: 1 },
      { run: { ...savedMetadata, reason: "provider secret" }, snapshotChunks: 0 },
      { run: { ...savedMetadata, reason: undefined }, snapshotChunks: 0 },
      { run: { ...savedMetadata, snapshot: snapshot() }, snapshotChunks: 1 },
      { run: savedMetadata, snapshotChunks: 1, extra: true },
    ];
    for (const item of invalid) {
      const storage = savedState();
      storage.values.set("state", { kind: "pending", ...item });
      const before = structuredClone(storage.values);
      const persist = mock(async (): Promise<never> => {
        throw new Error("must not persist");
      });
      const { coordinator, collect } = retryHarness(storage, persist);
      expect(await onlyRetry(coordinator)).toEqual({
        status: "refused",
        reason: "invalid-pending",
      });
      expect(storage.values).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("missing, oversized, empty, invalid UTF8/JSON/shape and residual chunks remain untouched", async () => {
    for (const chunk of [
      undefined,
      "text",
      new Uint8Array(),
      new Uint8Array(64 * 1024 + 1),
      new Uint8Array([0xff]),
      new TextEncoder().encode("{"),
      new TextEncoder().encode("{}"),
    ]) {
      const storage = savedState();
      if (chunk === undefined) storage.values.delete(`pending:${savedRunId}:0`);
      else storage.values.set(`pending:${savedRunId}:0`, chunk);
      const before = structuredClone(storage.values);
      const persist = mock(async (): Promise<never> => {
        throw new Error("must not persist");
      });
      const { coordinator, collect } = retryHarness(storage, persist);
      expect(await onlyRetry(coordinator)).toEqual({
        status: "refused",
        reason: "invalid-pending",
      });
      expect(storage.values).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    }
    for (const reason of [undefined, "login-rejected"] as const) {
      const storage = savedState(reason);
      storage.values.set(`pending:${savedRunId}:31`, new Uint8Array([1]));
      const before = structuredClone(storage.values);
      const { coordinator, collect } = retryHarness(storage);
      expect(await onlyRetry(coordinator)).toEqual({
        status: "refused",
        reason: "invalid-pending",
      });
      expect(storage.values).toEqual(before);
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("storage failures are closed and release the active guard", async () => {
    const storage = savedState();
    const before = structuredClone(storage.values);
    const original = storage.get.bind(storage);
    storage.get = async () => {
      throw new Error("synthetic secret storage error");
    };
    const { coordinator, collect } = retryHarness(storage);
    expect(await onlyRetry(coordinator)).toEqual({ status: "failed", reason: "state-unavailable" });
    expect(storage.values).toEqual(before);
    storage.get = original;
    expect(await onlyRetry(coordinator)).toMatchObject({ status: "stored" });
    expect(collect).not.toHaveBeenCalled();
  });

  test("persistence throw, incomplete and conflict keep the exact original evidence", async () => {
    const bucket = new FakeR2Bucket();
    const success = await persistSharedRun(bucket, { ...savedMetadata, snapshot: snapshot() });
    if (success.outcome !== "persisted") throw new Error("synthetic fixture failed");
    for (const outcome of ["throw", "incomplete", "conflict"] as const) {
      const storage = savedState();
      const before = structuredClone(storage.values);
      const { coordinator, collect } = retryHarness(storage, async () => {
        if (outcome === "throw") throw new Error("synthetic secret");
        return {
          ...success,
          outcome,
          reasonCode: "synthetic",
          storedDigest: null,
          failedArtifactKey: null,
        };
      });
      expect(await onlyRetry(coordinator)).toEqual({
        status: "failed",
        reason: "persistence-incomplete",
      });
      expect(storage.values).toEqual(before);
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("held persistence cannot erase a replacement state, metadata, failure reason or chunk", async () => {
    const mutations: ((storage: Storage) => void)[] = [
      (s) =>
        s.values.set("state", { kind: "blocked", reason: "login-rejected", runId: otherRunId }),
      (s) =>
        s.values.set("state", {
          kind: "pending",
          run: { ...savedMetadata, runId: otherRunId },
          snapshotChunks: 1,
        }),
      ...["attemptId", "startedAt", "completedAt"].map((field) => (s: Storage) => {
        const state = s.values.get("state") as { run: Record<string, unknown> };
        state.run[field] =
          field === "attemptId" ? `attempt-${otherRunId}` : "2026-01-01T00:00:30.000Z";
      }),
      (s) =>
        s.values.set("state", {
          kind: "pending",
          run: { ...savedMetadata, reason: "login-rejected" },
          snapshotChunks: 0,
        }),
      (s) => s.values.set(`pending:${savedRunId}:0`, new Uint8Array([1])),
      (s) => s.values.delete(`pending:${savedRunId}:0`),
      (s) => s.values.set(`pending:${savedRunId}:31`, new Uint8Array([1])),
      (s) => s.values.delete("state"),
    ];
    for (const mutate of mutations) {
      const storage = savedState();
      const entered = deferred();
      const release = deferred();
      const bucket = new FakeR2Bucket();
      let writes = 0;
      const { coordinator, collect } = retryHarness(storage, async (run) => {
        writes++;
        entered.resolve();
        await release.promise;
        return persistSharedRun(bucket, run);
      });
      const pending = onlyRetry(coordinator);
      await entered.promise;
      mutate(storage);
      const changed = structuredClone(storage.values);
      release.resolve();
      expect(await pending).toEqual({ status: "refused", reason: "state-changed" });
      expect(storage.values).toEqual(changed);
      expect(writes).toBe(1);
      expect(collect).not.toHaveBeenCalled();
    }
    const storage = savedState("login-rejected");
    const { coordinator, collect } = retryHarness(storage, async (run) => {
      storage.values.set("state", {
        kind: "pending",
        run: { ...savedMetadata, reason: "authentication-challenge" },
        snapshotChunks: 0,
      });
      return persistSharedRun(new FakeR2Bucket(), run);
    });
    expect(await onlyRetry(coordinator)).toEqual({ status: "refused", reason: "state-changed" });
    expect(await storage.get<unknown>("state")).toMatchObject({
      run: { reason: "authentication-challenge" },
    });
    expect(collect).not.toHaveBeenCalled();
  });

  test("cleanup rollback retains pending, then already-persisted retry finishes the same run", async () => {
    const storage = savedState();
    const before = structuredClone(storage.values);
    const bucket = new FakeR2Bucket();
    const outcomes: string[] = [];
    const originalDelete = storage.delete.bind(storage);
    storage.delete = async (key) => {
      await originalDelete(key);
      throw new Error("synthetic cleanup outage");
    };
    const { coordinator, collect } = retryHarness(storage, async (run) => {
      const result = await persistSharedRun(bucket, run);
      outcomes.push(result.outcome);
      return result;
    });
    expect(await onlyRetry(coordinator)).toEqual({ status: "failed", reason: "state-unavailable" });
    expect(storage.values).toEqual(before);
    storage.delete = originalDelete;
    expect(await onlyRetry(coordinator)).toMatchObject({ status: "stored", runId: savedRunId });
    expect(outcomes).toEqual(["persisted", "already_persisted"]);
    expect(storage.values.size).toBe(0);
    expect(collect).not.toHaveBeenCalled();
  });

  test("uses the transaction handle and a transaction retry never repeats external persistence", async () => {
    const storage = savedState();
    let inTransaction = false;
    let transactions = 0;
    let persistence = 0;
    const directGet = storage.get.bind(storage),
      directPut = storage.put.bind(storage),
      directDelete = storage.delete.bind(storage);
    const handle: StateStorage = {
      get: directGet,
      put: directPut,
      delete: directDelete,
      transaction: async () => {
        throw new Error("nested transaction");
      },
    };
    storage.get = async <T>(key: string) => {
      if (inTransaction) throw new Error("wrong handle");
      return directGet<T>(key);
    };
    storage.put = async (key, value) => {
      if (inTransaction) throw new Error("wrong handle");
      await directPut(key, value);
    };
    storage.delete = async (key) => {
      if (inTransaction) throw new Error("wrong handle");
      await directDelete(key);
    };
    storage.transaction = async (closure) => {
      inTransaction = true;
      try {
        transactions++;
        if (transactions === 2) {
          const before = structuredClone(storage.values);
          await closure(handle);
          storage.values = before;
        }
        return await closure(handle);
      } finally {
        inTransaction = false;
      }
    };
    const { coordinator, collect } = retryHarness(storage, async (run) => {
      expect(inTransaction).toBe(false);
      persistence++;
      return persistSharedRun(new FakeR2Bucket(), run);
    });
    expect(await onlyRetry(coordinator)).toMatchObject({ status: "stored" });
    expect(persistence).toBe(1);
    expect(transactions).toBe(2);
    expect(collect).not.toHaveBeenCalled();
  });

  test("retry holds the same busy guard as trigger and resume", async () => {
    const storage = savedState();
    const entered = deferred();
    const release = deferred();
    const { coordinator, collect } = retryHarness(storage, async (run) => {
      entered.resolve();
      await release.promise;
      return persistSharedRun(new FakeR2Bucket(), run);
    });
    const pending = onlyRetry(coordinator);
    await entered.promise;
    expect(await coordinator.retryPending({ expectedRunId: savedRunId })).toEqual({
      status: "busy",
    });
    expect(await coordinator.trigger()).toEqual({ status: "busy" });
    expect(await coordinator.resume()).toEqual({ status: "busy" });
    release.resolve();
    expect(await pending).toMatchObject({ status: "stored" });
    expect(collect).not.toHaveBeenCalled();
  });

  test("trigger and resume each keep retry busy without altering their existing behavior", async () => {
    for (const method of ["trigger", "resume"] as const) {
      const storage = savedState();
      const gate = deferred();
      const originalGet = storage.get.bind(storage);
      storage.get = async <T>(key: string) => {
        await gate.promise;
        return originalGet<T>(key);
      };
      const { coordinator, collect } = retryHarness(storage);
      const active = coordinator[method]();
      expect(await onlyRetry(coordinator)).toEqual({ status: "busy" });
      expect(await coordinator.trigger()).toEqual({ status: "busy" });
      expect(await coordinator.resume()).toEqual({ status: "busy" });
      gate.resolve();
      expect(await active).toMatchObject(
        method === "trigger"
          ? { status: "stored" }
          : { status: "failed", reason: "persistence-pending" },
      );
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("accepts the full 2 MiB / 32 chunk bound and refuses one additional byte", async () => {
    for (const extra of [0, 1]) {
      const storage = savedState();
      const serialized = JSON.stringify(snapshot());
      const bytes = new TextEncoder().encode(
        serialized + " ".repeat(2 * 1024 * 1024 - serialized.length + extra),
      );
      storage.values.set("state", { kind: "pending", run: savedMetadata, snapshotChunks: 32 });
      for (let index = 0; index < 32; index++)
        storage.values.set(
          `pending:${savedRunId}:${index}`,
          bytes.slice(index * 64 * 1024, index === 31 ? undefined : (index + 1) * 64 * 1024),
        );
      const before = structuredClone(storage.values);
      const { coordinator, collect } = retryHarness(storage);
      expect(await onlyRetry(coordinator)).toMatchObject(
        extra === 0 ? { status: "stored" } : { status: "refused", reason: "invalid-pending" },
      );
      if (extra) expect(storage.values).toEqual(before);
      expect(collect).not.toHaveBeenCalled();
    }
  });

  test("the method remains absent from Worker and private schedule entrypoints", () => {
    for (const file of ["../src/worker.ts", "../src/schedule-entrypoint.ts"])
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toContain("retryPending");
  });

  test("unaddressed keys outside the bounded run namespace are not deleted", async () => {
    const storage = savedState();
    storage.values.set(`pending:${savedRunId}:32`, new Uint8Array([9]));
    storage.values.set(`pending:${otherRunId}:0`, new Uint8Array([8]));
    const { coordinator, collect } = retryHarness(storage);
    expect(await onlyRetry(coordinator)).toMatchObject({ status: "stored" });
    expect(storage.values.size).toBe(2);
    expect(storage.values.get(`pending:${savedRunId}:32`)).toEqual(new Uint8Array([9]));
    expect(collect).not.toHaveBeenCalled();
  });
});
