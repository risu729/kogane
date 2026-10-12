import { expect, test } from "bun:test";
import { checkBackpressure, BACKPRESSURE_CHECK_MAX_CHUNKS } from "../src/backpressure-check";
import { BACKPRESSURE_MAX_CHUNKS } from "../container/server.mjs";
import { verifyBackpressureCheck } from "../driver.mjs";

const ID = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const stable = { processIdentity: ID, posts: 2, streams: 1, backpressureChunks: 32 };
function scenario(kind = "pass") {
  let clock = 0,
    stats = 0,
    canceled = 0,
    running = true;
  const paths: string[] = [];
  const samples = [{ ...stable, streams: 0, backpressureChunks: 0 }, { ...stable }, { ...stable }];
  if (kind === "early") samples[1].backpressureChunks = 4096;
  if (kind === "late") samples[2].backpressureChunks = 4096;
  if (kind === "progress") samples[2].backpressureChunks = 33;
  if (kind === "identity") samples[2].processIdentity = OTHER;
  if (kind === "malformed") (samples as unknown[])[2] = { ...stable, streams: "1" };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65536));
    },
    cancel() {
      canceled++;
      if (kind === "cancel-error") throw new Error("private cancellation error");
    },
  });
  return {
    samples,
    paths,
    get stats() {
      return stats;
    },
    get canceled() {
      return canceled;
    },
    stop() {
      running = false;
    },
    deps: {
      running: () => running,
      now: () => clock,
      wait: async (ms: number) => {
        expect([1000, 35_000]).toContain(ms);
        clock += ms;
        if (kind === "stopped" && ms === 35_000) running = false;
        if (kind === "cancel-error" && ms === 35_000) samples[2].backpressureChunks = 33;
      },
      fetchBoundary: async (request: Request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === "/stats") return Response.json(samples[stats++]);
        if (path === "/backpressure") return new Response(stream);
        throw new Error("unexpected route");
      },
    },
  };
}
test("in-DO check uses the boundary response, reads once, samples after 1s+35s, and cancels", async () => {
  const sample = scenario();
  expect(await checkBackpressure(sample.deps)).toEqual({
    code: "pass",
    earlyChunks: 32,
    lateChunks: 32,
    elapsedMs: 35_000,
  });
  expect(sample.paths).toEqual(["/stats", "/backpressure", "/stats", "/stats"]);
  expect(sample.canceled).toBe(1);
});
test("in-DO check classifies cap exhaustion, progress, identity, malformed stats and stop", async () => {
  for (const [kind, code] of [
    ["early", "exhausted_early"],
    ["late", "exhausted_late"],
    ["progress", "progress"],
    ["identity", "process"],
    ["malformed", "chunks"],
    ["stopped", "process"],
  ]) {
    const sample = scenario(kind);
    expect(await checkBackpressure(sample.deps)).toEqual({ code });
    expect(sample.canceled).toBe(1);
    expect(sample.stats).toBe(kind === "stopped" ? 2 : 3);
  }
});
test("a stopped baseline issues no stats request", async () => {
  const sample = scenario();
  sample.stop();
  expect(await checkBackpressure(sample.deps)).toEqual({ code: "process" });
  expect(sample.paths).toEqual([]);
});
test("cancellation failure preserves the primary measurement failure", async () => {
  const sample = scenario("cancel-error");
  expect(await checkBackpressure(sample.deps)).toEqual({ code: "progress" });
  expect(sample.canceled).toBe(1);
});
test("a hung first read times out and still attempts bounded cancellation", async () => {
  let canceled = 0,
    stats = 0,
    releasedPull = 0;
  let releasePull: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise<void>((resolve) => {
        releasePull = resolve;
      }),
    cancel: () => {
      canceled++;
      // Model a stalled read until cancellation, then release the pending pull.
      releasePull?.();
      releasedPull++;
    },
  });
  const report = await checkBackpressure({
    timeoutMs: 10,
    cancelTimeoutMs: 10,
    running: () => true,
    fetchBoundary: async (request) => {
      if (new URL(request.url).pathname === "/stats") {
        stats++;
        return Response.json({ ...stable, streams: 0 });
      }
      return new Response(stream);
    },
  });
  expect(report).toEqual({ code: "timeout" });
  expect(stats).toBe(1);
  expect(canceled).toBe(1);
  expect(releasedPull).toBe(1);
});
test("driver accepts only a finite closed report from one GET", async () => {
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    return Response.json({ code: "pass", earlyChunks: 32, lateChunks: 32, elapsedMs: 35_000 });
  };
  expect(await verifyBackpressureCheck({ request })).toEqual({
    code: "pass",
    earlyChunks: 32,
    lateChunks: 32,
    elapsedMs: 35_000,
  });
  expect(paths).toEqual(["/backpressure-check"]);
  for (const value of [
    { code: "pass", earlyChunks: "32", lateChunks: 32, elapsedMs: 35_000 },
    { code: "pass", earlyChunks: 4096, lateChunks: 4096, elapsedMs: 35_000 },
    { code: "pass", earlyChunks: 32, lateChunks: 33, elapsedMs: 35_000 },
    { code: "pass", earlyChunks: 32, lateChunks: 32, elapsedMs: Infinity },
    { code: "pass", earlyChunks: 32, lateChunks: 32, elapsedMs: 35_000, id: ID },
    { code: "untrusted" },
    null,
  ]) {
    await expect(
      verifyBackpressureCheck({ request: async () => Response.json(value) }),
    ).rejects.toThrow("verification_backpressure_report");
  }
  await expect(
    verifyBackpressureCheck({
      request: async () => Response.json({ code: "exhausted_late" }),
    }),
  ).rejects.toThrow("verification_backpressure_exhausted_late");
});

