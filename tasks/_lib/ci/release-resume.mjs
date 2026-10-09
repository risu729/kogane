// Immutable checkpoints for the existing serial production deployment.
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  unlinkSync,
  linkSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clientFromEnv, request, paginate } from "./github-api.mjs";
import { isReleaseRecord, setDeploymentStatus } from "./release-ledger.mjs";
import { canonicalJson } from "./release-manifest.mjs";
import {
  CONTAINER_TARGETS,
  cloudflareApi,
  readApplication,
  verifyApplicationIdentity,
  verifyApplicationBaseline,
  verifyRegistryImage,
  registryImage,
  dockerImageId,
  containerInputDigest,
  currentRegistryNamespace,
} from "./cf-container-release.mjs";

const fail = (code) => {
  throw new Error(`release_resume_${code}`);
};
const HASH_CHUNK_BYTES = 64 * 1024;
const hash = (data) => {
  const digest = createHash("sha256");
  if (typeof data === "string") digest.update(data);
  else
    for (let offset = 0; offset < data.length; offset += HASH_CHUNK_BYTES)
      digest.update(data.subarray(offset, offset + HASH_CHUNK_BYTES));
  return digest.digest("hex");
};
// Preserve deliberate refusal codes; expose only a closed stage for unexpected failures.
const stage = async (name, action) => {
  try {
    return await action();
  } catch (error) {
    if (/^release_resume_[a-z_]+$/u.test(error?.message)) throw error;
    fail(name);
  }
};

/** Untrusted bytes stay private until their complete bound SHA-256 matches. */
export async function streamArtifact(body, digest, temp, { beforePromote = () => {} } = {}) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) fail("binding_invalid");
  const directory = await stage("artifact_stage", () =>
    mkdtempSync(resolve(temp, "release-resume-artifact-")),
  );
  const partial = resolve(directory, "artifact.part"),
    zip = resolve(directory, "artifact.zip");
  let fd;
  try {
    fd = await stage("artifact_write", () =>
      openSync(
        partial,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    );
    const calculated = createHash("sha256");
    await stage("artifact_body", async () => {
      if (!body) fail("artifact_body");
      for await (const chunk of body) {
        // Bound even an unexpected custom producer; never pass >INT_MAX to Hash.update.
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 64 * 1024 * 1024)
          fail("artifact_chunk");
        for (let offset = 0; offset < chunk.byteLength; offset += HASH_CHUNK_BYTES) {
          const bytes = chunk.subarray(offset, offset + HASH_CHUNK_BYTES);
          await stage("artifact_hash", () => calculated.update(bytes));
          await stage("artifact_write", () => {
            let written = 0;
            while (written < bytes.byteLength) {
              const count = writeSync(fd, bytes, written, bytes.byteLength - written);
              if (!count) fail("artifact_write");
              written += count;
            }
          });
        }
      }
    });
    await stage("artifact_write", () => closeSync(fd));
    fd = undefined;
    if (`sha256:${calculated.digest("hex")}` !== digest) fail("artifact_digest");
    await stage("artifact_promote", () => {
      beforePromote(directory);
      // Exclusive promotion cannot replace a preexisting file or symlink.
      linkSync(partial, zip);
      unlinkSync(partial);
    });
    return { directory, zip };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    // Only the directory just created by this invocation is eligible for cleanup.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => writeFileSync(file, canonicalJson(value));
const output = (values) =>
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
const exec = (bin, args, failure = "local_command_failed") => {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail(failure);
  }
};

/** Open once without following symlinks; inspect and read the held descriptor. */
export function copyPrepared(source, dest, { openImpl = openSync } = {}) {
  const fd = openImpl(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      // Ubuntu release runners: hold the directory even if its source path changes.
      const directory = `/proc/self/fd/${fd}`;
      for (const name of readdirSync(directory))
        copyPrepared(resolve(directory, name), resolve(dest, name), { openImpl });
    } else if (stat.isFile()) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(fd));
    } else fail("prepared_shape");
  } finally {
    closeSync(fd);
  }
}
export function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id !== value) fail("identity_invalid");
  return id;
}

