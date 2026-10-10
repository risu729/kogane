import { expect, test, spyOn } from "bun:test";
import {
  canonicalDriverHttpCode,
  createSyntheticRequest,
  syntheticHttpFailure,
  sdkStartupCategory,
  initializeOuterFailureObservation,
} from "../http-diagnostics.mjs";
import { worker, classifySdkStartupResponse, SDK_NO_INSTANCE_RESPONSE } from "../src/common";
import {
  readFileSync,
  mkdtempSync,
  chmodSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  sdkStartupFailureRecord,
  initializeOuterFailureRecord,
  readRecord,
  writeRecord,
} from "../driver.mjs";
import { verifyPhase, verifyConcurrency } from "../driver.mjs";

const routes = [
  ["/initialize", "initialize", "POST"],
  ["/state", "state", "GET"],
  ["/once", "once_concurrency", "POST", "concurrency"],
  ["/stats", "stats", "GET"],
  ["/delay", "delay", "GET"],
  ["/stream", "stream", "GET"],
  ["/backpressure", "backpressure", "GET"],
  ["/backpressure-check", "backpressure_check", "GET"],
  ["/backpressure-compare", "backpressure_compare", "GET"],
  ["/stream-error", "stream_error", "GET"],
  ["/hold", "hold", "GET"],
  ["/destroy", "destroy", "POST"],
  ["/signal", "signal", "POST"],
  ["/exit", "exit", "POST"],
];
const statuses: [number, string][] = [
  [201, "unexpected_success"],
  [302, "redirect"],
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [408, "request_timeout"],
  [409, "conflict"],
  [418, "client_error"],
  [429, "rate_limited"],
  [500, "server_error"],
  [502, "bad_gateway"],
  [503, "unavailable"],
  [504, "gateway_timeout"],
  [599, "other_server"],
];

test("each fixed route maps exact outer and upstream HTTP categories without reading a body", () => {
  for (const [path, route, method, substage] of routes) {
    for (const [status, category] of statuses) {
      const outer = new Response("private-provider-body", { status });
      expect(syntheticHttpFailure(path, method, outer, substage)).toBe(
        `verification_http_${route}_outer_${category}`,
      );
      expect(outer.bodyUsed).toBe(false);
      const upstream = new Response("private-provider-body", {
        status: 502,
        headers: {
          "x-verification-failure": "upstream_http",
          "x-verification-upstream-status": String(status),
        },
      });
      expect(syntheticHttpFailure(path, method, upstream, substage)).toBe(
        `verification_http_${route}_upstream_${category}`,
      );
      expect(upstream.bodyUsed).toBe(false);
    }
  }
});
test("malformed or contradictory diagnostic metadata projects only a closed code", () => {
  for (const headers of [
    { "x-verification-failure": "private-exception" },
    { "x-verification-upstream-status": "503" },
    { "x-verification-failure": "upstream_http" },
    {
      "x-verification-failure": "upstream_http",
      "x-verification-upstream-status": "503 private-text",
    },
    { "x-verification-failure": "upstream_http", "x-verification-upstream-status": "0503" },
    { "x-verification-failure": "upstream_http", "x-verification-upstream-status": "600" },
    { "x-verification-failure": "upstream_http", "x-verification-upstream-status": "200" },
    { "x-verification-failure": "worker_exception", "x-verification-upstream-status": "503" },
  ])
    expect(
      syntheticHttpFailure("/delay", "GET", new Response(null, { status: 502, headers })),
    ).toBe("verification_http_delay_metadata_invalid");
  expect(
    syntheticHttpFailure(
      "/delay",
      "GET",
      new Response(null, {
        status: 503,
        headers: {
          "x-verification-failure": "upstream_http",
          "x-verification-upstream-status": "503",
        },
      }),
    ),
  ).toBe("verification_http_delay_metadata_invalid");
  expect(syntheticHttpFailure("/delay", "GET", { status: NaN, headers: new Headers() })).toBe(
    "verification_http_delay_outer_invalid_status",
  );
  expect(
    syntheticHttpFailure(
      "/delay",
      "GET",
      new Response(null, {
        status: 502,
        headers: { "x-verification-failure": "worker_exception" },
      }),
    ),
  ).toBe("verification_http_delay_worker_exception");
});
test("canonical runner vocabulary rejects appended text and unknown route/origin/category", () => {
  const valid = "verification_http_delay_upstream_unavailable";
  expect(canonicalDriverHttpCode(valid)).toBe(valid);
  expect(canonicalDriverHttpCode("verification_http_route")).toBe("verification_http_route");
  for (const value of [
    valid + " private-text",
    valid + "\n",
    "verification_http_private_upstream_unavailable",
    "verification_http_delay_provider_unavailable",
    "verification_http_delay_outer_custom",
    "private-text",
    undefined,
    {},
    new String(valid),
  ])
    expect(canonicalDriverHttpCode(value)).toBeUndefined();
});
test("single bounded request keeps manual redirects, 120s deadline and unchanged 200 response", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  const response = new Response("synthetic-stream", {
    headers: { "x-verification-failure": "ignored-on-success" },
  });
  let calls = 0;
  const request = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    fetchImpl: async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe("https://synthetic.invalid/stream");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(init.headers).toEqual({ authorization: "Bearer private-key" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response;
    },
  });
  try {
    expect(await request("/stream")).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(calls).toBe(1);
    expect(timeout).toHaveBeenCalledWith(120_000);
  } finally {
    timeout.mockRestore();
  }
});
test("only the backpressure GET requests identity encoding at the outer hop", async () => {
  const seen: [string, RequestInit][] = [];
  const request = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    fetchImpl: async (url: string, init: RequestInit) => {
      seen.push([new URL(url).pathname, init]);
      return new Response(null);
    },
  });
  await request("/backpressure");
  await request("/backpressure-check");
  await request("/stats");
  expect(seen.map(([path, init]) => [path, init.headers])).toEqual([
    ["/backpressure", { authorization: "Bearer private-key", "accept-encoding": "identity" }],
    ["/backpressure-check", { authorization: "Bearer private-key" }],
    ["/stats", { authorization: "Bearer private-key" }],
  ]);
  expect(seen.every(([, init]) => init.method === "GET" && init.redirect === "manual")).toBe(true);
});
test("failed request never reads provider body, retries or forwards exception text", async () => {
  let calls = 0;
  const response = new Response("private-provider-body", { status: 503 });
  const request = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    fetchImpl: async () => {
      calls++;
      return response;
    },
  });
  await expect(request("/delay")).rejects.toThrow("verification_http_delay_outer_unavailable");
  expect(response.bodyUsed).toBe(false);
  expect(calls).toBe(1);
  const failed = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    fetchImpl: async () => {
      throw new Error("private-provider-message");
    },
  });
  await expect(failed("/delay")).rejects.toThrow("verification_transport");
  for (const path of [
    "/unknown",
    "/delay?private",
    "/delay/private",
    "https://private.invalid",
    "__proto__",
  ])
    await expect(request(path)).rejects.toThrow("verification_http_route");
  await expect(request("/once")).rejects.toThrow("verification_http_route");
  expect(calls).toBe(1);
});
function environment(fetchImpl: (request: Request) => Promise<Response>) {
  return {
    HARNESS_KEY: "private-key",
    HARNESS_REVISION: "baseline_sdk",
    HARNESS_MONITOR: "enabled",
    HARNESS: { idFromName: () => "synthetic", get: () => ({ fetch: fetchImpl }) },
  };
}
const authorized = () =>
  new Request("https://synthetic.invalid/delay", {
    headers: { authorization: "Bearer private-key" },
  });
