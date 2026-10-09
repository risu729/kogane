import { expect, test } from "bun:test";
import { waitHttpReady } from "../http-readiness.mjs";
import { canonicalDriverHttpCode } from "../http-diagnostics.mjs";

function state(revision = "baseline_sdk") {
  return {
    kvSentinelMatch: 0,
    sqlSentinelMatch: 0,
    sdkAlarmPresent: 0,
    revision,
    running: 0,
    [revision.startsWith("native") ? "starts" : "startCallbacks"]: 0,
    stops: 0,
    errors: 0,
    signaled: 0,
    exitSeven: 0,
  };
}
function options(extra: Record<string, unknown> = {}) {
  return {
    phase: "baseline_sdk",
    subdomain: "synthetic",
    key: "private-key",
    deadline: 180_000,
    now: () => 0,
    sleep: async () => {
      throw new Error("unexpected-sleep");
    },
    ...extra,
  };
}
test("public readiness uses one exact authenticated GET and accepts validated state without starting a Container", async () => {
  let calls = 0;
  const ready = await waitHttpReady(
    options({
      fetchImpl: async (url: string, init: RequestInit) => {
        calls++;
        expect(url).toBe("https://kogane-container-api-verification.synthetic.workers.dev/state");
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(init.cache).toBe("no-store");
        expect(init.headers).toEqual({ authorization: "Bearer private-key" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json(state());
      },
    }),
  );
  expect(calls).toBe(1);
  expect(ready).toEqual(state());
});
test("only bootstrap404/503 and strictly validated known old revisions retry within the same deadline", async () => {
  let clock = 170_000,
    calls = 0,
    canceled = 0;
  const sleeps: number[] = [];
  await waitHttpReady(
    options({
      phase: "native_recovered",
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetchImpl: async () => {
        calls++;
        if (calls <= 2)
          return new Response(
            new ReadableStream({
              cancel() {
                canceled++;
              },
            }),
            { status: calls === 1 ? 404 : 503 },
          );
        return Response.json(state(calls === 3 ? "baseline_sdk" : "native_recovered"));
      },
    }),
  );
  expect(calls).toBe(4);
  expect(canceled).toBe(2);
  expect(sleeps).toEqual([2000, 2000, 2000]);
  expect(clock).toBe(176_000);
});
test("rollback HTTP readiness requires the original SDK revision, while native phases require their exact marker", async () => {
  for (const phase of [
    "baseline_sdk",
    "native",
    "native_unmonitored",
    "native_recovered",
    "rollback_sdk",
  ]) {
    await waitHttpReady(
      options({
        phase,
        fetchImpl: async () =>
          Response.json(state(phase === "rollback_sdk" ? "baseline_sdk" : phase)),
      }),
    );
  }
});
test("auth, redirects and unexpected HTTP fail immediately without reading bodies or retrying", async () => {
  for (const [status, category] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [302, "redirect"],
    [500, "server_error"],
    [502, "bad_gateway"],
  ] as const) {
    let calls = 0,
      pulls = 0,
      canceled = 0;
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            pulls++;
          },
          cancel() {
            canceled++;
          },
        },
        { highWaterMark: 0 },
      ),
      { status },
    );
    await expect(
      waitHttpReady(
        options({
          fetchImpl: async () => {
            calls++;
            return response;
          },
        }),
      ),
    ).rejects.toThrow(`verification_http_state_outer_${category}`);
    expect(calls).toBe(1);
    expect(pulls).toBe(0);
    expect(canceled).toBe(1);
  }
});
test("marked 404 and 503 or malformed metadata fail readiness immediately", async () => {
  for (const [status, headers, code] of [
    [
      404,
      { "x-verification-failure": "worker_route_missing" },
      "verification_http_state_worker_route_missing",
    ],
    [
      503,
      { "x-verification-failure": "worker_revision_invalid" },
      "verification_http_state_worker_revision_invalid",
    ],
    [
      404,
      { "x-verification-failure": "worker_revision_invalid" },
      "verification_http_state_metadata_invalid",
    ],
    [
      503,
      { "x-verification-failure": "private-marker" },
      "verification_http_state_metadata_invalid",
    ],
    [404, { "x-verification-upstream-status": "503" }, "verification_http_state_metadata_invalid"],
  ] as const) {
    let calls = 0,
      canceled = 0,
      sleeps = 0;
    await expect(
      waitHttpReady(
        options({
          fetchImpl: async () => {
            calls++;
            return new Response(
              new ReadableStream(
                {
                  cancel() {
                    canceled++;
                  },
                },
                { highWaterMark: 0 },
              ),
              { status, headers },
            );
          },
          sleep: async () => {
            sleeps++;
          },
        }),
      ),
    ).rejects.toThrow(code);
    expect(calls).toBe(1);
    expect(canceled).toBe(1);
    expect(sleeps).toBe(0);
  }
});
test("unknown revisions, partial shapes, extra private fields and wrong counter types never become readiness", async () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...state(), revision: "private-provider-text" },
    { ...state(), running: true },
    { ...state(), errors: -1 },
    { ...state(), stops: "0" },
    { ...state(), sdkAlarmPresent: 2 },
    { ...state(), private: "private-provider-text" },
    { ...state("native"), startCallbacks: 0 },
    { ...state(), revision: "native" },
  ])
    await expect(
      waitHttpReady(options({ fetchImpl: async () => Response.json(invalid) })),
    ).rejects.toThrow("verification_state_schema");
});
test("an old revision with a malformed schema fails rather than waiting for its replacement", async () => {
  let calls = 0;
  await expect(
    waitHttpReady(
      options({
        phase: "native",
        fetchImpl: async () => {
          calls++;
          return Response.json({ ...state("baseline_sdk"), private: "private-provider-text" });
        },
      }),
    ),
  ).rejects.toThrow("verification_state_schema");
  expect(calls).toBe(1);
});
test("unending404 uses only the original remaining budget and clamps its final sleep", async () => {
  let clock = 175_500,
    calls = 0;
  const sleeps: number[] = [];
  await expect(
    waitHttpReady(
      options({
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
        fetchImpl: async () => {
          calls++;
          return new Response("private-provider-body", { status: 404 });
        },
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(clock).toBe(180_000);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([2000, 2000, 500]);
});
test("a200 received before deadline cannot pass if its body finishes after the deadline", async () => {
  let clock = 179_000;
  await expect(
    waitHttpReady(
      options({
        now: () => clock,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                clock = 180_001;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(state())));
                controller.close();
              },
            }),
          ),
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
});
test("successful headers do not release the hard remaining-budget timer for a stalled body", async () => {
  let canceled = 0,
    aborted = 0;
  const started = Date.now();
  await expect(
    waitHttpReady(
      options({
        now: Date.now,
        deadline: started + 100,
        fetchImpl: async (_url: string, init: RequestInit) => {
          init.signal!.addEventListener("abort", () => {
            aborted++;
          });
          return new Response(
            new ReadableStream(
              {
                cancel() {
                  canceled++;
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(canceled).toBe(1);
  expect(aborted).toBe(1);
});
test("a fetch ignoring AbortSignal still cannot escape the hard remaining-budget deadline", async () => {
  const started = Date.now();
  await expect(
    waitHttpReady(
      options({
        now: Date.now,
        deadline: started + 100,
        fetchImpl: async () => new Promise(() => {}),
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(Date.now() - started).toBeLessThan(1000);
});
test("body reads are bounded8KiB and never expose parse failures or provider messages", async () => {
  for (const body of ["private-provider-text", "x".repeat(8193)]) {
    await expect(
      waitHttpReady(options({ fetchImpl: async () => new Response(body) })),
    ).rejects.toThrow("verification_state_response");
  }
  await expect(
    waitHttpReady(
      options({
        fetchImpl: async () => {
          throw new Error("private-network-message");
        },
      }),
    ),
  ).rejects.toThrow("verification_state_transport");
  for (const code of ["inputs", "timeout", "transport", "response", "schema"]) {
    expect(canonicalDriverHttpCode(`verification_state_${code}`)).toBe(
      `verification_state_${code}`,
    );
    expect(canonicalDriverHttpCode(`verification_state_${code} private-text`)).toBeUndefined();
  }
});
test("unknown phase, endpoint selectors and expired or extended budgets fail before any HTTP request", async () => {
  let calls = 0;
  for (const invalid of [
    { phase: "unknown" },
    { subdomain: "other.invalid/path" },
    { subdomain: {} },
    { key: "" },
    { deadline: 180_001 },
    { deadline: NaN },
  ])
    await expect(
      waitHttpReady(
        options({
          ...invalid,
          fetchImpl: async () => {
            calls++;
            return Response.json(state());
          },
        }),
      ),
    ).rejects.toThrow("verification_state_inputs");
  await expect(
    waitHttpReady(
      options({
        deadline: 0,
        fetchImpl: async () => {
          calls++;
          return Response.json(state());
        },
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(calls).toBe(0);
});
