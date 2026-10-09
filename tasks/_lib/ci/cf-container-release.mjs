// Default-scheduling Container deployment guards. No collector is invoked.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  lstatSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../../scripts/jsonc.ts";
import { resolve } from "node:path";

export const CONTAINER_POSTCHECK_TIMEOUT_MS = 600000;

export const CONTAINER_TARGETS = [
  {
    name: "globalpass-worker",
    path: "services/collector-globalpass",
    worker: "kogane-globalpass-collector-poc",
    className: "GlobalPassCollectorContainer",
    classes: ["GlobalPassCollectorContainer"],
    appName: "kogane-globalpass-collector-poc-globalpasscollectorcontainer",
    appId: "a03ac341-52a7-4e81-9a7c-279a90cc4b0c",
    maxInstances: 2,
  },
  {
    name: "sbi-shinsei-worker",
    path: "services/collector-sbi-shinsei",
    worker: "kogane-sbi-shinsei-collector-poc",
    className: "SbiShinseiCollectorContainer",
    classes: ["SbiShinseiCollectorContainer"],
    appName: "kogane-sbi-shinsei-collector-poc-sbishinseicollectorcontainer",
    appId: "a03d0e7f-2b1f-4650-a8e6-b78123d53aa5",
    maxInstances: 2,
  },
  {
    name: "st-george-worker",
    path: "services/collector-st-george",
    worker: "kogane-st-george-collector",
    className: "StGeorgeCollectorContainer",
    classes: ["StGeorgeCollectorContainer", "StGeorgeCollectionState"],
    appName: "kogane-st-george-collector-stgeorgecollectorcontainer",
    appId: "a032f0dd-e68f-4c69-9f25-901ae7422e74",
    maxInstances: 1,
  },
];
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw new Error(`cf_container_${code}`);
};

/** The first admitted alarm rollback target pins 4.145.0. No tool is installed. */
export function requireExportsWrangler(version) {
  const found = /^(4)\.(\d+)\.(\d+)$/u.exec(version ?? "");
  if (!found || Number(found[2]) < 145) fail("wrangler_exports_unsupported");
}

/** Only the exact three known v1 histories may become equivalent SQLite exports. */
export function normalizeContainerRollback(target, config) {
  if (!CONTAINER_TARGETS.includes(target)) fail("rollback_target_unknown");
  if (
    config.name !== target.worker ||
    config.exports !== undefined ||
    !same(config.migrations, [{ tag: "v1", new_sqlite_classes: target.classes }])
  )
    fail("rollback_history_unknown");
  const bindings = config.durable_objects?.bindings;
  if (
    !Array.isArray(bindings) ||
    bindings.length !== target.classes.length ||
    !same(bindings.map((binding) => binding.class_name).sort(), [...target.classes].sort()) ||
    bindings.some(
      (binding) =>
        typeof binding.name !== "string" ||
        (binding.script_name !== undefined && binding.script_name !== target.worker),
    )
  )
    fail("rollback_binding_unknown");
  const containers = config.containers;
  if (
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    containers[0].class_name !== target.className ||
    (containers[0].name !== undefined && containers[0].name !== target.appName) ||
    (containers[0].scheduling_policy !== undefined && containers[0].scheduling_policy !== "default")
  )
    fail("rollback_container_unknown");
  const { migrations: _history, ...normalized } = config;
  return {
    ...normalized,
    exports: Object.fromEntries(
      target.classes.map((name) => [name, { type: "durable-object", storage: "sqlite" }]),
    ),
  };
}