test("Worker-owned auth, revision and route errors have exact closed markers", async () => {
  let forwarded = 0;
  const service = worker();
  const env = environment(async (request) => {
    forwarded++;
    expect(new URL(request.url).pathname).toBe("/initialize");
    expect(request.method).toBe("POST");
    expect([...request.headers]).toEqual([]);
    expect(request.body).toBeNull();
    return Response.json({ accepted: 1 });
  });
  const authorizedPost = new Request("https://synthetic.invalid/initialize", {
    method: "POST",
    headers: { authorization: "Bearer private-key" },
  });
  const success = await service.fetch(authorizedPost, env as never);
  expect(success.status).toBe(200);
  expect(success.headers.get("x-verification-failure")).toBeNull();
  expect(forwarded).toBe(1);
  const cases = [
    [
      await service.fetch(
        new Request("https://synthetic.invalid/initialize", {
          method: "POST",
        }),
        env as never,
      ),
      401,
      "worker_unauthorized",
    ],
    [
      await service.fetch(authorizedPost, {
        ...env,
        HARNESS_REVISION: "private-revision",
      } as never),
      503,
      "worker_revision_invalid",
    ],
    [
      await service.fetch(
        new Request("https://synthetic.invalid/initialize", {
          method: "GET",
          headers: { authorization: "Bearer private-key" },
        }),
        env as never,
      ),
      404,
      "worker_route_missing",
    ],
  ] as const;
  for (const [response, status, suffix] of cases) {
    expect(response.status).toBe(status);
    expect(response.headers.get("x-verification-failure")).toBe(suffix);
    expect(response.headers.get("x-verification-upstream-status")).toBeNull();
    expect(response.bodyUsed).toBe(false);
    expect(syntheticHttpFailure("/initialize", "POST", response)).toBe(
      `verification_http_initialize_${suffix}`,
    );
    expect(response.bodyUsed).toBe(false);
    expect(canonicalDriverHttpCode(`verification_http_initialize_${suffix}`)).toBe(
      `verification_http_initialize_${suffix}`,
    );
  }
  expect(forwarded).toBe(1);
});

test("worker markers require their exact status and no conflicting metadata", () => {
  const owned = [
    [401, "worker_unauthorized"],
    [503, "worker_revision_invalid"],
    [404, "worker_route_missing"],
  ] as const;
  for (const [status, marker] of owned) {
    for (const wrongStatus of [401, 404, 503].filter((value) => value !== status)) {
      expect(
        syntheticHttpFailure(
          "/initialize",
          "POST",
          new Response(null, {
            status: wrongStatus,
            headers: { "x-verification-failure": marker },
          }),
        ),
      ).toBe("verification_http_initialize_metadata_invalid");
    }
    expect(
      syntheticHttpFailure(
        "/initialize",
        "POST",
        new Response(null, {
          status,
          headers: { "x-verification-failure": marker, "x-verification-upstream-status": "503" },
        }),
      ),
    ).toBe("verification_http_initialize_metadata_invalid");
    expect(
      canonicalDriverHttpCode(`verification_http_initialize_${marker} private`),
    ).toBeUndefined();
  }
  expect(syntheticHttpFailure("/initialize", "POST", new Response(null, { status: 404 }))).toBe(
    "verification_http_initialize_outer_not_found",
  );
  expect(
    syntheticHttpFailure(
      "/initialize",
      "POST",
      new Response(null, { status: 404, headers: { "x-verification-failure": "private-forgery" } }),
    ),
  ).toBe("verification_http_initialize_metadata_invalid");
});
test("Worker keeps 502 but exposes only upstream numeric status, cancels body and strips provider metadata", async () => {
  let canceled = 0;
  const response = await worker().fetch(
    authorized(),
    environment(async (request) => {
      expect([...request.headers]).toEqual([]);
      expect(request.body).toBeNull();
      return new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        {
          status: 503,
          headers: {
            "private-provider-header": "private-text",
            "x-verification-failure": "private-spoof",
          },
        },
      );
    }) as never,
  );
  expect(response.status).toBe(502);
  expect(canceled).toBe(1);
  expect(response.headers.get("x-verification-failure")).toBe("upstream_http");
  expect(response.headers.get("x-verification-upstream-status")).toBe("503");
  expect(response.headers.get("private-provider-header")).toBeNull();
  expect(await response.json()).toEqual({ code: "operation_failed" });
  expect(syntheticHttpFailure("/delay", "GET", response)).toBe(
    "verification_http_delay_upstream_unavailable",
  );
});
test("Worker exceptions remain closed and distinguishable from upstream HTTP and outer HTTP", async () => {
  const response = await worker().fetch(
    authorized(),
    environment(async () => {
      throw new Error("private-exception");
    }) as never,
  );
  expect(response.status).toBe(502);
  expect(response.headers.get("x-verification-failure")).toBe("worker_exception");
  expect(response.headers.get("x-verification-upstream-status")).toBeNull();
  expect(await response.json()).toEqual({ code: "operation_failed" });
  expect(syntheticHttpFailure("/delay", "GET", response)).toBe(
    "verification_http_delay_worker_exception",
  );
  const success = new Response("synthetic-response", { status: 200 });
  expect(await worker().fetch(authorized(), environment(async () => success) as never)).toBe(
    success,
  );
});

