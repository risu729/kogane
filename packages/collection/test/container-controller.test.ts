import { describe, expect, test } from "bun:test";
import {
  ContainerController,
  type ContainerContext,
  type ContainerProcess,
  type ContainerStop,
} from "../src/container-controller";
import { getContainer } from "../src/container-stub";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const idleKey = "__kogane_container_idle_v1";
function fixture(running = false, idleMs = 30_000, saved = new Map<string, unknown>()) {
  const monitor = deferred<void>();
  let alarmAt: number | undefined;
  const alarmWrites: number[] = [];
  const storageKeys: string[] = [];
  saved.set("sdk-sentinel", "synthetic-sdk-state");
  const waits: Promise<unknown>[] = [];
  let starts = 0,
    deletes = 0,
    destroys = 0,
    health = 0,
    posts = 0;
  const signals: number[] = [],
    timeouts: number[] = [],
    stops: ContainerStop[] = [],
    errors: unknown[] = [];
  const configs: unknown[] = [];
  const started: number[] = [];
  let reply: (request: Request) => Promise<Response> = async () => new Response("synthetic");
  let check: () => Promise<Response> = async () => new Response("ready");
  let allocationErrors = 0;
  const process: ContainerProcess = {
    running,
    start(options) {
      starts++;
      configs.push(options);
      if (allocationErrors-- > 0)
        throw new Error(
          "there is no container instance that can be provided to this durable object",
        );
      Object.assign(process, { running: true });
    },
    monitor: () => monitor.promise,
    destroy: async () => {
      destroys++;
      Object.assign(process, { running: false });
      monitor.resolve();
    },
    signal: (value) => {
      signals.push(value);
    },
    setInactivityTimeout: async (value) => {
      timeouts.push(value);
    },
    getTcpPort: (port) => {
      expect(port).toBe(8080);
      return {
        fetch: async (request) => {
          if (new URL(request.url).pathname === "/health") {
            health++;
            return check();
          }
          posts++;
          return reply(request);
        },
      };
    },
  };
  const ctx: ContainerContext = {
    container: process,
    blockConcurrencyWhile: (callback) => callback(),
    storage: {
      get: async (key) => saved.get(key),
      put: async (key, value) => {
        storageKeys.push(key);
        saved.set(key, value);
      },
      delete: async (key) => {
        storageKeys.push(key);
        return saved.delete(key);
      },
      setAlarm: async (timestamp) => {
        alarmAt = timestamp;
        alarmWrites.push(timestamp);
      },
      deleteAlarm: async () => {
        deletes++;
        alarmAt = undefined;
      },
    },
    waitUntil: (promise) => {
      waits.push(promise);
    },
  };
  const controller = new ContainerController(
    ctx,
    { TZ: "synthetic/timezone" },
    {
      onStart: () => {
        started.push(1);
      },
      onStop: (value) => stops.push(value),
      onError: (error) => errors.push(error),
    },
    { startupMs: 40, pollMs: 1, pingMs: 5, idleMs },
  );
  return {
    ctx,
    process,
    controller,
    saved,
    storageKeys,
    alarmWrites,
    alarmAt: () => alarmAt,
    monitor,
    waits,
    timeouts,
    configs,
    signals,
    started,
    stops,
    errors,
    counts: () => ({ starts, deletes, destroys, health, posts }),
    reply: (fn: typeof reply) => {
      reply = fn;
    },
    check: (fn: typeof check) => {
      check = fn;
    },
    allocations: (count: number) => {
      allocationErrors = count;
    },
  };
}
describe("direct container lifecycle", () => {
  test("named stub identity is unchanged", () => {
    const names: string[] = [];
    const stub = {};
    expect(
      getContainer(
        {
          idFromName: (name: string) => {
            names.push(name);
            return name;
          },
          get: (id: string) => {
            expect(id).toBe("existing-name");
            return stub;
          },
        },
        "existing-name",
      ),
    ).toBe(stub);
    expect(names).toEqual(["existing-name"]);
  });
  test("coalesces concurrent startup and passes exact internet/timezone options", async () => {
    const f = fixture();
    const check = deferred<Response>();
    f.check(() => check.promise);
    const a = f.controller.startAndWaitForPorts(),
      b = f.controller.startAndWaitForPorts();
    expect(a).toBe(b);
    check.resolve(new Response("ready"));
    await Promise.all([a, b]);
    expect(f.counts().starts).toBe(1);
    expect(f.configs).toEqual([{ enableInternet: true, env: { TZ: "synthetic/timezone" } }]);
    expect(f.timeouts).toEqual([30_000]);
  });
  test("allocation and readiness retries never send a POST", async () => {
    const f = fixture();
    f.allocations(2);
    let checks = 0;
    f.check(async () => {
      if (checks++ === 0) throw new Error("not listening");
      return new Response("ready");
    });
    await f.controller.startAndWaitForPorts();
    expect(f.counts().starts).toBe(3);
    expect(f.counts().health).toBe(2);
    expect(f.counts().posts).toBe(0);
  });
  test("a transport failure never replays the application POST", async () => {
    const f = fixture();
    f.reply(async () => {
      throw new Error("synthetic-private");
    });
    await expect(
      f.controller.fetch(new Request("http://container/collect", { method: "POST" })),
    ).rejects.toThrow("synthetic-private");
    expect(f.counts().posts).toBe(1);
  });
  test("retains lifetime until a delayed response body completes", async () => {
    const f = fixture();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    f.reply(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              stream = value;
            },
          }),
        ),
    );
    const res = await f.controller.fetch(
      new Request("http://container/collect", { method: "POST" }),
    );
    const lifetime = f.waits.at(-1)!;
    let done = false;
    void lifetime.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    stream.enqueue(new TextEncoder().encode("synthetic"));
    stream.close();
    expect(await res.text()).toBe("synthetic");
    await lifetime;
    expect(done).toBe(true);
    expect(f.counts().posts).toBe(1);
    expect(f.counts().destroys).toBe(0);
  });
  test("response backpressure bounds upstream reads and cancellation releases lifetime", async () => {
    const f = fixture();
    let reads = 0,
      canceled = 0;
    f.reply(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(stream) {
                reads++;
                stream.enqueue(new Uint8Array([1]));
              },
              cancel() {
                canceled++;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const response = await f.controller.fetch(new Request("http://container/collect"));
    let finished = false;
    const lifetime = f.waits.at(-1)!;
    void lifetime.then(() => {
      finished = true;
    });
    await Bun.sleep(0);
    expect(reads).toBe(1);
    expect(finished).toBe(false);
    await response.body!.cancel();
    await lifetime;
    expect(canceled).toBe(1);
    expect(finished).toBe(true);
  });
  test("body cancel and body failure both release lifetime", async () => {
    for (const failure of [false, true]) {
      const f = fixture();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      f.reply(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(value) {
                stream = value;
              },
            }),
          ),
      );
      const res = await f.controller.fetch(new Request("http://container/collect"));
      const lifetime = f.waits.at(-1)!;
      if (failure) {
        stream.error(new Error("synthetic-stream-failure"));
        await expect(res.text()).rejects.toThrow("synthetic-stream-failure");
      } else await res.body!.cancel();
      await lifetime;
    }
  });
  test("constructor reattaches timeout/monitor and replaces only the SDK alarm", async () => {
    const f = fixture(true);
    await f.waits[0];
    expect(f.counts().starts).toBe(0);
    expect(f.counts().deletes).toBe(1);
    expect(f.timeouts).toEqual([30_000]);
    expect(f.waits).toHaveLength(1);
    f.monitor.reject(Object.assign(new Error("synthetic-private"), { exitCode: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stops).toEqual([{ reason: "exit", exitCode: 7 }]);
    expect(f.errors).toEqual([]);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.saved.get("sdk-sentinel")).toBe("synthetic-sdk-state");
    expect(f.storageKeys.every((key) => key === idleKey)).toBe(true);
  });
  test("graceful stop uses SIGTERM and records native exit code", async () => {
    const f = fixture();
    await f.controller.startAndWaitForPorts();
    await f.controller.stop();
    expect(f.signals).toEqual([15]);
    f.monitor.reject(Object.assign(new Error("private"), { exitCode: 143 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stops).toEqual([{ reason: "runtime_signal", exitCode: 143 }]);
  });
  test("destroy cancels pending readiness and keeps storage intact", async () => {
    const f = fixture();
    const check = deferred<Response>();
    f.check(() => check.promise);
    const start = f.controller.startAndWaitForPorts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.controller.destroy();
    check.resolve(new Response("ready"));
    await expect(start).rejects.toThrow("container-start-canceled");
    expect(f.counts().destroys).toBe(1);
    expect(f.counts().posts).toBe(0);
    expect(f.stops).toEqual([{ reason: "destroyed" }]);
  });
  test("readiness has a bounded deadline and no application retry", async () => {
    const f = fixture();
    f.check(async () => new Response("not ready", { status: 503 }));
    await expect(f.controller.startAndWaitForPorts()).rejects.toThrow("container-start-timeout");
    expect(f.counts().posts).toBe(0);
  });
  test("process exit before readiness is terminal", async () => {
    const f = fixture();
    f.check(async () => {
      Object.assign(f.process, { running: false });
      throw new Error("gone");
    });
    await expect(f.controller.startAndWaitForPorts()).rejects.toThrow(
      "container-start-process-exit",
    );
    expect(f.counts().starts).toBe(1);
    expect(f.counts().posts).toBe(0);
  });

  test("reused healthy process starts once and repeated stop sends one signal", async () => {
    const f = fixture();
    await f.controller.startAndWaitForPorts();
    await f.controller.startAndWaitForPorts();
    expect(f.started).toHaveLength(1);
    await f.controller.stop();
    await f.controller.stop();
    expect(f.signals).toEqual([15]);
  });
  test("late old monitor cannot report or remove monitoring of a new process", async () => {
    for (const reject of [false, true]) {
      const f = fixture();
      const current = deferred<void>();
      let calls = 0;
      Object.assign(f.process, {
        monitor: () => (++calls === 1 ? f.monitor.promise : current.promise),
      });
      await f.controller.startAndWaitForPorts();
      Object.assign(f.process, { running: false });
      await f.controller.startAndWaitForPorts();
      expect(calls).toBe(2);
      expect(f.started).toHaveLength(2);
      if (reject) f.monitor.reject(Object.assign(new Error("obsolete"), { exitCode: 9 }));
      else f.monitor.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.stops).toEqual([]);
      expect(f.errors).toEqual([]);
      current.reject(Object.assign(new Error("current"), { exitCode: 4 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.stops).toEqual([{ reason: "exit", exitCode: 4 }]);
    }
  });

  test("old monitor is invalidated before awaiting new timeout configuration", async () => {
    const f = fixture();
    const current = deferred<void>();
    const timeout = deferred<void>();
    let calls = 0;
    Object.assign(f.process, {
      monitor: () => (++calls === 1 ? f.monitor.promise : current.promise),
    });
    await f.controller.startAndWaitForPorts();
    Object.assign(f.process, { running: false, setInactivityTimeout: () => timeout.promise });
    const start = f.controller.startAndWaitForPorts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.monitor.reject(Object.assign(new Error("obsolete"), { exitCode: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stops).toEqual([]);
    expect(f.errors).toEqual([]);
    timeout.resolve();
    await start;
    current.reject(Object.assign(new Error("current"), { exitCode: 4 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stops).toEqual([{ reason: "exit", exitCode: 4 }]);
  });
  test("coalesces teardown and blocks new startup until destruction completes", async () => {
    const f = fixture();
    const destroyed = deferred<void>();
    let destroyCalls = 0;
    await f.controller.startAndWaitForPorts();
    Object.assign(f.process, {
      destroy: async () => {
        destroyCalls++;
        await destroyed.promise;
        Object.assign(f.process, { running: false });
      },
    });
    const a = f.controller.destroy(),
      b = f.controller.destroy();
    expect(a).toBe(b);
    const fetch = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyCalls).toBe(1);
    expect(f.counts().posts).toBe(0);
    expect(f.counts().starts).toBe(1);
    destroyed.resolve();
    await a;
    const response = await fetch;
    await response.text();
    expect(f.counts().starts).toBe(2);
    expect(f.counts().posts).toBe(1);
    expect(f.stops).toEqual([{ reason: "destroyed" }]);
  });

  test("allocation retries share the bounded startup deadline", async () => {
    const f = fixture();
    f.allocations(1000);
    await expect(f.controller.startAndWaitForPorts()).rejects.toThrow("container-start-timeout");
    expect(f.counts().starts).toBeGreaterThan(0);
    expect(f.counts().posts).toBe(0);
    expect(f.counts().health).toBe(0);
  });
  test("timeout configuration shares the hard deadline and cannot resume an old startup", async () => {
    const f = fixture();
    const timeout = deferred<void>();
    const current = deferred<void>();
    let timeouts = 0,
      monitors = 0;
    Object.assign(f.process, {
      setInactivityTimeout: () => (++timeouts === 1 ? timeout.promise : Promise.resolve()),
      monitor: () => (++monitors === 1 ? f.monitor.promise : current.promise),
    });
    const start = f.controller.startAndWaitForPorts().then(
      () => "ready",
      (error: Error) => error.message,
    );
    const outcome = await Promise.race([start, Bun.sleep(120).then(() => "still pending")]);
    await f.controller.destroy();
    await f.controller.startAndWaitForPorts();
    const healthChecks = f.counts().health;
    timeout.resolve();
    await start;
    await Bun.sleep(0);
    expect(outcome).toBe("container-start-timeout");
    expect(f.counts().health).toBe(healthChecks);
    expect(f.started).toHaveLength(1);
    current.reject(Object.assign(new Error("current"), { exitCode: 4 }));
    await Bun.sleep(0);
    expect(f.stops).toEqual([{ reason: "destroyed" }, { reason: "exit", exitCode: 4 }]);
  });
  test("stalled readiness fetch and health-body cancellation obey the hard deadline", async () => {
    for (const stalledBody of [false, true]) {
      const f = fixture();
      const health = deferred<Response>();
      const canceled = deferred<void>();
      f.check(() =>
        stalledBody
          ? Promise.resolve(new Response(new ReadableStream({ cancel: () => canceled.promise })))
          : health.promise,
      );
      const start = f.controller.startAndWaitForPorts().then(
        () => "ready",
        (error: Error) => error.message,
      );
      const outcome = await Promise.race([start, Bun.sleep(120).then(() => "still pending")]);
      health.resolve(new Response("ready"));
      canceled.resolve();
      await start;
      expect(outcome).toBe("container-start-timeout");
      expect(f.started).toEqual([]);
      expect(f.counts().posts).toBe(0);
    }
  });
  test("failed destruction restores monitoring of the still-running process", async () => {
    const f = fixture();
    await f.controller.startAndWaitForPorts();
    Object.assign(f.process, {
      destroy: async () => {
        throw new Error("destroy-failed");
      },
    });
    await expect(f.controller.destroy()).rejects.toThrow("destroy-failed");
    await f.controller.startAndWaitForPorts();
    expect(f.started).toHaveLength(1);
    f.monitor.reject(Object.assign(new Error("current"), { exitCode: 7 }));
    await Bun.sleep(0);
    expect(f.stops).toEqual([{ reason: "exit", exitCode: 7 }]);
  });
  test("failed SIGTERM can be retried and is recorded only after a successful signal", async () => {
    const f = fixture();
    await f.controller.startAndWaitForPorts();
    let signals = 0;
    Object.assign(f.process, {
      signal: () => {
        if (++signals === 1) throw new Error("signal-failed");
      },
    });
    await expect(f.controller.stop()).rejects.toThrow("signal-failed");
    await f.controller.stop();
    await f.controller.stop();
    expect(signals).toBe(2);
    f.monitor.resolve();
    await Bun.sleep(0);
    expect(f.stops).toEqual([{ reason: "runtime_signal", exitCode: 0 }]);
  });
  test("stopping an already-exited process does not invent a signal outcome", async () => {
    const f = fixture();
    await f.controller.startAndWaitForPorts();
    Object.assign(f.process, { running: false });
    await f.controller.stop();
    f.monitor.resolve();
    await Bun.sleep(0);
    expect(f.signals).toEqual([]);
    expect(f.stops).toEqual([{ reason: "exit", exitCode: 0 }]);
  });

  test("a startup timeout never releases an in-flight destroy barrier", async () => {
    const f = fixture();
    const timeout = deferred<void>();
    const destroyed = deferred<void>();
    let configurations = 0;
    Object.assign(f.process, {
      setInactivityTimeout: () => (++configurations === 1 ? timeout.promise : Promise.resolve()),
      destroy: async () => {
        await destroyed.promise;
        Object.assign(f.process, { running: false });
      },
    });
    const first = f.controller.startAndWaitForPorts().catch((error: Error) => error.message);
    await Bun.sleep(0);
    const teardown = f.controller.destroy();
    let restarted = false;
    const next = f.controller.startAndWaitForPorts().then(() => {
      restarted = true;
    });
    await Bun.sleep(70);
    expect(await first).toBe("container-start-canceled");
    expect(restarted).toBe(false);
    expect(f.counts().starts).toBe(1);
    timeout.resolve();
    await Bun.sleep(0);
    expect(restarted).toBe(false);
    expect(f.counts().health).toBe(0);
    destroyed.resolve();
    await teardown;
    await next;
    expect(f.counts().starts).toBe(2);
  });
  test("a late health response is canceled without affecting a newer process", async () => {
    for (const failedCancel of [false, true]) {
      const f = fixture();
      const health = deferred<Response>();
      let canceled = 0;
      f.check(() => health.promise);
      const first = f.controller.startAndWaitForPorts().catch((error: Error) => error.message);
      const outcome = await Promise.race([first, Bun.sleep(120).then(() => "still pending")]);
      expect(outcome).toBe("container-start-timeout");
      await f.controller.destroy();
      f.check(async () => new Response("ready"));
      await f.controller.startAndWaitForPorts();
      health.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              canceled++;
              if (failedCancel) throw new Error("private-cancel-failure");
            },
          }),
        ),
      );
      await Bun.sleep(0);
      expect(canceled).toBe(1);
      expect(f.started).toHaveLength(1);
      expect(f.errors).toHaveLength(1);
      expect(f.counts().posts).toBe(0);
    }
  });
});