/** Docker failures never surface child stdout/stderr or its command. */
export function dockerImageId(tag, execImpl = execFileSync) {
  if (
    typeof tag !== "string" ||
    !/^(?:cloudflare-build\/[a-f0-9]{12}\/[a-z0-9._-]+:[a-f0-9]{12}|kogane-[a-z0-9-]+:rollback-[a-f0-9]{12})$/u.test(
      tag,
    )
  )
    fail("local_tag_invalid");
  let value;
  try {
    value = execImpl("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail("local_image_unavailable");
  }
  if (!digestPattern.test(value)) fail("local_image_invalid");
  return value;
}

export function localContainerImages(root, target, inspect = dockerImageId) {
  const directory = resolve(root, target.path, ".cloudflare/output/v0/containers");
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    fail("output_missing");
  }
  const configs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) fail("output_shape");
    let config;
    try {
      config = JSON.parse(
        readFileSync(resolve(directory, entry.name, "container.config.json"), "utf8"),
      );
    } catch {
      fail("output_shape");
    }
    configs.push(config);
  }
  if (configs.length !== 1) fail("output_shape");
  const config = configs[0];
  if (
    config.name !== target.appName ||
    config.schedulingPolicy !== "default" ||
    config.maxInstances !== target.maxInstances ||
    config.instanceType !== "basic" ||
    !same(config.constraints?.regions, ["APAC"]) ||
    typeof config.image?.localReference !== "string"
  )
    fail("output_identity");
  const tag = config.image.localReference;
  return {
    name: target.name,
    appId: target.appId,
    appName: target.appName,
    localTag: tag,
    imageId: inspect(tag),
  };
}

export function verifyLocalContainerImages(recorded, actual) {
  if (!same(recorded, actual)) fail("local_image_changed");
}

/** GET applications expands the documented basic preset into these exact quantities. */
export function isBasicApplicationConfiguration(config) {
  return (
    config != null &&
    (config.instance_type === undefined || config.instance_type === "basic") &&
    config.vcpu === 0.25 &&
    config.memory_mib === 1024 &&
    config.disk?.size_mb === 4000
  );
}

/** Capture only operational IDs and configuration; no health/provider text. */
export function applicationSnapshot(target, app, bindings, accountId) {
  if (
    app.id !== target.appId ||
    app.name !== target.appName ||
    app.account_id !== accountId ||
    app.scheduling_policy !== "default" ||
    app.max_instances !== target.maxInstances ||
    !isBasicApplicationConfiguration(app.configuration) ||
    !same(app.constraints?.regions, ["APAC"])
  )
    fail("application_identity");
  if (
    !Array.isArray(bindings) ||
    bindings.filter((b) => b.type === "durable_object_namespace").length !== target.classes.length
  )
    fail("namespace_binding_set");
  const namespaces = target.classes.map((className) => {
    const found = bindings.filter(
      (b) =>
        b.type === "durable_object_namespace" &&
        b.class_name === className &&
        (b.script_name === undefined || b.script_name === target.worker),
    );
    if (found.length !== 1 || !/^[a-f0-9]{32}$/u.test(found[0].namespace_id ?? ""))
      fail("namespace_binding");
    return { className, namespaceId: found[0].namespace_id };
  });
  if (
    app.durable_objects?.namespace_id !==
    namespaces.find((n) => n.className === target.className).namespaceId
  )
    fail("application_namespace");
  if (
    typeof app.configuration.image !== "string" ||
    !new RegExp(
      `^registry\\.cloudflare\\.com/[a-z0-9_-]{1,64}/${target.appName}@sha256:[a-f0-9]{64}$`,
      "u",
    ).test(app.configuration.image) ||
    !Number.isSafeInteger(app.version) ||
    app.version < 0 ||
    (app.active_rollout_id != null &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(app.active_rollout_id))
  )
    fail("application_snapshot_shape");
  return {
    name: target.name,
    appId: target.appId,
    appName: target.appName,
    namespaces,
    image: app.configuration.image,
    version: app.version,
    activeRolloutId: app.active_rollout_id ?? null,
  };
}

export function verifyApplicationIdentity(before, after) {
  for (const key of ["name", "appId", "appName", "namespaces"])
    if (!same(before[key], after[key])) fail("namespace_changed");
}

/** Unknown allocation entries are never evidence, including inactive zero-percent entries. */
export function verifyApplicationVersions(versions) {
  if (
    !Array.isArray(versions) ||
    versions.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry.configuration?.image !== "string" ||
        !entry.configuration.image ||
        !Number.isSafeInteger(entry.version) ||
        entry.version < 0 ||
        !Number.isFinite(entry.percentage) ||
        entry.percentage < 0 ||
        entry.percentage > 100,
    )
  )
    fail("version_shape");
}