test("phase verification uses route diagnostics before any success report or record creation", async () => {
  const reports: string[] = [];
  const options = {
    phase: "baseline_sdk",
    temp: "/tmp/not-created-synthetic-record-directory",
    subdomain: "synthetic",
    key: "private-key",
    accountId: "a".repeat(32),
    apiToken: "private-api-token",
    appId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    rolloutDeadline: Date.now() + 180_000,
    report: (value: string) => reports.push(value),
  };
  let requests = 0;
  await expect(
    verifyPhase({
      ...options,
      fetchImpl: async () => {
        requests++;
        return new Response("private-provider-body", { status: 401 });
      },
    }),
  ).rejects.toThrow("verification_http_state_outer_unauthorized");
  expect(requests).toBe(1);
  expect(reports).toEqual([]);
  const paths: string[] = [];
  await expect(
    verifyPhase({
      ...options,
      fetchImpl: async (input: string) => {
        const path = new URL(input).pathname;
        paths.push(path);
        if (path === "/state")
          return Response.json({
            kvSentinelMatch: 0,
            sqlSentinelMatch: 0,
            sdkAlarmPresent: 0,
            revision: "baseline_sdk",
            running: 0,
            startCallbacks: 0,
            stops: 0,
            errors: 0,
            signaled: 0,
            exitSeven: 0,
          });
        return new Response("private-provider-body", {
          status: 502,
          headers: {
            "x-verification-failure": "upstream_http",
            "x-verification-upstream-status": "500",
          },
        });
      },
    }),
  ).rejects.toThrow("verification_http_initialize_upstream_server_error");
  expect(paths).toEqual(["/state", "/initialize"]);
  expect(reports).toEqual([]);
});

test("once HTTP diagnostics require one of five exact substages before any request", async () => {
  let calls = 0;
  const response = new Response("private-provider-body", { status: 503 });
  const request = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    fetchImpl: async () => {
      calls++;
      return response;
    },
  });
  const stages = [
    "concurrency",
    "idle_restart",
    "destroy_restart",
    "signal_restart",
    "exit_restart",
  ];
  for (const stage of stages) {
    const code = `verification_http_once_${stage}_outer_unavailable`;
    await expect(request("/once", "POST", stage)).rejects.toThrow(code);
    expect(canonicalDriverHttpCode(code)).toBe(code);
    expect(
      syntheticHttpFailure(
        "/once",
        "POST",
        new Response(null, {
          status: 502,
          headers: {
            "x-verification-failure": "upstream_http",
            "x-verification-upstream-status": "503",
          },
        }),
        stage,
      ),
    ).toBe(`verification_http_once_${stage}_upstream_unavailable`);
  }
  expect(calls).toBe(5);
  for (const stage of [undefined, "unknown", "concurrency private-text", "concurrency\n", {}, null])
    await expect(request("/once", "POST", stage)).rejects.toThrow("verification_http_route");
  await expect(request("/delay", "GET", "concurrency")).rejects.toThrow("verification_http_route");
  expect(calls).toBe(5);
  expect(response.bodyUsed).toBe(false);
  expect(
    canonicalDriverHttpCode("verification_http_once_concurrency_upstream_unavailable private-text"),
  ).toBeUndefined();
});

test("both cold concurrent POSTs carry the exact concurrency substage without extra POSTs", async () => {
  const calls: [string, string, string | undefined][] = [];
  let states = 0;
  const processIdentity = "dddddddd-dddd-4ddd-addd-dddddddddddd";
  await verifyConcurrency({
    phase: "native",
    json: async (path: string, method = "GET", substage?: string) => {
      calls.push([path, method, substage]);
      if (path === "/state")
        return states++ === 0 ? { running: 0, starts: 0 } : { running: 1, starts: 1 };
      if (path === "/once") return { accepted: 1, processIdentity };
      return { posts: 2, processIdentity };
    },
  });
  expect(calls.filter(([, method]) => method === "POST")).toEqual([
    ["/once", "POST", "concurrency"],
    ["/once", "POST", "concurrency"],
  ]);
  expect(
    calls.filter(([path]) => path !== "/once").every(([, , substage]) => substage === undefined),
  ).toBe(true);
});

const unavailableCode = "verification_http_once_concurrency_upstream_unavailable";
const sdkStartupHeader = "x-verification-sdk-startup";
function startupFailureResponse(
  category: string,
  extra: Record<string, string> = {},
  status = 502,
) {
  return new Response("private-unread-error-body", {
    status,
    headers: {
      "x-verification-failure": "upstream_http",
      "x-verification-upstream-status": "503",
      [sdkStartupHeader]: category,
      ...extra,
    },
  });
}
const onceRequest = () =>
  new Request("https://synthetic.invalid/once", {
    method: "POST",
    headers: { authorization: "Bearer private-key" },
  });

test("startup classifier matches the pinned SDK's entire 337 byte literal and EOF", async () => {
  const sdk = readFileSync(
    new URL("../node_modules/@cloudflare/containers/dist/lib/container.js", import.meta.url),
    "utf8",
  );
  const pinned = JSON.parse(
    readFileSync(
      new URL("../node_modules/@cloudflare/containers/package.json", import.meta.url),
      "utf8",
    ),
  );
  expect(pinned.version).toBe("0.3.7");
  const literal = sdk.match(/new Response\('([^']*)', \{ status: 503 \}\)/u)?.[1];
  expect(literal).toBeDefined();
  expect(JSON.parse('"' + literal + '"')).toBe(SDK_NO_INSTANCE_RESPONSE);
  expect(new TextEncoder().encode(SDK_NO_INSTANCE_RESPONSE).byteLength).toBe(337);
  expect(await classifySdkStartupResponse(new Response(SDK_NO_INSTANCE_RESPONSE))).toBe(
    "sdk_no_instance_response",
  );
  let index = 0;
  const bytes = new TextEncoder().encode(SDK_NO_INSTANCE_RESPONSE);
  expect(
    await classifySdkStartupResponse(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (index === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(index, ++index));
          },
        }),
      ),
    ),
  ).toBe("sdk_no_instance_response"); // 337 data reads plus EOF = 338 total samples.
});

