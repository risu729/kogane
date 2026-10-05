// Dedicated, explicitly approved synthetic environment only. No production configuration is read.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { identity } from "./driver.mjs";

export const WORKER = "kogane-container-api-verification";
export const APP = `${WORKER}-verificationcontainer`;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const fail = (code) => {
  throw new Error(`verification_runner_${code}`);
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const root = dirname(fileURLToPath(import.meta.url));

export function inputs(env) {
  const account = env.CONTAINER_VERIFICATION_ACCOUNT_ID;
  const token = env.CONTAINER_VERIFICATION_API_TOKEN;
  const subdomain = env.CONTAINER_VERIFICATION_SUBDOMAIN;
  if (
    !HEX.test(account ?? "") ||
    !token ||
    !/^[a-z0-9-]+$/u.test(subdomain ?? "") ||
    !SHA.test(env.GITHUB_SHA ?? "") ||
    !env.RUNNER_TEMP
  )
    fail("inputs");
  return { account, token, subdomain, sha: env.GITHUB_SHA, temp: resolve(env.RUNNER_TEMP) };
}

export function config(source, { account, image, phase }) {
  const sdk = phase === "baseline_sdk";
  const expected = {
    name: APP,
    class_name: "VerificationContainer",
    image: "./Dockerfile",
    max_instances: 1,
    instance_type: "basic",
    scheduling_policy: "default",
    constraints: { regions: ["APAC"] },
  };
  if (
    source.name !== WORKER ||
    source.main !== (sdk ? "src/sdk.ts" : "src/native.ts") ||
    JSON.stringify(source.containers) !== JSON.stringify([expected]) ||
    JSON.stringify(source.durable_objects) !==
      JSON.stringify({ bindings: [{ name: "HARNESS", class_name: "VerificationContainer" }] }) ||
    JSON.stringify(source.migrations) !==
      JSON.stringify([{ tag: "v1", new_sqlite_classes: ["VerificationContainer"] }]) ||
    source.workers_dev !== true ||
    source.preview_urls !== false ||
    Object.keys(source.vars ?? {})
      .sort()
      .join(",") !== "HARNESS_MONITOR,HARNESS_REVISION" ||
    !["baseline_sdk", "native", "native_unmonitored", "native_recovered"].includes(phase) ||
    !HEX.test(account) ||
    !new RegExp(`^registry\\.cloudflare\\.com/${account}/${APP}@sha256:[a-f0-9]{64}$`, "u").test(
      image,
    )
  )
    fail("config");
  const allowed = [
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    "vars",
    "containers",
    "durable_objects",
    "migrations",
  ];
  if (Object.keys(source).some((name) => !allowed.includes(name))) fail("config");
  const result = structuredClone(source);
  delete result.$schema;
  result.account_id = account;
  result.main = resolve(root, source.main);
  result.containers[0].image = image;
  result.vars = {
    HARNESS_REVISION: phase,
    HARNESS_MONITOR: phase === "native_unmonitored" ? "disabled" : "enabled",
  };
  return result;
}

export function readProtected(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) fail("state");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("state");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeProtected(path, value, initial = false, raw = false) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        (initial ? constants.O_EXCL : constants.O_TRUNC),
      0o600,
    );
    if (!fstatSync(fd).isFile() || (fstatSync(fd).mode & 0o777) !== 0o600) fail("state");
    writeFileSync(fd, raw ? value : JSON.stringify(value));
  } catch {
    fail("state");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validateState(state, input) {
  const allowed = [
    "account",
    "sha",
    "worker",
    "appName",
    "appId",
    "namespace",
    "image",
    "workerVersion",
    "claimed",
    "imageAttempted",
    "completed",
    "cleaned",
  ];
  if (
    !state ||
    Object.keys(state).some((key) => !allowed.includes(key)) ||
    state.account !== input.account ||
    state.sha !== input.sha ||
    state.worker !== WORKER ||
    state.appName !== APP ||
    state.claimed !== true ||
    (state.appId !== undefined && !UUID.test(state.appId)) ||
    (state.namespace !== undefined && !HEX.test(state.namespace)) ||
    (state.workerVersion !== undefined && !UUID.test(state.workerVersion)) ||
    (state.image !== undefined &&
      !new RegExp(
        `^registry\\.cloudflare\\.com/${input.account}/${APP}@sha256:[a-f0-9]{64}$`,
        "u",
      ).test(state.image)) ||
    ["imageAttempted", "completed", "cleaned"].some(
      (key) => state[key] !== undefined && typeof state[key] !== "boolean",
    )
  )
    fail("state");
  return state;
}

// Retain closed driver codes and numeric counts only; arbitrary child text is never forwarded.
export function phaseCounts(phase) {
  const recovered = phase === "native_recovered";
  const counts = { phases: 1, identityMatches: 1, sentinelMatches: 1 };
  for (const key of [
    "concurrencyChecks",
    "longDelayChecks",
    "longStreamChecks",
    "backpressureChecks",
    "cancelChecks",
    "streamFailureChecks",
    "idleChecks",
    "destroyRestartChecks",
    "signalChecks",
    "nonzeroExitChecks",
  ])
    counts[key] = recovered ? 0 : 1;
  counts.recoveryChecks = recovered ? 1 : 0;
  counts.sdkAlarmChecks = ["baseline_sdk", "rollback_sdk"].includes(phase) ? 1 : 0;
  return counts;
}
export function driverReport(text, phase) {
  let item;
  try {
    item = JSON.parse(text);
  } catch {
    fail("driver_output");
  }
  const expected = phaseCounts(phase);
  const keys = [
    "code",
    "phase",
    ...Object.keys(expected),
    ...(phase === "native_recovered" ? [] : ["idleObservedMs"]),
  ];
  if (
    !["baseline_sdk", "native", "native_unmonitored", "native_recovered", "rollback_sdk"].includes(
      phase,
    ) ||
    item?.code !== "verification_phase_complete" ||
    item.phase !== phase ||
    Object.keys(item).sort().join(",") !== keys.sort().join(",") ||
    Object.entries(expected).some(([name, value]) => item[name] !== value) ||
    (phase !== "native_recovered" &&
      (!Number.isSafeInteger(item.idleObservedMs) || item.idleObservedMs < 0))
  )
    fail("driver_output");
  return item;
}

export function child(
  command,
  args,
  { cwd = root, env, stdin = "", timeout = 600000, onLine } = {},
) {
  return new Promise((done, reject) => {
    const process = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "",
      pending = "",
      bytes = 0,
      timedOut = false,
      badOutput = false;
    const kill = (signal) => {
      try {
        globalThis.process.kill(-process.pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    const interrupted = () => {
      timedOut = true;
      kill("SIGTERM");
    };
    globalThis.process.once("SIGTERM", interrupted);
    globalThis.process.once("SIGINT", interrupted);
    const detach = () => {
      globalThis.process.removeListener("SIGTERM", interrupted);
      globalThis.process.removeListener("SIGINT", interrupted);
    };
    const timer = setTimeout(interrupted, timeout);
    const hardTimer = setTimeout(() => kill("SIGKILL"), timeout + 5000);
    process.on("error", () => {
      detach();
      clearTimeout(timer);
      clearTimeout(hardTimer);
      reject(new Error("verification_runner_child"));
    });
    process.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        badOutput = true;
        kill("SIGTERM");
        return;
      }
      if (onLine) {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          try {
            onLine(line);
          } catch {
            badOutput = true;
            kill("SIGTERM");
          }
        }
      } else output += chunk.toString();
    });
    // Capture/discard stderr. It can contain arbitrary provider text or credentials.
    process.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        badOutput = true;
        kill("SIGTERM");
      }
    });
    process.stdin.on("error", () => {});
    process.stdin.end(stdin);
    process.on("close", (code) => {
      detach();
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (code !== 0 || timedOut || badOutput) reject(new Error("verification_runner_child"));
      else done(output);
    });
  });
}

