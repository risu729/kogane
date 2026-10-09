import { expect, test } from "bun:test";
import {
  syntheticServer,
  READER_LIFETIME_FRAME_BYTES,
  READER_LIFETIME_FRAMES,
} from "../container/server.mjs";
import { checkReaderLifetime, READER_TOTAL_BYTES } from "../src/reader-lifetime-check";
import { verifyReaderLifetimeCheck, verifyReaderIdleCycle } from "../driver.mjs";
const ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const virtual = () => {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  };
};
test("unpaced source has ordered indexed frames and releases on EOF or cancel", async () => {
  const serve = syntheticServer();
  const response = await serve(new Request("http://container/reader-lifetime"));
  expect(response.headers.get("cache-control")).toBe("no-transform");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.byteLength).toBe(READER_LIFETIME_FRAMES * READER_LIFETIME_FRAME_BYTES);
  for (let frame = 0; frame < READER_LIFETIME_FRAMES; frame++) {
    const offset = frame * READER_LIFETIME_FRAME_BYTES;
    expect(new DataView(bytes.buffer).getUint32(offset, true)).toBe(frame);
    expect(bytes[offset + 4]).toBe((frame * 37 + 4 * 13) & 255);
  }
  expect((await (await serve(new Request("http://container/stats"))).json()).streams).toBe(0);
  const cancelled = await serve(new Request("http://container/reader-lifetime"));
  const reader = cancelled.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect((await (await serve(new Request("http://container/stats"))).json()).streams).toBe(0);
});
test("resume and cancel each pause over 35s at the returned boundary", async () => {
  for (const arm of ["resume", "cancel"] as const) {
    const time = virtual(),
      serve = syntheticServer();
    const events: string[] = [];
    const report = await checkReaderLifetime({
      arm,
      fetchBoundary: (request) => serve(request),
      running: () => {
        events.push("running_check");
        return true;
      },
      wait: time.wait,
      now: time.now,
      onEvent: (event) => events.push(event),
    });
    expect(report).toEqual({
      code: "pass",
      elapsedMs: 36_000,
      bytes: arm === "resume" ? READER_TOTAL_BYTES : READER_LIFETIME_FRAME_BYTES,
    });
    expect(events.indexOf("running_check")).toBeLessThan(events.indexOf("stats"));
    expect(events.filter((event) => event === "running_check")).toHaveLength(2);
    expect(events).toContain(arm === "resume" ? "resumed" : "cancelled");
    expect((await (await serve(new Request("http://container/stats"))).json()).streams).toBe(0);
  }
});
test("stopped process is rejected before late stats can auto-start", async () => {
  const time = virtual(),
    serve = syntheticServer();
  let checks = 0,
    stats = 0;
  const report = await checkReaderLifetime({
    arm: "resume",
    now: time.now,
    wait: time.wait,
    running: () => ++checks === 1,
    fetchBoundary: (request) => {
      if (new URL(request.url).pathname === "/stats") stats++;
      return serve(request);
    },
  });
  expect(report).toEqual({ code: "process" });
  expect(stats).toBe(1);
});
test("changed identity, post count, and payload fail closed", async () => {
  for (const changed of ["identity", "posts", "payload"] as const) {
    const time = virtual(),
      serve = syntheticServer();
    let samples = 0;
    const report = await checkReaderLifetime({
      arm: "resume",
      now: time.now,
      wait: time.wait,
      running: () => true,
      fetchBoundary: (request) => {
        if (new URL(request.url).pathname === "/stats") {
          samples++;
          return Promise.resolve(
            Response.json({
              processIdentity: changed === "identity" && samples === 2 ? OTHER : ID,
              posts: changed === "posts" && samples === 2 ? 1 : 0,
            }),
          );
        }
        if (changed === "payload") return Promise.resolve(new Response(new Uint8Array([9])));
        return serve(request);
      },
    });
    expect(report).toEqual({ code: changed });
  }
});
test("timeout cleanup is bounded and cancellation cannot erase primary payload failure", async () => {
  let cancellations = 0;
  const pending = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0]));
    },
    cancel() {
      cancellations++;
    },
  });
  const timed = await checkReaderLifetime({
    arm: "resume",
    timeoutMs: 10,
    cancelTimeoutMs: 10,
    running: () => true,
    wait: async () => new Promise<void>(() => {}),
    fetchBoundary: async (request) =>
      new URL(request.url).pathname === "/stats"
        ? Response.json({ processIdentity: ID, posts: 0 })
        : new Response(pending),
  });
  expect(timed).toEqual({ code: "timeout" });
  expect(cancellations).toBe(1);
  const bad = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([255]));
    },
    cancel() {
      throw new Error("private transport error");
    },
  });
  const primary = await checkReaderLifetime({
    arm: "resume",
    cancelTimeoutMs: 10,
    running: () => true,
    fetchBoundary: async (request) =>
      new URL(request.url).pathname === "/stats"
        ? Response.json({ processIdentity: ID, posts: 0 })
        : new Response(bad),
  });
  expect(primary).toEqual({ code: "payload" });
});
test("driver admits only closed finite reports from the selected single GET", async () => {
  for (const arm of ["resume", "cancel"] as const) {
    const paths: string[] = [],
      bytes = arm === "resume" ? READER_TOTAL_BYTES : 1888;
    expect(
      await verifyReaderLifetimeCheck({
        arm,
        request: async (path: string) => {
          paths.push(path);
          return Response.json({ code: "pass", elapsedMs: 36_000, bytes });
        },
      }),
    ).toEqual({ code: "pass", elapsedMs: 36_000, bytes });
    expect(paths).toEqual([arm === "resume" ? "/reader-resume-check" : "/reader-cancel-check"]);
  }
  for (const report of [
    { code: "pass", elapsedMs: 36_000, bytes: 1, identity: ID },
    { code: "pass", elapsedMs: 34_999, bytes: READER_TOTAL_BYTES },
    { code: "pass", elapsedMs: 36_000, bytes: READER_TOTAL_BYTES - 1 },
    { code: "untrusted" },
  ])
    await expect(
      verifyReaderLifetimeCheck({ arm: "resume", request: async () => Response.json(report) }),
    ).rejects.toThrow("verification_reader_report");
  await expect(
    verifyReaderLifetimeCheck({
      arm: "cancel",
      request: async () => Response.json({ code: "process" }),
    }),
  ).rejects.toThrow("verification_reader_process");
});