export function selectResumeDeployment(deployments, { runId, sha, trustedSha }) {
  const records = deployments.filter((d) => isReleaseRecord(d.payload)).sort((a, b) => b.id - a.id);
  const own = records.find((d) => d.payload.runId === runId);
  if (!own) return null;
  // Failed and pending releases may have published too; successful-only is insufficient.
  if (records[0].id !== own.id) fail("superseded");
  const binding = own.payload.resume;
  if (
    !binding ||
    own.sha !== sha ||
    own.payload.sha !== sha ||
    binding.runId !== runId ||
    binding.sha !== sha ||
    binding.trustedSha !== trustedSha ||
    !Number.isSafeInteger(binding.attempt) ||
    binding.attempt < 1 ||
    !Number.isSafeInteger(binding.artifactId) ||
    binding.artifactId < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.artifactDigest)
  )
    fail("binding_invalid");
  return own;
}

export function verifyArtifactMetadata(metadata, binding, runId) {
  if (
    metadata.id !== binding.artifactId ||
    metadata.expired !== false ||
    metadata.workflow_run?.id !== Number(runId) ||
    metadata.digest !== binding.artifactDigest
  )
    fail("artifact_identity");
}
export function verifyArtifactBytes(bytes, digest) {
  if (`sha256:${hash(bytes)}` !== digest) fail("artifact_digest");
}
export function parseCheckpointStatus(description) {
  const found = /^kogane-resume-v1:([1-9][0-9]*):([a-f0-9]{64})$/u.exec(description ?? "");
  if (!found || !Number.isSafeInteger(Number(found[1]))) return null;
  return { artifactId: Number(found[1]), artifactDigest: `sha256:${found[2]}` };
}
export function mergePublicationSteps(saved, current) {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(saved ?? {})) {
    if (
      CONTAINER_TARGETS.some((target) =>
        ["deploy-" + target.name, "cf-deploy-" + target.name].includes(key),
      ) &&
      value.outcome === "success" &&
      (!result[key] || result[key].outcome === "skipped")
    )
      result[key] = value;
  }
  return result;
}
export function verifyReceipt(receipt, deployment, context) {
  const binding = deployment.payload.resume;
  if (
    receipt.version !== "release-resume-v1" ||
    receipt.deploymentId !== deployment.id ||
    receipt.recordSha256 !== hash(canonicalJson(deployment.payload)) ||
    receipt.runId !== context.runId ||
    receipt.sha !== context.sha ||
    receipt.trustedSha !== context.trustedSha ||
    receipt.originalAttempt !== binding.attempt ||
    !Number.isSafeInteger(receipt.attempt) ||
    receipt.attempt < binding.attempt ||
    receipt.attempt > context.attempt ||
    !Array.isArray(receipt.targets) ||
    receipt.targets.length < 1 ||
    !receipt.steps ||
    typeof receipt.steps !== "object"
  )
    fail("receipt_identity");
  const published = new Set(
    Object.entries(receipt.steps)
      .filter(([key, value]) => /^(?:cf-)?deploy-/u.test(key) && value.outcome === "success")
      .map(([key]) => key.replace(/^(?:cf-)?deploy-/u, "")),
  );
  for (const target of receipt.targets) {
    if (
      !CONTAINER_TARGETS.some((entry) => entry.name === target.name) ||
      !published.has(target.name) ||
      !uuid.test(target.workerVersion) ||
      !Number.isSafeInteger(target.version) ||
      target.version < 0 ||
      typeof target.image !== "string" ||
      !Array.isArray(target.namespaces)
    )
      fail("receipt_target");
  }
  if (new Set(receipt.targets.map((target) => target.name)).size !== receipt.targets.length)
    fail("receipt_target");
  return receipt.targets.map((target) => target.name);
}
/** Unique new version, never the current desired version or arbitrary latest match. */
export function publicationCandidate(before, versions, registryNamespace, target) {
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
  const candidates = versions.filter((entry) => entry.version > before.version);
  if (candidates.length === 0) fail("publication_pending");
  if (candidates.length !== 1) fail("publication_ambiguous");
  registryImage(target, candidates[0].configuration?.image, registryNamespace);
  return candidates[0];
}
/** Retry only an absent allocation target; all schema/identity/read errors are final. */
export async function waitForPublicationCandidate(
  readState,
  {
    before,
    target,
    publishedVersion,
    deadline,
    now = Date.now,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  },
) {
  while (now() < deadline) {
    const state = await readState(deadline);
    if (now() >= deadline) fail("publication_pending");
    verifyApplicationIdentity(before, state.snapshot);
    if (!uuid.test(publishedVersion) || state.snapshot.workerVersion !== publishedVersion)
      fail("published_worker_mismatch");
    if (
      state.snapshot.version < before.version ||
      (state.snapshot.version === before.version && state.snapshot.image !== before.image)
    )
      fail("application_superseded");
    try {
      const candidate = publicationCandidate(
        before,
        state.versions,
        state.registryNamespace,
        target,
      );
      verifyBoundPublication(
        { ...state.snapshot, version: candidate.version, image: candidate.configuration.image },
        state.snapshot,
      );
      return { ...state, candidate };
    } catch (error) {
      if (error.message !== "release_resume_publication_pending") throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(5000, remaining));
  }
  fail("publication_pending");
}

