import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  fstatSync,
  linkSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
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
  verifyConcurrency,
  recoveryHold,
  baselineRecord,
  recoveryRecord,
  readRecord,
  writeRecord,
} from "../driver.mjs";
import { worker } from "../src/common";
import { canonicalHex, canonicalUuid, canonicalImageRef } from "../identifiers.mjs";
const appId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const namespace = "b".repeat(32);
const workerVersion = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const processIdentity = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const image = `registry.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/kogane-container-api-verification-verificationcontainer@sha256:${"e".repeat(64)}`;
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
    const first = await (await fetch(url + "/once", { method: "POST" })).json();
    const second = await (await fetch(url + "/once", { method: "POST" })).json();
    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);
    expect(canonicalUuid(first.processIdentity)).toBe(first.processIdentity);
    expect(second.processIdentity).toBe(first.processIdentity);
    const stats = await (await fetch(url + "/stats")).json();
    expect(stats.processIdentity).toBe(first.processIdentity);
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
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(temp, "container-api-verification-recovery.json"),
      JSON.stringify({ processIdentity }),
      { mode: 0o600 },
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
      { mode: 0o600 },
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

test("persisted identities are exact canonical records with no arbitrary network text", () => {
  const baseline = { ...identity(app, version), workerVersion };
  expect(baselineRecord(baseline, app.account_id)).toEqual(baseline);
  expect(recoveryRecord({ processIdentity })).toEqual({ processIdentity });
  expect(canonicalHex("f".repeat(64), 64)).toBe("f".repeat(64));
  expect(canonicalUuid(appId)).toBe(appId);
  expect(canonicalImageRef(image, app.account_id)).toBe(image);
  for (const value of [
    null,
    {},
    [],
    { ...baseline, provider: "untrusted" },
    { ...baseline, appId: "../other" },
    { ...baseline, namespace: "b".repeat(33) },
    { ...baseline, workerVersion: workerVersion.toUpperCase() },
    { ...baseline, image: image + "/payload" },
  ]) {
    expect(() => baselineRecord(value, app.account_id)).toThrow();
  }
  expect(() => canonicalImageRef(image, "f".repeat(32))).toThrow("verification_identity");
  for (const value of [
    null,
    {},
    { processIdentity, provider: "untrusted" },
    { processIdentity: { toString: () => processIdentity } },
    { processIdentity: "d".repeat(4096) },
  ])
    expect(() => recoveryRecord(value)).toThrow();
  for (const value of ["f".repeat(31), "F".repeat(32), "f".repeat(32) + "\n", {}, null])
    expect(() => canonicalHex(value, 32)).toThrow("verification_identity");
});