test("wrong, suffixed, truncated, oversized and non-UTF8 bodies never match the SDK literal", async () => {
  for (const body of [
    "private-body",
    SDK_NO_INSTANCE_RESPONSE + "x",
    SDK_NO_INSTANCE_RESPONSE.slice(0, -1),
    SDK_NO_INSTANCE_RESPONSE + "x".repeat(4096),
    new Uint8Array([255]),
    "",
  ])
    expect(await classifySdkStartupResponse(new Response(body))).toBe("other_503_response");
  expect(await classifySdkStartupResponse(new Response(null))).toBe("unavailable");
});

test("classification needs EOF and one deadline includes stalled reads and cleanup", async () => {
  for (const mode of ["no_eof", "slow", "error", "cancel_stall", "late_cancel"] as const) {
    let emitted = false,
      canceled = 0,
      rejectCancel!: (error: Error) => void;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (mode === "error") {
            controller.error(new Error("private-read-error"));
            return;
          }
          if (mode === "slow" || emitted) return;
          emitted = true;
          controller.enqueue(
            new TextEncoder().encode(
              mode === "cancel_stall" || mode === "late_cancel"
                ? "wrong"
                : SDK_NO_INSTANCE_RESPONSE,
            ),
          );
        },
        cancel() {
          canceled++;
          if (mode === "cancel_stall") return new Promise<void>(() => {});
          if (mode === "late_cancel")
            return new Promise<void>((_, reject) => {
              rejectCancel = reject;
            });
        },
      }),
    );
    const started = Date.now();
    expect(await classifySdkStartupResponse(response, { timeoutMs: 15 })).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(200);
    expect(canceled).toBe(mode === "error" ? 0 : 1);
    if (mode === "late_cancel") {
      rejectCancel(new Error("private-late-cancel-error"));
      await new Promise((done) => setTimeout(done, 0));
    }
  }
});

test("late read rejection is handled and zero-byte chunks consume the finite sample budget", async () => {
  let rejectPull!: (error: Error) => void;
  expect(
    await classifySdkStartupResponse(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>((_, reject) => {
              rejectPull = reject;
            });
          },
          cancel() {},
        }),
      ),
      { timeoutMs: 10 },
    ),
  ).toBe("unavailable");
  rejectPull(new Error("private-late-read-error"));
  await new Promise((done) => setTimeout(done, 0));
  const empty = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(0));
      },
    }),
  );
  const reader = empty.body!.getReader();
  let reads = 0;
  const originalRead = reader.read.bind(reader);
  spyOn(reader, "read").mockImplementation(() => {
    reads++;
    return originalRead();
  });
  spyOn(empty.body!, "getReader").mockReturnValue(reader);
  expect(await classifySdkStartupResponse(empty)).toBe("unavailable");
  expect(reads).toBe(338);
});

test("elapsed time rejects late matching EOF even before the timer callback runs", async () => {
  let now = 0,
    sent = false;
  expect(
    await classifySdkStartupResponse(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode(SDK_NO_INSTANCE_RESPONSE));
            } else {
              now = 1001;
              controller.close();
            }
          },
        }),
      ),
      { now: () => now },
    ),
  ).toBe("unavailable");
});

test("Worker classifies only authenticated SDK POST once 503 responses without extra requests", async () => {
  for (const revision of [
    "baseline_sdk",
    "rollback_sdk",
    "native",
    "native_unmonitored",
    "native_recovered",
  ]) {
    for (const status of [503, 500, 200]) {
      let calls = 0;
      const env = {
        ...environment(async (request) => {
          calls++;
          expect(new URL(request.url).pathname).toBe("/once");
          expect(request.method).toBe("POST");
          expect([...request.headers]).toEqual([]);
          expect(request.body).toBeNull();
          return new Response(SDK_NO_INSTANCE_RESPONSE, {
            status,
            headers: { [sdkStartupHeader]: "private-forged" },
          });
        }),
        HARNESS_REVISION: revision,
      };
      const response = await worker().fetch(onceRequest(), env as never);
      const classify = ["baseline_sdk", "rollback_sdk"].includes(revision) && status === 503;
      expect(response.headers.get(sdkStartupHeader)).toBe(
        classify ? "sdk_no_instance_response" : status === 200 ? "private-forged" : null,
      );
      expect(calls).toBe(1);
      if (status !== 200) {
        expect(response.status).toBe(502);
        expect(response.headers.get("x-verification-upstream-status")).toBe(String(status));
        expect(await response.json()).toEqual({ code: "operation_failed" });
      }
    }
  }
  let forwarded = 0;
  const unauthorized = await worker().fetch(
    new Request("https://synthetic.invalid/once", { method: "POST" }),
    environment(async () => {
      forwarded++;
      return new Response(SDK_NO_INSTANCE_RESPONSE, { status: 503 });
    }) as never,
  );
  expect(unauthorized.status).toBe(401);
  expect(forwarded).toBe(0);
  const wrongMethod = await worker().fetch(
    new Request("https://synthetic.invalid/once", {
      headers: { authorization: "Bearer private-key" },
    }),
    environment(async () => {
      forwarded++;
      return new Response(SDK_NO_INSTANCE_RESPONSE, { status: 503 });
    }) as never,
  );
  expect(wrongMethod.status).toBe(404);
  expect(forwarded).toBe(0);
});

test("a stalled classifier preserves the original Worker and driver upstream 503 error", async () => {
  let canceled = 0;
  const started = Date.now();
  const response = await worker().fetch(
    onceRequest(),
    environment(
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              canceled++;
              return new Promise<void>(() => {});
            },
          }),
          { status: 503 },
        ),
    ) as never,
  );
  expect(response.status).toBe(502);
  expect(response.headers.get(sdkStartupHeader)).toBe("unavailable");
  expect(response.headers.get("x-verification-upstream-status")).toBe("503");
  expect(syntheticHttpFailure("/once", "POST", response, "concurrency")).toBe(unavailableCode);
  expect(canceled).toBe(1);
  expect(Date.now() - started).toBeLessThan(1300);
});