export function verifyBoundPublication(bound, snapshot) {
  verifyApplicationIdentity(bound, snapshot);
  if (snapshot.workerVersion !== bound.workerVersion) fail("worker_superseded");
  if (
    snapshot.version > bound.version ||
    (snapshot.version === bound.version && snapshot.image !== bound.image)
  )
    fail("application_superseded");
}
export function verifyResumeContainerState(before, bound, current, versions) {
  verifyApplicationIdentity(before, current);
  if (!Array.isArray(versions) || versions.some((entry) => !Number.isSafeInteger(entry.version)))
    fail("version_shape");
  const expected = bound ?? before;
  if (versions.some((entry) => entry.version > expected.version)) fail("application_superseded");
  if (bound) {
    verifyBoundPublication(bound, current);
    if (
      !versions.some(
        (entry) => entry.version === bound.version && entry.configuration?.image === bound.image,
      )
    )
      fail("publication_missing");
  } else if (
    current.workerVersion !== before.workerVersion ||
    current.version !== before.version ||
    current.image !== before.image
  )
    fail("unpublished_target_changed");
  if (!bound) verifyApplicationBaseline(before, current, versions);
}

export function validatePreparedPaths(paths) {
  if (
    paths.some(
      (path) =>
        !/^(?:checkout|temp)\/[a-zA-Z0-9_./-]+$/u.test(path) ||
        path.split("/").some((part) => part === ".." || part === "." || part === ""),
    )
  )
    fail("archive_path");
}