test("driver records create private exclusive600 files and preserve content on duplicate writes", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-records-"));
  const name = "container-api-verification-baseline.json";
  const baseline = baselineRecord({ ...identity(app, version), workerVersion }, app.account_id);
  try {
    writeRecord(temp, name, baseline);
    // Inspect the opened file, never check a pathname before opening it.
    const fd = openSync(resolve(temp, name), constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const metadata = fstatSync(fd);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
      expect(metadata.uid).toBe(process.getuid());
    } finally {
      closeSync(fd);
    }
    expect(readRecord(temp, name)).toEqual(baseline);
    expect(() => writeRecord(temp, name, baseline)).toThrow();
    expect(readRecord(temp, name)).toEqual(baseline);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject public-mode file fixtures", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-public-record-"));
  const name = "container-api-verification-baseline.json";
  try {
    writeFileSync(resolve(temp, name), "{}", { mode: 0o644, flag: "wx" });
    expect(() => readRecord(temp, name)).toThrow("verification_record");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject an independently created oversized file fixture", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-oversized-record-"));
  const name = "container-api-verification-baseline.json";
  try {
    writeFileSync(resolve(temp, name), "x".repeat(1025), { mode: 0o600, flag: "wx" });
    expect(() => readRecord(temp, name)).toThrow("verification_record");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject symlink fixtures without modifying their targets", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-symlink-record-"));
  const name = "container-api-verification-baseline.json";
  const baseline = baselineRecord({ ...identity(app, version), workerVersion }, app.account_id);
  const target = resolve(temp, "target");
  try {
    writeFileSync(target, JSON.stringify(baseline), { mode: 0o600, flag: "wx" });
    symlinkSync(target, resolve(temp, name));
    expect(() => readRecord(temp, name)).toThrow();
    expect(() => writeRecord(temp, name, baseline)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify(baseline));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject independent hardlink fixtures", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-hardlink-record-"));
  const name = "container-api-verification-baseline.json";
  const baseline = baselineRecord({ ...identity(app, version), workerVersion }, app.account_id);
  const target = resolve(temp, "target");
  try {
    writeFileSync(target, JSON.stringify(baseline), { mode: 0o600, flag: "wx" });
    linkSync(target, resolve(temp, name));
    expect(() => readRecord(temp, name)).toThrow("verification_record");
    expect(() => writeRecord(temp, name, baseline)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify(baseline));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject public directories before creating a record", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-public-directory-"));
  const name = "container-api-verification-baseline.json";
  const baseline = baselineRecord({ ...identity(app, version), workerVersion }, app.account_id);
  try {
    chmodSync(temp, 0o755);
    expect(() => writeRecord(temp, name, baseline)).toThrow("verification_record");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("driver records reject path escape and oversized output before creating a record", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "synthetic-invalid-record-"));
  const name = "container-api-verification-baseline.json";
  const baseline = baselineRecord({ ...identity(app, version), workerVersion }, app.account_id);
  try {
    expect(() => writeRecord(temp, "../outside.json", baseline)).toThrow("verification_record");
    expect(() => writeRecord(temp, name, { payload: "x".repeat(1025) })).toThrow(
      "verification_record",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("SDK concurrency measures accepted POSTs in one actual process rather than readiness callbacks", async () => {
  for (const phase of ["baseline_sdk", "rollback_sdk"]) {
    const calls: { path: string; method: string }[] = [];
    let states = 0;
    await verifyConcurrency({
      phase,
      json: async (path: string, method = "GET") => {
        calls.push({ path, method });
        if (path === "/state")
          return states++ === 0
            ? { running: 0, startCallbacks: 0 }
            : { running: 1, startCallbacks: 2 };
        if (path === "/once") return { accepted: 1, processIdentity };
        if (path === "/stats") return { posts: 2, processIdentity };
        throw new Error("unexpected");
      },
    });
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { path: "/once", method: "POST" },
      { path: "/once", method: "POST" },
    ]);
  }
});
test("native concurrency retains exactly one startup callback as well as the process/POST proof", async () => {
  for (const phase of ["native", "native_unmonitored"]) {
    let states = 0;
    await verifyConcurrency({
      phase,
      json: async (path: string) => {
        if (path === "/state")
          return states++ === 0 ? { running: 0, starts: 3 } : { running: 1, starts: 4 };
        if (path === "/once") return { accepted: 1, processIdentity };
        return { posts: 2, processIdentity };
      },
    });
  }
});
test("concurrency fails closed for extra/missing POSTs, changed process, wrong state or duplicate native startup", async () => {
  const cases = [
    { override: { posts: 3 }, code: "concurrency_posts" },
    { override: { posts: 1 }, code: "concurrency_posts" },
    { override: { accepted: 0 }, code: "concurrency_posts" },
    {
      override: { replyIdentity: "ffffffff-ffff-4fff-afff-ffffffffffff" },
      code: "concurrency_process",
    },
    { override: { statsIdentity: "provider-text" }, code: "concurrency_process" },
    { override: { replyIdentity: processIdentity.toUpperCase() }, code: "concurrency_process" },
    { override: { beforeRunning: 1 }, code: "concurrency_state" },
    { override: { afterRunning: 0 }, code: "concurrency_state" },
    { override: { afterStarts: 2 }, code: "concurrency_start" },
    { override: { beforeStarts: "0" }, code: "concurrency_start" },
  ];
  for (const { override, code } of cases) {
    const shape = {
      posts: 2,
      accepted: 1,
      replyIdentity: processIdentity,
      statsIdentity: processIdentity,
      beforeRunning: 0,
      afterRunning: 1,
      beforeStarts: 0,
      afterStarts: 1,
      ...override,
    };
    let states = 0,
      posts = 0;
    await expect(
      verifyConcurrency({
        phase: "native",
        json: async (path: string, method = "GET") => {
          if (method === "POST") posts++;
          if (path === "/state")
            return states++ === 0
              ? { running: shape.beforeRunning, starts: shape.beforeStarts }
              : { running: shape.afterRunning, starts: shape.afterStarts };
          if (path === "/once")
            return { accepted: shape.accepted, processIdentity: shape.replyIdentity };
          return { posts: shape.posts, processIdentity: shape.statsIdentity };
        },
      }),
    ).rejects.toThrow(`verification_${code}`);
    expect(posts).toBe(shape.beforeRunning === 0 ? 2 : 0);
  }
});

test("malformed concurrency state or stats remain classified closed errors", async () => {
  for (const malformed of ["before", "after", "stats"]) {
    let states = 0;
    await expect(
      verifyConcurrency({
        phase: "native",
        json: async (path: string) => {
          if (path === "/state") {
            if (states++ === 0) return malformed === "before" ? null : { running: 0, starts: 0 };
            return malformed === "after" ? null : { running: 1, starts: 1 };
          }
          if (path === "/once") return { accepted: 1, processIdentity };
          return malformed === "stats" ? null : { posts: 2, processIdentity };
        },
      }),
    ).rejects.toThrow(`verification_concurrency_${malformed === "stats" ? "posts" : "state"}`);
  }
});
