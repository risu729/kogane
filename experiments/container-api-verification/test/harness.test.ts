import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  syntheticServer,
  BACKPRESSURE_CHUNK_BYTES,
  BACKPRESSURE_MAX_CHUNKS,
} from "../container/server.mjs";
import {
  identity,
  sameIdentity,
  verifyPhase,
  verifyBackpressure,
  recoveryHold,
} from "../driver.mjs";
import { worker } from "../src/common";
const appId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const namespace = "b".repeat(32);
const workerVersion = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const processIdentity = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const image = `registry.cloudflare.com/synthetic/kogane-container-api-verification-verificationcontainer@sha256:${"e".repeat(64)}`;
const app = {
  id: appId,
  account_id: "a".repeat(32),
  version: 1,
  active_rollout_id: null,
  name: "kogane-container-api-verification-verificationcontainer",
  scheduling_policy: "default",
  configuration: { image, vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } },
  max_instances: 1,
  constraints: { regions: ["APAC"] },
  durable_objects: { namespace_id: namespace },
};
const version = {
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

test("synthetic local TCP server only serves fixed counters; no outbound request", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: syntheticServer() });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(url + "/health")).json()).toEqual({ ready: 1 });
    expect(await (await fetch(url + "/once", { method: "POST" })).json()).toEqual({ accepted: 1 });
    expect(await (await fetch(url + "/once", { method: "POST" })).json()).toEqual({ accepted: 1 });
    const stats = await (await fetch(url + "/stats")).json();
    expect(stats.posts).toBe(2);
    expect(stats.streams).toBe(0);
    expect(stats.processIdentity).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await fetch(url + "/unknown")).status).toBe(404);
  } finally {
    server.stop(true);
  }
});
test("Worker auth and route guard prevent unauthenticated DO lookup and strip credentials", async () => {
  let lookups = 0;
  const env = {
    HARNESS_KEY: "synthetic-secret",
    HARNESS_REVISION: "native",
    HARNESS_MONITOR: "enabled",
    HARNESS: {
      idFromName: (name: string) => {
        expect(name).toBe("synthetic-fixed-object-v1");
        lookups++;
        return name;
      },
      get: () => ({
        fetch: async (request: Request) => {
          expect([...request.headers]).toEqual([]);
          expect(request.body).toBeNull();
          return Response.json({ accepted: 1 });
        },
      }),
    },
  };
  const service = worker();
  expect(
    (await service.fetch(new Request("https://synthetic/once", { method: "POST" }), env as never))
      .status,
  ).toBe(401);
  expect(lookups).toBe(0);
  const authorized = { method: "POST", headers: { authorization: "Bearer synthetic-secret" } };
  expect(
    (await service.fetch(new Request("https://synthetic/unknown", authorized), env as never))
      .status,
  ).toBe(404);
  expect(lookups).toBe(0);
  expect(
    (await service.fetch(new Request("https://synthetic/once", authorized), env as never)).status,
  ).toBe(200);
  expect(lookups).toBe(1);
  expect(
    (
      await service.fetch(new Request("https://synthetic/once", authorized), {
        ...env,
        HARNESS_KEY: "",
      } as never)
    ).status,
  ).toBe(401);
});
test("identity requires exact synthetic class, namespace, policy/resources and immutable image", () => {
  const snapshot = identity(app, version);
  expect(sameIdentity(snapshot, { ...snapshot })).toBe(true);
  expect(sameIdentity(snapshot, { ...snapshot, namespace: "f".repeat(32) })).toBe(false);
  for (const bad of [
    { ...app, name: "existing-collector" },
    { ...app, max_instances: 2 },
    { ...app, scheduling_policy: "durable_object" },
    { ...app, configuration: { ...app.configuration, vcpu: "0.25" } },
    { ...app, configuration: { ...app.configuration, image: "https://arbitrary.invalid/image" } },
  ])
    expect(() => identity(bad, version)).toThrow("verification_identity");
  expect(() => identity(app, { resources: { bindings: [] } })).toThrow("verification_identity");
});
test("native recovery validates persisted process and control-plane identity without mutating", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-harness-"));
  try {
    writeFileSync(
      resolve(temp, "container-api-verification-baseline.json"),
      JSON.stringify({ ...identity(app, version), workerVersion }),
    );
    writeFileSync(
      resolve(temp, "container-api-verification-recovery.json"),
      JSON.stringify({ processIdentity }),
    );
    const reports: string[] = [];
    const fetchImpl = async (input: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      const url = new URL(input);
      if (url.host === "kogane-container-api-verification.synthetic.workers.dev") {
        expect(init.headers).toEqual({ authorization: "Bearer private-harness-key" });
        if (url.pathname === "/state")
          return Response.json({
            revision: "native_recovered",
            running: 1,
            kvSentinelMatch: 1,
            sqlSentinelMatch: 1,
          });
        if (url.pathname === "/stats") return Response.json({ processIdentity, streams: 0 });
        throw new Error("unexpected");
      }
      expect(url.host).toBe("api.cloudflare.com");
      expect(init.headers).toEqual({ authorization: "Bearer private-api-token" });
      const result =
        url.pathname.includes("/containers/") && url.pathname.endsWith("/versions")
          ? [{ version: 1, percentage: 100, configuration: { image } }]
          : url.pathname.includes("/containers/")
            ? app
            : url.pathname.endsWith("/deployments")
              ? { deployments: [{ versions: [{ version_id: workerVersion, percentage: 100 }] }] }
              : version;
      return Response.json({ success: true, result });
    };
    const counts = await verifyPhase({
      phase: "native_recovered",
      temp,
      subdomain: "synthetic",
      key: "private-harness-key",
      accountId: "a".repeat(32),
      apiToken: "private-api-token",
      appId,
      fetchImpl,
      report: (value: string) => reports.push(value),
    });
    expect(counts.recoveryChecks).toBe(1);
    expect(counts.identityMatches).toBe(1);
    expect(counts.sentinelMatches).toBe(1);
    expect(JSON.stringify(reports)).not.toContain("private-");
    expect(JSON.stringify(reports)).not.toContain(namespace);
    expect(JSON.stringify(reports)).not.toContain(processIdentity);
    const ledger = resolve(temp, "container-api-verification-recovery.json");
    rmSync(ledger);
    symlinkSync(resolve(temp, "container-api-verification-baseline.json"), ledger);
    await expect(
      verifyPhase({
        phase: "native_recovered",
        temp,
        subdomain: "synthetic",
        key: "key",
        accountId: "a".repeat(32),
        apiToken: "key",
        appId,
        fetchImpl: async (input: string) =>
          fetchImpl(input, {
            method: "GET",
            redirect: "manual",
            headers:
              new URL(input).host === "api.cloudflare.com"
                ? { authorization: "Bearer private-api-token" }
                : { authorization: "Bearer private-harness-key" },
          }),
        report: () => {},
      }),
    ).rejects.toThrow("verification_recovery_baseline");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("config variants preserve namespace/app/image history and contain no bank/VPC/secret", () => {
  const sdk = JSON.parse(readFileSync(new URL("../wrangler.sdk.jsonc", import.meta.url), "utf8"));
  const native = JSON.parse(
    readFileSync(new URL("../wrangler.native.jsonc", import.meta.url), "utf8"),
  );
  for (const key of ["name", "containers", "durable_objects", "migrations"])
    expect(native[key]).toEqual(sdk[key]);
  expect(native.vpc_networks).toBeUndefined();
  expect(sdk.vpc_networks).toBeUndefined();
  expect(native.vars.HARNESS_KEY).toBeUndefined();
  expect(sdk.vars.HARNESS_KEY).toBeUndefined();
  expect(native.containers[0].instance_type).toBe("basic");
});
test("driver rejects unknown endpoint selectors before any request", async () => {
  let calls = 0;
  await expect(
    verifyPhase({
      phase: "native",
      temp: "/tmp",
      subdomain: "evil.invalid/path",
      key: "key",
      accountId: "a".repeat(32),
      apiToken: "key",
      appId,
      fetchImpl: async () => {
        calls++;
        throw new Error("unexpected");
      },
    }),
  ).rejects.toThrow("verification_inputs");
  expect(calls).toBe(0);
});

test("rollback requires exact baseline SDK Worker version before any application mutation", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-rollback-"));
  try {
    writeFileSync(
      resolve(temp, "container-api-verification-baseline.json"),
      JSON.stringify({ ...identity(app, version), workerVersion }),
    );
    let posts = 0;
    await expect(
      verifyPhase({
        phase: "rollback_sdk",
        temp,
        subdomain: "synthetic",
        key: "private-key",
        accountId: "a".repeat(32),
        apiToken: "private-token",
        appId,
        report: () => {},
        fetchImpl: async (input: string, init: RequestInit) => {
          if (init.method !== "GET") posts++;
          const url = new URL(input);
          if (url.host.endsWith(".workers.dev"))
            return Response.json({
              revision: "baseline_sdk",
              running: 0,
              kvSentinelMatch: 1,
              sqlSentinelMatch: 1,
            });
          const result = url.pathname.includes("/containers/")
            ? url.pathname.endsWith("/versions")
              ? [{ version: 1, percentage: 100, configuration: { image } }]
              : app
            : url.pathname.endsWith("/deployments")
              ? {
                  deployments: [
                    {
                      versions: [
                        { version_id: "ffffffff-ffff-4fff-afff-ffffffffffff", percentage: 100 },
                      ],
                    },
                  ],
                }
              : version;
          return Response.json({ success: true, result });
        },
      }),
    ).rejects.toThrow("verification_rollback_version");
    expect(posts).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Worker discards SDK error response text and headers", async () => {
  let canceled = 0;
  const upstream = new ReadableStream({
    cancel() {
      canceled++;
    },
  });
  const response = await worker().fetch(
    new Request("https://synthetic/once", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-key" },
    }),
    {
      HARNESS_KEY: "synthetic-key",
      HARNESS_REVISION: "baseline_sdk",
      HARNESS_MONITOR: "enabled",
      HARNESS: {
        idFromName: () => "synthetic",
        get: () => ({
          fetch: async () =>
            new Response(upstream, {
              status: 500,
              headers: { "x-provider-detail": "synthetic-private" },
            }),
        }),
      },
    } as never,
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ code: "operation_failed" });
  expect(response.headers.has("x-provider-detail")).toBe(false);
  expect(canceled).toBe(1);
});