async function apiContext() {
  const client = clientFromEnv(process.env);
  return { client, base: `${client.apiUrl}/repos/${client.owner}/${client.repo}` };
}
async function download(binding, temp, context) {
  const artifactId = positiveId(binding.artifactId);
  if (!/^sha256:[a-f0-9]{64}$/u.test(binding.artifactDigest)) fail("binding_invalid");
  const { client, base } = await apiContext();
  const metadata = await stage(
    "artifact_metadata",
    async () =>
      (await request(`${base}/actions/artifacts/${artifactId}`, { token: client.token })).data,
  );
  verifyArtifactMetadata(metadata, binding, context.runId);
  const response = await stage("artifact_redirect", () =>
    fetch(`${base}/actions/artifacts/${artifactId}/zip`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${client.token}`, "X-GitHub-Api-Version": "2022-11-28" },
    }),
  );
  if (response.status !== 302) fail("artifact_download");
  const url = await stage("artifact_redirect", () => new URL(response.headers.get("location")));
  if (url.protocol !== "https:" || url.username || url.password) fail("artifact_download");
  // The signed download URL receives no GitHub or production credentials.
  const archive = await stage("artifact_fetch", () =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(300000) }),
  );
  if (archive.status !== 200) fail("artifact_download");
  const { directory, zip } = await streamArtifact(archive.body, binding.artifactDigest, temp);
  try {
    const paths = exec("unzip", ["-Z1", zip], "artifact_list").trim().split("\n");
    if (paths.some((path) => !["prepared.tar", "resume-receipt.json"].includes(path)))
      fail("archive_shape");
    exec("unzip", ["-o", zip, "-d", directory], "artifact_extract");
    await stage("artifact_cleanup", () => unlinkSync(zip));
    return directory;
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const root = process.cwd(),
    temp = process.env.RUNNER_TEMP;
  const context = {
    runId: process.env.GITHUB_RUN_ID,
    sha: process.env.SHA,
    trustedSha: process.env.TRUSTED_SHA,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const receiptPath = resolve(temp, "resume-receipt.json"),
    recordPath = resolve(temp, "release-record.json");
  if (command === "resource-check") {
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES, 0x5a);
    const bytes = 2 ** 31 + HASH_CHUNK_BYTES;
    async function* chunks() {
      for (let offset = 0; offset < bytes; offset += chunk.length) yield chunk;
    }
    const artifact = await streamArtifact(
      chunks(),
      "sha256:dd898751fdb6f848addfe85e5bb85fb070e31313a77654c1e664ab707e7de031",
      temp,
    );
    try {
      const fd = openSync(artifact.zip, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (fstatSync(fd).size !== bytes) fail("resource_size");
      } finally {
        closeSync(fd);
      }
      if (process.resourceUsage().maxRSS > 256 * 1024) fail("resource_memory");
      console.log(
        `Verified ${bytes} streamed bytes; peak RSS ${process.resourceUsage().maxRSS} KiB`,
      );
    } finally {
      rmSync(artifact.directory, { recursive: true, force: true });
    }
    return;
  }
  if (command === "discover") {
    const { client, base } = await apiContext();
    const listed = await paginate(`${base}/deployments?environment=production&per_page=100`, {
      token: client.token,
    });
    const deployment = selectResumeDeployment(listed, context);
    if (!deployment) {
      output({ resume: "false", published: "[]" });
      return;
    }
    const statuses = await paginate(`${base}/deployments/${deployment.id}/statuses?per_page=100`, {
      token: client.token,
    });
    const latest = [...statuses].sort((a, b) => b.id - a.id)[0];
    if (latest?.state === "success") fail("already_completed");
    const bound = [...statuses]
      .filter((s) => s.state === "in_progress")
      .sort((a, b) => b.id - a.id)
      .map((s) => parseCheckpointStatus(s.description))
      .find(Boolean);
    if (!bound) fail("checkpoint_missing");
    const directory = await download(bound, temp, context);
    const receipt = json(resolve(directory, "resume-receipt.json"));
    const published = verifyReceipt(receipt, deployment, context);
    write(receiptPath, receipt);
    write(recordPath, deployment.payload);
    rmSync(directory, { recursive: true, force: true });
    output({
      resume: "true",
      published: JSON.stringify(published),
      "deployment-id": String(deployment.id),
    });
    return;
  }
  if (command === "pack") {
    const stage = resolve(temp, "prepared"),
      manifest = json(resolve(temp, "release-manifest.json"));
    mkdirSync(resolve(stage, "checkout"), { recursive: true });
    mkdirSync(resolve(stage, "temp"), { recursive: true });
    const paths = new Set(manifest.configs.map((entry) => entry.path));
    for (const bundle of manifest.bundles) paths.add(bundle.directory);
    for (const artifact of manifest.cfArtifacts ?? []) {
      const worker = manifest.workers.find((w) => w.name === artifact.name);
      paths.add(`${worker.path}/.cloudflare/output/v0`);
    }
    for (const path of paths) copyPrepared(resolve(root, path), resolve(stage, "checkout", path));
    for (const path of [
      "release-plan.json",
      "release-manifest.json",
      "container-manifest.json",
      "container-baseline.json",
      "cf-do-identity.json",
      "previous-record.json",
    ])
      if (existsSync(resolve(temp, path)))
        copyPrepared(resolve(temp, path), resolve(stage, "temp", path));
    const images = json(resolve(temp, "container-manifest.json"));
    if (images.length)
      exec("docker", [
        "image",
        "save",
        "--output",
        resolve(stage, "temp", "docker-images.tar"),
        ...images.map((i) => i.localTag),
      ]);
    exec("tar", ["-cf", resolve(temp, "prepared.tar"), "-C", stage, "checkout", "temp"]);
    return;
  }
  if (command === "bind") {
    const record = json(recordPath);
    record.resume = {
      runId: context.runId,
      sha: context.sha,
      trustedSha: context.trustedSha,
      attempt: context.attempt,
      artifactId: Number(process.env.ARTIFACT_ID),
      artifactDigest: process.env.ARTIFACT_DIGEST,
    };
    record.containerBaselineSha256 = hash(readFileSync(resolve(temp, "container-baseline.json")));
    write(recordPath, record);
    return;
  }
  if (command === "restore") {
    const { record, receipt } = await stage("restore_binding", () => ({
      record: json(recordPath),
      receipt: json(receiptPath),
    }));
    const directory = await download(record.resume, temp, context);
    const archive = resolve(directory, "prepared.tar");
    const paths = exec("tar", ["-tf", archive], "prepared_list")
      .trim()
      .split("\n")
      .map((p) => p.replace(/\/$/u, ""));
    validatePreparedPaths(paths.filter((p) => !["checkout", "temp"].includes(p)));
    const restored = await stage("prepared_stage", () =>
      mkdtempSync(resolve(temp, "release-resume-restored-")),
    );
    exec("tar", ["-xf", archive, "-C", restored, "--no-same-owner"], "prepared_extract");
    await stage("prepared_cleanup", () => {
      unlinkSync(archive);
      rmSync(directory, { recursive: true, force: true });
    });
    const images = await stage("prepared_binding", () => {
      if (
        hash(readFileSync(resolve(restored, "temp/container-manifest.json"))) !==
          record.containerManifestSha256 ||
        hash(readFileSync(resolve(restored, "temp/container-baseline.json"))) !==
          record.containerBaselineSha256
      )
        fail("prepared_binding");
      return json(resolve(restored, "temp/container-manifest.json"));
    });
    let imageDirectory;
    if (images.length) {
      imageDirectory = await stage("image_stage", () =>
        mkdtempSync(resolve(temp, "release-resume-images-")),
      );
      // Both paths are within RUNNER_TEMP: rename fails closed rather than copying across filesystems.
      await stage("image_move", () =>
        renameSync(
          resolve(restored, "temp/docker-images.tar"),
          resolve(imageDirectory, "docker-images.tar"),
        ),
      );
    }
    exec("cp", ["-a", `${restored}/checkout/.`, root], "prepared_checkout");
    exec("cp", ["-a", `${restored}/temp/.`, temp], "prepared_state");
    await stage("prepared_cleanup", () => rmSync(restored, { recursive: true, force: true }));
    if (images.length)
      exec(
        "docker",
        ["image", "load", "--input", resolve(imageDirectory, "docker-images.tar")],
        "image_load",
      );
    await stage("restored_image", () => {
      for (const image of images) {
        const target = CONTAINER_TARGETS.find((t) => t.name === image.name);
        if (
          !target ||
          dockerImageId(image.localTag) !== image.imageId ||
          containerInputDigest(root, target) !== image.inputs
        )
          fail("restored_image");
      }
    });
    if (images.length) {
      await stage("image_cleanup", () => rmSync(imageDirectory, { recursive: true, force: true }));
      await stage("image_daemon", () =>
        appendFileSync(
          process.env.GITHUB_ENV,
          `CONTAINER_RESTORED_DAEMON=${exec("docker", ["info", "--format", "{{.ID}}"], "image_daemon").trim()}\n`,
        ),
      );
    }
    const api = cloudflareApi({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    const original = json(resolve(temp, "container-baseline.json"));
    for (const baseline of original.snapshots) {
      const target = CONTAINER_TARGETS.find((entry) => entry.name === baseline.name);
      if (!target) fail("prepared_binding");
      const current = await stage("restore_application", () =>
        readApplication(target, api, process.env.CLOUDFLARE_ACCOUNT_ID),
      );
      const versions = await stage("restore_versions", () =>
        api(`containers/applications/${target.appId}/versions`),
      );
      verifyResumeContainerState(
        baseline,
        receipt.targets.find((entry) => entry.name === baseline.name),
        current,
        versions,
      );
    }
    const doBaseline = resolve(temp, "cf-do-identity.json");
    if (existsSync(doBaseline))
      exec(
        process.execPath,
        [fileURLToPath(new URL("./cf-do-identity.mjs", import.meta.url)), "verify", doBaseline],
        "restore_do_identity",
      );
    return;
  }
  if (command === "verify-publication-baseline") {
    const before = json(resolve(temp, "container-baseline.json"));
    const target = CONTAINER_TARGETS.find((entry) => entry.name === argument);
    const baseline = before.snapshots.find((entry) => entry.name === argument);
    if (!target || !baseline) fail("prepared_binding");
    const api = cloudflareApi({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      deadline: Date.now() + 30000,
    });
    const current = await readApplication(target, api, process.env.CLOUDFLARE_ACCOUNT_ID);
    const versions = await api(`containers/applications/${target.appId}/versions`);
    await currentRegistryNamespace(api, before.registryNamespace);
    verifyApplicationBaseline(baseline, current, versions);
    return;
  }
  if (command === "capture") {
    const record = json(recordPath),
      before = json(resolve(temp, "container-baseline.json"));
    const saved = existsSync(receiptPath) ? json(receiptPath) : null;
    const target = CONTAINER_TARGETS.find((t) => t.name === argument);
    const image = json(resolve(temp, "container-manifest.json")).find((i) => i.name === argument);
    if (!target || !image || !before.snapshots.some((entry) => entry.name === argument))
      fail("prepared_binding");
    const deadline = Date.now() + 30000;
    const api = cloudflareApi({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      deadline,
    });
    const baseline = before.snapshots.find((s) => s.name === argument);
    let publishedVersion = process.env.PUBLISHED_WORKER_VERSION;
    if (!publishedVersion && process.env.LEGACY_PUBLICATION === "true") {
      const first = await readApplication(target, api, process.env.CLOUDFLARE_ACCOUNT_ID);
      if (first.workerVersion !== baseline.workerVersion) publishedVersion = first.workerVersion;
    }
    if (!uuid.test(publishedVersion ?? "")) fail("published_worker_mismatch");
    const readState = async () => ({
      snapshot: await readApplication(target, api, process.env.CLOUDFLARE_ACCOUNT_ID),
      versions: await api(`containers/applications/${target.appId}/versions`),
      registryNamespace: await currentRegistryNamespace(api, before.registryNamespace),
    });
    const { snapshot, candidate, registryNamespace } = await waitForPublicationCandidate(
      readState,
      {
        before: baseline,
        target,
        publishedVersion,
        deadline,
      },
    );
    const credentials = await api("containers/registries/registry.cloudflare.com/credentials", {
      expiration_minutes: 5,
      permissions: ["pull"],
    });
    await verifyRegistryImage({
      target,
      image: candidate.configuration.image,
      imageId: image.imageId,
      registryNamespace,
      ...credentials,
      deadline,
    });
    if (image.legacy && image.registryImage !== candidate.configuration.image)
      fail("rollback_image_changed");
    // Reconfirm the complete exact target after registry proof, before any receipt can be written.
    const final = await readState();
    if (Date.now() >= deadline) fail("publication_pending");
    if (
      final.snapshot.version < baseline.version ||
      (final.snapshot.version === baseline.version && final.snapshot.image !== baseline.image)
    )
      fail("application_superseded");
    const finalCandidate = publicationCandidate(
      baseline,
      final.versions,
      final.registryNamespace,
      target,
    );
    if (
      finalCandidate.version !== candidate.version ||
      finalCandidate.configuration.image !== candidate.configuration.image
    )
      fail("application_superseded");
    const bound = { ...snapshot, version: candidate.version, image: candidate.configuration.image };
    verifyBoundPublication(bound, final.snapshot);
    const steps = mergePublicationSteps(saved?.steps, JSON.parse(process.env.STEPS_JSON));
    write(receiptPath, {
      version: "release-resume-v1",
      deploymentId: Number(process.env.DEPLOYMENT_ID),
      recordSha256: hash(canonicalJson(record)),
      runId: context.runId,
      sha: context.sha,
      trustedSha: context.trustedSha,
      originalAttempt: record.resume.attempt,
      attempt: context.attempt,
      steps,
      targets: [...(saved?.targets ?? []).filter((t) => t.name !== argument), bound],
    });
    return;
  }
  if (command === "checkpoint") {
    const receipt = json(receiptPath);
    await setDeploymentStatus(clientFromEnv(process.env), {
      id: positiveId(receipt.deploymentId),
      state: "in_progress",
      description: `kogane-resume-v1:${process.env.ARTIFACT_ID}:${process.env.ARTIFACT_DIGEST.replace(/^sha256:/u, "")}`,
    });
    return;
  }
  if (command === "progress") {
    const saved = existsSync(receiptPath) ? json(receiptPath).steps : {};
    process.stdout.write(
      JSON.stringify(mergePublicationSteps(saved, JSON.parse(process.env.STEPS_JSON))),
    );
    return;
  }
  fail("command_unknown");
}
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    await main();
  } catch (error) {
    console.error(
      process.argv[2] === "capture" && error.message === "cf_container_rollout_pending"
        ? "release_resume_publication_pending"
        : /^(?:release_resume|cf_container)_[a-z_]+$/u.test(error.message)
          ? error.message
          : `release_resume_${process.argv[2] === "restore" ? "restore_failed" : "failed"}`,
    );
    process.exitCode = 1;
  }
}
