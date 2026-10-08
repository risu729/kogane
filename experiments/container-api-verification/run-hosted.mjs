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
  ftruncateSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { identity } from "./driver.mjs";
import { canonicalHex, canonicalUuid, canonicalImageRef } from "./identifiers.mjs";

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

// Only complete project-owned codes may cross a captured-child/log boundary.
const DRIVER_CODES = new Set(
  [
    "allocation",
    "application",
    "application_rollout",
    "backpressure",
    "baseline",
    "cancel",
    "concurrency",
    "concurrency_posts",
    "concurrency_process",
    "concurrency_start",
    "concurrency_state",
    "delay",
    "destroy",
    "exit_diagnostic",
    "failed",
    "hold",
    "http",
    "identity",
    "identity_changed",
    "identity_http",
    "identity_response",
    "identity_transport",
    "inputs",
    "phase",
    "record",
    "recovery",
    "recovery_baseline",
    "response",
    "restart",
    "revision",
    "rollback_version",
    "sdk_alarm",
    "sentinel",
    "signal_diagnostic",
    "state_timeout",
    "stream",
    "stream_failure",
    "transport",
  ].map((code) => `verification_${code}`),
);
const RUNNER_CODES = new Set(
  [
    "allocation",
    "api_http",
    "api_response",
    "api_selector",
    "api_transport",
    "application",
    "baseline",
    "child",
    "cleanup_identity",
    "cleanup_image",
    "cleanup_image_identity",
    "cleanup_image_readback_timeout",
    "cleanup_image_remaining",
    "cleanup_namespace",
    "cleanup_timeout",
    "command",
    "config",
    "deadline",
    "deployment_identity",
    "driver_output",
    "failed",
    "image_missing",
    "inputs",
    "namespaces",
    "preexisting",
    "private_directory",
    "recovery",
    "registry_credentials",
    "registry_digest",
    "registry_http",
    "registry_identity",
    "registry_inputs",
    "registry_transport",
    "rollout",
    "rollout_timeout",
    "state",
    "state_exists",
    "worker_not_blank",
  ].map((code) => `verification_runner_${code}`),
);
const HTTP_CATEGORIES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limit",
  "server",
  "redirect",
  "default",
];
for (const endpoint of [
  "settings",
  "deployments",
  "worker_delete",
  "registry_credentials",
  "namespaces",
  "namespace_objects",
  "applications",
  "application_versions",
  "worker_version",
])
  for (const category of HTTP_CATEGORIES)
    RUNNER_CODES.add(`verification_runner_api_http_${endpoint}_${category}`);
for (const operation of ["lookup", "predelete", "delete", "readback"])
  for (const category of HTTP_CATEGORIES)
    RUNNER_CODES.add(`verification_runner_registry_http_${operation}_${category}`);
export function diagnosticCode(error) {
  const code = error?.message;
  for (const known of RUNNER_CODES) if (known === code) return known;
  for (const known of DRIVER_CODES) if (known === code) return known;
  return "verification_runner_failed";
}
export function driverFailure(text) {
  const code = text.trim();
  for (const known of DRIVER_CODES) if (known === code) return known;
  return "verification_runner_child";
}
function httpCategory(status) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (Number.isInteger(status) && status >= 500 && status <= 599) return "server";
  if (Number.isInteger(status) && status >= 300 && status <= 399) return "redirect";
  return "default";
}
export function registryHttpCode(operation, status) {
  if (!["lookup", "predelete", "delete", "readback"].includes(operation)) return "registry_http";
  return `registry_http_${operation}_${httpCategory(status)}`;
}

export function wranglerArgs(...args) {
  return [resolve(root, "node_modules/wrangler/bin/wrangler.js"), ...args];
}

export function inputs(env, { tempFixture } = {}) {
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
  const directory = tempFixture ?? env.CONTAINER_VERIFICATION_TEMP;
  if (
    !directory ||
    (tempFixture === undefined &&
      (dirname(resolve(directory)) !== resolve(env.RUNNER_TEMP) ||
        !/^container-api-verification\.[A-Za-z0-9]{8}$/u.test(basename(directory))))
  )
    fail("private_directory");
  return { account, token, subdomain, sha: env.GITHUB_SHA, temp: resolve(directory) };
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
  result.containers[0].image = canonicalImageRef(image, account);
  result.vars = {
    HARNESS_REVISION: phase,
    HARNESS_MONITOR: phase === "native_unmonitored" ? "disabled" : "enabled",
  };
  return result;
}