describe("explicit Container idle alarms", () => {
  test("standalone startup persists the thirty-second deadline without waiting for its monitor", async () => {
    const f = fixture();
    const before = Date.now();
    await f.controller.startAndWaitForPorts();
    expect(f.alarmAt()).toBeGreaterThanOrEqual(before + 30_000);
    expect(f.alarmAt()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(f.saved.get(idleKey)).toEqual({ deadline: f.alarmAt() });
    expect(f.saved.get("sdk-sentinel")).toBe("synthetic-sdk-state");
    expect(f.storageKeys.every((key) => key === idleKey)).toBe(true);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);

    const short = fixture(false, 10);
    await short.controller.startAndWaitForPorts();
    await Bun.sleep(15);
    await short.controller.alarm();
    expect(short.signals).toEqual([15]);
    // The synthetic process ignores SIGTERM: retry on its next idle deadline.
    await Bun.sleep(15);
    await short.controller.alarm();
    expect(short.signals).toEqual([15, 15]);
    expect(short.counts().posts).toBe(0);
  });

  test("headers remain active beyond the idle timeout and a bodyless response starts a fresh window", async () => {
    const f = fixture(false, 10);
    const headers = deferred<Response>();
    f.reply(() => headers.promise);
    const pending = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.alarmAt()).toBeUndefined();
    headers.resolve(new Response(null, { status: 204 }));
    await pending;
    const finished = Date.now();
    expect(f.alarmAt()).toBeGreaterThanOrEqual(finished + 8);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15]);
    expect(f.counts().posts).toBe(1);
  });

  test("EOF, cancellation and stream error each release an idle window only after the body ends", async () => {
    for (const mode of ["eof", "cancel", "error"]) {
      const f = fixture(false, 10);
      let source!: ReadableStreamDefaultController<Uint8Array>;
      f.reply(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
              },
            }),
          ),
      );
      const response = await f.controller.fetch(
        new Request("http://container/collect", { method: "POST" }),
      );
      await Bun.sleep(15);
      await f.controller.alarm();
      expect(f.signals).toEqual([]);
      expect(f.alarmAt()).toBeUndefined();
      if (mode === "cancel") await response.body!.cancel();
      else if (mode === "error") {
        source.error(new Error("synthetic-stream-error"));
        await expect(response.text()).rejects.toThrow("synthetic-stream-error");
      } else {
        source.close();
        await response.text();
      }
      await f.waits.at(-1);
      await f.controller.alarm();
      expect(f.signals).toEqual([]);
      await Bun.sleep(15);
      await f.controller.alarm();
      expect(f.signals).toEqual([15]);
      expect(f.counts().posts).toBe(1);
    }
  });

  test("one completed concurrent response cannot make another backpressured response idle", async () => {
    const f = fixture(false, 10);
    f.reply(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        ),
    );
    const [a, b] = await Promise.all([
      f.controller.fetch(new Request("http://container/collect", { method: "POST" })),
      f.controller.fetch(new Request("http://container/collect", { method: "POST" })),
    ]);
    await a.body!.cancel();
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    await b.body!.cancel();
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15]);
    expect(f.counts().posts).toBe(2);
  });

  test("an alarm whose storage read overlaps new activity cannot signal that request", async () => {
    const f = fixture(false, 10);
    await f.controller.startAndWaitForPorts();
    await Bun.sleep(15);
    const old = f.saved.get(idleKey);
    const read = deferred<unknown>();
    const get = f.ctx.storage.get;
    f.ctx.storage.get = () => read.promise;
    const alarm = f.controller.alarm();
    await Bun.sleep(0);
    const headers = deferred<Response>();
    f.reply(() => headers.promise);
    const request = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(0);
    read.resolve(old);
    await alarm;
    f.ctx.storage.get = get;
    expect(f.signals).toEqual([]);
    headers.resolve(new Response(null));
    await request;
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.counts().posts).toBe(1);
  });

  test("a previous process alarm cannot stop its successor", async () => {
    const f = fixture(false, 10);
    await f.controller.startAndWaitForPorts();
    await Bun.sleep(15);
    const old = f.saved.get(idleKey);
    const read = deferred<unknown>();
    const get = f.ctx.storage.get;
    f.ctx.storage.get = () => read.promise;
    const alarm = f.controller.alarm();
    await Bun.sleep(0);
    await f.controller.destroy();
    const monitor = deferred<void>();
    Object.assign(f.process, { monitor: () => monitor.promise });
    const headers = deferred<Response>();
    f.reply(() => headers.promise);
    const request = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(0);
    read.resolve(old);
    await alarm;
    f.ctx.storage.get = get;
    expect(f.signals).toEqual([]);
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    headers.resolve(new Response(null));
    await request;
    expect(f.counts().posts).toBe(1);
  });

  test("an old response completion cannot idle a newer process with an active request", async () => {
    const f = fixture(false, 10);
    f.reply(async () => new Response(new ReadableStream<Uint8Array>()));
    const old = await f.controller.fetch(
      new Request("http://container/collect", { method: "POST" }),
    );
    await f.controller.destroy();
    const monitor = deferred<void>();
    Object.assign(f.process, { monitor: () => monitor.promise });
    const headers = deferred<Response>();
    f.reply(() => headers.promise);
    const request = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(0);
    await old.body!.cancel();
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.alarmAt()).toBeUndefined();
    headers.resolve(new Response(null));
    await request;
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15]);
    expect(f.counts().posts).toBe(2);
  });

  test("a request waiting behind destroy keeps its new response active until cancellation", async () => {
    const f = fixture(false, 10);
    await f.controller.startAndWaitForPorts();
    const destroyed = deferred<void>();
    Object.assign(f.process, {
      destroy: async () => {
        await destroyed.promise;
        Object.assign(f.process, { running: false });
      },
      monitor: () => deferred<void>().promise,
    });
    f.reply(async () => new Response(new ReadableStream<Uint8Array>()));
    const teardown = f.controller.destroy();
    const pending = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(0);
    expect(f.counts().posts).toBe(0);
    destroyed.resolve();
    await teardown;
    const response = await pending;
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.alarmAt()).toBeUndefined();
    await response.body!.cancel();
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15]);
    expect(f.counts().posts).toBe(1);
  });

  test("stalled idle writes cannot extend readiness or forward an application request later", async () => {
    for (const fetch of [false, true]) {
      const f = fixture();
      await f.waits[0];
      const write = deferred<void>();
      const remove = f.ctx.storage.delete;
      f.ctx.storage.delete = () => write.promise;
      const started = Date.now();
      const pending = fetch
        ? f.controller.fetch(new Request("http://container/collect", { method: "POST" }))
        : f.controller.startAndWaitForPorts();
      const outcome = await Promise.race([
        pending.then(
          () => "ready",
          (error: Error) => error.message,
        ),
        Bun.sleep(120).then(() => "still pending"),
      ]);
      expect(outcome).toBe("container-start-timeout");
      expect(Date.now() - started).toBeLessThan(120);
      expect(f.counts().posts).toBe(0);
      f.ctx.storage.delete = remove;
      write.resolve();
      await Bun.sleep(0);
      expect(f.counts().starts).toBe(0);
      expect(f.counts().posts).toBe(0);
    }
  });

  test("destroy during idle storage setup cancels that startup before forwarding", async () => {
    const f = fixture();
    await f.waits[0];
    const write = deferred<void>();
    const remove = f.ctx.storage.delete;
    let removes = 0;
    f.ctx.storage.delete = (key) => (++removes === 1 ? write.promise : remove(key));
    const pending = f.controller.fetch(new Request("http://container/collect", { method: "POST" }));
    await Bun.sleep(0);
    const destroyed = f.controller.destroy();
    write.resolve();
    await expect(pending).rejects.toThrow("container-start-canceled");
    await destroyed;
    expect(f.counts().starts).toBe(0);
    expect(f.counts().posts).toBe(0);
  });

  test("failed idle signals retry and failed destroy restores the explicit idle alarm", async () => {
    const f = fixture(false, 10);
    await f.controller.startAndWaitForPorts();
    let attempts = 0;
    Object.assign(f.process, {
      signal: (value: number) => {
        if (++attempts === 1) throw new Error("synthetic-signal-failed");
        f.signals.push(value);
      },
    });
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([]);
    expect(f.errors).toHaveLength(1);
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15]);
    Object.assign(f.process, {
      destroy: async () => {
        throw new Error("synthetic-destroy-failed");
      },
    });
    await expect(f.controller.destroy()).rejects.toThrow("synthetic-destroy-failed");
    await Bun.sleep(0);
    expect(f.alarmAt()).toBeGreaterThan(Date.now());
    await Bun.sleep(15);
    await f.controller.alarm();
    expect(f.signals).toEqual([15, 15]);
    expect(f.counts().posts).toBe(0);
  });

  test("constructor restores its own deadline and preserves SDK state across recovery", async () => {
    const deadline = Date.now() + 10_000;
    const saved = new Map<string, unknown>([[idleKey, { deadline }]]);
    const f = fixture(true, 30_000, saved);
    await f.waits[0];
    expect(f.alarmAt()).toBe(deadline);
    expect(f.timeouts).toEqual([30_000]);
    expect(f.counts().starts).toBe(0);
    expect(saved.get("sdk-sentinel")).toBe("synthetic-sdk-state");
    expect(f.storageKeys.every((key) => key === idleKey)).toBe(true);
    const orphaned = fixture(true, 10, new Map([[idleKey, { deadline: null }]]));
    await orphaned.waits[0];
    expect(orphaned.alarmAt()).toBeGreaterThan(Date.now());
    await Bun.sleep(15);
    await orphaned.controller.alarm();
    expect(orphaned.signals).toEqual([15]);
    const stopped = fixture(false, 10, new Map([[idleKey, { deadline }]]));
    await stopped.waits[0];
    expect(stopped.saved.has(idleKey)).toBe(false);
    expect(stopped.alarmAt()).toBeUndefined();
  });
});
