import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../../scripts/jsonc.ts";

/** Existing namespaces are a prerequisite; this path never applies DO migrations. */
export function preservedDoTargets({ root, order, selected }) {
  return order.workers
    .filter(
      (worker) =>
        worker.deployBackend === "cf" &&
        worker.doLifecycle === "preserve" &&
        selected.includes(worker.name),
    )
    .map((worker) => {
      const config = parseJsonc(
        readFileSync(resolve(root, worker.path, worker.config), "utf8"),
        worker.config,
      );
      const tag = config.migrations?.at(-1)?.tag;
      const bindings = config.durable_objects?.bindings;
      if (
        typeof tag !== "string" ||
        tag.length === 0 ||
        !Array.isArray(bindings) ||
        bindings.length === 0 ||
        bindings.some(
          (binding) =>
            typeof binding.name !== "string" ||
            typeof binding.class_name !== "string" ||
            (binding.script_name !== undefined && binding.script_name !== worker.worker),
        )
      ) {
        throw new Error(`cf_do_invalid_canonical_lifecycle_${worker.name}`);
      }
      return {
        name: worker.name,
        worker: worker.worker,
        migrationTag: tag,
        bindings: bindings
          .map((binding) => ({ name: binding.name, className: binding.class_name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
}

/** Require code-only build output to keep the canonical self-worker bindings. */
export function verifyPreservedDoArtifact(target, artifact) {
  if (
    artifact.name !== target.worker ||
    artifact.exports !== undefined ||
    artifact.migrations !== undefined
  )
    throw new Error("cf_do_artifact_lifecycle_changed");
  const found = Object.entries(artifact.env ?? {})
    .filter(([, binding]) => binding.type === "durable-object")
    .map(([name, binding]) => ({ name, className: binding.exportName, worker: binding.worker }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const expected = target.bindings.map((binding) => ({ ...binding, worker: target.worker }));
  if (JSON.stringify(found) !== JSON.stringify(expected))
    throw new Error("cf_do_artifact_binding_changed");
}

export async function readDoIdentity({ targets, accountId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token)
    throw new Error("cf_do_credentials_missing");
  const api = async (path) => {
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/${path}`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch {
      throw new Error("cf_do_readback_unavailable");
    }
    if (response.status !== 200) throw new Error(`cf_do_readback_http_${response.status}`);
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error("cf_do_readback_invalid_response");
    }
    if (envelope?.success !== true || !envelope.result)
      throw new Error("cf_do_readback_invalid_response");
    return envelope.result;
  };
  const snapshot = [];
  for (const target of targets) {
    if (!/^[a-z0-9-]{1,63}$/u.test(target.worker)) throw new Error("cf_do_invalid_worker");
    const service = await api(`services/${target.worker}`);
    if (service.default_environment?.script?.migration_tag !== target.migrationTag)
      throw new Error(`cf_do_pending_lifecycle_${target.name}`);
    const deployment = (await api(`scripts/${target.worker}/deployments`)).deployments?.[0];
    if (
      !Array.isArray(deployment?.versions) ||
      deployment.versions.length === 0 ||
      deployment.versions.some(
        (version) =>
          !/^[a-f0-9-]{36}$/u.test(version.version_id ?? "") ||
          typeof version.percentage !== "number" ||
          version.percentage <= 0,
      ) ||
      deployment.versions.reduce((total, version) => total + version.percentage, 0) !== 100
    )
      throw new Error(`cf_do_invalid_allocation_${target.name}`);
    let identities;
    for (const allocation of deployment.versions) {
      const version = await api(`scripts/${target.worker}/versions/${allocation.version_id}`);
      const live = version.resources?.bindings;
      if (!Array.isArray(live)) throw new Error(`cf_do_bindings_missing_${target.name}`);
      if (
        live.filter((binding) => binding.type === "durable_object_namespace").length !==
        target.bindings.length
      )
        throw new Error(`cf_do_binding_set_changed_${target.name}`);
      const found = target.bindings.map((binding) => {
        const matches = live.filter(
          (candidate) =>
            candidate.type === "durable_object_namespace" &&
            candidate.name === binding.name &&
            candidate.class_name === binding.className &&
            (candidate.script_name === undefined || candidate.script_name === target.worker),
        );
        if (matches.length !== 1 || !/^[a-f0-9]{32}$/u.test(matches[0].namespace_id ?? ""))
          throw new Error(`cf_do_namespace_missing_${target.name}_${binding.name}`);
        return { ...binding, namespaceId: matches[0].namespace_id };
      });
      if (identities !== undefined && JSON.stringify(identities) !== JSON.stringify(found))
        throw new Error(`cf_do_active_namespace_conflict_${target.name}`);
      identities = found;
    }
    snapshot.push({
      name: target.name,
      worker: target.worker,
      migrationTag: target.migrationTag,
      bindings: identities,
    });
  }
  return snapshot;
}

export function verifyDoIdentity(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("cf_do_namespace_identity_changed");
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const [mode, baselinePath] = process.argv.slice(2);
  if (!["capture", "verify", "validate"].includes(mode) || !baselinePath)
    throw new Error("cf_do_invalid_command");
  const root =
    mode === "validate" ? fileURLToPath(new URL("../../../", import.meta.url)) : process.cwd();
  const order = JSON.parse(readFileSync(resolve(root, "infra/deploy-order.json"), "utf8"));
  if (mode === "validate") {
    const targets = preservedDoTargets({ root, order, selected: [baselinePath] });
    if (targets.length !== 1) throw new Error("cf_do_invalid_artifact_target");
    const worker = order.workers.find((entry) => entry.name === baselinePath);
    const artifact = JSON.parse(
      readFileSync(
        resolve(root, worker.path, ".cloudflare/output/v0/workers/default/worker.config.json"),
        "utf8",
      ),
    );
    verifyPreservedDoArtifact(targets[0], artifact);
    console.log(`Existing DO build identity verified: ${baselinePath}.`);
  } else {
    const plan = JSON.parse(
      readFileSync(resolve(process.env.RUNNER_TEMP, "release-plan.json"), "utf8"),
    );
    const targets = preservedDoTargets({ root, order, selected: plan.selected });
    const snapshot = await readDoIdentity({
      targets,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    if (mode === "capture") writeFileSync(baselinePath, JSON.stringify(snapshot));
    else verifyDoIdentity(JSON.parse(readFileSync(baselinePath, "utf8")), snapshot);
    console.log(
      `Existing DO identity ${mode === "capture" ? "captured" : "verified"}: ${snapshot.length} Workers.`,
    );
  }
}
