import { expect, test } from "bun:test";
import { checkStreamError } from "../src/stream-error-check";
import { verifyStreamErrorCheck } from "../driver.mjs";
import { worker } from "../src/common";

const ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
type Scenario = {
  terminal?: "error" | "eof" | "stall";
  emitted?: number;
  value?: number;
  elapsed?: number;
  status?: number;
  body?: boolean;
  encoding?: string;
  failFetch?: boolean;
  afterId?: string;
  afterPosts?: number;
  afterStreams?: number;
  running?: (sample: number) => boolean;
};
function fixture(scenario: Scenario = {}) {
  let clock = 0,
    samples = 0,
    fetches = 0,
    canceled = 0;
  const fetchBoundary = async (request: Request) => {
    const path = new URL(request.url).pathname;
    fetches++;
    if (path === "/stats") {
      samples++;
      return Response.json({
        processIdentity: samples === 2 ? (scenario.afterId ?? ID) : ID,
        posts: samples === 2 ? (scenario.afterPosts ?? 2) : 2,
        streams: samples === 2 ? (scenario.afterStreams ?? 0) : 0,
      });
    }
    expect(path).toBe("/stream-error");
    expect(request.headers.get("accept-encoding")).toBeNull();
    if (scenario.failFetch) throw new Error("private_fetch_error");
    if (scenario.body === false) return new Response(null);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (scenario.terminal === "stall") return;
        if (emitted === (scenario.emitted ?? 35)) {
          clock = scenario.elapsed ?? 36_000;
          if (scenario.terminal === "eof") controller.close();
          else controller.error(new Error("private_stream_error"));
          return;
        }
        emitted++;
        controller.enqueue(new Uint8Array([scenario.value ?? 1]));
      },
      cancel() {
        canceled++;
      },
    });
    return new Response(body, {
      status: scenario.status ?? 200,
      headers: scenario.encoding ? { "content-encoding": scenario.encoding } : undefined,
    });
  };
  return {
    fetchBoundary,
    running: () => scenario.running?.(samples) ?? true,
    now: () => clock,
    get samples() {
      return samples;
    },
    get fetches() {
      return fetches;
    },
    get canceled() {
      return canceled;
    },
  };
}
test("actual response boundary passes only the 35-byte delayed read error and released process", async () => {
  const x = fixture();
  expect(
    await checkStreamError({
      fetchBoundary: x.fetchBoundary,
      running: x.running,
      now: x.now,
    }),
  ).toEqual({ code: "pass", bytes: 35, reads: 35, elapsedMs: 36_000 });
  expect(x.samples).toBe(2);
  expect(x.fetches).toBe(3);
  // A terminal errored stream may reject cancel; after stats still prove release.
});

test("EOF, partial/early/late errors, altered content, body and HTTP failures never pass", async () => {
  for (const [scenario, expected] of [
    [{ terminal: "eof" }, "eof"],
    [{ emitted: 34 }, "partial"],
    [{ elapsed: 34_999 }, "timing"],
    [{ elapsed: 46_001 }, "timing"],
    [{ emitted: 36 }, "limit"],
    [{ value: 2 }, "payload"],
    [{ body: false }, "body"],
    [{ status: 503 }, "http"],
    [{ encoding: "gzip" }, "encoding"],
    [{ failFetch: true }, "fetch"],
  ] as const) {
    const x = fixture(scenario);
    expect(
      await checkStreamError({ fetchBoundary: x.fetchBoundary, running: x.running, now: x.now }),
    ).toEqual({ code: expected });
    if (expected === "http" || expected === "encoding") expect(x.canceled).toBe(1);
  }
});

test("stopped process is never started by stats; changed identity, posts and live streams fail", async () => {
  for (const [scenario, expected, samples] of [
    [{ running: () => false }, "process", 0],
    [{ running: (count: number) => count === 0 }, "process", 1],
    [{ afterId: OTHER }, "identity", 2],
    [{ afterPosts: 3 }, "posts", 2],
    [{ afterStreams: 1 }, "streams", 2],
  ] as const) {
    const x = fixture(scenario);
    expect(
      await checkStreamError({ fetchBoundary: x.fetchBoundary, running: x.running, now: x.now }),
    ).toEqual({ code: expected });
    expect(x.samples).toBe(samples);
  }
});

test("deadline and outer abort cannot be mistaken for a source read error", async () => {
  const stalled = fixture({ terminal: "stall" });
  expect(
    await checkStreamError({
      fetchBoundary: stalled.fetchBoundary,
      running: stalled.running,
      now: stalled.now,
      timeoutMs: 10,
      cancelTimeoutMs: 10,
    }),
  ).toEqual({ code: "timeout" });
  const controller = new AbortController();
  const aborted = fixture({ terminal: "stall" });
  const promise = checkStreamError({
    fetchBoundary: aborted.fetchBoundary,
    running: aborted.running,
    now: aborted.now,
    outerSignal: controller.signal,
    cancelTimeoutMs: 10,
  });
  setTimeout(() => controller.abort(), 0);
  expect(await promise).toEqual({ code: "timeout" });
});

test("driver accepts only closed finite pass report and reports owned failures", async () => {
  const pass = { code: "pass", bytes: 35, reads: 35, elapsedMs: 36_000 };
  let paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    return Response.json(pass);
  };
  expect(await verifyStreamErrorCheck({ request })).toEqual(pass);
  expect(paths).toEqual(["/stream-error-check"]);
  for (const bad of [
    { ...pass, bytes: 34 },
    { ...pass, reads: 0 },
    { ...pass, elapsedMs: 34_999 },
    { ...pass, private: ID },
    { code: "pass" },
  ])
    await expect(
      verifyStreamErrorCheck({ request: async () => Response.json(bad) }),
    ).rejects.toThrow("verification_stream_check_report");
  await expect(
    verifyStreamErrorCheck({ request: async () => Response.json({ code: "eof" }) }),
  ).rejects.toThrow("verification_stream_check_eof");
});

test("new route is guarded before DO lookup and carries no credentials to the DO", async () => {
  let lookups = 0;
  const env = {
    HARNESS_KEY: "private-key",
    HARNESS_REVISION: "native",
    HARNESS_MONITOR: "enabled",
    HARNESS: {
      idFromName: () => {
        lookups++;
        return "id";
      },
      get: () => ({
        fetch: async (request: Request) => {
          expect(request.method).toBe("GET");
          expect([...request.headers]).toEqual([]);
          expect(request.body).toBeNull();
          return Response.json({ code: "pass", bytes: 35, reads: 35, elapsedMs: 36_000 });
        },
      }),
    },
  };
  const service = worker();
  expect(
    (await service.fetch(new Request("https://x/stream-error-check"), env as never)).status,
  ).toBe(401);
  expect(
    (
      await service.fetch(
        new Request("https://x/stream-error-check", {
          method: "POST",
          headers: { authorization: "Bearer private-key" },
        }),
        env as never,
      )
    ).status,
  ).toBe(404);
  expect(lookups).toBe(0);
  expect(
    (
      await service.fetch(
        new Request("https://x/stream-error-check", {
          headers: { authorization: "Bearer private-key" },
        }),
        env as never,
      )
    ).status,
  ).toBe(200);
  expect(lookups).toBe(1);
});
