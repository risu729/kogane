import { expect, test } from "bun:test";
import { compareBackpressure } from "../src/backpressure-compare";
import { checkBackpressure } from "../src/backpressure-check";
import { syntheticServer } from "../container/server.mjs";
import { worker } from "../src/common";

const ID = "dddddddd-dddd-4ddd-addd-dddddddddddd";
function boundary(lateChunks: number, lateStreams = 1, cancelThrows = false, id = ID) {
  let statsReads = 0,
    cancels = 0;
  const snapshots = [
    { posts: 2, streams: 0, processIdentity: id, backpressureChunks: 0 },
    { posts: 2, streams: 1, processIdentity: id, backpressureChunks: 32 },
    { posts: 2, streams: lateStreams, processIdentity: id, backpressureChunks: lateChunks },
  ];
  return {
    get statsReads() {
      return statsReads;
    },
    get cancels() {
      return cancels;
    },
    fetchBoundary: async (request: Request) => {
      if (new URL(request.url).pathname === "/stats") return Response.json(snapshots[statsReads++]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65536));
          },
          cancel() {
            cancels++;
            if (cancelThrows) throw new Error("private");
          },
        }),
      );
    },
  };
}
test("diagnostic compares SDK then raw on one process under a cleared activity lease", async () => {
  const sdk = boundary(4096, 0);
  const raw = boundary(32);
  const order: string[] = [];
  let now = 0,
    renewals = 0,
    cleared = 0;
  const report = await compareBackpressure({
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
    setIntervalImpl: ((callback: () => void, ms: number) => {
      expect(ms).toBe(10_000);
      callback();
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalImpl: ((id: ReturnType<typeof setInterval>) => {
      expect(id).toBe(1);
      cleared++;
    }) as typeof clearInterval,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  expect(order).toEqual(["sdk", "sdk", "sdk", "sdk", "raw", "raw", "raw", "raw"]);
  expect(sdk.cancels).toBe(1);
  expect(raw.cancels).toBe(1);
  expect(sdk.statsReads).toBe(3);
  expect(raw.statsReads).toBe(3);
  expect(renewals).toBe(2);
  expect(cleared).toBe(1);
  expect(report.activityLease).toBe(1);
  expect(report.sdk?.code).toBe("exhausted_late");
  expect(report.raw?.code).toBe("pass");
  expect(report.sameProcess).toBe(1);
  expect(report.conclusive).toBe(1);
  expect(report.sdk?.firstReadBytes).toBe(65536);
  expect(report.sdk?.early.chunks).toBe(32);
  expect(report.sdk?.late.chunks).toBe(4096);
  expect(report.raw?.late.chunks).toBe(32);
  expect(report.sdk?.elapsedMs).toBe(35_000);
  expect(JSON.stringify(report)).not.toContain(ID);
});
test("diagnostic refuses raw arm after incomplete SDK stream cancellation", async () => {
  const sdk = boundary(4096, 0, true);
  let rawCalls = 0,
    now = 0,
    cleared = 0;
  const report = await compareBackpressure({
    sdkFetch: sdk.fetchBoundary,
    rawFetch: async () => {
      rawCalls++;
      throw new Error("must not fetch");
    },
    running: () => true,
    renewActivityTimeout: () => {},
    setIntervalImpl: (() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
    clearIntervalImpl: (() => {
      cleared++;
    }) as typeof clearInterval,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  expect(report.sdk?.code).toBe("exhausted_late");
  expect(report.sdk?.cancelled).toBe(0);
  expect(report.raw).toBeNull();
  expect(report.conclusive).toBe(0);
  expect(rawCalls).toBe(0);
  expect(cleared).toBe(1);
});
test("diagnostic raw baseline confirms previous stream released and same process", async () => {
  const serve = syntheticServer();
  let now = 0;
  const report = await compareBackpressure({
    sdkFetch: (request) => serve(request),
    rawFetch: (request) => serve(request),
    running: () => true,
    renewActivityTimeout: () => {},
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  expect(report.sdk?.code).toBe("pass");
  expect(report.raw?.code).toBe("pass");
  expect(report.raw?.baseline.streams).toBe(0);
  expect(report.sameProcess).toBe(1);
  expect(report.conclusive).toBe(1);
});
test("observer callback failure cannot change acceptance code", async () => {
  const serve = syntheticServer();
  let now = 0;
  const report = await checkBackpressure({
    fetchBoundary: (request) => serve(request),
    running: () => true,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    onEvent: () => {
      throw new Error("observer");
    },
  });
  expect(report.code).toBe("pass");
});

test("comparison route requires authentication and baseline SDK revision before DO lookup", async () => {
  let lookups = 0;
  const env = {
    HARNESS_KEY: "private-key",
    HARNESS_REVISION: "native",
    HARNESS_MONITOR: "enabled",
    HARNESS: {
      idFromName: () => "fixed",
      get: () => {
        lookups++;
        throw new Error("must not reach DO");
      },
    },
  };
  const url = "http://worker/backpressure-compare";
  const unauthorized = await worker().fetch(new Request(url), env as never);
  expect(unauthorized.status).toBe(401);
  const wrongRevision = await worker().fetch(
    new Request(url, {
      headers: { authorization: "Bearer private-key" },
    }),
    env as never,
  );
  expect(wrongRevision.status).toBe(404);
  expect(lookups).toBe(0);
});

test("diagnostic marks a different raw process as inconclusive without exposing its identity", async () => {
  const sdk = boundary(4096, 0);
  const raw = boundary(32, 1, false, "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee");
  let now = 0;
  const report = await compareBackpressure({
    sdkFetch: sdk.fetchBoundary,
    rawFetch: raw.fetchBoundary,
    running: () => true,
    renewActivityTimeout: () => {},
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  expect(report.sameProcess).toBe(0);
  expect(report.conclusive).toBe(0);
  expect(JSON.stringify(report)).not.toContain("eeeeeeee-");
});

test("diagnostic skips raw when SDK observation itself is inconclusive", async () => {
  let stats = 0,
    rawCalls = 0,
    now = 0;
  const sdkFetch = async (request: Request) => {
    if (new URL(request.url).pathname === "/stats") {
      stats++;
      return Response.json({
        posts: 2,
        streams: stats === 1 ? 0 : 1,
        processIdentity: ID,
        backpressureChunks: stats === 1 ? 0 : 4096,
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65536));
        },
        cancel() {},
      }),
    );
  };
  const report = await compareBackpressure({
    sdkFetch,
    rawFetch: async () => {
      rawCalls++;
      throw new Error("must not fetch");
    },
    running: () => true,
    renewActivityTimeout: () => {},
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  expect(report.sdk?.code).toBe("exhausted_early");
  expect(report.sdk?.cancelled).toBe(1);
  expect(report.raw).toBeNull();
  expect(report.conclusive).toBe(0);
  expect(rawCalls).toBe(0);
});
