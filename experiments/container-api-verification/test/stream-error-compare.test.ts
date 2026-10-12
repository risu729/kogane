import { expect, test } from "bun:test";
import { compareStreamError } from "../src/stream-error-compare";
import { worker } from "../src/common";
const ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
function boundary(terminal: "read_error" | "eof", id = ID, cancelRejects = false, posts = 2) {
  let active = 0,
    stats = 0,
    calls = 0;
  return {
    get stats() {
      return stats;
    },
    get active() {
      return active;
    },
    get calls() {
      return calls;
    },
    fetchBoundary: async (request: Request) => {
      const path = new URL(request.url).pathname;
      calls++;
      expect(request.method).toBe("GET");
      expect([...request.headers]).toEqual([]);
      if (path === "/stats") {
        stats++;
        return Response.json({ processIdentity: id, posts, streams: active });
      }
      expect(path).toBe("/stream-error");
      active++;
      let count = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (count++ === 35) {
              active--;
              if (terminal === "read_error") controller.error(new Error("private"));
              else controller.close();
            } else controller.enqueue(new Uint8Array([7]));
          },
          cancel() {
            if (active > 0) active--;
            if (cancelRejects) throw new Error("private_cancel");
          },
        }),
      );
    },
  };
}
const noInterval = {
  setIntervalImpl: (() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
  clearIntervalImpl: (id: ReturnType<typeof setInterval>) => {
    expect(id).toBe(1);
  },
};
test("SDK then raw compare exact same request on one process and tolerate errored-stream cancel", async () => {
  const sdk = boundary("read_error", ID, true),
    raw = boundary("eof");
  const order: string[] = [];
  let renewals = 0,
    time = 0;
  const report = await compareStreamError({
    sdkFetch: async (request) => {
      order.push("sdk");
      return sdk.fetchBoundary(request);
    },
    rawFetch: async (request) => {
      order.push("raw");
      return raw.fetchBoundary(request);
    },
    running: () => true,
    renewActivityTimeout: () => {
      renewals++;
    },
    now: () => {
      const value = time;
      time += 36_000;
      return value;
    },
    ...noInterval,
  });
  expect(order).toEqual(["sdk", "sdk", "sdk", "raw", "raw", "raw"]);
  expect(sdk.stats).toBe(2);
  expect(raw.stats).toBe(2);
  expect(sdk.active).toBe(0);
  expect(raw.active).toBe(0);
  expect(renewals).toBe(1);
  expect(report.sdk?.terminal).toBe("read_error");
  expect(report.sdk?.bytes).toBe(35);
  expect(report.sdk?.reads).toBe(35);
  expect(report.sdk?.after.streams).toBe(0);
  expect(report.sdk?.cancelAttempted).toBe(1);
  expect(report.sdk?.cancelOk).toBe(0);
  expect(report.raw?.terminal).toBe("eof");
  expect(report.sameProcess).toBe(1);
  expect(report.conclusive).toBe(1);
  expect(JSON.stringify(report)).not.toContain(ID);
});
test("raw does not run when SDK stream has not released or process stopped before stats", async () => {
  let rawCalls = 0,
    checks = 0,
    statsCalls = 0;
  const report = await compareStreamError({
    sdkFetch: async (request) => {
      if (new URL(request.url).pathname === "/stats") {
        statsCalls++;
        return Response.json({ processIdentity: ID, posts: 2, streams: statsCalls === 1 ? 0 : 1 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      );
    },
    rawFetch: async () => {
      rawCalls++;
      throw new Error("must_not_run");
    },
    running: () => {
      checks++;
      return true;
    },
    renewActivityTimeout: () => {},
    ...noInterval,
  });
  expect(statsCalls).toBe(2);
  expect(checks).toBe(2);
  expect(rawCalls).toBe(0);
  expect(report.sdk?.after.streams).toBe(1);
  expect(report.raw).toBeNull();
  expect(report.conclusive).toBe(0);
  let stoppedReads = 0;
  const stopped = await compareStreamError({
    sdkFetch: async () => {
      stoppedReads++;
      throw new Error("must_not_run");
    },
    rawFetch: async () => {
      rawCalls++;
      throw new Error("must_not_run");
    },
    running: () => false,
    renewActivityTimeout: () => {},
    ...noInterval,
  });
  expect(stoppedReads).toBe(0);
  expect(stopped.sdk?.baseline.running).toBe(0);
  expect(stopped.raw).toBeNull();
});
test("identity swap is reported without exposing UUID, and pre-abort performs no fetch", async () => {
  const sdk = boundary("eof"),
    raw = boundary("eof", OTHER);
  const report = await compareStreamError({
    sdkFetch: sdk.fetchBoundary,
    rawFetch: raw.fetchBoundary,
    running: () => true,
    renewActivityTimeout: () => {},
    ...noInterval,
  });
  expect(report.sameProcess).toBe(0);
  expect(report.conclusive).toBe(0);
  expect(JSON.stringify(report)).not.toContain(OTHER);
  const outer = new AbortController();
  outer.abort();
  let calls = 0;
  const skipped = await compareStreamError({
    sdkFetch: async () => {
      calls++;
      throw new Error("fetch");
    },
    rawFetch: async () => {
      calls++;
      throw new Error("fetch");
    },
    running: () => true,
    renewActivityTimeout: () => {
      calls++;
    },
    outerSignal: outer.signal,
  });
  expect(calls).toBe(0);
  expect(skipped).toEqual({
    code: "stream_error_compare",
    activityLease: 0,
    sdk: null,
    raw: null,
    sameProcess: null,
    conclusive: 0,
  });
});
test("hung SDK fetch times out, skips raw, cancels late owned response", async () => {
  let release!: (value: Response) => void,
    rawCalls = 0,
    cancelled = 0;
  const late = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const report = await compareStreamError({
    sdkFetch: async (request) =>
      new URL(request.url).pathname === "/stats"
        ? Response.json({ processIdentity: ID, posts: 2, streams: 0 })
        : late,
    rawFetch: async () => {
      rawCalls++;
      throw new Error("raw");
    },
    running: () => true,
    renewActivityTimeout: () => {},
    armTimeoutMs: 10,
    cancelTimeoutMs: 10,
    ...noInterval,
  });
  expect(report.sdk?.terminal).toBe("timeout");
  expect(report.raw).toBeNull();
  expect(rawCalls).toBe(0);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await new Promise((done) => setTimeout(done, 0));
  expect(cancelled).toBe(1);
});
test("diagnostic route remains authenticated and SDK-only", async () => {
  let lookups = 0;
  const env = {
    HARNESS_KEY: "key",
    HARNESS_REVISION: "native",
    HARNESS_MONITOR: "enabled",
    HARNESS: {
      idFromName: () => "id",
      get: () => {
        lookups++;
        throw new Error("no lookup");
      },
    },
  };
  const service = worker();
  expect(
    (await service.fetch(new Request("https://synthetic/stream-error-compare"), env as never))
      .status,
  ).toBe(401);
  expect(
    (
      await service.fetch(
        new Request("https://synthetic/stream-error-compare", {
          headers: { authorization: "Bearer key" },
        }),
        env as never,
      )
    ).status,
  ).toBe(404);
  expect(lookups).toBe(0);
});

test("cross-arm POST change and short source cannot be conclusive", async () => {
  let time = 0;
  const sdk = boundary("eof"),
    raw = boundary("read_error", ID, false, 3);
  const changed = await compareStreamError({
    sdkFetch: sdk.fetchBoundary,
    rawFetch: raw.fetchBoundary,
    running: () => true,
    renewActivityTimeout: () => {},
    now: () => {
      const value = time;
      time += 36_000;
      return value;
    },
    ...noInterval,
  });
  expect(changed.sameProcess).toBe(1);
  expect(changed.sdk?.after.posts).toBe(2);
  expect(changed.raw?.baseline.posts).toBe(3);
  expect(changed.conclusive).toBe(0);
  let shortTime = 0;
  const short = boundary("eof");
  const early = await compareStreamError({
    sdkFetch: short.fetchBoundary,
    rawFetch: short.fetchBoundary,
    running: () => true,
    renewActivityTimeout: () => {},
    now: () => {
      const value = shortTime;
      shortTime += 1;
      return value;
    },
    ...noInterval,
  });
  expect(early.sdk?.bytes).toBe(35);
  expect(early.sdk?.elapsedMs).toBe(1);
  expect(early.conclusive).toBe(0);
});
