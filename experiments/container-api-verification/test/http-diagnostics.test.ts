import { expect, test, spyOn } from "bun:test";
import {
  canonicalDriverHttpCode,
  createSyntheticRequest,
  syntheticHttpFailure,
} from "../http-diagnostics.mjs";
import { worker } from "../src/common";
import { verifyPhase, verifyConcurrency } from "../driver.mjs";

const routes = [
  ["/initialize", "initialize", "POST"],
  ["/state", "state", "GET"],
  ["/once", "once_concurrency", "POST", "concurrency"],
  ["/stats", "stats", "GET"],
  ["/delay", "delay", "GET"],
  ["/stream", "stream", "GET"],
  ["/backpressure", "backpressure", "GET"],
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
        if (path === "/state") return Response.json({ revision: "baseline_sdk" });
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