export function apiClient(input, fetchImpl = fetch) {
  return async (path, { method = "GET", body, missing = false, timeout = 30000 } = {}) => {
    const headers = { authorization: `Bearer ${input.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${input.account}/${path}`,
        {
          method,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(30000, Math.max(1, timeout))),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      fail("api_transport");
    }
    if (missing && response.status === 404) return undefined;
    if (!response.ok || response.status >= 300) fail("api_http");
    // The public scripts DELETE explicitly returns no successful response body.
    if (method === "DELETE" && path === `workers/scripts/${WORKER}?force=false`) {
      const text = await response.text();
      if (!text.trim()) return { result: null };
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        fail("api_response");
      }
      if (body?.success !== true) fail("api_response");
      return { result: body.result ?? null };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      fail("api_response");
    }
    if (data?.success !== true || data.result === undefined) fail("api_response");
    return { result: data.result, info: data.result_info };
  };
}

export async function namespaces(api) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`workers/durable_objects/namespaces?per_page=100&page=${page}`);
    if (!Array.isArray(data.result)) fail("namespaces");
    for (const entry of data.result) {
      if (
        !entry ||
        !HEX.test(entry.id ?? "") ||
        typeof entry.script !== "string" ||
        typeof entry.class !== "string"
      )
        fail("namespaces");
      if (entry.script === WORKER) result.push(entry);
    }
    const pages = data.info?.total_pages;
    if (pages !== undefined && (!Number.isSafeInteger(pages) || pages < page)) fail("namespaces");
    if (pages === page || (pages === undefined && data.result.length < 100)) return result;
  }
  fail("namespaces");
}

