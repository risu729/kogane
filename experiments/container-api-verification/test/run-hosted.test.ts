import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  chmodSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  WORKER,
  APP,
  inputs,
  config,
  validateState,
  readProtected,
  driverReport,
  apiClient,
  apiHttpCode,
  wranglerArgs,
  preflight,
  namespaces,
  activeVersion,
  cleanup,
  execute,
  child,
  registryStatus,
  canonicalApiPath,
  privateDirectory,
  deleteRegistryTag,
  phaseCounts,
  waitMissing,
} from "../run-hosted.mjs";

const account = "a".repeat(32),
  sha = "b".repeat(40);
const appId = "11111111-1111-4111-8111-111111111111";
const workerVersion = "22222222-2222-4222-8222-222222222222";
const namespace = "c".repeat(32);
const image = `registry.cloudflare.com/${account}/${APP}@sha256:${"d".repeat(64)}`;
const token = "synthetic-test-token";
const source = JSON.parse(readFileSync(new URL("../wrangler.sdk.jsonc", import.meta.url), "utf8"));
const input = (temp = "/tmp/synthetic") => ({ account, sha, token, temp, subdomain: "synthetic" });
const state = () => ({
  account,
  sha,
  worker: WORKER,
  appName: APP,
  claimed: true,
  imagePreflightAbsent: true,
});
const protectedFile = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const app = () => ({
  id: appId,
  account_id: account,
  name: APP,
  scheduling_policy: "default",
  max_instances: 1,
  active_rollout_id: null,
  version: 1,
  constraints: { regions: ["APAC"] },
  durable_objects: { namespace_id: namespace },
  configuration: { vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 }, image },
});
const version = () => ({
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
});

test("dedicated inputs have no production fallback and enforce fixed shapes", () => {
  const env = {
    CONTAINER_VERIFICATION_ACCOUNT_ID: account,
    CONTAINER_VERIFICATION_API_TOKEN: token,
    CONTAINER_VERIFICATION_SUBDOMAIN: "synthetic",
    GITHUB_SHA: sha,
    RUNNER_TEMP: "/tmp",
    CONTAINER_VERIFICATION_TEMP: "/tmp/container-api-verification.Abcd1234",
  };
  expect(inputs(env)).toEqual(input("/tmp/container-api-verification.Abcd1234"));
  for (const name of Object.keys(env))
    expect(() => inputs({ ...env, [name]: "" })).toThrow(
      name === "CONTAINER_VERIFICATION_TEMP"
        ? "verification_runner_private_directory"
        : "verification_runner_inputs",
    );
  expect(() => inputs({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account })).toThrow();
  expect(() => inputs({ ...env, CONTAINER_VERIFICATION_SUBDOMAIN: "other.example.com" })).toThrow();
});

test("generated configs share immutable image and fixed resources; only native revision/monitor changes", () => {
  expect(config(source, { account, image, phase: "baseline_sdk" }).containers[0].image).toBe(image);
  const native = { ...source, main: "src/native.ts" };
  const value = config(native, { account, image, phase: "native_unmonitored" });
  expect(value.vars).toEqual({
    HARNESS_REVISION: "native_unmonitored",
    HARNESS_MONITOR: "disabled",
  });
  expect(value.account_id).toBe(account);
  expect(value.main).toEndWith("/src/native.ts");
  for (const changed of [
    { ...source, name: "production" },
    { ...source, vpc_services: [{}] },
    { ...source, containers: [{ ...source.containers[0], max_instances: 2 }] },
    { ...source, vars: { ...source.vars, BANK_TOKEN: "not-allowed" } },
    { ...source, migrations: [{ tag: "v2", deleted_classes: ["VerificationContainer"] }] },
  ])
    expect(() => config(changed, { account, image, phase: "baseline_sdk" })).toThrow(
      "verification_runner_config",
    );
  expect(() =>
    config(source, {
      account,
      image: "registry.cloudflare.com/other/image:latest",
      phase: "baseline_sdk",
    }),
  ).toThrow();
});