test("diagnostic headers require exact trusted status metadata, stage and category", async () => {
  for (const category of ["sdk_no_instance_response", "other_503_response", "unavailable"]) {
    const observations: unknown[] = [];
    const response = startupFailureResponse(category);
    const request = createSyntheticRequest({
      origin: "https://synthetic.invalid",
      key: "private-key",
      fetchImpl: async () => response,
      onFailure: (value: unknown) => observations.push(value),
    });
    await expect(request("/once", "POST", "concurrency")).rejects.toThrow(unavailableCode);
    expect(observations).toEqual([{ code: unavailableCode, category }]);
    expect(response.bodyUsed).toBe(false);
    for (const stage of [
      "idle_restart",
      "reader_cancel_restart",
      "destroy_restart",
      "signal_restart",
      "exit_restart",
    ])
      await expect(request("/once", "POST", stage)).rejects.toThrow(
        `verification_http_once_${stage}_upstream_unavailable`,
      );
    expect(observations).toHaveLength(1);
  }
  for (const category of ["private", "sdk_no_instance_response_extra"]) {
    const response = startupFailureResponse(category);
    expect(sdkStartupCategory(response)).toBeUndefined();
    let observed = 0;
    await expect(
      createSyntheticRequest({
        origin: "https://synthetic.invalid",
        key: "private-key",
        fetchImpl: async () => response,
        onFailure: () => {
          observed++;
        },
      })("/once", "POST", "concurrency"),
    ).rejects.toThrow(unavailableCode);
    expect(observed).toBe(0);
  }
  for (const response of [
    startupFailureResponse("sdk_no_instance_response", {
      "x-verification-failure": "worker_exception",
    }),
    startupFailureResponse("sdk_no_instance_response", { "x-verification-upstream-status": "500" }),
    startupFailureResponse("sdk_no_instance_response", {}, 503),
    new Response(null, { headers: { [sdkStartupHeader]: "sdk_no_instance_response" } }),
  ])
    expect(sdkStartupCategory(response)).toBeUndefined();
  for (const onFailure of [
    () => {
      throw new Error("private-write-error");
    },
    async () => {
      throw new Error("private-late-write-error");
    },
  ])
    await expect(
      createSyntheticRequest({
        origin: "https://synthetic.invalid",
        key: "private-key",
        fetchImpl: async () => startupFailureResponse("sdk_no_instance_response"),
        onFailure,
      })("/once", "POST", "concurrency"),
    ).rejects.toThrow(unavailableCode);
  await new Promise((done) => setTimeout(done, 0));
});

test("startup private record schema is closed and never carries SDK text", () => {
  const valid = {
    code: "sdk_startup_failure_observation",
    phase: "baseline_sdk",
    category: "sdk_no_instance_response",
  };
  expect(sdkStartupFailureRecord(valid)).toEqual(valid);
  expect(sdkStartupFailureRecord(valid)).not.toBe(valid);
  for (const change of [
    { private: SDK_NO_INSTANCE_RESPONSE },
    { phase: "native" },
    { code: "private" },
    { category: "provisioning" },
  ])
    expect(() => sdkStartupFailureRecord({ ...valid, ...change })).toThrow("verification_record");
});

test("driver privately persists only SDK concurrency diagnostics and preserves HTTP error on disk failure", async () => {
  const account = "a".repeat(32),
    namespace = "b".repeat(32);
  const appId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    workerVersion = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const image = `registry.cloudflare.com/${account}/kogane-container-api-verification-verificationcontainer@sha256:${"c".repeat(64)}`;
  for (const [phase, mode] of [
    ["baseline_sdk", "normal"],
    ["rollback_sdk", "normal"],
    ["native", "normal"],
    ["baseline_sdk", "existing"],
    ["baseline_sdk", "directory"],
    ["baseline_sdk", "unknown_header"],
  ]) {
    const temp = mkdtempSync(resolve(tmpdir(), "sdk-startup-"));
    chmodSync(temp, 0o700);
    const path = resolve(temp, "container-api-verification-sdk-startup-failure.json");
    const existing = {
      code: "sdk_startup_failure_observation",
      phase,
      category: "other_503_response",
    };
    if (mode === "existing") writeFileSync(path, JSON.stringify(existing), { mode: 0o600 });
    if (mode === "directory") mkdirSync(path, { mode: 0o700 });
    if (phase !== "baseline_sdk")
      writeRecord(temp, "container-api-verification-baseline.json", {
        appId,
        namespace,
        image,
        workerVersion,
      });
    const calls: string[] = [],
      reports: string[] = [];
    const app = {
      id: appId,
      account_id: account,
      name: "kogane-container-api-verification-verificationcontainer",
      version: 1,
      active_rollout_id: null,
      scheduling_policy: "default",
      max_instances: 1,
      constraints: { regions: ["APAC"] },
      durable_objects: { namespace_id: namespace },
      configuration: { image, vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } },
    };
    try {
      await expect(
        verifyPhase({
          phase,
          temp,
          subdomain: "synthetic",
          key: "private-key",
          accountId: account,
          apiToken: "private-api-token",
          appId,
          rolloutDeadline: Date.now() + 180_000,
          report: (line: string) => reports.push(line),
          fetchImpl: async (input: string, options: RequestInit) => {
            const url = new URL(input);
            calls.push(`${options.method} ${url.pathname}`);
            if (url.host === "api.cloudflare.com") {
              const result = url.pathname.endsWith("/deployments")
                ? { deployments: [{ versions: [{ version_id: workerVersion, percentage: 100 }] }] }
                : url.pathname.includes("/containers/") && url.pathname.endsWith("/versions")
                  ? [{ version: 1, percentage: 100, configuration: { image } }]
                  : url.pathname.includes("/containers/")
                    ? app
                    : {
                        resources: {
                          bindings: [
                            {
                              type: "durable_object_namespace",
                              name: "HARNESS",
                              class_name: "VerificationContainer",
                              namespace_id: namespace,
                            },
                          ],
                        },
                      };
              return Response.json({ success: true, result });
            }
            if (url.pathname === "/state")
              return Response.json({
                kvSentinelMatch: 1,
                sqlSentinelMatch: 1,
                sdkAlarmPresent: 0,
                revision: phase === "rollback_sdk" ? "baseline_sdk" : phase,
                running: 0,
                ...(phase === "native" ? { starts: 0 } : { startCallbacks: 0 }),
                stops: 0,
                errors: 0,
                signaled: 0,
                exitSeven: 0,
              });
            if (url.pathname === "/initialize") return Response.json({ accepted: 1 });
            if (url.pathname === "/destroy") return Response.json({ destroyed: 1 });
            expect(url.pathname).toBe("/once");
            return startupFailureResponse(
              mode === "unknown_header" ? "private" : "sdk_no_instance_response",
            );
          },
        }),
      ).rejects.toThrow(unavailableCode);
      expect(calls.filter((call) => call.endsWith(" /once"))).toEqual(["POST /once", "POST /once"]);
      expect(calls.filter((call) => call.endsWith(" /state"))).toHaveLength(3);
      expect(calls.some((call) => call.endsWith(" /stats"))).toBe(false);
      expect(reports).toEqual([]);
      if (phase === "native" || mode === "unknown_header") expect(existsSync(path)).toBe(false);
      else if (mode !== "directory")
        expect(readRecord(temp, "container-api-verification-sdk-startup-failure.json")).toEqual(
          mode === "existing"
            ? existing
            : {
                code: "sdk_startup_failure_observation",
                phase,
                category: "sdk_no_instance_response",
              },
        );
    } finally {
      rmSync(temp, { recursive: true });
    }
  }
});