export async function application(api, required = false) {
  const data = await api(`containers/applications?name=${APP}`);
  if (
    data.info?.next_page_token ||
    !Array.isArray(data.result) ||
    data.result.some((app) => app.name !== APP || !UUID.test(app.id ?? "")) ||
    data.result.length > 1 ||
    (required && data.result.length !== 1)
  )
    fail("application");
  return data.result[0];
}

export async function activeVersion(api) {
  const deployed = (await api(`workers/scripts/${WORKER}/deployments`)).result.deployments?.[0]
    ?.versions;
  if (
    !Array.isArray(deployed) ||
    deployed.length !== 1 ||
    deployed[0].percentage !== 100 ||
    !UUID.test(deployed[0].version_id ?? "")
  )
    fail("allocation");
  const id = deployed[0].version_id;
  return { id, version: (await api(`workers/scripts/${WORKER}/versions/${id}`)).result };
}

export async function registryStatus(input, api, fetchImpl = fetch) {
  const credentials = (
    await api("containers/registries/registry.cloudflare.com/credentials", {
      method: "POST",
      body: { expiration_minutes: 5, permissions: ["pull"] },
    })
  ).result;
  if (typeof credentials?.password !== "string" || !credentials.password)
    fail("registry_credentials");
  let response;
  try {
    response = await fetchImpl(
      `https://registry.cloudflare.com/v2/${input.account}/${APP}/manifests/${input.sha}`,
      {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
        headers: {
          authorization: `Basic ${Buffer.from(`v1:${credentials.password}`).toString("base64")}`,
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
  } catch {
    fail("registry_transport");
  }
  if (response.status !== 200 && response.status !== 404) fail("registry_http");
  if (response.status === 404) return undefined;
  const digest = response.headers.get("docker-content-digest");
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? "")) fail("registry_digest");
  return `registry.cloudflare.com/${input.account}/${APP}@${digest}`;
}

// Application deletion is asynchronous. Success requires the subsequent GET404.
export async function waitMissing(
  api,
  path,
  { now = Date.now, sleep = pause, duration = 180000 } = {},
) {
  const deadline = now() + duration;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) fail("cleanup_timeout");
    if ((await api(path, { missing: true, timeout: remaining })) === undefined) return;
    const rest = deadline - now();
    if (rest <= 0) fail("cleanup_timeout");
    await sleep(Math.min(2000, rest));
  }
}

export async function waitReady(api, image, { now = Date.now, sleep = pause } = {}) {
  const deadline = now() + 180000;
  while (true) {
    if (now() >= deadline) fail("rollout_timeout");
    const app = await application(api, true);
    const active = await activeVersion(api);
    const current = identity(app, active.version);
    if (current.image !== image) fail("deployment_identity");
    const versions = (await api(`containers/applications/${app.id}/versions`)).result;
    if (
      !Array.isArray(versions) ||
      !Number.isSafeInteger(app.version) ||
      versions.some(
        (entry) =>
          !Number.isSafeInteger(entry.percentage) || entry.percentage < 0 || entry.percentage > 100,
      )
    )
      fail("rollout");
    if (
      app.active_rollout_id == null &&
      versions.filter(
        (entry) =>
          entry.version === app.version &&
          entry.percentage === 100 &&
          entry.configuration?.image === image,
      ).length === 1 &&
      versions.every((entry) => entry.version === app.version || entry.percentage === 0)
    )
      return current;
    const remaining = deadline - now();
    if (remaining <= 0) fail("rollout_timeout");
    await sleep(Math.min(2000, remaining));
  }
}

