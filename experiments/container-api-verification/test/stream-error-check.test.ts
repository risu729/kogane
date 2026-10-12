import { expect, test } from "bun:test";
import { checkStreamError } from "../src/stream-error-check";
import { verifyStreamErrorCheck, streamCheckFailureRecord, readRecord } from "../driver.mjs";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  statsDelay?: number[];
  stats?: Array<{ streams: number; processIdentity?: string; posts?: number }>;
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
      clock += scenario.statsDelay?.[samples - 1] ?? 0;
      const current = scenario.stats?.[Math.min(samples - 1, scenario.stats.length - 1)];
      return Response.json({
        processIdentity: current?.processIdentity ?? (samples >= 2 ? (scenario.afterId ?? ID) : ID),
        posts: current?.posts ?? (samples >= 2 ? (scenario.afterPosts ?? 2) : 2),
        streams: current?.streams ?? (samples >= 2 ? (scenario.afterStreams ?? 0) : 0),
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
          clock += scenario.elapsed ?? 36_000;
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
    sleep: async (ms: number) => {
      clock += ms;
    },
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
    [{ afterStreams: 1 }, "streams_after", 31],
  ] as const) {
    const x = fixture(scenario);
    expect(
      await checkStreamError({
        fetchBoundary: x.fetchBoundary,
        running: x.running,
        now: x.now,
        sleep: x.sleep,
      }),
    ).toMatchObject({ code: expected });
    expect(x.samples).toBeLessThanOrEqual(samples);
    if (expected !== "streams_after") expect(x.samples).toBe(samples);
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

const observation = (stage = "before", failureCode = "streams_before") => ({
  code: "stream_check_failure_observation",
  failureCode,
  stage,
  samples: 1,
  elapsedMs: 0,
  running: 1,
  streams: 1,
  identityMatches: 1,
  postsMatches: 1,
});

test("release waits retry only a validated single stream before and after the one error arm", async () => {
  const x = fixture({
    stats: [{ streams: 1 }, { streams: 1 }, { streams: 0 }, { streams: 1 }, { streams: 0 }],
  });
  expect(await checkStreamError({ ...x, now: x.now, sleep: x.sleep })).toEqual({
    code: "pass",
    bytes: 35,
    reads: 35,
    elapsedMs: 36_000,
  });
  expect(x.samples).toBe(5);
  expect(x.fetches).toBe(6);
});

test("every waiting sample retains the first identity and posts anchor", async () => {
  for (const [change, expected] of [
    [{ processIdentity: OTHER }, "identity"],
    [{ posts: 3 }, "posts"],
  ] as const) {
    for (const stage of ["before", "after"] as const) {
      for (const streams of [0, 1]) {
        const stats =
          stage === "before"
            ? [{ streams: 1 }, { streams, ...change }, { streams: 0 }]
            : [{ streams: 0 }, { streams: 1 }, { streams, ...change }, { streams: 0 }];
        const x = fixture({ stats });
        const result = await checkStreamError({ ...x, sleep: x.sleep });
        expect(result).toMatchObject({
          code: expected,
          observation: {
            stage,
            samples: 2,
            running: 1,
            streams,
            identityMatches: expected === "identity" ? 0 : 1,
            postsMatches: expected === "posts" ? 0 : 1,
          },
        });
        expect(x.samples).toBe(stage === "before" ? 2 : 3);
        expect(x.fetches - x.samples).toBe(stage === "before" ? 0 : 1);
      }
    }
  }
});

test("multiple streams fail immediately; stuck one has a finite 31 sample ceiling", async () => {
  for (const stage of ["before", "after"] as const) {
    const x = fixture({
      stats: stage === "before" ? [{ streams: 2 }] : [{ streams: 0 }, { streams: 2 }],
    });
    expect(await checkStreamError({ ...x, sleep: x.sleep })).toMatchObject({
      code: `streams_${stage}`,
      observation: { stage, samples: 1, streams: 2 },
    });
    expect(x.fetches - x.samples).toBe(stage === "before" ? 0 : 1);
    const stuck = fixture({
      stats: stage === "before" ? [{ streams: 1 }] : [{ streams: 0 }, { streams: 1 }],
    });
    expect(await checkStreamError({ ...stuck, sleep: async () => {} })).toMatchObject({
      code: `streams_${stage}`,
      observation: { stage, samples: 31, streams: 1 },
    });
    expect(stuck.fetches - stuck.samples).toBe(stage === "before" ? 0 : 1);
  }
});

test("running is rechecked before every retry and cannot auto-start a process", async () => {
  const x = fixture({ stats: [{ streams: 1 }], running: (samples) => samples === 0 });
  expect(await checkStreamError({ ...x, sleep: x.sleep })).toMatchObject({
    code: "process",
    observation: { stage: "before", samples: 1, running: 0, streams: 1 },
  });
  expect(x.fetches).toBe(1);
  const stopped = fixture({ running: () => false });
  expect(await checkStreamError({ ...stopped })).toMatchObject({
    code: "process",
    observation: { stage: "before", samples: 0, running: 0, streams: null },
  });
});

test("invalid stats and failed stats transport are not retried", async () => {
  for (const mode of ["json", "transport", "oversize", "status"] as const) {
    let fetches = 0;
    expect(
      await checkStreamError({
        running: () => true,
        fetchBoundary: async () => {
          fetches++;
          if (mode === "transport") throw new Error("private");
          if (mode === "status") return new Response("{}", { status: 503 });
          return new Response(mode === "oversize" ? "x".repeat(4097) : "{");
        },
      }),
    ).toMatchObject({ code: "stats", observation: { stage: "before", samples: 1 } });
    expect(fetches).toBe(1);
  }
});

test("outer abort and shared global deadline stop release waits without executing another arm", async () => {
  const controller = new AbortController();
  const x = fixture({ stats: [{ streams: 1 }] });
  expect(
    await checkStreamError({
      ...x,
      outerSignal: controller.signal,
      sleep: async () => controller.abort(),
    }),
  ).toMatchObject({ code: "timeout", observation: { stage: "before", samples: 1 } });
  expect(x.fetches).toBe(1);
  const y = fixture({ stats: [{ streams: 0 }, { streams: 1 }] });
  expect(await checkStreamError({ ...y, timeoutMs: 36_100, sleep: y.sleep })).toMatchObject({
    code: "timeout",
    observation: { stage: "after", samples: 1 },
  });
  expect(y.fetches).toBe(3);
  const z = fixture();
  controller.abort();
  expect(await checkStreamError({ ...z, outerSignal: controller.signal })).toEqual({
    code: "timeout",
  });
  expect(z.fetches).toBe(0);
});

test("hung stats body and hung cancellation never extend the shared deadline", async () => {
  for (const mode of ["fetch", "body"] as const) {
    let canceled = 0;
    const started = Date.now();
    const result = await checkStreamError({
      running: () => true,
      timeoutMs: 15,
      fetchBoundary: () =>
        mode === "fetch"
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  pull() {},
                  cancel() {
                    canceled++;
                    return new Promise<void>(() => {});
                  },
                }),
              ),
            ),
    });
    expect(result).toMatchObject({ code: "timeout", observation: { stage: "before", samples: 1 } });
    expect(Date.now() - started).toBeLessThan(200);
    expect(canceled).toBe(mode === "body" ? 1 : 0);
  }
});