export function privateDirectory(path) {
  const absolute = resolve(path);
  let fd;
  try {
    if (realpathSync(absolute) !== absolute || lstatSync(absolute).isSymbolicLink())
      fail("private_directory");
    fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0o700,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      typeof process.getuid !== "function" ||
      stat.uid !== process.getuid()
    )
      fail("private_directory");
    return absolute;
  } catch {
    fail("private_directory");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function protectedLocation(path) {
  const absolute = resolve(path);
  const parent = privateDirectory(dirname(absolute));
  if (dirname(absolute) !== parent) fail("state");
  return absolute;
}

export function readProtected(path) {
  let fd;
  try {
    fd = openSync(protectedLocation(path), constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 16384 ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid()
    )
      fail("state");
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
      protectedLocation(path),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        (initial ? constants.O_EXCL : 0),
      0o600,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid()
    )
      fail("state");
    ftruncateSync(fd, 0);
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
    "imagePreflightAbsent",
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
    state.imagePreflightAbsent !== true ||
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
  // Reconstruct only the approved primitive schema. Never reuse a parsed
  // object or arbitrary file property as an API selector or persisted value.
  const result = {
    account: input.account,
    sha: input.sha,
    worker: WORKER,
    appName: APP,
    claimed: true,
    imagePreflightAbsent: true,
  };
  if (state.appId !== undefined) result.appId = canonicalUuid(state.appId);
  if (state.namespace !== undefined) result.namespace = canonicalHex(state.namespace, 32);
  if (state.workerVersion !== undefined) result.workerVersion = canonicalUuid(state.workerVersion);
  if (state.image !== undefined) result.image = canonicalImageRef(state.image, input.account);
  for (const key of ["imageAttempted", "completed", "cleaned"])
    if (state[key] !== undefined) result[key] = state[key] === true;
  return result;
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
    const controlledDriver =
      command === "node" && args.length === 1 && args[0] === resolve(root, "driver.mjs");
    let driverStderr = "";
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
    // CLI/provider stderr stays discarded. Only a complete finite driver code is admitted.
    process.stderr.on("data", (chunk) => {
      if (controlledDriver && driverStderr.length <= 4096) driverStderr += chunk.toString();
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
      if (code !== 0 || timedOut || badOutput)
        reject(
          new Error(
            controlledDriver && !timedOut && !badOutput && driverStderr.length <= 4096
              ? driverFailure(driverStderr)
              : "verification_runner_child",
          ),
        );
      else done(output);
    });
  });
}

export function canonicalApiPath(path, method = "GET") {
  if (typeof path !== "string") fail("api_selector");
  for (const fixed of [
    `workers/scripts/${WORKER}/settings`,
    `workers/scripts/${WORKER}/deployments`,
    `containers/applications?name=${APP}`,
  ])
    if (path === fixed && method === "GET") return fixed;
  if (path === `workers/scripts/${WORKER}?force=false` && method === "DELETE")
    return `workers/scripts/${WORKER}?force=false`;
  if (path === "containers/registries/registry.cloudflare.com/credentials" && method === "POST")
    return "containers/registries/registry.cloudflare.com/credentials";
  const pages = /^workers\/durable_objects\/namespaces\?per_page=100&page=(\d+)$/u.exec(path);
  if (pages && method === "GET") {
    const page = Number(pages[1]);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) fail("api_selector");
    return `workers/durable_objects/namespaces?per_page=100&page=${page}`;
  }
  const namespace = /^workers\/durable_objects\/namespaces\/([a-f0-9]{32})\/objects$/u.exec(path);
  if (namespace && method === "GET")
    return `workers/durable_objects/namespaces/${canonicalHex(namespace[1], 32)}/objects`;
  const app = /^containers\/applications\/([a-f0-9-]+)(\/versions)?$/u.exec(path);
  if (app && (method === "GET" || (method === "DELETE" && app[2] === undefined)))
    return `containers/applications/${canonicalUuid(app[1])}${app[2] ? "/versions" : ""}`;
  const prefix = `workers/scripts/${WORKER}/versions/`;
  if (path.startsWith(prefix) && method === "GET")
    return `workers/scripts/${WORKER}/versions/${canonicalUuid(path.slice(prefix.length))}`;
  fail("api_selector");
}