/** Control-plane completion only; zero sleeping instances do not need waking. */
export function verifyApplicationRollout(snapshot, versions) {
  verifyApplicationVersions(versions);
  if (snapshot.activeRolloutId !== null) fail("rollout_pending");
  if (
    !Number.isInteger(snapshot.version) ||
    snapshot.version < 0 ||
    !Array.isArray(versions) ||
    versions.filter(
      (version) =>
        version.version === snapshot.version &&
        version.configuration?.image === snapshot.image &&
        version.percentage === 100,
    ).length !== 1 ||
    versions.some((version) => version.version !== snapshot.version && version.percentage !== 0)
  )
    fail("rollout_unverified");
}

/** Reject unstable or changed original targets before any new Container publication. */
export function verifyApplicationBaseline(before, current, versions) {
  verifyApplicationIdentity(before, current);
  if (
    current.workerVersion !== before.workerVersion ||
    current.version !== before.version ||
    current.image !== before.image
  )
    fail("baseline_changed");
  verifyApplicationVersions(versions);
  if (versions.some((entry) => entry.version > before.version)) fail("baseline_changed");
  verifyApplicationRollout(current, versions);
}

/** All reads and waits consume one absolute postcheck deadline; never reset it. */
export async function waitForApplicationRollout(
  readState,
  {
    now = Date.now,
    wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
    publication,
    deadline = now() + CONTAINER_POSTCHECK_TIMEOUT_MS,
  } = {},
) {
  while (now() < deadline) {
    const { snapshot, versions } = await readState(deadline);
    if (now() >= deadline) fail("rollout_pending");
    try {
      if (
        publication &&
        (snapshot.version !== publication.version || snapshot.image !== publication.image)
      )
        fail("rollout_pending");
      verifyApplicationRollout(snapshot, versions);
      return snapshot;
    } catch (error) {
      if (
        !["cf_container_rollout_pending", "cf_container_rollout_unverified"].includes(error.message)
      )
        throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(5000, remaining));
  }
  fail("rollout_pending");
}

/** Registry proof and the final complete readback share the original polling budget. */
export async function waitForApplicationPostcheck(
  readState,
  verifyImage,
  { now = Date.now, wait, publication, deadline = now() + CONTAINER_POSTCHECK_TIMEOUT_MS } = {},
) {
  return waitForApplicationRollout(
    async (sharedDeadline) => {
      const state = await readState(sharedDeadline);
      if (now() >= sharedDeadline) fail("rollout_pending");
      if (
        publication &&
        (state.snapshot.version !== publication.version ||
          state.snapshot.image !== publication.image)
      )
        return state;
      try {
        verifyApplicationRollout(state.snapshot, state.versions);
      } catch (error) {
        if (
          !["cf_container_rollout_pending", "cf_container_rollout_unverified"].includes(
            error.message,
          )
        )
          throw error;
        return state;
      }
      await verifyImage(state.snapshot, sharedDeadline);
      if (now() >= sharedDeadline) fail("rollout_pending");
      // A registry-time replacement or resumed rollout must never become verified.
      return readState(sharedDeadline);
    },
    { now, wait, publication, deadline },
  );
}

/** Use the authenticated current namespace, while refusing any baseline drift. */
export async function currentRegistryNamespace(api, expected) {
  const current = (await api("containers/me")).external_account_id;
  if (!/^[a-z0-9_-]{1,64}$/u.test(current ?? "")) fail("registry_namespace_invalid");
  if (current !== expected) fail("registry_namespace_changed");
  return current;
}

export function registryImage(target, image, registryNamespace) {
  if (!/^[a-z0-9_-]{1,64}$/u.test(registryNamespace ?? "")) fail("registry_namespace_invalid");
  const prefix = `registry.cloudflare.com/${registryNamespace}/${target.appName}@`;
  if (
    typeof image !== "string" ||
    !image.startsWith(prefix) ||
    !digestPattern.test(image.slice(prefix.length))
  )
    fail("registry_image_invalid");
  return {
    repository: `${registryNamespace}/${target.appName}`,
    digest: image.slice(prefix.length),
  };
}