export async function preflight(input, api, registry) {
  const settings = (await api(`workers/scripts/${WORKER}/settings`)).result;
  if (
    !Array.isArray(settings?.bindings) ||
    settings.bindings.length !== 0 ||
    (settings.migration_tag !== undefined && settings.migration_tag !== "")
  )
    fail("worker_not_blank");
  if ((await namespaces(api)).length !== 0 || (await application(api)) || (await registry()))
    fail("preexisting");
}

export async function cleanup(
  input,
  {
    api = apiClient(input),
    run = child,
    registry = () => registryStatus(input, api),
    report = console.log,
  } = {},
) {
  const path = resolve(input.temp, "container-api-verification-owned.json");
  const existing = readProtected(path);
  if (existing === undefined) {
    report(JSON.stringify({ code: "verification_cleanup_unclaimed", resources: 0 }));
    return;
  }
  const state = validateState(existing, input);
  if (state.cleaned) {
    report(JSON.stringify({ code: "verification_cleanup_complete", resources: 0 }));
    return;
  }
  const app = await application(api);
  const ownedNamespaces = await namespaces(api);
  if (
    ownedNamespaces.length > 1 ||
    ownedNamespaces.some(
      (ns) =>
        ns.class !== "VerificationContainer" || (state.namespace && ns.id !== state.namespace),
    )
  )
    fail("cleanup_identity");
  const namespace = ownedNamespaces[0]?.id ?? state.namespace;
  if (app) {
    if (
      (state.appId && app.id !== state.appId) ||
      !namespace ||
      app.durable_objects?.namespace_id !== namespace ||
      (state.image && app.configuration?.image !== state.image)
    )
      fail("cleanup_identity");
    state.appId = app.id;
    state.namespace = namespace;
  }
  const settings = await api(`workers/scripts/${WORKER}/settings`, { missing: true });
  if (settings) {
    const bindings = settings.result?.bindings;
    if (
      !Array.isArray(bindings) ||
      bindings.some(
        (binding) =>
          !(binding.type === "secret_text" && binding.name === "HARNESS_KEY") &&
          !(
            binding.type === "plain_text" &&
            ["HARNESS_REVISION", "HARNESS_MONITOR"].includes(binding.name)
          ) &&
          !(
            binding.type === "durable_object_namespace" &&
            binding.name === "HARNESS" &&
            binding.class_name === "VerificationContainer" &&
            (binding.script_name === undefined || binding.script_name === WORKER)
          ),
      )
    )
      fail("cleanup_identity");
  }
  if (namespace) state.namespace = namespace;
  writeProtected(path, state);
  if (app) {
    await api(`containers/applications/${app.id}`, { method: "DELETE" });
    await waitMissing(api, `containers/applications/${app.id}`);
  }
  if (ownedNamespaces.length !== 0) {
    // Legacy deleted_classes is the supported namespace/data deletion operation.
    // Only this claimed, fixed synthetic class can enter the teardown config.
    if (!settings || !namespace) fail("cleanup_identity");
    const entrypoint = resolve(input.temp, "container-api-verification-teardown.mjs");
    writeProtected(
      entrypoint,
      "export default { fetch() { return new Response(null, { status: 404 }); } };",
      false,
      true,
    );
    const teardownPath = resolve(input.temp, "container-api-verification-teardown.json");
    writeProtected(teardownPath, {
      name: WORKER,
      account_id: input.account,
      main: entrypoint,
      compatibility_date: "2026-10-04",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: false },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["VerificationContainer"] },
        { tag: "v2", deleted_classes: ["VerificationContainer"] },
      ],
    });
    await run("bun", ["exec", "wrangler", "deploy", "--config", teardownPath], {
      env: commandEnv(input),
      timeout: 180000,
    });
    await waitMissing(api, `workers/durable_objects/namespaces/${namespace}/objects`, {
      duration: 90000,
    });
    if ((await namespaces(api)).length !== 0) fail("cleanup_namespace");
  } else if (namespace) {
    await waitMissing(api, `workers/durable_objects/namespaces/${namespace}/objects`, {
      duration: 90000,
    });
  }
  // force=false refuses deletion when another Worker references this synthetic Worker.
  if (settings) await api(`workers/scripts/${WORKER}?force=false`, { method: "DELETE" });
  await waitMissing(api, `workers/scripts/${WORKER}/settings`, { duration: 90000 });
  if (state.imageAttempted && (await registry())) {
    await run(
      "bun",
      ["exec", "wrangler", "containers", "images", "delete", `${APP}:${input.sha}`, "-y"],
      { env: commandEnv(input), timeout: 120000 },
    );
  }
  if (await registry()) fail("cleanup_image");
  state.cleaned = true;
  writeProtected(path, state);
  report(JSON.stringify({ code: "verification_cleanup_complete", resources: 4 }));
}