test("startup classifier test budgets cannot loosen the fixed one-second bound", async () => {
  for (const timeoutMs of [NaN, Infinity, -Infinity, -1, 0, 1001]) {
    const response = new Response(SDK_NO_INSTANCE_RESPONSE);
    expect(await classifySdkStartupResponse(response, { timeoutMs })).toBe("unavailable");
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
  }
});

const initializeOuterCode = "verification_http_initialize_outer_not_found";
const initializeRequestUrl = "https://synthetic.invalid/initialize";
const initializeObservation = {
  code: "initialize_outer_failure_observation",
  phase: "baseline_sdk",
  cfErrorType: "missing",
  cfErrorOriginPresent: false,
  cfRayPresent: false,
  contentType: "missing",
  responseUrl: "absent",
  redirected: false,
};
function observeInitialize(response: Response, changes = {}) {
  return initializeOuterFailureObservation({
    phase: "baseline_sdk",
    path: "/initialize",
    method: "POST",
    code: initializeOuterCode,
    requestUrl: initializeRequestUrl,
    response,
    ...changes,
  });
}
test("initial outer 404 records only closed header categories and never reads values/body", () => {
  for (const category of [
    "1000",
    "1016",
    "1101",
    "1102",
    "521",
    "522",
    "523",
    "524",
    "525",
    "526",
    "missing",
    "other",
  ]) {
    const response = new Response(null, {
      status: 404,
      headers:
        category === "missing"
          ? {}
          : {
              "cf-error-type": category === "other" ? "private-unknown-error" : category,
              "cf-error-origin": "private-origin",
              "cf-ray": "private-ray",
              "content-type": "Text/HTML; charset=private-charset",
            },
    });
    expect(observeInitialize(response)).toEqual({
      ...initializeObservation,
      cfErrorType: category,
      ...(category === "missing"
        ? {}
        : { cfErrorOriginPresent: true, cfRayPresent: true, contentType: "text/html" }),
    });
    expect(response.bodyUsed).toBe(false);
    expect(JSON.stringify(observeInitialize(response))).not.toContain("private");
  }
  for (const [header, expected] of [
    [null, "missing"],
    ["application/json", "application/json"],
    ["text/plain; charset=utf-8", "text/plain"],
    ["application/octet-stream", "application/octet-stream"],
    ["text/xml", "other"],
    ["x".repeat(129), "other"],
  ]) {
    const response = new Response(null, {
      status: 404,
      headers: header ? { "content-type": header } : {},
    });
    expect(observeInitialize(response)?.contentType).toBe(expected);
  }
  for (const [url, expected] of [
    [initializeRequestUrl, "expected"],
    ["https://private.invalid/secret", "other"],
    ["", "absent"],
  ]) {
    const response = new Response(null, { status: 404 });
    Object.defineProperties(response, { url: { value: url }, redirected: { value: true } });
    expect(observeInitialize(response)).toEqual({
      ...initializeObservation,
      responseUrl: expected,
      redirected: true,
    });
    expect(JSON.stringify(observeInitialize(response))).not.toContain("private");
  }
});
test("initial outer diagnostic gate rejects other phases/routes/methods/statuses and any owned marker", () => {
  const response = new Response(null, { status: 404 });
  for (const changes of [
    { phase: "native" },
    { phase: "native_unmonitored" },
    { phase: "native_recovered" },
    { phase: "rollback_sdk" },
    { phase: undefined },
    { path: "/state" },
    { path: "/once" },
    { method: "GET" },
    { code: "verification_http_state_outer_not_found" },
    { response: new Response(null, { status: 503 }) },
    { response: new Response(null, { status: 200 }) },
    {
      response: new Response(null, {
        status: 404,
        headers: { "x-verification-failure": "worker_route_missing" },
      }),
    },
    { response: new Response(null, { status: 404, headers: { "x-verification-failure": "" } }) },
    {
      response: new Response(null, {
        status: 404,
        headers: { "x-verification-upstream-status": "404" },
      }),
    },
    {
      response: new Response(null, {
        status: 404,
        headers: { "x-verification-upstream-status": "" },
      }),
    },
  ])
    expect(observeInitialize(response, changes)).toBeUndefined();
});
test("initial outer request persists observation before canonical failure and cancels without body reads/retry", async () => {
  let calls = 0,
    cancels = 0,
    reads = 0,
    completed = false;
  const response = new Response("private-body", { status: 404 });
  spyOn(response.body!, "getReader").mockImplementation(() => {
    reads++;
    throw new Error("private-read");
  });
  spyOn(response.body!, "cancel").mockImplementation(async () => {
    cancels++;
  });
  const request = createSyntheticRequest({
    origin: "https://synthetic.invalid",
    key: "private-key",
    phase: "baseline_sdk",
    fetchImpl: async (url: string, options: RequestInit) => {
      calls++;
      expect(url).toBe(initializeRequestUrl);
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("manual");
      return response;
    },
    onFailure: async (value: unknown) => {
      expect(value).toEqual({ code: initializeOuterCode, observation: initializeObservation });
      await new Promise((done) => setTimeout(done, 10));
      completed = true;
    },
  });
  await expect(request("/initialize", "POST")).rejects.toThrow(initializeOuterCode);
  expect(completed).toBe(true);
  expect(calls).toBe(1);
  expect(cancels).toBe(1);
  expect(reads).toBe(0);
});
test("initial outer secondary failures and one shared monotonic cleanup budget preserve original error", async () => {
  for (const mode of ["write", "late_write", "cancel", "late_cancel", "pending"]) {
    const response = new Response("private-body", { status: 404 });
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = spyOn(response.body!, "cancel").mockImplementation(() => {
      if (mode === "cancel") throw new Error("private-cancel");
      if (mode === "late_cancel")
        return new Promise((_, reject) => {
          lateTimer = setTimeout(() => reject(new Error("private-late")), 1100);
        });
      if (mode === "pending") return new Promise(() => {});
      return Promise.resolve();
    });
    const started = performance.now();
    await expect(
      createSyntheticRequest({
        origin: "https://synthetic.invalid",
        key: "private-key",
        phase: "baseline_sdk",
        fetchImpl: async () => response,
        onFailure: () => {
          if (mode === "write") throw new Error("private-write");
          if (mode === "late_write") return Promise.reject(new Error("private-async-write"));
          return undefined;
        },
      })("/initialize", "POST"),
    ).rejects.toThrow(initializeOuterCode);
    expect(performance.now() - started).toBeLessThan(1200);
    expect(cancel).toHaveBeenCalledTimes(1);
    if (lateTimer) await new Promise((done) => setTimeout(done, 150));
  }
  // Time spent in a secondary observer cannot reset the cancellation budget.
  const response = new Response("private-body", { status: 404 });
  spyOn(response.body!, "cancel").mockImplementation(() => new Promise(() => {}));
  const started = performance.now();
  await expect(
    createSyntheticRequest({
      origin: "https://synthetic.invalid",
      key: "private-key",
      phase: "baseline_sdk",
      fetchImpl: async () => response,
      onFailure: () => new Promise((done) => setTimeout(done, 250)),
    })("/initialize", "POST"),
  ).rejects.toThrow(initializeOuterCode);
  expect(performance.now() - started).toBeLessThan(1200);
});
test("initial outer private record requires exact keys/enums/booleans and never carries header text/URL", () => {
  expect(initializeOuterFailureRecord(initializeObservation)).toEqual(initializeObservation);
  expect(initializeOuterFailureRecord(initializeObservation)).not.toBe(initializeObservation);
  for (const change of [
    { code: "private" },
    { phase: "rollback_sdk" },
    { cfErrorType: "520" },
    { cfErrorType: "private" },
    { cfErrorOriginPresent: 1 },
    { cfRayPresent: "true" },
    { contentType: "private" },
    { responseUrl: initializeRequestUrl },
    { redirected: 0 },
    { body: "private" },
    { header: "private" },
  ])
    expect(() => initializeOuterFailureRecord({ ...initializeObservation, ...change })).toThrow(
      "verification_record",
    );
  const missing = { ...initializeObservation };
  delete (missing as Partial<typeof missing>).cfErrorType;
  for (const value of [null, [], missing])
    expect(() => initializeOuterFailureRecord(value)).toThrow("verification_record");
});
test("baseline initial outer failure writes a private first observation before exit and makes only GET/state + POST/initialize", async () => {
  for (const mode of [
    "normal",
    "existing",
    "directory",
    "unsafe_directory",
    "symlink",
    "hardlink",
  ]) {
    const temp = mkdtempSync(resolve(tmpdir(), "initialize-outer-"));
    chmodSync(temp, mode === "unsafe_directory" ? 0o755 : 0o700);
    const name = "container-api-verification-initialize-outer-failure.json";
    const path = resolve(temp, name);
    const existing = { ...initializeObservation, cfErrorType: "other" };
    if (mode === "existing") writeFileSync(path, JSON.stringify(existing), { mode: 0o600 });
    if (mode === "directory") mkdirSync(path, { mode: 0o700 });
    const target = resolve(temp, "private-target.json");
    if (mode === "symlink" || mode === "hardlink") {
      writeFileSync(target, "private-target", { mode: 0o600 });
      if (mode === "symlink") symlinkSync(target, path);
      else linkSync(target, path);
    }
    const calls: string[] = [],
      reports: string[] = [];
    try {
      await expect(
        verifyPhase({
          phase: "baseline_sdk",
          temp,
          subdomain: "synthetic",
          key: "private-key",
          accountId: "a".repeat(32),
          apiToken: "private-api-token",
          appId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          rolloutDeadline: Date.now() + 180_000,
          report: (line: string) => reports.push(line),
          fetchImpl: async (input: string, options: RequestInit) => {
            const url = new URL(input);
            calls.push(`${options.method} ${url.pathname}`);
            if (url.pathname === "/state")
              return Response.json({
                kvSentinelMatch: 0,
                sqlSentinelMatch: 0,
                sdkAlarmPresent: 0,
                revision: "baseline_sdk",
                running: 0,
                startCallbacks: 0,
                stops: 0,
                errors: 0,
                signaled: 0,
                exitSeven: 0,
              });
            expect(url.pathname).toBe("/initialize");
            return new Response(null, { status: 404 });
          },
        }),
      ).rejects.toThrow(initializeOuterCode);
      expect(calls).toEqual(["GET /state", "POST /initialize"]);
      expect(reports).toEqual([]);
      if (mode === "normal" || mode === "existing")
        expect(readRecord(temp, name)).toEqual(
          mode === "existing" ? existing : initializeObservation,
        );
      if (mode === "unsafe_directory") expect(existsSync(path)).toBe(false);
      if (mode === "symlink" || mode === "hardlink") {
        expect(readFileSync(target, "utf8")).toBe("private-target");
        expect(() => readRecord(temp, name)).toThrow();
      }
      expect(existsSync(resolve(temp, "container-api-verification-sdk-startup-failure.json"))).toBe(
        false,
      );
    } finally {
      rmSync(temp, { recursive: true });
    }
  }
});