test("late stats response is canceled after timeout without further requests", async () => {
  let canceled = 0,
    requests = 0;
  let accept!: (response: Response) => void;
  expect(
    await checkStreamError({
      running: () => true,
      timeoutMs: 5,
      fetchBoundary: () => {
        requests++;
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      },
    }),
  ).toMatchObject({ code: "timeout" });
  accept(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(canceled).toBe(1);
  expect(requests).toBe(1);
});

test("failure observations are closed, finite, projected and privately persisted", async () => {
  const valid = observation();
  expect(streamCheckFailureRecord(valid)).toEqual(valid);
  expect(streamCheckFailureRecord(valid)).not.toBe(valid);
  for (const change of [
    { private: ID },
    { failureCode: "fetch" },
    { failureCode: "streams_after" },
    { stage: "secret" },
    { samples: -1 },
    { samples: 32 },
    { samples: 1.5 },
    { samples: NaN },
    { elapsedMs: 46001 },
    { elapsedMs: Infinity },
    { running: 2 },
    { streams: 3 },
    { identityMatches: "yes" },
    { postsMatches: 2 },
    { code: "private" },
  ])
    expect(() => streamCheckFailureRecord({ ...valid, ...change })).toThrow(
      "verification_stream_check_report",
    );
  const temp = mkdtempSync(join(tmpdir(), "stream-check-"));
  chmodSync(temp, 0o700);
  try {
    const { code: _, failureCode, ...details } = valid;
    await expect(
      verifyStreamErrorCheck({
        temp,
        request: async () => Response.json({ code: failureCode, observation: details }),
      }),
    ).rejects.toThrow("verification_stream_check_streams_before");
    expect(readRecord(temp, "container-api-verification-stream-check-failure.json")).toEqual(valid);
    // O_EXCL refuses a second write; retain the validated failure rather than exposing the disk error.
    await expect(
      verifyStreamErrorCheck({
        temp,
        request: async () => Response.json({ code: failureCode, observation: details }),
      }),
    ).rejects.toThrow("verification_stream_check_streams_before");
    await expect(
      verifyStreamErrorCheck({
        temp: join(temp, "missing"),
        request: async () => Response.json({ code: failureCode, observation: details }),
      }),
    ).rejects.toThrow("verification_stream_check_streams_before");
    for (const change of [{ private: ID }, { samples: 32 }, { streams: 3 }])
      await expect(
        verifyStreamErrorCheck({
          request: async () =>
            Response.json({ code: failureCode, observation: { ...details, ...change } }),
        }),
      ).rejects.toThrow("verification_stream_check_report");
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("valid zero stats arriving beyond a release or global deadline cannot pass", async () => {
  for (const stage of ["before", "after"] as const) {
    const x = fixture({ statsDelay: stage === "before" ? [3001] : [0, 3001] });
    expect(await checkStreamError({ ...x, sleep: x.sleep })).toMatchObject({
      code: `streams_${stage}`,
      observation: { stage, samples: 1, streams: 0, elapsedMs: 3001 },
    });
    expect(x.fetches - x.samples).toBe(stage === "before" ? 0 : 1);
  }
  const y = fixture({ elapsed: 44_001, statsDelay: [0, 2000] });
  expect(await checkStreamError({ ...y, sleep: y.sleep })).toMatchObject({
    code: "timeout",
    observation: { stage: "after", samples: 1, streams: 0 },
  });
  expect(y.fetches - y.samples).toBe(1);
});

test("a stats response arriving after the three-second release timeout is canceled", async () => {
  let canceled = 0,
    requests = 0;
  let accept!: (response: Response) => void;
  expect(
    await checkStreamError({
      running: () => true,
      fetchBoundary: () => {
        requests++;
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      },
    }),
  ).toMatchObject({ code: "streams_before", observation: { stage: "before", samples: 1 } });
  accept(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(canceled).toBe(1);
  expect(requests).toBe(1);
}, 5000);