/** Read the exact immutable manifest. Tokens never follow redirects or another host. */
export async function verifyRegistryImage({
  target,
  image,
  imageId,
  registryNamespace,
  username,
  password,
  fetchImpl = fetch,
  deadline,
  now = Date.now,
}) {
  if (
    !digestPattern.test(imageId) ||
    typeof username !== "string" ||
    !username ||
    typeof password !== "string" ||
    !password
  )
    fail("registry_credentials_invalid");
  const ref = registryImage(target, image, registryNamespace);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const manifest = async (digest) => {
    if (!digestPattern.test(digest)) fail("registry_digest_invalid");
    const remaining = deadline === undefined ? 30000 : Math.min(30000, Math.ceil(deadline - now()));
    if (remaining <= 0) fail("rollout_pending");
    let response;
    try {
      response = await fetchImpl(
        `https://registry.cloudflare.com/v2/${ref.repository}/manifests/${digest}`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(remaining),
          headers: {
            Authorization: authorization,
            Accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json",
          },
        },
      );
    } catch {
      if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
      fail("registry_unavailable");
    }
    if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
    if (response.status !== 200) fail("registry_http");
    let bytes;
    try {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          fail("registry_response");
        }
        chunks.push(Buffer.from(value));
      }
      bytes = Buffer.concat(chunks);
    } catch {
      if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
      fail("registry_response");
    }
    if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
    if (
      bytes.length > 4 * 1024 * 1024 ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest
    )
      fail("registry_digest_mismatch");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("registry_response");
    }
  };
  let found = await manifest(ref.digest);
  if (Array.isArray(found.manifests)) {
    const platform = found.manifests.filter(
      (entry) =>
        entry.platform?.os === "linux" &&
        entry.platform?.architecture === "amd64" &&
        !entry.platform.variant,
    );
    if (platform.length !== 1) fail("registry_platform_unknown");
    found = await manifest(platform[0].digest);
  }
  if (found.config?.digest !== imageId) fail("registry_image_mismatch");
}