test("encoded boundary response is rejected and canceled", async () => {
  let canceled = 0;
  const report = await checkBackpressure({
    running: () => true,
    fetchBoundary: async (request) =>
      new URL(request.url).pathname === "/stats"
        ? Response.json({ ...stable, streams: 0 })
        : new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                canceled++;
              },
            }),
            { headers: { "content-encoding": "gzip" } },
          ),
  });
  expect(report).toEqual({ code: "encoding" });
  expect(canceled).toBe(1);
});
test("hung stats response and cancellation cannot outlive the internal deadline", async () => {
  const report = await checkBackpressure({
    timeoutMs: 10,
    cancelTimeoutMs: 10,
    running: () => true,
    fetchBoundary: async () => new Promise<Response>(() => {}),
  });
  expect(report).toEqual({ code: "timeout" });
});

test("non-200 stats body is canceled before failure is reported", async () => {
  let canceled = 0;
  const report = await checkBackpressure({
    running: () => true,
    fetchBoundary: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled++;
          },
        }),
        { status: 503 },
      ),
  });
  expect(report).toEqual({ code: "chunks" });
  expect(canceled).toBe(1);
});
test("a fetch resolving after timeout releases its unclaimed response body", async () => {
  let resolveFetch!: (response: Response) => void;
  let canceled = 0;
  const operation = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const report = await checkBackpressure({
    timeoutMs: 10,
    cancelTimeoutMs: 10,
    running: () => true,
    fetchBoundary: async () => operation,
  });
  expect(report).toEqual({ code: "timeout" });
  resolveFetch(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((done) => setTimeout(done, 0));
  expect(canceled).toBe(1);
});

test("the observer cap matches the synthetic source cap", () => {
  expect(BACKPRESSURE_CHECK_MAX_CHUNKS).toBe(BACKPRESSURE_MAX_CHUNKS);
});
test("driver caps its result body before parsing and cancels an oversized stream", async () => {
  let canceled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel() {
        canceled++;
      },
    }),
  );
  await expect(verifyBackpressureCheck({ request: async () => response })).rejects.toThrow(
    "verification_backpressure_report",
  );
  expect(canceled).toBe(1);
});
test("driver rejects malformed UTF-8 and JSON reports", async () => {
  for (const response of [new Response(new Uint8Array([0xff])), new Response("{broken")]) {
    await expect(verifyBackpressureCheck({ request: async () => response })).rejects.toThrow(
      "verification_backpressure_report",
    );
  }
});