test("unpaced synthetic source stalls behind a paused reader and releases on cancellation", async () => {
  const serve = syntheticServer();
  const reader = (await serve(new Request("http://synthetic/backpressure"))).body!.getReader();
  try {
    expect((await reader.read()).value!.byteLength).toBe(BACKPRESSURE_CHUNK_BYTES);
    await Bun.sleep(1);
    const stats = async () => (await serve(new Request("http://synthetic/stats"))).json();
    const before = await stats();
    expect(before.streams).toBe(1);
    expect(before.backpressureChunks).toBeGreaterThan(0);
    expect(before.backpressureChunks).toBeLessThan(BACKPRESSURE_MAX_CHUNKS);
    await Bun.sleep(1);
    expect((await stats()).backpressureChunks).toBe(before.backpressureChunks);
  } finally {
    await reader.cancel();
  }
  expect((await (await serve(new Request("http://synthetic/stats"))).json()).streams).toBe(0);
});
test("backpressure verification requires a real elapsed idle window, stable process and stalled source", async () => {
  const stable = { processIdentity, posts: 2, streams: 1, backpressureChunks: 32 };
  for (const scenario of ["valid", "ended", "restarted", "moving", "too_short"]) {
    let calls = 0,
      time = 0,
      canceled = false;
    const counts = [
      stable,
      stable,
      {
        ...stable,
        ...(scenario === "ended"
          ? { streams: 0, backpressureChunks: BACKPRESSURE_MAX_CHUNKS }
          : {}),
        ...(scenario === "restarted"
          ? { processIdentity: "ffffffff-ffff-4fff-afff-ffffffffffff" }
          : {}),
        ...(scenario === "moving" ? { backpressureChunks: 33 } : {}),
      },
    ];
    const result = verifyBackpressure({
      request: async (path: string) => {
        expect(path).toBe("/backpressure");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              canceled = true;
            },
          }),
        );
      },
      json: async (path: string) => {
        expect(path).toBe("/stats");
        return counts[calls++];
      },
      wait: async (ms: number) => {
        if (scenario !== "too_short") time += ms;
      },
      now: () => time,
    });
    if (scenario === "valid") await result;
    else await expect(result).rejects.toThrow("verification_backpressure");
    expect(canceled).toBe(true);
  }
});

test("recovery hold fails closed when HTTP fails before a stream-open marker", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-hold-"));
  const reports: string[] = [];
  try {
    await expect(
      recoveryHold({
        temp,
        subdomain: "synthetic",
        key: "synthetic-key",
        report: (value: string) => reports.push(value),
        fetchImpl: async (input: string) =>
          new URL(input).pathname === "/stats"
            ? Response.json({ processIdentity })
            : new Response("provider failure must not appear", { status: 500 }),
      }),
    ).rejects.toThrow("verification_hold");
    expect(reports).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