test("protected ownership rejects secrets, another run/account and symlinks", () => {
  expect(validateState(state(), input())).toEqual(state());
  for (const change of [
    { token },
    { account: "f".repeat(32) },
    { sha: "e".repeat(40) },
    { worker: "production" },
    { claimed: false },
    { namespace: "../other" },
    { appId: "not-an-id" },
  ])
    expect(() => validateState({ ...state(), ...change }, input())).toThrow(
      "verification_runner_state",
    );
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  try {
    const path = resolve(temp, "owned.json"),
      link = resolve(temp, "link.json");
    protectedFile(path, state());
    symlinkSync(path, link);
    expect(readProtected(path)).toEqual(state());
    expect(() => readProtected(link)).toThrow("verification_runner_state");
    expect(readProtected(resolve(temp, "missing.json"))).toBeUndefined();
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("driver output permits closed phase/counts only", () => {
  expect(
    driverReport(
      JSON.stringify({
        code: "verification_phase_complete",
        phase: "native",
        ...phaseCounts("native"),
        idleObservedMs: 1,
      }),
      "native",
    ).phases,
  ).toBe(1);
  for (const output of [
    "synthetic-secret",
    "{}",
    JSON.stringify({ code: "verification_phase_complete", phase: "native", provider: token }),
    JSON.stringify({ code: "verification_phase_complete", phase: "native", count: -1 }),
  ])
    expect(() => driverReport(output, "native")).toThrow("verification_runner_driver_output");
  expect(() =>
    driverReport(
      JSON.stringify({ code: "verification_phase_complete", phase: "native" }),
      "baseline_sdk",
    ),
  ).toThrow();
});

test("API never follows redirects and discards provider failures", async () => {
  let options: RequestInit | undefined,
    url = "";
  const api = apiClient(input(), async (target: string, opts: RequestInit) => {
    url = target;
    options = opts;
    return new Response(JSON.stringify({ success: true, result: [] }));
  });
  await api(`containers/applications?name=${APP}`);
  expect(url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications?name=${APP}`,
  );
  expect(options?.redirect).toBe("manual");
  expect(options?.headers).toEqual({ authorization: `Bearer ${token}` });
  for (const response of [
    new Response(token, { status: 302 }),
    new Response(token, { status: 403 }),
    new Response(token),
    new Response(JSON.stringify({ success: false, errors: [{ message: token }] })),
  ]) {
    const denied = apiClient(input(), async () => response);
    await expect(denied(`containers/applications?name=${APP}`)).rejects.toThrow(
      /verification_runner_api_(http|response)/u,
    );
  }
  expect(
    await apiClient(input(), async () => new Response("", { status: 404 }))(
      `workers/scripts/${WORKER}/settings`,
      {
        missing: true,
      },
    ),
  ).toBeUndefined();
});

test("registry preflight/readback uses memory-only five-minute pull credentials and exact fixed manifest", async () => {
  const calls: unknown[] = [];
  const api = async (path: string, options: unknown) => {
    calls.push([path, options]);
    return { result: { password: token } };
  };
  const result = await registryStatus(input(), api, async (url: string, opts: RequestInit) => {
    expect(url).toBe(`https://registry.cloudflare.com/v2/${account}/${APP}/manifests/${sha}`);
    expect(opts.redirect).toBe("manual");
    return new Response("", { status: 404 });
  });
  expect(result).toBeUndefined();
  expect(calls).toEqual([
    [
      "containers/registries/registry.cloudflare.com/credentials",
      { method: "POST", body: { expiration_minutes: 5, permissions: ["pull"] } },
    ],
  ]);
  await expect(
    registryStatus(input(), api, async () => new Response(token, { status: 302 })),
  ).rejects.toThrow("verification_runner_registry_http");
});

test("blank Worker preflight refuses existing app/namespace/image or secret; no writes", async () => {
  for (const occupied of ["app", "namespace", "image", "secret"]) {
    const api = async (path: string) => {
      if (path.endsWith("/settings"))
        return {
          result: {
            bindings: occupied === "secret" ? [{ type: "secret_text", name: "HARNESS_KEY" }] : [],
          },
        };
      if (path.startsWith("workers/durable_objects"))
        return {
          result:
            occupied === "namespace"
              ? [{ id: namespace, script: WORKER, class: "VerificationContainer" }]
              : [],
        };
      if (path.startsWith("containers/applications"))
        return { result: occupied === "app" ? [app()] : [] };
      throw new Error("unexpected mutation");
    };
    await expect(
      preflight(input(), api, async () => (occupied === "image" ? image : undefined)),
    ).rejects.toThrow(/verification_runner_(preexisting|worker_not_blank)/u);
  }
});

test("namespace pages cannot hide occupied fixed namespaces; malformed pages reject", async () => {
  let calls = 0;
  const entries = Array.from({ length: 100 }, () => ({
    id: namespace,
    script: "other",
    class: "Other",
  }));
  expect(
    await namespaces(async () => ({
      result:
        ++calls === 1
          ? entries
          : [{ id: namespace, script: WORKER, class: "VerificationContainer" }],
      info: { total_pages: 2 },
    })),
  ).toHaveLength(1);
  expect(calls).toBe(2);
  await expect(
    namespaces(async () => ({ result: [{ id: namespace, class: "missing-script" }] })),
  ).rejects.toThrow("verification_runner_namespaces");
});

test("allocation must be one exact UUID at 100 percent", async () => {
  for (const versions of [
    [],
    [{ version_id: workerVersion, percentage: 99 }],
    [{ version_id: "invalid", percentage: 100 }],
    [
      { version_id: workerVersion, percentage: 100 },
      { version_id: appId, percentage: 0 },
    ],
  ])
    await expect(
      activeVersion(async () => ({ result: { deployments: [{ versions }] } })),
    ).rejects.toThrow("verification_runner_allocation");
});

test("cleanup without an ownership claim performs no remote operation", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  try {
    const outputs: string[] = [];
    await cleanup(input(temp), {
      api: async () => {
        throw new Error("remote forbidden");
      },
      report: (text: string) => outputs.push(text),
    });
    expect(outputs).toEqual([
      JSON.stringify({ code: "verification_cleanup_unclaimed", resources: 0 }),
    ]);
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("cleanup refuses changed application and protected state leaves resource IDs for diagnosis", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  try {
    protectedFile(resolve(temp, "container-api-verification-owned.json"), {
      ...state(),
      appId,
      namespace,
      image,
    });
    const calls: string[] = [];
    await expect(
      cleanup(input(temp), {
        api: async (path: string, options?: { method?: string }) => {
          calls.push(options?.method ?? "GET");
          return {
            result: path.startsWith("containers/")
              ? [{ ...app(), id: workerVersion }]
              : [{ id: namespace, script: WORKER, class: "VerificationContainer" }],
          };
        },
        report: () => {},
      }),
    ).rejects.toThrow("verification_runner_cleanup_identity");
    expect(calls.every((method) => method === "GET")).toBe(true);
    expect(readProtected(resolve(temp, "container-api-verification-owned.json")).appId).toBe(appId);
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("orchestration builds once, pushes one exact tag, secret via stdin, all phases, exact baseline rollback, and cleanup", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  let deployed = false,
    secret = false,
    removed = false,
    pushed = false,
    imageRemoved = false;
  const calls: Array<[string, string[], Record<string, any>]> = [],
    reports: string[] = [];
  const api = async (path: string, options: { method?: string; missing?: boolean } = {}) => {
    if (options.method === "DELETE") {
      removed = true;
      return { result: {} };
    }
    if (path.endsWith("/settings"))
      return removed && options.missing
        ? undefined
        : {
            result: {
              bindings: deployed
                ? [
                    {
                      type: "durable_object_namespace",
                      name: "HARNESS",
                      class_name: "VerificationContainer",
                    },
                  ]
                : secret
                  ? [{ type: "secret_text", name: "HARNESS_KEY" }]
                  : [],
            },
          };
    if (path.startsWith("workers/durable_objects/namespaces/")) return undefined;
    if (path.startsWith("workers/durable_objects"))
      return {
        result:
          deployed && !removed
            ? [{ id: namespace, script: WORKER, class: "VerificationContainer" }]
            : [],
      };
    if (path === `containers/applications/${appId}/versions`)
      return { result: [{ version: 1, percentage: 100, configuration: { image } }] };
    if (path === `containers/applications/${appId}`) return removed ? undefined : { result: app() };
    if (path.startsWith("containers/applications?"))
      return { result: deployed && !removed ? [app()] : [] };
    if (path.endsWith("/deployments"))
      return {
        result: { deployments: [{ versions: [{ version_id: workerVersion, percentage: 100 }] }] },
      };
    if (path.includes("/versions/")) return { result: version() };
    throw new Error("unhandled path");
  };
  try {
    await execute(input(temp), {
      api,
      registry: async () => (pushed && !imageRemoved ? image : undefined),
      deleteImage: async (owned: string) => {
        expect(owned).toBe(image);
        imageRemoved = true;
      },
      report: (text: string) => reports.push(text),
      hold: async () => ({ stop: async () => {} }),
      run: async (command: string, args: string[], options: Record<string, any>) => {
        calls.push([command, args, options]);
        if (args.includes("push")) pushed = true;
        if (args.includes("secret")) {
          secret = true;
          expect(options.stdin).toMatch(/^[A-Za-z0-9_-]{43}\n$/u);
        }
        if (args.includes("deploy")) deployed = true;
        if (args.includes("delete")) throw new Error("child deletion is forbidden");
        if (command === "node" && args[0].endsWith("/driver.mjs")) {
          const phase = options.env.HARNESS_PHASE;
          if (phase === "baseline_sdk")
            protectedFile(resolve(temp, "container-api-verification-baseline.json"), {
              appId,
              namespace,
              image,
              workerVersion,
            });
          return JSON.stringify({
            code: "verification_phase_complete",
            phase,
            ...phaseCounts(phase),
            ...(phase === "native_recovered" ? {} : { idleObservedMs: 1 }),
          });
        }
        return "";
      },
    });
    expect(calls.filter(([command]) => command === "docker")).toHaveLength(1);
    expect(calls.some(([, args]) => args.includes("delete"))).toBe(false);
    const cliCalls = calls.filter(([, args]) => args[0] === wranglerArgs()[0]);
    expect(cliCalls).toHaveLength(8); // push, secret, four deploys, exact rollback and namespace teardown
    for (const [command, args] of cliCalls) {
      expect(command).toBe("node");
      expect(args).toEqual(wranglerArgs(...args.slice(1)));
    }
    expect(calls.some(([command]) => command === "bun")).toBe(false);
    expect(calls.filter(([, args]) => args.includes("push"))[0]?.[1]).toContain(`${APP}:${sha}`);
    expect(calls.filter(([, args]) => args.includes("rollback"))[0]?.[1]).toContain(workerVersion);
    expect(
      calls
        .filter(([command, args]) => command === "node" && args[0].endsWith("/driver.mjs"))
        .map(([, , options]) => options.env.HARNESS_PHASE),
    ).toEqual(["baseline_sdk", "native", "native_unmonitored", "native_recovered", "rollback_sdk"]);
    expect(reports.some((text) => text.includes(token))).toBe(false);
    const saved = readProtected(resolve(temp, "container-api-verification-owned.json"));
    expect(saved.completed).toBe(true);
    expect(saved.cleaned).toBe(true);
    expect(Object.keys(saved)).not.toContain("key");
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("captured child stderr never reaches errors/output and redirects cannot inject shell commands", async () => {
  await expect(
    child("node", ["-e", "console.error('synthetic-secret'); process.exit(1)"], {
      env: { PATH: process.env.PATH },
      timeout: 1000,
    }),
  ).rejects.toThrow("verification_runner_child");
  expect(
    await child("node", ["-e", "process.stdout.write(process.argv[1])", "$("], {
      env: { PATH: process.env.PATH },
      timeout: 1000,
    }),
  ).toBe("$(");
});

test("asynchronous deletion requires readback404 within deadline and clamps each call/sleep", async () => {
  let time = 0,
    calls = 0;
  await waitMissing(
    async (_path: string, options: { timeout: number }) => {
      expect(options.timeout).toBeLessThanOrEqual(5000 - time);
      return ++calls < 3 ? { result: { message: "pending" } } : undefined;
    },
    "fixed",
    {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      duration: 5000,
    },
  );
  expect(calls).toBe(3);
  time = 0;
  await expect(
    waitMissing(async () => ({ result: {} }), "fixed", {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      duration: 5000,
    }),
  ).rejects.toThrow("verification_runner_cleanup_timeout");
  expect(time).toBe(5000);
});

test("only exact public Worker DELETE accepts a successful empty body", async () => {
  const api = apiClient(input(), async () => new Response(null, { status: 204 }));
  expect(await api(`workers/scripts/${WORKER}?force=false`, { method: "DELETE" })).toEqual({
    result: null,
  });
  await expect(api(`containers/applications/${appId}`, { method: "DELETE" })).rejects.toThrow(
    "verification_runner_api_response",
  );
});

test("missing or zeroed phase checks cannot produce runtime success", () => {
  const good = {
    code: "verification_phase_complete",
    phase: "native",
    ...phaseCounts("native"),
    idleObservedMs: 0,
  };
  for (const name of Object.keys(phaseCounts("native"))) {
    const bad = { ...good, [name]: 7 };
    expect(() => driverReport(JSON.stringify(bad), "native")).toThrow(
      "verification_runner_driver_output",
    );
    delete (bad as Record<string, unknown>)[name];
    expect(() => driverReport(JSON.stringify(bad), "native")).toThrow(
      "verification_runner_driver_output",
    );
  }
  expect(() => driverReport(JSON.stringify({ ...good, surprise: 1 }), "native")).toThrow();
});

import { EventEmitter } from "node:events";
import { recoveryHolder } from "../run-hosted.mjs";

test("cleanup deletes the exact app, explicit synthetic class, Worker, then image with separate readbacks", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  let appExists = true,
    namespaceExists = true,
    workerExists = true,
    imageExists = true;
  const steps: string[] = [];
  try {
    protectedFile(resolve(temp, "container-api-verification-owned.json"), {
      ...state(),
      appId,
      namespace,
      image,
      imageAttempted: true,
    });
    await cleanup(input(temp), {
      api: async (path: string, options: { method?: string; missing?: boolean } = {}) => {
        if (options.method === "DELETE") {
          if (path === `containers/applications/${appId}`) {
            steps.push("app_delete");
            appExists = false;
          } else if (path === `workers/scripts/${WORKER}?force=false`) {
            expect(namespaceExists).toBe(false);
            steps.push("worker_delete");
            workerExists = false;
          } else throw new Error("unexpected deletion");
          return { result: { message: "accepted" } };
        }
        if (path.startsWith("containers/applications?"))
          return { result: appExists ? [app()] : [] };
        if (path === `containers/applications/${appId}`) {
          if (!appExists) steps.push("app_404");
          return appExists ? { result: app() } : undefined;
        }
        if (path.endsWith("/settings")) {
          if (!workerExists) {
            steps.push("worker_404");
            return undefined;
          }
          return {
            result: {
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: "HARNESS",
                  class_name: "VerificationContainer",
                },
              ],
            },
          };
        }
        if (path === `workers/durable_objects/namespaces/${namespace}/objects`) {
          if (!namespaceExists) steps.push("namespace_404");
          return namespaceExists ? { result: [] } : undefined;
        }
        return {
          result: namespaceExists
            ? [{ id: namespace, script: WORKER, class: "VerificationContainer" }]
            : [],
        };
      },
      deleteImage: async (owned: string) => {
        expect(owned).toBe(image);
        expect(workerExists).toBe(false);
        expect(namespaceExists).toBe(false);
        steps.push("image_delete");
        imageExists = false;
      },
      registry: async () => {
        if (!imageExists) steps.push("image_404");
        return imageExists ? image : undefined;
      },
      run: async (command: string, args: string[]) => {
        expect(command).toBe("node");
        expect(args[0]).toBe(wranglerArgs()[0]);
        if (args[1] === "deploy") {
          expect(appExists).toBe(false);
          expect(workerExists).toBe(true);
          const path = args[args.indexOf("--config") + 1];
          const teardown = readProtected(path);
          expect(teardown.name).toBe(WORKER);
          expect(teardown.account_id).toBe(account);
          expect(teardown.migrations).toEqual([
            { tag: "v1", new_sqlite_classes: ["VerificationContainer"] },
            { tag: "v2", deleted_classes: ["VerificationContainer"] },
          ]);
          expect(teardown.containers).toBeUndefined();
          expect(teardown.durable_objects).toBeUndefined();
          expect(teardown.workers_dev).toBe(false);
          const code = readFileSync(teardown.main, "utf8");
          expect(code).not.toContain("VerificationContainer");
          expect(code).not.toContain(token);
          steps.push("namespace_teardown");
          namespaceExists = false;
        } else {
          throw new Error("only fixed namespace teardown child is permitted");
        }
        return "";
      },
      report: () => {},
    });
    expect(steps).toEqual([
      "app_delete",
      "app_404",
      "namespace_teardown",
      "namespace_404",
      "worker_delete",
      "worker_404",
      "image_delete",
      "image_404",
    ]);
    expect(readProtected(resolve(temp, "container-api-verification-owned.json")).cleaned).toBe(
      true,
    );
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test("teardown failure leaves ownership evidence and never claims cleanup or deletes Worker/image", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  let appExists = true;
  const methods: string[] = [],
    output: string[] = [];
  try {
    protectedFile(resolve(temp, "container-api-verification-owned.json"), {
      ...state(),
      appId,
      namespace,
      image,
      imageAttempted: true,
    });
    await expect(
      cleanup(input(temp), {
        api: async (path: string, options: { method?: string } = {}) => {
          if (options.method === "DELETE") {
            methods.push(path);
            appExists = false;
            return { result: {} };
          }
          if (path.startsWith("containers/applications?"))
            return { result: appExists ? [app()] : [] };
          if (path === `containers/applications/${appId}`)
            return appExists ? { result: app() } : undefined;
          if (path.endsWith("/settings")) return { result: { bindings: [] } };
          return { result: [{ id: namespace, script: WORKER, class: "VerificationContainer" }] };
        },
        registry: async () => image,
        run: async () => {
          throw new Error("verification_runner_child");
        },
        report: (text: string) => output.push(text),
      }),
    ).rejects.toThrow("verification_runner_child");
    expect(methods).toEqual([`containers/applications/${appId}`]);
    expect(output).toHaveLength(0);
    expect(
      readProtected(resolve(temp, "container-api-verification-owned.json")).cleaned,
    ).toBeUndefined();
  } finally {
    rmSync(temp, { recursive: true });
  }
});

function fakeHolder(lines: Array<string | number>) {
  const process = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let killed = false;
  const options = {
    spawnImpl: () => {
      setTimeout(() => {
        for (const line of lines) {
          if (typeof line === "number") {
            process.emit("close", line);
            break;
          }
          process.stdout.emit("data", Buffer.from(line + "\n"));
        }
      }, 0);
      return process;
    },
    signalImpl: () => {
      killed = true;
      process.emit("close", 0);
    },
  };
  return { options, process, killed: () => killed };
}

test("holder rejects exit before opening; invalid or duplicate markers after opening remain failures", async () => {
  const open = JSON.stringify({ code: "verification_recovery_stream_open", streams: 1 });
  await expect(recoveryHolder({}, fakeHolder([0]).options)).rejects.toThrow(
    "verification_runner_recovery",
  );
  for (const bad of [
    "synthetic-secret",
    "null",
    open,
    JSON.stringify({
      code: "verification_recovery_stream_disconnected",
      streams: 1,
      provider: token,
    }),
  ]) {
    const fake = fakeHolder([open, bad]);
    const holder = await recoveryHolder({}, fake.options);
    await expect(holder.stop()).rejects.toThrow("verification_runner_recovery");
    expect(fake.killed()).toBe(true);
  }
});

test("holder tolerates a clean post-open disconnect only; recovery verification remains separate", async () => {
  const fake = fakeHolder([
    JSON.stringify({ code: "verification_recovery_stream_open", streams: 1 }),
    JSON.stringify({ code: "verification_recovery_stream_disconnected", streams: 1 }),
    0,
  ]);
  const holder = await recoveryHolder({}, fake.options);
  await holder.stop();
  expect(fake.killed()).toBe(false);
});

test("tag-only deletion uses one fixed URL, digest proof, five-minute pull+push credentials, and GET404", async () => {
  const calls: Array<[string, string]> = [],
    credentials: unknown[] = [];
  let time = 0,
    cancelled = 0;
  await deleteRegistryTag(input(), image, {
    api: async (path: string, body: unknown) => {
      credentials.push([path, body]);
      return { result: { password: token } };
    },
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    fetchImpl: async (url: string, options: RequestInit) => {
      expect(options.redirect).toBe("manual");
      expect((options.headers as Record<string, string>).authorization).toStartWith("Basic ");
      calls.push([url, options.method!]);
      const status = calls.length === 2 ? 202 : calls.length === 4 ? 404 : 200;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          status,
          headers: { "docker-content-digest": image.split("@")[1]! },
        },
      );
    },
  });
  expect(credentials).toEqual([
    [
      "containers/registries/registry.cloudflare.com/credentials",
      { method: "POST", body: { expiration_minutes: 5, permissions: ["pull", "push"] } },
    ],
  ]);
  const url = `https://registry.cloudflare.com/v2/${account}/${APP}/manifests/${sha}`;
  expect(calls).toEqual([
    [url, "GET"],
    [url, "DELETE"],
    [url, "GET"],
    [url, "GET"],
  ]);
  expect(cancelled).toBe(4);
  expect(calls.every(([target, method]) => !target.includes("/gc/") && method !== "PUT")).toBe(
    true,
  );
});

test("tag deletion refuses redirects, missing/changed digests and malformed credentials before DELETE", async () => {
  for (const credentials of [
    null,
    {},
    { password: "" },
    { password: 1 },
    { password: "bad\ncredential" },
  ]) {
    let requests = 0;
    await expect(
      deleteRegistryTag(input(), image, {
        api: async () => ({ result: credentials }),
        fetchImpl: async () => {
          requests++;
          throw new Error("must not reach registry");
        },
      }),
    ).rejects.toThrow("verification_runner_registry_credentials");
    expect(requests).toBe(0);
  }
  for (const response of [
    new Response("", { status: 302, headers: { location: "https://untrusted.invalid/" } }),
    new Response("", { status: 200 }),
    new Response("", {
      status: 200,
      headers: { "docker-content-digest": `sha256:${"e".repeat(64)}` },
    }),
  ]) {
    const methods: string[] = [];
    await expect(
      deleteRegistryTag(input(), image, {
        api: async () => ({ result: { password: token } }),
        fetchImpl: async (_url: string, options: RequestInit) => {
          methods.push(options.method!);
          return response;
        },
      }),
    ).rejects.toThrow(/verification_runner_registry_(http|digest|identity)/u);
    expect(methods).toEqual(["GET"]);
  }
});

test("redirects or changed tags during deletion/readback stay failures with no unrelated endpoint", async () => {
  for (const badStage of ["delete_redirect", "readback_redirect", "readback_identity"]) {
    let requests = 0;
    const methods: string[] = [];
    await expect(
      deleteRegistryTag(input(), image, {
        api: async () => ({ result: { password: token } }),
        fetchImpl: async (_url: string, options: RequestInit) => {
          methods.push(options.method!);
          requests++;
          if (
            (requests === 2 && badStage === "delete_redirect") ||
            (requests === 3 && badStage === "readback_redirect")
          )
            return new Response("", { status: 302 });
          return new Response(requests === 2 ? null : "", {
            status: requests === 2 ? 204 : 200,
            headers: {
              "docker-content-digest": `sha256:${(requests === 3 ? "e" : "d").repeat(64)}`,
            },
          });
        },
      }),
    ).rejects.toThrow(/verification_runner_registry_(http|identity)/u);
    expect(methods).toEqual(
      badStage === "delete_redirect" ? ["GET", "DELETE"] : ["GET", "DELETE", "GET"],
    );
  }
});

test("partial push deletion requires prior exact-tag absence claim and persists a validated digest before DELETE", async () => {
  for (const proof of ["valid", "missing_preflight", "invalid_digest", "changed_digest"]) {
    const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
    let removed = false,
      deletes = 0,
      calls = 0;
    try {
      const value: Record<string, unknown> = { ...state(), imageAttempted: true };
      if (proof === "missing_preflight") delete value.imagePreflightAbsent;
      if (proof === "changed_digest") value.image = image;
      protectedFile(resolve(temp, "container-api-verification-owned.json"), value);
      const task = cleanup(input(temp), {
        api: async (path: string) => {
          calls++;
          if (path.endsWith("/settings")) return undefined;
          return { result: [] };
        },
        registry: async () =>
          removed
            ? undefined
            : proof === "invalid_digest"
              ? "unvalidated"
              : proof === "changed_digest"
                ? image.replace("d".repeat(64), "e".repeat(64))
                : image,
        deleteImage: async (owned: string) => {
          deletes++;
          const stored = readProtected(resolve(temp, "container-api-verification-owned.json"));
          expect(stored.imagePreflightAbsent).toBe(true);
          expect(stored.imageAttempted).toBe(true);
          expect(stored.image).toBe(image);
          expect(owned).toBe(image);
          removed = true;
        },
        report: () => {},
      });
      if (proof === "valid") {
        await task;
        expect(deletes).toBe(1);
        expect(readProtected(resolve(temp, "container-api-verification-owned.json")).cleaned).toBe(
          true,
        );
      } else {
        await expect(task).rejects.toThrow(
          proof === "missing_preflight"
            ? "verification_runner_state"
            : "verification_runner_cleanup_image_identity",
        );
        expect(deletes).toBe(0);
        if (proof === "missing_preflight") expect(calls).toBe(0);
        expect(
          readProtected(resolve(temp, "container-api-verification-owned.json")).cleaned,
        ).toBeUndefined();
      }
    } finally {
      rmSync(temp, { recursive: true });
    }
  }
});

test("private state storage rejects public or symlink parents and multiply linked files before API", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  const sibling = mkdtempSync(resolve(tmpdir(), "verification-test-"));
  try {
    const path = resolve(temp, "owned.json");
    protectedFile(path, state());
    linkSync(path, resolve(sibling, "outside.json"));
    expect(() => readProtected(path)).toThrow("verification_runner_state");
    expect(readFileSync(resolve(sibling, "outside.json"), "utf8")).toBe(JSON.stringify(state()));
    chmodSync(temp, 0o755);
    expect(() => privateDirectory(temp)).toThrow("verification_runner_private_directory");
    let requests = 0;
    await expect(
      execute(input(temp), {
        api: async () => {
          requests++;
          throw new Error("forbidden");
        },
      }),
    ).rejects.toThrow("verification_runner_private_directory");
    expect(requests).toBe(0);
    chmodSync(temp, 0o700);
    const symbolic = resolve(sibling, "private-link");
    symlinkSync(temp, symbolic);
    expect(() => privateDirectory(symbolic)).toThrow("verification_runner_private_directory");
  } finally {
    rmSync(temp, { recursive: true });
    rmSync(sibling, { recursive: true });
  }
});

test("private directory selection requires explicit runner handoff and direct random child boundary", () => {
  const env = {
    CONTAINER_VERIFICATION_ACCOUNT_ID: account,
    CONTAINER_VERIFICATION_API_TOKEN: token,
    CONTAINER_VERIFICATION_SUBDOMAIN: "synthetic",
    GITHUB_SHA: sha,
    RUNNER_TEMP: "/tmp",
  };
  expect(() => inputs(env)).toThrow("verification_runner_private_directory");
  expect(inputs(env, { tempFixture: "/tmp/explicit-fixture" }).temp).toBe("/tmp/explicit-fixture");
  for (const temp of [
    "/tmp",
    "/other/container-api-verification.Abcd1234",
    "/tmp/container-api-verification.Abcd1234/../escape",
    "/tmp/container-api-verification.fixed",
  ])
    expect(() => inputs({ ...env, CONTAINER_VERIFICATION_TEMP: temp })).toThrow(
      "verification_runner_private_directory",
    );
});

test("outbound selectors admit only fixed Worker and canonical synthetic application/namespace identifiers", async () => {
  expect(canonicalApiPath(`containers/applications/${appId}`, "DELETE")).toBe(
    `containers/applications/${appId}`,
  );
  expect(canonicalApiPath(`workers/durable_objects/namespaces/${namespace}/objects`)).toBe(
    `workers/durable_objects/namespaces/${namespace}/objects`,
  );
  expect(canonicalApiPath(`workers/scripts/${WORKER}/versions/${workerVersion}`)).toBe(
    `workers/scripts/${WORKER}/versions/${workerVersion}`,
  );
  const bad = [
    "https://untrusted.invalid/",
    "../secrets",
    "workers/scripts/production/settings",
    `workers/durable_objects/namespaces/${namespace}/objects?redirect=foreign`,
    "workers/durable_objects/namespaces?per_page=100&page=101",
    `containers/applications/${appId}/../other`,
    `containers/applications/${appId}?foreign`,
    `workers/scripts/${WORKER}/versions/${workerVersion}%2fother`,
  ];
  let requests = 0;
  const api = apiClient(input(), async () => {
    requests++;
    return new Response("");
  });
  for (const path of bad) await expect(api(path)).rejects.toThrow();
  await expect(
    api(`containers/applications/${appId}/versions`, { method: "DELETE" }),
  ).rejects.toThrow("verification_runner_api_selector");
  expect(requests).toBe(0);
});

test("owned state is projected into canonical primitives instead of retaining parsed response objects", () => {
  const source = { ...state(), appId, namespace, image, workerVersion, imageAttempted: true };
  const projected = validateState(source, input());
  expect(projected).toEqual(source);
  expect(projected).not.toBe(source);
  source.appId = workerVersion;
  expect(projected.appId).toBe(appId);
});

test("workflow mktemp handoff round-trips through GITHUB_ENV to a separate cleanup process without network", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "verification runner "));
  const githubEnv = resolve(parent, "github env");
  const workflow = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const block = workflow.match(
    /      - name: Verify the synthetic runtime and exact SDK rollback\n[\s\S]*?        run: \|\n([\s\S]*?)        env:/u,
  )?.[1];
  expect(block).toBeDefined();
  const lines = block!
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(10));
  expect(lines.pop()).toBe(
    "mise exec -- node experiments/container-api-verification/run-hosted.mjs",
  );
  const env = {
    PATH: process.env.PATH!,
    RUNNER_TEMP: parent,
    GITHUB_ENV: githubEnv,
    CONTAINER_VERIFICATION_ACCOUNT_ID: account,
    CONTAINER_VERIFICATION_API_TOKEN: token,
    CONTAINER_VERIFICATION_SUBDOMAIN: "synthetic",
    GITHUB_SHA: sha,
  };
  try {
    const selected = execFileSync(
      "bash",
      ["-eu", "-c", [...lines, 'printf "%s" "$CONTAINER_VERIFICATION_TEMP"'].join("\n")],
      { env, encoding: "utf8", timeout: 5000 },
    );
    const handoff = readFileSync(githubEnv, "utf8");
    expect(handoff).toBe(`CONTAINER_VERIFICATION_TEMP=${selected}\n`);
    expect(inputs({ ...env, CONTAINER_VERIFICATION_TEMP: selected }).temp).toBe(selected);
    expect(privateDirectory(selected)).toBe(selected);
    // A distinct process consumes exactly the environment entry the Actions runner forwards.
    // Importing the helpers performs no network calls or cleanup/deployment operations.
    const moduleUrl = new URL("../run-hosted.mjs", import.meta.url).href;
    const probe = `import { inputs, privateDirectory } from ${JSON.stringify(moduleUrl)};
globalThis.fetch = () => { throw new Error("network_forbidden"); };
process.stdout.write(privateDirectory(inputs(process.env).temp));`;
    const forwarded = Object.fromEntries(
      handoff
        .trimEnd()
        .split("\n")
        .map((line) => {
          const equals = line.indexOf("=");
          return [line.slice(0, equals), line.slice(equals + 1)];
        }),
    );
    expect(
      execFileSync("node", ["--input-type=module", "-e", probe], {
        env: { ...env, ...forwarded },
        encoding: "utf8",
        timeout: 5000,
      }),
    ).toBe(selected);
    expect(() => inputs(env)).toThrow("verification_runner_private_directory");
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("API HTTP diagnostics expose only fixed endpoint and status categories without reading provider data", async () => {
  const endpoints: Array<[string, string, string]> = [
    [`workers/scripts/${WORKER}/settings`, "GET", "settings"],
    ["workers/durable_objects/namespaces?per_page=100&page=1", "GET", "namespaces"],
    [`containers/applications?name=${APP}`, "GET", "applications"],
    ["containers/registries/registry.cloudflare.com/credentials", "POST", "registry_credentials"],
    [`workers/scripts/${WORKER}/deployments`, "GET", "deployments"],
    [`workers/scripts/${WORKER}/versions/${workerVersion}`, "GET", "worker_version"],
    [`containers/applications/${appId}/versions`, "GET", "application_versions"],
    [`workers/durable_objects/namespaces/${namespace}/objects`, "GET", "namespace_objects"],
    [`containers/applications/${appId}`, "DELETE", "applications"],
    [`workers/scripts/${WORKER}?force=false`, "DELETE", "worker_delete"],
  ];
  const statuses: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limit"],
    [500, "server"],
    [599, "server"],
    [302, "redirect"],
    [400, "default"],
  ];
  let providerReads = 0;
  for (const [path, method, endpoint] of endpoints) {
    for (const [status, category] of statuses) {
      let requests = 0;
      const response = {
        status,
        ok: false,
        get headers() {
          providerReads++;
          throw new Error(token);
        },
        async text() {
          providerReads++;
          throw new Error(token);
        },
        async json() {
          providerReads++;
          throw new Error(token);
        },
      } as unknown as Response;
      const api = apiClient(input(), async (_url: string, options: RequestInit) => {
        requests++;
        expect(options.redirect).toBe("manual");
        return response;
      });
      let message = "";
      try {
        await api(path, { method });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`verification_runner_api_http_${endpoint}_${category}`);
      expect(message).toMatch(/^verification_(?:runner_)?[a-z_]+$/u);
      for (const privateValue of [
        token,
        account,
        appId,
        namespace,
        workerVersion,
        WORKER,
        APP,
        "https://",
        path,
      ])
        expect(message).not.toContain(privateValue);
      expect(requests).toBe(1);
    }
  }
  expect(providerReads).toBe(0);
});

test("unknown endpoint diagnostics stay generic and allowed missing404 remains silent", async () => {
  for (const selector of [
    null,
    {},
    token,
    "https://foreign.invalid/" + account,
    `workers/scripts/${WORKER}/settings?provider=${token}`,
  ])
    expect(apiHttpCode(selector, 403)).toBe("api_http");
  expect(apiHttpCode(`workers/scripts/${WORKER}/settings`, token)).toBe(
    "api_http_settings_default",
  );
  const absent = apiClient(
    input(),
    async () =>
      ({
        status: 404,
        ok: false,
        text: () => {
          throw new Error(token);
        },
        json: () => {
          throw new Error(token);
        },
      }) as unknown as Response,
  );
  expect(await absent(`workers/scripts/${WORKER}/settings`, { missing: true })).toBeUndefined();
});

test("real pinned Wrangler receives each production subcommand and positional argv without a shell or remote access", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "verification-cli-"));
  try {
    const installed = JSON.parse(
      readFileSync(new URL("../node_modules/wrangler/package.json", import.meta.url), "utf8"),
    );
    const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(installed.version).toBe(declared.devDependencies.wrangler);
    const blockNetwork = resolve(temp, "block-network.cjs");
    writeFileSync(
      blockNetwork,
      `const blocked = () => { throw new Error("test_network_forbidden"); };
globalThis.fetch = blocked;
for (const moduleName of ["node:http", "node:https"]) {
  const transport = require(moduleName);
  transport.request = blocked;
  transport.get = blocked;
}
`,
      { mode: 0o600, flag: "wx" },
    );
    const env = {
      PATH: process.env.PATH!,
      HOME: temp,
      XDG_CONFIG_HOME: temp,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      NODE_OPTIONS: `--require=${blockNetwork}`,
    };
    const cases: Array<[string[], string]> = [
      [["containers", "push", `${APP}:${sha}`], "wrangler containers push <TAG>"],
      [["secret", "put", "HARNESS_KEY"], "wrangler secret put <key>"],
      [["deploy"], "wrangler deploy [path]"],
      [["rollback", workerVersion, "--yes"], "wrangler rollback [version-id]"],
    ];
    for (const [args, usage] of cases) {
      const output = await child(
        "node",
        wranglerArgs(
          ...args,
          "--config",
          new URL("../wrangler.sdk.jsonc", import.meta.url).pathname,
          "--help",
        ),
        {
          env,
          stdin: "synthetic-stdin\n",
          timeout: 10000,
        },
      );
      expect(output).toContain(usage);
      expect(output).not.toContain("synthetic-stdin");
    }
    // An invalid subcommand reaches Wrangler's parser and fails rather than succeeding with generic help.
    await expect(
      child("node", wranglerArgs("containers", "verification_unknown"), { env, timeout: 10000 }),
    ).rejects.toThrow("verification_runner_child");
  } finally {
    rmSync(temp, { recursive: true });
  }
}, 60000);