test("each arm observes idle only through DO state and restarts a different process", async () => {
  for (const arm of ["resume", "cancel"] as const) {
    const calls: string[] = [];
    let time = 0;
    const bytes = arm === "resume" ? READER_TOTAL_BYTES : 1888;
    const observed = await verifyReaderIdleCycle({
      arm,
      now: () => time,
      json: async (path: string, method?: string, substage?: string) => {
        calls.push(`${path}:${method ?? "GET"}:${substage ?? ""}`);
        if (path === "/state") return { running: 1 };
        if (path === "/stats") return { processIdentity: ID };
        if (path === "/once") return { processIdentity: OTHER };
        throw new Error("unexpected route");
      },
      request: async (path: string) => {
        calls.push(path);
        return Response.json({ code: "pass", elapsedMs: 36_000, bytes });
      },
      waitState: async (predicate: (state: { running: number }) => boolean) => {
        calls.push("waitState");
        expect(predicate({ running: 0 })).toBe(true);
        time += 30_000;
      },
    });
    expect(observed).toBe(30_000);
    expect(calls).toEqual([
      "/state:GET:",
      "/stats:GET:",
      arm === "resume" ? "/reader-resume-check" : "/reader-cancel-check",
      "waitState",
      `/once:POST:${arm === "resume" ? "idle_restart" : "reader_cancel_restart"}`,
    ]);
  }
});
test("idle cycle rejects early stop and unchanged restart identity", async () => {
  for (const problem of ["early", "same"] as const) {
    let time = 0;
    const run = () =>
      verifyReaderIdleCycle({
        arm: "resume",
        now: () => time,
        json: async (path: string) =>
          path === "/state"
            ? { running: 1 }
            : path === "/stats"
              ? { processIdentity: ID }
              : { processIdentity: problem === "same" ? ID : OTHER },
        request: async () =>
          Response.json({ code: "pass", elapsedMs: 36_000, bytes: READER_TOTAL_BYTES }),
        waitState: async () => {
          time += problem === "early" ? 0 : 30_000;
        },
      });
    await expect(run()).rejects.toThrow(
      problem === "early" ? "verification_reader_idle" : "verification_reader_restart",
    );
  }
});
