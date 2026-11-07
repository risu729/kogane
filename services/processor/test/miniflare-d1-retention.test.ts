import { expect, test } from "bun:test";
import {
  pendingNativeD1Calls,
  retainedNativeD1References,
  retainNativeD1,
} from "./miniflare-d1-retention.ts";

function deferred() {
  let resolve!: (value: object) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<object>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("D1 calls retain receiver, method and a snapshot of mutable array references", async () => {
  const before = pendingNativeD1Calls();
  const gate = deferred();
  const statement = {};
  const statements = [statement];
  const native = {
    batch(actual: object[]) {
      expect(this).toBe(native);
      expect(actual).toBe(statements);
      return gate.promise;
    },
  };
  const guarded = retainNativeD1(native);
  const detached = guarded.batch;
  const pending = detached(statements);
  statements.length = 0;
  expect(pendingNativeD1Calls()).toBe(before + 1);
  expect(retainedNativeD1References()).toContain(statement);
  expect(retainedNativeD1References()).toContain(native);
  expect(retainedNativeD1References()).toContain(native.batch);
  const result = { results: [] };
  gate.resolve(result);
  expect(await pending).toBe(result);
  expect(pendingNativeD1Calls()).toBe(before);
  expect(retainedNativeD1References()).not.toContain(statement);
});

test("rejection, synchronous return and synchronous throw release their pins", async () => {
  const before = pendingNativeD1Calls();
  const gate = deferred();
  const error = new Error("synthetic D1 failure");
  const native = {
    all: () => gate.promise,
    getBookmark: () => "bookmark",
    exec: () => {
      throw error;
    },
  };
  const guarded = retainNativeD1(native);
  const pending = guarded.all();
  gate.reject(error);
  expect(
    await pending.then(
      () => null,
      (caught: unknown) => caught,
    ),
  ).toBe(error);
  expect(pendingNativeD1Calls()).toBe(before);
  expect(guarded.getBookmark()).toBe("bookmark");
  expect(pendingNativeD1Calls()).toBe(before);
  expect(() => guarded.exec()).toThrow(error);
  expect(pendingNativeD1Calls()).toBe(before);
});

test("overlapping calls keep independent pins until each response settles", async () => {
  const before = pendingNativeD1Calls();
  const first = deferred();
  const second = deferred();
  const native = retainNativeD1({
    run: (index: number) => (index === 0 ? first.promise : second.promise),
  });
  const a = native.run(0);
  const b = native.run(1);
  expect(pendingNativeD1Calls()).toBe(before + 2);
  first.resolve({});
  await a;
  expect(pendingNativeD1Calls()).toBe(before + 1);
  second.reject(new Error("synthetic second failure"));
  await b.catch(() => undefined);
  expect(pendingNativeD1Calls()).toBe(before);
});

test("native metadata, method identity and prepare/bind/session chains are preserved", async () => {
  const address = Symbol("native-address");
  const result = { results: [{ n: 1 }] };
  const rawStatement = {
    [address]: 7,
    bind() {
      return this;
    },
    all: () => Promise.resolve(result),
  };
  const rawSession = { prepare: () => rawStatement, getBookmark: () => "bookmark" };
  const rawDatabase = { prepare: () => rawStatement, withSession: () => rawSession };
  const database = retainNativeD1(rawDatabase);
  expect(retainNativeD1(rawDatabase)).toBe(database);
  expect(database.prepare).toBe(database.prepare);
  const statement = database.prepare();
  expect(statement.bind()).toBe(statement);
  expect(address in statement).toBe(true);
  expect(statement[address]).toBe(7);
  expect(Object.getPrototypeOf(statement)).toBe(Object.getPrototypeOf(rawStatement));
  expect(await statement.all()).toBe(result);
  expect(database.withSession().prepare()).toBe(statement);
  expect(database.withSession().getBookmark()).toBe("bookmark");
});

test("reference snapshots avoid getters, tolerate cycles and do not traverse plain objects", async () => {
  const gate = deferred();
  let reads = 0;
  const accessor = Object.defineProperty([], "0", {
    get() {
      reads++;
      return {};
    },
  });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const plain = Object.defineProperty({}, "value", {
    get() {
      reads++;
      return {};
    },
  });
  const native = retainNativeD1({ batch: (_args: unknown[]) => gate.promise });
  const pending = native.batch([accessor, cycle, plain]);
  expect(reads).toBe(0);
  gate.resolve({});
  await pending;
});