// Emit only a fixed endpoint/status vocabulary, never URL segments or provider data.
export function apiHttpCode(selector, status) {
  let endpoint;
  if (selector === `workers/scripts/${WORKER}/settings`) endpoint = "settings";
  else if (selector === `workers/scripts/${WORKER}/deployments`) endpoint = "deployments";
  else if (selector === `workers/scripts/${WORKER}?force=false`) endpoint = "worker_delete";
  else if (selector === "containers/registries/registry.cloudflare.com/credentials")
    endpoint = "registry_credentials";
  else if (
    typeof selector === "string" &&
    /^workers\/durable_objects\/namespaces\?per_page=100&page=\d+$/u.test(selector)
  )
    endpoint = "namespaces";
  else if (
    typeof selector === "string" &&
    /^workers\/durable_objects\/namespaces\/[a-f0-9]{32}\/objects$/u.test(selector)
  )
    endpoint = "namespace_objects";
  else if (selector === `containers/applications?name=${APP}`) endpoint = "applications";
  else if (
    typeof selector === "string" &&
    /^containers\/applications\/[a-f0-9-]+\/versions$/u.test(selector)
  )
    endpoint = "application_versions";
  else if (typeof selector === "string" && /^containers\/applications\/[a-f0-9-]+$/u.test(selector))
    endpoint = "applications";
  else if (
    typeof selector === "string" &&
    selector.startsWith(`workers/scripts/${WORKER}/versions/`) &&
    UUID.test(selector.slice(`workers/scripts/${WORKER}/versions/`.length))
  )
    endpoint = "worker_version";
  if (endpoint === undefined) return "api_http";
  return `api_http_${endpoint}_${httpCategory(status)}`;
}