/** Only the files these three Dockerfiles consume. Symlinks are refused. */
/** Open once: neither symlink replacement nor a path swap changes the measured inode. */
export function readRegularFile(path, { openImpl = openSync, allowAbsent = false } = {}) {
  let fd;
  try {
    fd = openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) fail("context_shape");
    return readFileSync(fd);
  } catch (error) {
    if (allowAbsent && error?.code === "ENOENT") return null;
    if (error?.message?.startsWith("cf_container_")) throw error;
    fail(error?.code === "ELOOP" ? "context_symlink" : "context_shape");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function containerInputDigest(root, target) {
  const dockerfile = readRegularFile(resolve(root, target.path, "Dockerfile")).toString("utf8");
  // The hash covers all COPY sources of the three admitted single-stage images.
  if (/^\s*ADD\s/imu.test(dockerfile)) fail("context_instruction_unknown");
  const copies = [...dockerfile.matchAll(/^\s*COPY\s+(.+)$/gimu)];
  if (copies.length === 0 || copies.some(([, text]) => /\\\s*$/u.test(text)))
    fail("context_instruction_unknown");
  for (const [, text] of copies) {
    const sources = text.trim().split(/\s+/u).slice(0, -1);
    if (sources.length === 0) fail("context_instruction_unknown");
    for (const source of sources) {
      if (!/^container\/[a-z0-9._-]+$/u.test(source)) fail("context_instruction_unknown");
      let stat;
      try {
        stat = lstatSync(resolve(root, target.path, source));
      } catch {
        fail("context_shape");
      }
      if (!stat.isFile()) fail(stat.isSymbolicLink() ? "context_symlink" : "context_shape");
    }
  }
  const files = ["Dockerfile", ".dockerignore"];
  const walk = (directory) => {
    for (const entry of readdirSync(resolve(root, target.path, directory), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${directory}/${entry.name}`;
      // npm ci creates this tree and .bin symlinks; none is an admitted COPY source.
      if (relative === "container/node_modules" && entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) fail("context_symlink");
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.push(relative);
      else fail("context_shape");
    }
  };
  if (
    !lstatSync(resolve(root, target.path, "container")).isDirectory() ||
    lstatSync(resolve(root, target.path, "container")).isSymbolicLink()
  )
    fail("context_symlink");
  walk("container");
  return createHash("sha256")
    .update(
      files
        .sort()
        .map((file) => {
          const path = resolve(root, target.path, file);
          const bytes = readRegularFile(path, { allowAbsent: file === ".dockerignore" });
          if (bytes === null) return `${file} absent\n`;
          return `${file} ${createHash("sha256").update(bytes).digest("hex")}\n`;
        })
        .join(""),
    )
    .digest("hex");
}

export function containerProgress(steps) {
  const result = structuredClone(steps);
  for (const [key, value] of Object.entries(steps)) {
    if (key.startsWith("cf-deploy-") && value.outcome !== "skipped")
      result[key.replace(/^cf-deploy-/u, "deploy-")] = value;
  }
  for (const target of CONTAINER_TARGETS) {
    const deploy = result[`deploy-${target.name}`];
    if (
      deploy?.outcome === "success" &&
      steps[`verify-container-${target.name}`]?.outcome !== "success"
    )
      deploy.outcome = "failure";
  }
  return result;
}

function apiOperation(path, body) {
  if (body !== undefined) {
    if (
      path === "containers/registries/registry.cloudflare.com/credentials" &&
      same(body, { expiration_minutes: 5, permissions: ["pull"] })
    )
      return "registry_pull_credentials";
    fail("api_request_unknown");
  }
  if (path === "containers/me") return "containers_account";
  for (const target of CONTAINER_TARGETS) {
    if (path === `containers/applications/${target.appId}`) return "application";
    if (path === `containers/applications/${target.appId}/versions`) return "application_versions";
    if (path === `workers/scripts/${target.worker}/deployments`) return "worker_deployments";
    const prefix = `workers/scripts/${target.worker}/versions/`;
    if (
      path.startsWith(prefix) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(path.slice(prefix.length))
    )
      return "worker_version";
  }
  fail("api_request_unknown");
}

/** Failure diagnostics contain only allowlisted operations, closed codes and status numbers. */
export function cloudflareApi({
  accountId,
  token,
  deadline,
  now = Date.now,
  fetchImpl = fetch,
  reportDiagnostic = (diagnostic) => console.error(JSON.stringify(diagnostic)),
  reportResponse = () => {},
}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token) fail("credentials_missing");
  return async (path, body) => {
    const operation = apiOperation(path, body);
    const method = body === undefined ? "GET" : "POST";
    const reject = (code, status = null) => {
      reportDiagnostic({
        code: `cf_container_${code}`,
        operation,
        method,
        httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      });
      fail(code);
    };
    const remaining = deadline === undefined ? 30000 : Math.min(30000, Math.ceil(deadline - now()));
    if (remaining <= 0) fail("rollout_pending");
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
        {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(remaining),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
      reject("api_unavailable");
    }
    if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
    // Production credentials POST returns 201; every GET still requires 200.
    if (
      response.status !== 200 &&
      !(operation === "registry_pull_credentials" && response.status === 201)
    )
      reject("api_http", response.status);
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
      reject("api_response", response.status);
    }
    if (deadline !== undefined && now() >= deadline) fail("rollout_pending");
    if (envelope?.success !== true || envelope.result === undefined)
      reject("api_response", response.status);
    if (operation === "registry_pull_credentials") {
      const result = envelope.result;
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !["account_id", "username", "password"].every(
          (key) => typeof result[key] === "string" && result[key].length > 0,
        ) ||
        result.registry_host !== "registry.cloudflare.com"
      )
        reject("registry_credential_shape", response.status);
    }
    // This callback cannot receive the result, credential values or provider text.
    reportResponse({ operation, method, httpStatus: response.status });
    return envelope.result;
  };
}

export async function readApplication(target, api, accountId) {
  const allocation = (await api(`workers/scripts/${target.worker}/deployments`)).deployments?.[0]
    ?.versions;
  if (
    !Array.isArray(allocation) ||
    allocation.length !== 1 ||
    allocation[0].percentage !== 100 ||
    !/^[a-f0-9-]{36}$/u.test(allocation[0].version_id ?? "")
  )
    fail("worker_allocation");
  const version = await api(
    `workers/scripts/${target.worker}/versions/${allocation[0].version_id}`,
  );
  const app = await api(`containers/applications/${target.appId}`);
  return {
    ...applicationSnapshot(target, app, version.resources?.bindings, accountId),
    workerVersion: allocation[0].version_id,
  };
}

function quietExec(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1200000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch {
    fail("cli_failed");
  }
}

/** No override/install: use the target's already locked Wrangler. */
function rollbackWrangler(root, target) {
  const version = JSON.parse(readFileSync(resolve(root, target.path, "package.json"), "utf8"))
    .devDependencies?.wrangler;
  requireExportsWrangler(version);
  const binary = resolve(root, target.path, "node_modules/wrangler/bin/wrangler.js");
  const installed = JSON.parse(
    readFileSync(resolve(root, target.path, "node_modules/wrangler/package.json"), "utf8"),
  ).version;
  if (installed !== version) fail("wrangler_pin_mismatch");
  return binary;
}

export function prepareRollbackConfig(root, target) {
  rollbackWrangler(root, target);
  const path = resolve(root, target.path, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(path, "utf8"));
  const normalized = normalizeContainerRollback(target, config);
  const container = config.containers[0];
  if (
    container.image !== "./Dockerfile" ||
    (container.image_build_context !== undefined && container.image_build_context !== ".") ||
    container.image_vars !== undefined ||
    container.max_instances !== target.maxInstances ||
    container.instance_type !== "basic" ||
    !same(container.constraints?.regions, ["APAC"])
  )
    fail("rollback_build_unknown");
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const root = process.cwd();
  if (command === "validate") {
    const target = CONTAINER_TARGETS.find((entry) => entry.name === argument);
    if (!target) fail("target_unknown");
    // Service mise tasks run from the service directory.
    const projectRoot = resolve(root, "../..");
    localContainerImages(projectRoot, target);
    containerInputDigest(projectRoot, target);
    console.log("Container build identity verified: 1 target.");
    return;
  }
  if (command === "preflight") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const api = cloudflareApi({ accountId, token: process.env.CLOUDFLARE_API_TOKEN });
    const account = await api("containers/me");
    const counts = {
      targets: 0,
      cloudflareAccountMatches: 0,
      internalAccountMatches: 0,
      externalRegistryMatches: 0,
    };
    for (const target of CONTAINER_TARGETS) {
      const app = await api(`containers/applications/${target.appId}`);
      if (app.id !== target.appId || app.name !== target.appName) fail("application_identity");
      counts.targets++;
      if (app.account_id === accountId) counts.cloudflareAccountMatches++;
      if (typeof account.id === "string" && app.account_id === account.id)
        counts.internalAccountMatches++;
      try {
        registryImage(target, app.configuration?.image, account.external_account_id);
        counts.externalRegistryMatches++;
      } catch {
        /* Report only the comparison count; do not expose the image or ID. */
      }
    }
    console.log(JSON.stringify(counts));
    return;
  }
  const postDeadline = command === "post" ? Date.now() + CONTAINER_POSTCHECK_TIMEOUT_MS : undefined;
  const temp = process.env.RUNNER_TEMP;
  const plan = JSON.parse(readFileSync(resolve(temp, "release-plan.json"), "utf8"));
  const order = JSON.parse(readFileSync(resolve(root, "infra/deploy-order.json"), "utf8"));
  const targets = CONTAINER_TARGETS.filter((target) => plan.selected.includes(target.name));
  const path = resolve(temp, "container-manifest.json");
  const baseline = resolve(temp, "container-baseline.json");
  const legacy = (target) =>
    order.workers.find((entry) => entry.name === target.name)?.deployBackend !== "cf";
  if (command === "normalize") {
    for (const target of targets.filter(legacy)) {
      if (process.env.MODE !== "rollback") fail("legacy_release_refused");
      prepareRollbackConfig(root, target);
    }
  } else if (command === "capture") {
    if (targets.length === 0) {
      writeFileSync(path, "[]");
      return;
    }
    const daemonId = quietExec("docker", ["info", "--format", "{{.ID}}"]).trim();
    if (!/^[a-zA-Z0-9:-]{1,200}$/u.test(daemonId)) fail("daemon_invalid");
    const images = targets.map((target) => {
      let image;
      if (legacy(target)) {
        const localTag = `${target.appName}:rollback-${process.env.SHA.slice(0, 12)}`;
        const context = resolve(root, target.path);
        // Exact Wrangler 4.145/4.146 constructBuildCommand for the whitelisted no-vars context.
        if (process.env.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST) fail("network_override");
        quietExec(
          "docker",
          [
            "build",
            "--load",
            "-t",
            localTag,
            "--platform",
            "linux/amd64",
            "--provenance=false",
            "-f",
            "-",
            context,
          ],
          { input: readFileSync(resolve(context, "Dockerfile")) },
        );
        image = {
          name: target.name,
          appId: target.appId,
          appName: target.appName,
          localTag,
          imageId: dockerImageId(localTag),
          legacy: true,
        };
      } else image = { ...localContainerImages(root, target), legacy: false };
      return { ...image, inputs: containerInputDigest(root, target), daemonId };
    });
    writeFileSync(path, JSON.stringify(images));
  } else if (command === "prepare") {
    const images = JSON.parse(readFileSync(path, "utf8"));
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const api = cloudflareApi({ accountId, token: process.env.CLOUDFLARE_API_TOKEN });
    const snapshots = [];
    for (const target of targets) {
      const snapshot = await readApplication(target, api, accountId);
      const versions = await api(`containers/applications/${target.appId}/versions`);
      verifyApplicationBaseline(snapshot, snapshot, versions);
      snapshots.push(snapshot);
    }
    if (targets.length === 0) {
      writeFileSync(baseline, JSON.stringify({ registryNamespace: null, snapshots }));
      return;
    }
    const registryNamespace = (await api("containers/me")).external_account_id;
    if (!/^[a-z0-9_-]{1,64}$/u.test(registryNamespace ?? "")) fail("registry_namespace_invalid");
    for (const image of images.filter((entry) => entry.legacy)) {
      const target = targets.find((entry) => entry.name === image.name);
      if (
        dockerImageId(image.localTag) !== image.imageId ||
        containerInputDigest(root, target) !== image.inputs
      )
        fail("local_image_changed");
      quietExec(process.execPath, [
        rollbackWrangler(root, target),
        "containers",
        "push",
        image.localTag,
        "--config",
        resolve(root, target.path, "wrangler.jsonc"),
      ]);
      let digests;
      try {
        digests = JSON.parse(
          quietExec("docker", [
            "image",
            "inspect",
            "--format",
            "{{json .RepoDigests}}",
            `registry.cloudflare.com/${registryNamespace}/${image.localTag}`,
          ]),
        );
      } catch {
        fail("pushed_image_missing");
      }
      const found = digests.filter(
        (entry) =>
          typeof entry === "string" &&
          entry.startsWith(`registry.cloudflare.com/${registryNamespace}/${target.appName}@`),
      );
      if (found.length !== 1) fail("pushed_image_missing");
      const credentials = await api("containers/registries/registry.cloudflare.com/credentials", {
        expiration_minutes: 5,
        permissions: ["pull"],
      });
      await verifyRegistryImage({
        target,
        image: found[0],
        imageId: image.imageId,
        registryNamespace,
        ...credentials,
      });
      const configPath = resolve(root, target.path, "wrangler.jsonc");
      const config = parseJsonc(readFileSync(configPath, "utf8"));
      // Only the controlled registry/namespace/app and an immutable digest enter config.
      const immutable = registryImage(target, found[0], registryNamespace);
      config.containers[0].image = `registry.cloudflare.com/${immutable.repository}@${immutable.digest}`;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      image.registryImage = found[0];
    }
    writeFileSync(path, JSON.stringify(images));
    writeFileSync(baseline, JSON.stringify({ registryNamespace, snapshots }));
  } else if (command === "bind") {
    const recordPath = resolve(temp, "release-record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.containerManifestSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(recordPath, JSON.stringify(record));
  } else if (command === "verify-pre") {
    const record = JSON.parse(readFileSync(resolve(temp, "release-record.json"), "utf8"));
    if (
      record.containerManifestSha256 !==
      createHash("sha256").update(readFileSync(path)).digest("hex")
    )
      fail("manifest_changed");
    const images = JSON.parse(readFileSync(path, "utf8"));
    for (const image of images) {
      const target = targets.find((entry) => entry.name === image.name);
      if (
        !target ||
        (process.env.CONTAINER_RESTORED_DAEMON ?? image.daemonId) !==
          quietExec("docker", ["info", "--format", "{{.ID}}"]).trim() ||
        image.imageId !== dockerImageId(image.localTag) ||
        image.inputs !== containerInputDigest(root, target)
      )
        fail("local_image_changed");
      if (!image.legacy)
        verifyLocalContainerImages(
          Object.fromEntries(
            Object.entries(image).filter(
              ([key]) => !["legacy", "inputs", "daemonId"].includes(key),
            ),
          ),
          localContainerImages(root, target),
        );
    }
  } else if (command === "post") {
    const target = targets.find((entry) => entry.name === argument);
    if (!target) fail("target_unknown");
    const image = JSON.parse(readFileSync(path, "utf8")).find((entry) => entry.name === argument);
    const before = JSON.parse(readFileSync(baseline, "utf8"));
    const original = before.snapshots.find((entry) => entry.name === argument);
    const receipt = JSON.parse(readFileSync(resolve(temp, "resume-receipt.json"), "utf8"));
    const bound = receipt.targets.find((entry) => entry.name === argument);
    if (!bound) fail("publication_receipt_missing");
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const api = cloudflareApi({
      accountId,
      token: process.env.CLOUDFLARE_API_TOKEN,
      deadline: postDeadline,
    });
    const snapshot = await waitForApplicationPostcheck(
      async (deadline) => {
        // Every initial/final identity and allocation read shares the entry budget.
        const rolloutApi = cloudflareApi({
          accountId,
          token: process.env.CLOUDFLARE_API_TOKEN,
          deadline,
        });
        await currentRegistryNamespace(rolloutApi, before.registryNamespace);
        const current = await readApplication(target, rolloutApi, accountId);
        verifyApplicationIdentity(original, current);
        const versions = await rolloutApi(`containers/applications/${target.appId}/versions`);
        verifyApplicationVersions(versions);
        if (
          current.workerVersion !== bound.workerVersion ||
          current.version < original.version ||
          (current.version === original.version && current.image !== original.image) ||
          current.version > bound.version ||
          versions.some((entry) => entry.version > bound.version) ||
          (current.version === bound.version && current.image !== bound.image)
        )
          fail("publication_superseded");
        // Completion is evaluated against the exact intended publication, even
        // while GET application still describes the previous desired version.
        return { snapshot: current, versions };
      },
      async (current, deadline) => {
        const credentials = await api("containers/registries/registry.cloudflare.com/credentials", {
          expiration_minutes: 5,
          permissions: ["pull"],
        });
        const registryNamespace = await currentRegistryNamespace(api, before.registryNamespace);
        await verifyRegistryImage({
          target,
          image: current.image,
          imageId: image.imageId,
          registryNamespace,
          deadline,
          ...credentials,
        });
        if (image.legacy && image.registryImage !== current.image) fail("rollback_image_changed");
      },
      { publication: bound, deadline: postDeadline },
    );
    if (Date.now() >= postDeadline) fail("rollout_pending");
    // applicationSnapshot returned only validated operational IDs, digest and rollout scalars.
    writeFileSync(resolve(temp, `container-${argument}-verified.json`), JSON.stringify(snapshot));
  } else if (command === "progress") {
    process.stdout.write(JSON.stringify(containerProgress(JSON.parse(process.env.STEPS_JSON))));
    return;
  } else fail("command_invalid");
  console.log(`Container guard ${command}: ${targets.length} targets.`);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    await main();
  } catch (error) {
    console.error(
      /^cf_container_[a-z_]+$/u.test(error.message) ? error.message : "cf_container_guard_failed",
    );
    process.exitCode = 1;
  }
}
