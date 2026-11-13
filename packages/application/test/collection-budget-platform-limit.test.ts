import { expect, test } from "bun:test";
import { meterBucket, meterD1, OperationMeter } from "../src/collection/budget.ts";
import { platformLimitError } from "../src/collection/platform-limit.ts";

test("limit classification is closed, transient and total for hostile exception shapes", () => {
  for (const message of [
    "D1_ERROR: Too many API requests by single worker invocation.",
    "Too many subrequests.",
    "Subrequest depth limit exceeded.",
    "Worker invocation limit exceeded.",
  ])
    expect(platformLimitError(new Error(message))).toBe(true);
  const getter = Object.defineProperty(new Error(), "message", {
    get() {
      throw new Error("private getter");
    },
  });
  const malformed = Object.defineProperty(new Error(), "message", {
    value: {
      toString() {
        throw new Error("private coercion");
      },
    },
  });
  const prototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("private prototype");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    null,
    undefined,
    "Too many subrequests.",
    {},
    new Error("synthetic unavailable"),
    getter,
    malformed,
    prototype,
    revoked.proxy,
  ]) {
    expect(platformLimitError(value)).toBe(false);
  }
});

test("nested meters count each rejected call per scope and preserve shared Promise and Error identity", async () => {
  const error = new Error("Too many subrequests. private reused marker");
  const rejected = Promise.reject(error);
  const meters = [new OperationMeter(), new OperationMeter(), new OperationMeter()];
  const original = {
    prepare: () => ({ run: () => rejected }),
    batch: (_statements: object[]) => rejected,
  };
  const db = meters.reduce((binding, meter) => meterD1(binding, meter), original);
  const run = db.prepare().run();
  expect(run).toBe(rejected);
  await expect(run).rejects.toBe(error);
  const batch = db.batch([db.prepare(), db.prepare()]);
  expect(batch).toBe(rejected);
  await expect(batch).rejects.toBe(error);
  const bucket = meters.reduce((binding, meter) => meterBucket(binding, meter), {
    head() {
      throw error;
    },
  });
  let caught: unknown;
  try {
    bucket.head();
  } catch (failure) {
    caught = failure;
  }
  expect(caught).toBe(error);
  for (const meter of meters) {
    expect(meter.summary()).toMatchObject({
      d1Statements: 3,
      d1Batches: 1,
      d1FailedStatements: 3,
      d1PlatformLimitCalls: 2,
      r2FailedOperations: 1,
      r2PlatformLimitCalls: 1,
    });
    expect(JSON.stringify(meter.summary())).not.toContain("private");
  }
});

for (const method of ["first", "all", "run", "raw"] as const) {
  test(`the ${method} D1 session call reports one rejection without changing its Promise`, async () => {
    const error = new Error(
      "Too many API requests by single worker invocation. private session marker",
    );
    const rejected = Promise.reject(error);
    const session = { prepare: () => ({ [method]: () => rejected }) };
    const meter = new OperationMeter();
    const db = meterD1({ withSession: () => session }, meter);
    const promise = db.withSession().prepare()[method]!();
    expect(promise).toBe(rejected);
    await expect(promise).rejects.toBe(error);
    expect(meter.summary()).toMatchObject({
      d1Statements: 1,
      d1FailedStatements: 1,
      d1PlatformLimitCalls: 1,
      r2PlatformLimitCalls: 0,
    });
  });
}

test("thenable observer setup and repeated settlement cannot manufacture classified failures", () => {
  const error = new Error("Too many subrequests. private thenable marker");
  const setup = {
    then() {
      throw error;
    },
  };
  const firstSuccess = {
    then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      resolve({ success: true });
      reject(error);
    },
  };
  const firstFailure = {
    then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      reject(error);
      reject(error);
    },
  };
  const meter = new OperationMeter();
  for (const value of [setup, firstSuccess, firstFailure]) {
    const bucket = meterBucket({ get: () => value }, meter);
    expect(bucket.get()).toBe(value);
  }
  expect(meter.summary()).toMatchObject({
    r2Operations: 3,
    r2SettledOperations: 2,
    r2FailedOperations: 1,
    r2PlatformLimitCalls: 1,
  });
  expect(JSON.stringify(meter.summary())).not.toContain("private");
});

test("unclassifiable rejections preserve original failures and ordinary failures stay distinct", async () => {
  const getter = Object.defineProperty(new Error(), "message", {
    get() {
      throw new Error("private getter");
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const meter = new OperationMeter();
  for (const error of [getter, revoked.proxy, new Error("synthetic unavailable")]) {
    const promise = Promise.reject(error);
    const db = meterD1({ prepare: () => ({ run: () => promise }) }, meter);
    expect(db.prepare().run()).toBe(promise);
    await expect(promise).rejects.toBe(error);
  }
  const returned = { success: false, error: "Too many subrequests. private returned value" };
  const db = meterD1({ prepare: () => ({ run: () => returned }) }, meter);
  expect(db.prepare().run()).toBe(returned);
  expect(meter.summary()).toMatchObject({ d1FailedStatements: 4, d1PlatformLimitCalls: 0 });
  expect(JSON.stringify(meter.summary())).not.toContain("private");
});