export function apiClient(input, fetchImpl = fetch) {
  return async (path, { method = "GET", body, missing = false, timeout = 30000 } = {}) => {
    const selector = canonicalApiPath(path, method);
    const headers = { authorization: `Bearer ${input.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${canonicalHex(input.account, 32)}/${selector}`,
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
    if (!response.ok || response.status >= 300) fail(apiHttpCode(selector, response.status));
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

function manifestUrl(input) {
  if (!HEX.test(input.account ?? "") || !SHA.test(input.sha ?? "")) fail("registry_inputs");
  return `https://registry.cloudflare.com/v2/${input.account}/${APP}/manifests/${input.sha}`;
}
function validImage(input, image) {
  return (
    typeof image === "string" &&
    new RegExp(
      `^registry\\.cloudflare\\.com/${input.account}/${APP}@sha256:[a-f0-9]{64}$`,
      "u",
    ).test(image)
  );
}
async function registryAuth(api, permissions) {
  const credentials = (
    await api("containers/registries/registry.cloudflare.com/credentials", {
      method: "POST",
      body: { expiration_minutes: 5, permissions },
    })
  ).result;
  if (
    typeof credentials?.password !== "string" ||
    credentials.password.length === 0 ||
    credentials.password.length > 16384 ||
    /[\u0000-\u0020\u007f]/u.test(credentials.password)
  )
    fail("registry_credentials");
  return `Basic ${Buffer.from(`v1:${credentials.password}`).toString("base64")}`;
}
async function registryRequest(url, authorization, method, fetchImpl, timeout = 30000) {
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(30000, Math.max(1, timeout))),
      headers: {
        authorization,
        accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    await response.body?.cancel().catch(() => {});
    return response;
  } catch {
    fail("registry_transport");
  }
}
function digestImage(input, response) {
  const digest = response.headers.get("docker-content-digest");
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? "")) fail("registry_digest");
  return `registry.cloudflare.com/${input.account}/${APP}@${digest}`;
}
export async function registryStatus(input, api, fetchImpl = fetch) {
  const url = manifestUrl(input);
  const authorization = await registryAuth(api, ["pull"]);
  const response = await registryRequest(url, authorization, "GET", fetchImpl);
  if (response.status !== 200 && response.status !== 404)
    fail(registryHttpCode("lookup", response.status));
  return response.status === 404 ? undefined : digestImage(input, response);
}
export async function deleteRegistryTag(
  input,
  expectedImage,
  {
    api = apiClient(input),
    fetchImpl = fetch,
    now = Date.now,
    sleep = pause,
    report = console.log,
  } = {},
) {
  const url = manifestUrl(input);
  if (!validImage(input, expectedImage)) fail("registry_identity");
  // Exactly this account/repository/tag is addressed. No catalog, other tags,
  // digest-wide deletion, or account-wide /v2/gc/layers operation is performed.
  const authorization = await registryAuth(api, ["pull", "push"]);
  const current = await registryRequest(url, authorization, "GET", fetchImpl);
  if (current.status === 404) return;
  if (current.status !== 200) fail(registryHttpCode("predelete", current.status));
  if (digestImage(input, current) !== expectedImage) fail("registry_identity");
  const deleted = await registryRequest(url, authorization, "DELETE", fetchImpl);
  // A concurrent/eventually visible deletion can race the predelete GET.
  // DELETE404 is not absence proof: require a separate exact-tag GET404 below.
  if (![200, 202, 204, 404].includes(deleted.status))
    fail(registryHttpCode("delete", deleted.status));
  const deadline = now() + 90000;
  let observed = false;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) fail("cleanup_image_readback_timeout");
    const readback = await registryRequest(url, authorization, "GET", fetchImpl, remaining);
    if (readback.status === 404) return;
    if (readback.status !== 200) fail(registryHttpCode("readback", readback.status));
    if (digestImage(input, readback) !== expectedImage) fail("registry_identity");
    if (!observed) {
      observed = true;
      const remainingHead = deadline - now();
      if (remainingHead <= 0) fail("cleanup_image_readback_timeout");
      let headStatus = "transport";
      try {
        const head = await registryRequest(url, authorization, "HEAD", fetchImpl, remainingHead);
        headStatus = head.status === 200 ? "present" : httpCategory(head.status);
      } catch {
        // Observation failure neither proves absence nor changes the GET gate.
      }
      report(
        JSON.stringify({
          code: "verification_registry_readback_observation",
          delete: deleted.status === 404 ? "not_found" : "accepted",
          get: "present",
          head: headStatus,
        }),
      );
    }
    const rest = deadline - now();
    if (rest <= 0) fail("cleanup_image_readback_timeout");
    await sleep(Math.min(2000, rest));
  }
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
    deleteImage = (image) => deleteRegistryTag(input, image, { api, report }),
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
    state.appId = canonicalUuid(app.id);
    state.namespace = canonicalHex(namespace, 32);
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
  if (namespace) state.namespace = canonicalHex(namespace, 32);
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
    await run("node", wranglerArgs("deploy", "--config", teardownPath), {
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
  const remainingImage = await registry();
  if (state.imageAttempted && remainingImage) {
    if (!validImage(input, remainingImage) || (state.image && state.image !== remainingImage))
      fail("cleanup_image_identity");
    if (!state.image) {
      // A failed push can have published the tag before returning a digest.
      // Admission required GET404 for this exact immutable SHA tag; the
      // protected claim predates push and marks this run's attempted mutation.
      // Capture and persist the validated digest before any DELETE, rather than
      // treating an expected name alone as ownership evidence.
      if (!state.imagePreflightAbsent || !state.claimed) fail("cleanup_image_identity");
      state.image = canonicalImageRef(remainingImage, input.account);
      writeProtected(path, state);
    }
    await deleteImage(state.image);
  }
  if (await registry()) fail("cleanup_image_remaining");
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
    deleteImage = (image) => deleteRegistryTag(input, image, { api, report }),
    report = console.log,
    hold = recoveryHolder,
  } = {},
) {
  privateDirectory(input.temp);
  const statePath = resolve(input.temp, "container-api-verification-owned.json");
  if (readProtected(statePath) !== undefined) fail("state_exists");
  try {
    await preflight(input, api, registry);
  } catch (error) {
    const code = diagnosticCode(error);
    report(
      JSON.stringify({ code: "verification_execution_failed", stage: "preflight", error: code }),
    );
    throw new Error(code, { cause: error });
  }
  const state = {
    account: input.account,
    sha: input.sha,
    worker: WORKER,
    appName: APP,
    claimed: true,
    imagePreflightAbsent: true,
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
  let holder, failure;
  let stage = "image_build";
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
    stage = "image_push";
    state.imageAttempted = true;
    writeProtected(statePath, state);
    await boundedRun(
      "node",
      wranglerArgs("containers", "push", tag, "--config", resolve(root, "wrangler.sdk.jsonc")),
      { env, timeout: 300000 },
    );
    stage = "image_readback";
    const image = await registry();
    if (!image) fail("image_missing");
    state.image = canonicalImageRef(image, input.account);
    writeProtected(statePath, state);
    const driverEnv = {
      ...env,
      RUNNER_TEMP: input.temp,
      HARNESS_SUBDOMAIN: input.subdomain,
      HARNESS_KEY: key,
      HARNESS_API_TOKEN: input.token,
    };
    async function deploy(phase) {
      stage = `${phase}_config`;
      const source = JSON.parse(
        readFileSync(
          resolve(root, phase === "baseline_sdk" ? "wrangler.sdk.jsonc" : "wrangler.native.jsonc"),
          "utf8",
        ),
      );
      const path = resolve(input.temp, `container-api-verification-${phase}.json`);
      writeProtected(path, config(source, { account: input.account, image, phase }), true);
      if (phase === "baseline_sdk") {
        stage = "baseline_sdk_secret";
        await boundedRun("node", wranglerArgs("secret", "put", "HARNESS_KEY", "--config", path), {
          env,
          stdin: `${key}\n`,
          timeout: 120000,
        });
      }
      stage = `${phase}_deploy`;
      await boundedRun("node", wranglerArgs("deploy", "--config", path), {
        env,
        timeout: 300000,
      });
      stage = `${phase}_rollout`;
      const current = await waitReady(api, image);
      if (
        current.image !== image ||
        (state.appId && current.appId !== state.appId) ||
        (state.namespace && current.namespace !== state.namespace)
      )
        fail("deployment_identity");
      state.appId = canonicalUuid(current.appId);
      state.namespace = canonicalHex(current.namespace, 32);
      driverEnv.HARNESS_APPLICATION_ID = current.appId;
      writeProtected(statePath, state);
    }
    async function verify(phase) {
      stage = `${phase}_verify`;
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
    stage = "baseline_sdk_record";
    const baseline = readProtected(resolve(input.temp, "container-api-verification-baseline.json"));
    if (
      !UUID.test(baseline?.workerVersion ?? "") ||
      baseline.appId !== state.appId ||
      baseline.namespace !== state.namespace ||
      baseline.image !== image
    )
      fail("baseline");
    state.workerVersion = canonicalUuid(baseline.workerVersion);
    writeProtected(statePath, state);
    await deploy("native");
    await verify("native");
    await deploy("native_unmonitored");
    await verify("native_unmonitored");
    stage = "recovery_hold";
    holder = await hold({ ...driverEnv, HARNESS_PHASE: "native_unmonitored" });
    await deploy("native_recovered");
    await verify("native_recovered");
    stage = "recovery_stop";
    await holder.stop();
    holder = undefined;
    stage = "rollback_sdk_deploy";
    await boundedRun(
      "node",
      wranglerArgs(
        "rollback",
        state.workerVersion,
        "--yes",
        "--config",
        resolve(input.temp, "container-api-verification-baseline_sdk.json"),
      ),
      { env, timeout: 180000 },
    );
    await verify("rollback_sdk");
    state.completed = true;
    writeProtected(statePath, state);
    report(JSON.stringify({ code: "verification_runner_complete", phases: 5 }));
  } catch (error) {
    const code = diagnosticCode(error);
    failure = new Error(code);
    report(JSON.stringify({ code: "verification_execution_failed", stage, error: code }));
  } finally {
    // Reap the holder and clean up independently; neither erases the first failure.
    if (holder) {
      try {
        await holder.stop();
      } catch (error) {
        const code = diagnosticCode(error);
        failure ??= new Error(code);
        report(
          JSON.stringify({
            code: "verification_recovery_cleanup_failed",
            stage: "recovery_stop",
            error: code,
          }),
        );
      }
    }
    try {
      await cleanup(input, { api, run, registry, deleteImage, report });
    } catch (error) {
      const code = diagnosticCode(error);
      failure ??= new Error(code);
      report(
        JSON.stringify({ code: "verification_cleanup_failed", stage: "cleanup", error: code }),
      );
    }
  }
  if (failure) throw failure;
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
    if (!process.env.CONTAINER_VERIFICATION_TEMP) fail("private_directory");
    const input = inputs(process.env);
    privateDirectory(input.temp);
    if (process.argv[2] === "cleanup") await cleanup(input);
    else if (process.argv.length === 2) await execute(input);
    else fail("command");
  } catch (error) {
    console.error(diagnosticCode(error));
    process.exitCode = 1;
  }
}
