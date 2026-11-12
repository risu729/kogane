import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import workerThreads from "node:worker_threads";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  guardMiniflareSyncWorker,
  miniflareSyncWorkerGuarded,
  unguardedMiniflareWorker,
} from "./miniflare-sync-worker.ts";
import { miniflareHttpProxyGuarded } from "./miniflare-http-proxy.ts";

const require = createRequire(import.meta.url);
const miniflareEntry = require.resolve("miniflare");

test("the normal preload installs the helper guard once and preserves its constructor surface", () => {
  const installed = workerThreads.Worker;
  expect(miniflareSyncWorkerGuarded()).toBe(true);
  expect(miniflareHttpProxyGuarded()).toBe(true);
  expect(guardMiniflareSyncWorker(installed)).toBe(installed);
  expect(installed.prototype).toBe(unguardedMiniflareWorker.prototype);
  expect(Object.getOwnPropertyNames(installed)).toEqual(
    Object.getOwnPropertyNames(unguardedMiniflareWorker),
  );
});

test("unrelated Worker arguments, subclass newTarget and original constructor exceptions are unchanged", () => {
  const calls: { args: unknown[]; newTarget: object }[] = [];
  const target = new Proxy(unguardedMiniflareWorker, {
    construct(_original, args, newTarget) {
      calls.push({ args, newTarget });
      return Object.create(newTarget.prototype);
    },
  });
  const guarded = guardMiniflareSyncWorker(target);
  const options = { eval: true, workerData: { filename: "/synthetic/unrelated.js" } };
  const script = 'const { Pool, fetch } = actualRequire("undici");';
  const worker = new guarded(script, options);
  expect(worker).toBeInstanceOf(unguardedMiniflareWorker);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual([script, options]);
  expect(calls[0]!.args[1]).toBe(options);
  expect(calls[0]!.newTarget).toBe(guarded);
  class Derived extends guarded {}
  const derived = new Derived(script, options);
  expect(derived).toBeInstanceOf(Derived);
  expect(calls[1]!.newTarget).toBe(Derived);
  const failure = new Error("synthetic constructor failure");
  const rejecting = guardMiniflareSyncWorker(
    new Proxy(unguardedMiniflareWorker, {
      construct() {
        throw failure;
      },
    }),
  );
  const constructRejecting = () => new rejecting(script, options);
  let caught: unknown;
  try {
    constructRejecting();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
});

test("unrelated options accessors are not read by helper identification", () => {
  let reads = 0;
  const options = Object.defineProperty({}, "workerData", {
    get() {
      reads += 1;
      throw new Error("synthetic accessor");
    },
  });
  const target = new Proxy(unguardedMiniflareWorker, {
    construct(_original, args) {
      expect(args[1]).toBe(options);
      return Object.create(unguardedMiniflareWorker.prototype);
    },
  });
  const worker = new (guardMiniflareSyncWorker(target))("unrelated", options);
  expect(worker).toBeInstanceOf(unguardedMiniflareWorker);
  expect(reads).toBe(0);
});

test("a known Miniflare helper with unreviewed source fails before construction", () => {
  const channel = new workerThreads.MessageChannel();
  let constructed = 0;
  const target = new Proxy(unguardedMiniflareWorker, {
    construct() {
      constructed += 1;
      return {};
    },
  });
  try {
    expect(
      () =>
        new (guardMiniflareSyncWorker(target))("unreviewed source", {
          eval: true,
          workerData: {
            filename: miniflareEntry,
            notifyHandle: new Int32Array(new SharedArrayBuffer(4)),
            port: channel.port2,
          },
          transferList: [channel.port2],
        }),
    ).toThrow("unreviewed synchronous helper shape");
    expect(constructed).toBe(0);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

// Appended after the actual installed helper's declarations. This observes
// its lexical fetch and Pool, not a replica of its module-resolution code.
const PROBE = `
;(() => {
  const probeParent = require("node:worker_threads").parentPort;
  const paths = actualRequire("node:path");
  const manifest = actualRequire.resolve("undici/package.json");
  const locked = actualRequire(paths.join(paths.dirname(manifest), "index.js"));
  probeParent.postMessage({ probe: "identity", fetchMatchesLocked: fetch === locked.fetch,
    poolMatchesLocked: Pool === locked.Pool });
  const originalDispatch = Pool.prototype.dispatch;
  Pool.prototype.dispatch = function (...args) {
    probeParent.postMessage({ probe: "dispatch" });
    return Reflect.apply(originalDispatch, this, args);
  };
  port.addEventListener("message", () => probeParent.postMessage({ probe: "request" }));
})();
`;

test("the actual SynchronousFetcher uses locked fetch and Pool once per request and disposes normally", async () => {
  const installed = workerThreads.Worker;
  const records: { probe: string; fetchMatchesLocked?: boolean; poolMatchesLocked?: boolean }[] =
    [];
  const helpers: { exited: boolean; worker: InstanceType<typeof workerThreads.Worker> }[] = [];
  // Observe below the guard: only after its authentic source has been verified
  // and its single import rewritten do we append the read-only probe.
  const observing = new Proxy(unguardedMiniflareWorker, {
    construct(target, args, newTarget) {
      const [script, options] = args;
      if (options?.workerData?.filename !== miniflareEntry)
        return Reflect.construct(target, args, newTarget);
      const worker = Reflect.construct(target, [script + PROBE, options], newTarget);
      const observed = { worker, exited: false };
      helpers.push(observed);
      worker.on(
        "message",
        (value: { probe: string; fetchMatchesLocked?: boolean; poolMatchesLocked?: boolean }) => {
          if (["identity", "dispatch", "request"].includes(value?.probe)) records.push(value);
        },
      );
      worker.once("exit", () => {
        observed.exited = true;
      });
      return worker;
    },
  });
  workerThreads.Worker = guardMiniflareSyncWorker(observing);
  let mf: Miniflare | undefined;
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default {};",
        compatibilityDate: "2026-09-07",
        d1Databases: ["DB", "READ"],
        r2Buckets: ["EVIDENCE"],
      }),
    );
    const db = await mf.getD1Database("DB");
    const read = await mf.getD1Database("READ");
    const bucket = await mf.getR2Bucket("EVIDENCE");
    await db.prepare("CREATE TABLE synthetic(v INTEGER)").run();
    await db.prepare("INSERT INTO synthetic VALUES(1)").run();
    await expect(db.prepare("SELECT * FROM synthetic_missing").all()).rejects.toThrow(
      "synthetic_missing",
    );
    expect(await db.prepare("SELECT count(*) AS n FROM synthetic").first()).toEqual({ n: 1 });
    expect(await read.prepare("SELECT 2 AS n").first()).toEqual({ n: 2 });
    await bucket.put("synthetic", "original");
    expect(await (await bucket.get("synthetic"))?.text()).toBe("original");
  } finally {
    try {
      await mf?.dispose();
    } finally {
      workerThreads.Worker = installed;
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(helpers).toHaveLength(1);
  expect(helpers.every((helper) => helper.exited)).toBe(true);
  expect(records.filter((record) => record.probe === "identity")).toEqual([
    { probe: "identity", fetchMatchesLocked: true, poolMatchesLocked: true },
  ]);
  const requests = records.filter((record) => record.probe === "request").length;
  expect(requests).toBeGreaterThan(0);
  expect(records.filter((record) => record.probe === "dispatch")).toHaveLength(requests);
});