test("initial outer diagnostic metadata exceptions keep canonical failure and still cancel without reading", async () => {
  for (const mode of ["header", "url"]) {
    const response = new Response("private-body", { status: 404 });
    const headers = response.headers;
    if (mode === "header")
      Object.defineProperty(response, "headers", {
        value: {
          get: (name: string) => {
            if (name === "cf-error-type") throw new Error("private-header");
            return headers.get(name);
          },
          has: (name: string) => headers.has(name),
        },
      });
    else
      Object.defineProperty(response, "url", {
        get: () => {
          throw new Error("private-url");
        },
      });
    const cancel = spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const read = spyOn(response.body!, "getReader").mockImplementation(() => {
      throw new Error("private-read");
    });
    let observations = 0;
    await expect(
      createSyntheticRequest({
        phase: "baseline_sdk",
        origin: "https://synthetic.invalid",
        key: "private-key",
        fetchImpl: async () => response,
        onFailure: () => {
          observations++;
        },
      })("/initialize", "POST"),
    ).rejects.toThrow(initializeOuterCode);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(observations).toBe(0);
  }
});

test("native Node fetch classifies only the existing real TCP POST response with closed headers and URL evidence", () => {
  const output = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
      import { createServer } from "node:http";
      import { once } from "node:events";
      const { createSyntheticRequest } = await import(process.argv[1]);
      let calls = 0, observed;
      const server = createServer((request, response) => {
        calls++;
        if (request.method !== "POST" || request.url !== "/initialize") throw new Error("unexpected_request");
        response.writeHead(404, {
          "cf-error-type": "1101", "cf-error-origin": "synthetic-private-origin",
          "cf-ray": "synthetic-private-ray", "content-type": "text/html; charset=utf-8",
        });
        response.end("synthetic-private-body");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      let primary;
      try {
        await createSyntheticRequest({
          phase: "baseline_sdk", origin: "http://127.0.0.1:" + server.address().port,
          key: "synthetic-key", onFailure: (value) => { observed = value.observation; },
        })("/initialize", "POST");
      } catch (error) { primary = error.message; }
      finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
      console.log(JSON.stringify({ primary, calls, observed }));
    `,
      new URL("../http-diagnostics.mjs", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  expect(JSON.parse(output)).toEqual({
    primary: initializeOuterCode,
    calls: 1,
    observed: {
      ...initializeObservation,
      cfErrorType: "1101",
      cfErrorOriginPresent: true,
      cfRayPresent: true,
      contentType: "text/html",
      responseUrl: "expected",
    },
  });
  expect(output).not.toContain("synthetic-private");
}, 16000);

test("only successful GET/state adds the closed outer Worker revision without reading or teeing its body", async () => {
  for (const revision of [
    "baseline_sdk",
    "native",
    "native_unmonitored",
    "native_recovered",
    "rollback_sdk",
  ]) {
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("unchanged-state-body"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const original = new Response(body, {
      status: 200,
      statusText: "Synthetic state",
      headers: {
        "content-type": "application/json",
        "x-existing": "preserved",
        "x-verification-worker-revision": "private-spoof",
      },
    });
    Object.defineProperty(original.headers, "set", {
      value: () => {
        throw new Error("immutable-original-headers");
      },
    });
    const env = {
      ...environment(async () => original),
      HARNESS_REVISION: revision,
    };
    const response = await worker().fetch(
      new Request("https://synthetic.invalid/state", {
        headers: { authorization: "Bearer private-key" },
      }),
      env as never,
    );
    expect(response).not.toBe(original);
    expect(response.body).toBe(original.body);
    expect(response.status).toBe(original.status);
    expect(response.statusText).toBe(original.statusText);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-existing")).toBe("preserved");
    expect(response.headers.get("x-verification-worker-revision")).toBe(revision);
    expect(original.headers.get("x-verification-worker-revision")).toBe("private-spoof");
    expect(pulls).toBe(0);
    expect(await response.text()).toBe("unchanged-state-body");
    expect(pulls).toBe(1);
  }
});

test("outer revision diagnostic preserves identity for every other successful route and all existing failures", async () => {
  for (const [path, method] of [
    ["/initialize", "POST"],
    ["/once", "POST"],
    ["/stats", "GET"],
    ["/delay", "GET"],
    ["/stream", "GET"],
    ["/backpressure", "GET"],
    ["/backpressure-check", "GET"],
    ["/reader-resume-check", "GET"],
    ["/reader-cancel-check", "GET"],
    ["/backpressure-compare", "GET"],
    ["/stream-error-compare", "GET"],
    ["/stream-error-check", "GET"],
    ["/stream-error", "GET"],
    ["/hold", "GET"],
    ["/destroy", "POST"],
    ["/signal", "POST"],
    ["/exit", "POST"],
  ]) {
    const original = new Response("unchanged", { status: 200 });
    const response = await worker().fetch(
      new Request("https://synthetic.invalid" + path, {
        method,
        headers: { authorization: "Bearer private-key" },
      }),
      environment(async () => original) as never,
    );
    expect(response).toBe(original);
    expect(response.headers.get("x-verification-worker-revision")).toBeNull();
  }
  for (const kind of [
    "unauthorized",
    "invalid-revision",
    "wrong-method",
    "upstream",
    "exception",
  ]) {
    let calls = 0;
    const env = {
      ...environment(async () => {
        calls++;
        if (kind === "exception") throw new Error("private-error");
        return new Response("private-body", { status: 503 });
      }),
      HARNESS_REVISION: kind === "invalid-revision" ? "private-value" : "native",
    };
    const response = await worker().fetch(
      new Request("https://synthetic.invalid/state", {
        method: kind === "wrong-method" ? "POST" : "GET",
        headers: kind === "unauthorized" ? {} : { authorization: "Bearer private-key" },
      }),
      env as never,
    );
    expect(response.headers.get("x-verification-worker-revision")).toBeNull();
    expect(response.status).toBe(
      kind === "unauthorized"
        ? 401
        : kind === "invalid-revision"
          ? 503
          : kind === "wrong-method"
            ? 404
            : 502,
    );
    expect(calls).toBe(["upstream", "exception"].includes(kind) ? 1 : 0);
  }
});

test("outer revision emission closes unexpected values after the asynchronous DO response", async () => {
  for (const unexpected of ["private-worker-value", "", "private-value\r\ninjected: value"]) {
    let pulls = 0,
      calls = 0;
    const original = new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("unchanged-state-body"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200, statusText: "Synthetic state" },
    );
    const env = {
      ...environment(async () => {
        calls++;
        env.HARNESS_REVISION = unexpected;
        return original;
      }),
      HARNESS_REVISION: "native",
    };
    const response = await worker().fetch(
      new Request("https://synthetic.invalid/state", {
        headers: { authorization: "Bearer private-key" },
      }),
      env as never,
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(original.status);
    expect(response.statusText).toBe(original.statusText);
    expect(response.body).toBe(original.body);
    expect(response.headers.get("x-verification-worker-revision")).toBe("unknown");
    expect(Array.from(response.headers.values()).join(",")).not.toContain("private");
    expect(pulls).toBe(0);
    expect(await response.text()).toBe("unchanged-state-body");
    expect(pulls).toBe(1);
  }
});
