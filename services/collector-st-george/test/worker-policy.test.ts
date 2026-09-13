import { describe, expect, test } from "bun:test";
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
      expect(await create().trigger()).toMatchObject({ status: "blocked", reason });
      const restarted = create();
      expect(await restarted.trigger()).toEqual({ status: "blocked", reason });
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
