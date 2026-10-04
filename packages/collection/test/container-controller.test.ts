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
function fixture(running = false) {
  const monitor = deferred<void>();
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
      deleteAlarm: async () => {
        deletes++;
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
    { startupMs: 40, pollMs: 1, pingMs: 5 },
  );
  return {
    ctx,
    process,
    controller,
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
  test("constructor reattaches timeout/monitor and only deletes SDK alarm", async () => {
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
    await f.controller.retireAlarm();
    expect(f.counts().deletes).toBe(2);
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
});