function commandEnv(input) {
  // Explicit allowlist: never inherit production credentials, NODE_OPTIONS or shell hooks.
  const env = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG", "XDG_CONFIG_HOME"])
    if (process.env[name]) env[name] = process.env[name];
  return {
    ...env,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: input.token,
    CLOUDFLARE_ACCOUNT_ID: input.account,
  };
}

export async function execute(
  input,
  {
    api = apiClient(input),
    run = child,
    registry = () => registryStatus(input, api),
    report = console.log,
    hold = recoveryHolder,
  } = {},
) {
  mkdirSync(input.temp, { recursive: true, mode: 0o700 });
  const statePath = resolve(input.temp, "container-api-verification-owned.json");
  if (readProtected(statePath) !== undefined) fail("state_exists");
  await preflight(input, api, registry);
  const state = {
    account: input.account,
    sha: input.sha,
    worker: WORKER,
    appName: APP,
    claimed: true,
  };
  writeProtected(statePath, state, true);
  const env = commandEnv(input);
  const deadline = Date.now() + 28 * 60 * 1000;
  const boundedRun = (command, args, options) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("deadline");
    return run(command, args, { ...options, timeout: Math.min(options.timeout, remaining) });
  };
  const key = randomBytes(32).toString("base64url");
  let holder;
  try {
    const tag = `${APP}:${input.sha}`;
    await boundedRun(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "--provenance=false",
        "-t",
        tag,
        "-f",
        resolve(root, "Dockerfile"),
        root,
      ],
      { env, timeout: 600000 },
    );
    state.imageAttempted = true;
    writeProtected(statePath, state);
    await boundedRun(
      "bun",
      [
        "exec",
        "wrangler",
        "containers",
        "push",
        tag,
        "--config",
        resolve(root, "wrangler.sdk.jsonc"),
      ],
      { env, timeout: 300000 },
    );
    const image = await registry();
    if (!image) fail("image_missing");
    state.image = image;
    writeProtected(statePath, state);
    const driverEnv = {
      ...env,
      RUNNER_TEMP: input.temp,
      HARNESS_SUBDOMAIN: input.subdomain,
      HARNESS_KEY: key,
      HARNESS_API_TOKEN: input.token,
    };
    async function deploy(phase) {
      const source = JSON.parse(
        readFileSync(
          resolve(root, phase === "baseline_sdk" ? "wrangler.sdk.jsonc" : "wrangler.native.jsonc"),
          "utf8",
        ),
      );
      const path = resolve(input.temp, `container-api-verification-${phase}.json`);
      writeProtected(path, config(source, { account: input.account, image, phase }), true);
      if (phase === "baseline_sdk")
        await boundedRun(
          "bun",
          ["exec", "wrangler", "secret", "put", "HARNESS_KEY", "--config", path],
          { env, stdin: `${key}\n`, timeout: 120000 },
        );
      await boundedRun("bun", ["exec", "wrangler", "deploy", "--config", path], {
        env,
        timeout: 300000,
      });
      const current = await waitReady(api, image);
      if (
        current.image !== image ||
        (state.appId && current.appId !== state.appId) ||
        (state.namespace && current.namespace !== state.namespace)
      )
        fail("deployment_identity");
      state.appId = current.appId;
      state.namespace = current.namespace;
      driverEnv.HARNESS_APPLICATION_ID = current.appId;
      writeProtected(statePath, state);
    }
    async function verify(phase) {
      const result = await boundedRun("node", [resolve(root, "driver.mjs")], {
        env: { ...driverEnv, HARNESS_PHASE: phase },
        timeout: 360000,
      });
      const lines = result.trim().split("\n");
      if (lines.length !== 1) fail("driver_output");
      report(JSON.stringify(driverReport(lines[0], phase)));
    }
    await deploy("baseline_sdk");
    await verify("baseline_sdk");
    const baseline = readProtected(resolve(input.temp, "container-api-verification-baseline.json"));
    if (
      !UUID.test(baseline?.workerVersion ?? "") ||
      baseline.appId !== state.appId ||
      baseline.namespace !== state.namespace ||
      baseline.image !== image
    )
      fail("baseline");
    state.workerVersion = baseline.workerVersion;
    writeProtected(statePath, state);
    await deploy("native");
    await verify("native");
    await deploy("native_unmonitored");
    await verify("native_unmonitored");
    holder = await hold({ ...driverEnv, HARNESS_PHASE: "native_unmonitored" });
    await deploy("native_recovered");
    await verify("native_recovered");
    await holder.stop();
    holder = undefined;
    await boundedRun(
      "bun",
      [
        "exec",
        "wrangler",
        "rollback",
        state.workerVersion,
        "--yes",
        "--config",
        resolve(input.temp, "container-api-verification-baseline_sdk.json"),
      ],
      { env, timeout: 180000 },
    );
    await verify("rollback_sdk");
    state.completed = true;
    writeProtected(statePath, state);
    report(JSON.stringify({ code: "verification_runner_complete", phases: 5 }));
  } finally {
    try {
      if (holder) await holder.stop();
    } finally {
      await cleanup(input, { api, run, registry, report });
    }
  }
}

