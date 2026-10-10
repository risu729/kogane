import { expect, test } from "bun:test";
import { waitHttpReady, httpReadyTimeoutFailureRecord } from "../http-readiness.mjs";
import { writeRecord, readRecord } from "../driver.mjs";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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

test("timeout retains only the last completed classified response without changing polling or sleeping", async () => {
  for (const [phase, kind, revision, response] of [
    ["native", "unmarked_404", "none", () => new Response("private", { status: 404 })],
    ["native", "unmarked_503", "none", () => new Response("private", { status: 503 })],
    ["native", "validated_old_revision", "baseline_sdk", () => Response.json(state())],
    [
      "rollback_sdk",
      "validated_old_revision",
      "native_recovered",
      () => Response.json(state("native_recovered")),
    ],
  ] as const) {
    let clock = 175_500,
      calls = 0;
    const sleeps: number[] = [],
      observations: unknown[] = [];
    await expect(
      waitHttpReady(
        options({
          phase,
          now: () => clock,
          fetchImpl: async () => {
            calls++;
            return response();
          },
          sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
          },
          onTimeout: (value: unknown) => observations.push(value),
        }),
      ),
    ).rejects.toThrow("verification_state_timeout");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000, 2000, 500]);
    expect(clock).toBe(180_000);
    expect(observations).toEqual([
      {
        code: "http_ready_timeout_observation",
        phase,
        lastCompletedResponse: kind,
        observedRevision: revision,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("private");
  }
});
test("success and non-timeout failures never observe, and an expired initial budget reports none without fetching", async () => {
  let observed = 0,
    calls = 0;
  await waitHttpReady(
    options({ fetchImpl: async () => Response.json(state()), onTimeout: () => observed++ }),
  );
  await expect(
    waitHttpReady(
      options({
        fetchImpl: async () => Response.json({ ...state(), private: "private" }),
        onTimeout: () => observed++,
      }),
    ),
  ).rejects.toThrow("verification_state_schema");
  expect(observed).toBe(0);
  const values: unknown[] = [];
  await expect(
    waitHttpReady(
      options({
        deadline: 0,
        fetchImpl: async () => {
          calls++;
          return Response.json(state());
        },
        onTimeout: (value: unknown) => values.push(value),
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(calls).toBe(0);
  expect(values).toEqual([
    {
      code: "http_ready_timeout_observation",
      phase: "baseline_sdk",
      lastCompletedResponse: "none",
      observedRevision: "none",
    },
  ]);
});
test("a pending request records none or the earlier completed response and never guesses the pending result", async () => {
  for (const earlier of [false, true]) {
    const started = Date.now(),
      values: unknown[] = [];
    let calls = 0;
    await expect(
      waitHttpReady(
        options({
          now: Date.now,
          deadline: started + 100,
          sleep: async () => {},
          fetchImpl: async () => {
            calls++;
            if (earlier && calls === 1) return new Response("private", { status: 503 });
            return new Promise(() => {});
          },
          onTimeout: (value: unknown) => values.push(value),
        }),
      ),
    ).rejects.toThrow("verification_state_timeout");
    expect(calls).toBe(earlier ? 2 : 1);
    expect(values).toEqual([
      {
        code: "http_ready_timeout_observation",
        phase: "baseline_sdk",
        lastCompletedResponse: earlier ? "unmarked_503" : "none",
        observedRevision: "none",
      },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
  }
});
test("a late body cannot overwrite the last completed response or change acceptance", async () => {
  let clock = 178_000,
    calls = 0;
  const values: unknown[] = [];
  await expect(
    waitHttpReady(
      options({
        phase: "native",
        now: () => clock,
        sleep: async () => {
          clock = 179_000;
        },
        fetchImpl: async () => {
          calls++;
          if (calls === 1) return Response.json(state());
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  clock = 180_001;
                  controller.enqueue(new TextEncoder().encode(JSON.stringify(state("native"))));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
        onTimeout: (value: unknown) => values.push(value),
      }),
    ),
  ).rejects.toThrow("verification_state_timeout");
  expect(calls).toBe(2);
  expect(values).toEqual([
    {
      code: "http_ready_timeout_observation",
      phase: "native",
      lastCompletedResponse: "validated_old_revision",
      observedRevision: "baseline_sdk",
    },
  ]);
});
test("record validation rejects extra data, unknown enums, and inconsistent classification/revision pairs", () => {
  const base = {
    code: "http_ready_timeout_observation",
    phase: "native",
    lastCompletedResponse: "validated_old_revision",
    observedRevision: "baseline_sdk",
  };
  expect(httpReadyTimeoutFailureRecord(base)).toEqual(base);
  for (const invalid of [
    null,
    [],
    {},
    { ...base, private: "private" },
    { ...base, code: "other" },
    { ...base, phase: "private" },
    { ...base, lastCompletedResponse: "other" },
    { ...base, observedRevision: "private" },
    { ...base, observedRevision: "native" },
    { ...base, observedRevision: "none" },
    ...["none", "unmarked_404", "unmarked_503"].map((lastCompletedResponse) => ({
      ...base,
      lastCompletedResponse,
    })),
    { ...base, phase: "rollback_sdk", observedRevision: "baseline_sdk" },
  ])
    expect(() => httpReadyTimeoutFailureRecord(invalid)).toThrow("verification_state_observation");
});
test("synchronous observer errors preserve the original error object and cause", async () => {
  const cause = new Error("private"),
    primary = new Error("verification_state_timeout", { cause });
  let observed = 0,
    caught: unknown;
  try {
    await waitHttpReady(
      options({
        fetchImpl: async () => new Response("", { status: 404 }),
        sleep: async () => {
          throw primary;
        },
        onTimeout: () => {
          observed++;
          throw new Error("private-write-error");
        },
      }),
    );
  } catch (error) {
    caught = error;
  }
  expect(observed).toBe(1);
  expect(caught).toBe(primary);
  expect((caught as Error).cause).toBe(cause);
});
test("the private timeout record preserves its first writer and never overwrites a symlink target", async () => {
  const name = "container-api-verification-http-ready-timeout-failure.json";
  for (const mode of ["record", "symlink", "invalid"] as const) {
    const temp = mkdtempSync(resolve(tmpdir(), "http-ready-timeout-"));
    const target = resolve(temp, "target");
    const first = {
      code: "http_ready_timeout_observation",
      phase: "native",
      lastCompletedResponse: "unmarked_404",
      observedRevision: "none",
    };
    try {
      if (mode === "record") writeRecord(temp, name, first);
      if (mode === "symlink") {
        writeFileSync(target, "private");
        symlinkSync(target, resolve(temp, name));
      }
      await expect(
        waitHttpReady(
          options({
            deadline: 0,
            onTimeout: (value: unknown) =>
              writeRecord(
                temp,
                name,
                httpReadyTimeoutFailureRecord(
                  mode === "invalid" ? { ...(value as object), private: "private" } : value,
                ),
              ),
          }),
        ),
      ).rejects.toThrow("verification_state_timeout");
      if (mode === "record") expect(readRecord(temp, name)).toEqual(first);
      if (mode === "symlink") expect(readFileSync(target, "utf8")).toBe("private");
      if (mode === "invalid") expect(existsSync(resolve(temp, name))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});