export async function recoveryHolder(
  env,
  { spawnImpl = spawn, signalImpl = (pid, signal) => globalThis.process.kill(pid, signal) } = {},
) {
  const process = spawnImpl("node", [resolve(root, "driver.mjs"), "recovery-hold"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let pending = "",
    opened = false,
    closed = false,
    closedSuccessfully = false,
    failed = false,
    bytes = 0;
  let accept, reject;
  const ready = new Promise((yes, no) => {
    accept = yes;
    reject = no;
  });
  const stopSignal = (signal) => {
    try {
      signalImpl(-process.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  const invalid = () => {
    failed = true;
    reject(new Error("verification_runner_recovery"));
    stopSignal("SIGTERM");
  };
  const timer = setTimeout(invalid, 60000);
  const ended = new Promise((done) => {
    process.on("error", () => {
      reject(new Error("verification_runner_recovery"));
      done(false);
    });
    process.on("close", (code) => {
      closed = true;
      closedSuccessfully = code === 0;
      clearTimeout(timer);
      if (!opened) reject(new Error("verification_runner_recovery"));
      done(code === 0);
    });
  });
  process.stderr.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 65536) invalid();
  });
  process.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    pending += chunk.toString();
    if (bytes > 65536) {
      invalid();
      return;
    }
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        invalid();
        return;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        invalid();
        return;
      }
      if (
        item.code === "verification_recovery_stream_open" &&
        item.streams === 1 &&
        Object.keys(item).length === 2 &&
        !opened
      ) {
        opened = true;
        clearTimeout(timer);
        accept();
      } else if (
        item.code !== "verification_recovery_stream_disconnected" ||
        !opened ||
        item.streams !== 1 ||
        Object.keys(item).length !== 2
      )
        invalid();
    }
  });
  try {
    await ready;
  } catch (error) {
    stopSignal("SIGTERM");
    const hard = setTimeout(() => stopSignal("SIGKILL"), 5000);
    await ended;
    clearTimeout(hard);
    throw error;
  }
  return {
    stop: async () => {
      let successful = closedSuccessfully;
      if (!closed) {
        stopSignal("SIGTERM");
        const hard = setTimeout(() => stopSignal("SIGKILL"), 5000);
        successful = await ended;
        clearTimeout(hard);
      }
      if (!successful || failed) fail("recovery");
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = inputs(process.env);
    if (process.argv[2] === "cleanup") await cleanup(input);
    else if (process.argv.length === 2) await execute(input);
    else fail("command");
  } catch (error) {
    console.error(
      /^verification_(?:runner_)?[a-z_]+$/u.test(error?.message ?? "")
        ? error.message
        : "verification_runner_failed",
    );
    process.exitCode = 1;
  }
}
