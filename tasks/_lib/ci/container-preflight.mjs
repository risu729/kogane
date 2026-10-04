// GET-only by default; explicit credential probe mints and discards one five-minute pull credential.
import { pathToFileURL } from "node:url";
import { cloudflareApi, isBasicApplicationConfiguration } from "./cf-container-release.mjs";

const targets = [
  {
    worker: "kogane-globalpass-collector-poc",
    appId: "a03ac341-52a7-4e81-9a7c-279a90cc4b0c",
    appName: "kogane-globalpass-collector-poc-globalpasscollectorcontainer",
    className: "GlobalPassCollectorContainer",
    maxInstances: 2,
  },
  {
    worker: "kogane-sbi-shinsei-collector-poc",
    appId: "a03d0e7f-2b1f-4650-a8e6-b78123d53aa5",
    appName: "kogane-sbi-shinsei-collector-poc-sbishinseicollectorcontainer",
    className: "SbiShinseiCollectorContainer",
    maxInstances: 2,
  },
  {
    worker: "kogane-st-george-collector",
    appId: "a032f0dd-e68f-4c69-9f25-901ae7422e74",
    appName: "kogane-st-george-collector-stgeorgecollectorcontainer",
    className: "StGeorgeCollectorContainer",
    maxInstances: 1,
  },
];

export async function inspectContainers({ accountId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token)
    throw new Error("container_preflight_credentials_missing");
  async function get(path, label) {
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
        {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch {
      throw new Error(`container_preflight_${label}_unavailable`);
    }
    if (response.status !== 200)
      throw new Error(`container_preflight_${label}_http_${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`container_preflight_${label}_response`);
    }
    if (body?.success !== true || body.result === null || typeof body.result !== "object")
      throw new Error(`container_preflight_${label}_response`);
    return body.result;
  }
  const account = await get("containers/me", "account");
  const counts = {
    targets: 0,
    applicationIdentityMatches: 0,
    cloudflareAccountMatches: 0,
    containersAccountMatches: 0,
    externalRegistryDigestMatches: 0,
    defaultPolicyAndResourcesMatch: 0,
    defaultSchedulingPolicies: 0,
    missingSchedulingPolicies: 0,
    basicInstanceTypes: 0,
    basicResourceSizesMatch: 0,
    missingInstanceTypes: 0,
    maxInstanceLimitsMatch: 0,
    missingMaxInstanceLimits: 0,
    apacRegionConstraints: 0,
    missingRegionConstraints: 0,
    zeroActiveInstances: 0,
    zeroAssignedInstances: 0,
    activeRolloutsCompleted: 0,
    activeRolloutsPending: 0,
    activeRolloutsProgressing: 0,
    activeRolloutsOther: 0,
    rolloutTargetVersionMatches: 0,
    rolloutTargetImageMatches: 0,
    rolloutTargetPercentageAt100: 0,
    applicationsWithActiveRollout: 0,
    applicationVersionListsAreArrays: 0,
    desiredApplicationVersionAt100: 0,
    workerVersionAt100: 0,
    applicationNamespaceMatches: 0,
  };
  for (const target of targets) {
    const app = await get(`containers/applications/${target.appId}`, "application");
    const versions = await get(`containers/applications/${target.appId}/versions`, "versions");
    const deployment = await get(`workers/scripts/${target.worker}/deployments`, "deployment");
    counts.targets++;
    if (app.id === target.appId && app.name === target.appName) counts.applicationIdentityMatches++;
    if (app.account_id === accountId) counts.cloudflareAccountMatches++;
    if (typeof account.id === "string" && app.account_id === account.id)
      counts.containersAccountMatches++;
    const image = app.configuration?.image;
    const prefix = `registry.cloudflare.com/${account.external_account_id}/${target.appName}@`;
    if (
      typeof account.external_account_id === "string" &&
      typeof image === "string" &&
      image.startsWith(prefix) &&
      /^sha256:[a-f0-9]{64}$/u.test(image.slice(prefix.length))
    )
      counts.externalRegistryDigestMatches++;
    if (
      app.scheduling_policy === "default" &&
      isBasicApplicationConfiguration(app.configuration) &&
      app.max_instances === target.maxInstances &&
      JSON.stringify(app.constraints?.regions) === JSON.stringify(["APAC"])
    )
      counts.defaultPolicyAndResourcesMatch++;
    if (app.scheduling_policy === "default") counts.defaultSchedulingPolicies++;
    if (app.scheduling_policy == null) counts.missingSchedulingPolicies++;
    if (app.configuration?.instance_type === "basic") counts.basicInstanceTypes++;
    if (isBasicApplicationConfiguration(app.configuration)) counts.basicResourceSizesMatch++;
    if (app.configuration?.instance_type == null) counts.missingInstanceTypes++;
    if (app.max_instances === target.maxInstances) counts.maxInstanceLimitsMatch++;
    if (app.max_instances == null) counts.missingMaxInstanceLimits++;
    if (JSON.stringify(app.constraints?.regions) === JSON.stringify(["APAC"]))
      counts.apacRegionConstraints++;
    if (app.constraints?.regions == null) counts.missingRegionConstraints++;
    if (app.health?.instances?.active === 0) counts.zeroActiveInstances++;
    if (app.health?.instances?.assigned === 0) counts.zeroAssignedInstances++;
    if (app.active_rollout_id != null) {
      counts.applicationsWithActiveRollout++;
      if (
        typeof app.active_rollout_id === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(app.active_rollout_id)
      ) {
        const rollout = await get(
          `containers/applications/${target.appId}/rollouts/${app.active_rollout_id}`,
          "rollout",
        );
        if (rollout.status === "completed") counts.activeRolloutsCompleted++;
        else if (rollout.status === "pending") counts.activeRolloutsPending++;
        else if (rollout.status === "progressing") counts.activeRolloutsProgressing++;
        else counts.activeRolloutsOther++;
        if (
          Number.isSafeInteger(app.version) &&
          app.version >= 0 &&
          rollout.target_version === app.version
        )
          counts.rolloutTargetVersionMatches++;
        if (
          typeof image === "string" &&
          image.length > 0 &&
          rollout.target_configuration?.image === image
        )
          counts.rolloutTargetImageMatches++;
        if (
          rollout.percentage === 100 ||
          rollout.version_distribution?.target_version_percentage === 100 ||
          rollout.progress?.version_distribution?.target_version_percentage === 100
        )
          counts.rolloutTargetPercentageAt100++;
      } else counts.activeRolloutsOther++;
    }
    if (Array.isArray(versions)) {
      counts.applicationVersionListsAreArrays++;
      if (
        versions.filter(
          (v) =>
            v?.version === app.version &&
            v?.configuration?.image === image &&
            v?.percentage === 100,
        ).length === 1 &&
        versions.every((v) => v?.version === app.version || v?.percentage === 0)
      )
        counts.desiredApplicationVersionAt100++;
    }
    const allocation = deployment.deployments?.[0]?.versions;
    if (
      Array.isArray(allocation) &&
      allocation.length === 1 &&
      allocation[0].percentage === 100 &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(allocation[0].version_id ?? "")
    ) {
      counts.workerVersionAt100++;
      const version = await get(
        `workers/scripts/${target.worker}/versions/${allocation[0].version_id}`,
        "worker_version",
      );
      const bindings = version.resources?.bindings;
      if (
        Array.isArray(bindings) &&
        bindings.filter(
          (b) =>
            b?.type === "durable_object_namespace" &&
            b.class_name === target.className &&
            (b.script_name === undefined || b.script_name === target.worker) &&
            /^[a-f0-9]{32}$/u.test(b.namespace_id ?? "") &&
            b.namespace_id === app.durable_objects?.namespace_id,
        ).length === 1
      )
        counts.applicationNamespaceMatches++;
    }
  }
  return counts;
}

/** This optional diagnostic creates a short-lived credential; it never returns that credential. */
export async function probeRegistryCredentials(options) {
  let httpStatus;
  // The shared API validates the credential shape before exposing success metadata.
  await cloudflareApi({
    ...options,
    reportResponse: (metadata) => {
      httpStatus = metadata.httpStatus;
    },
  })("containers/registries/registry.cloudflare.com/credentials", {
    expiration_minutes: 5,
    permissions: ["pull"],
  });
  return {
    operation: "registry_pull_credentials",
    method: "POST",
    httpStatus,
    credentialShapeValid: true,
  };
}

export async function containerPreflight({ registryCredentialProbe = false, ...options }) {
  if (typeof registryCredentialProbe !== "boolean")
    throw new Error("container_preflight_probe_mode");
  const counts = await inspectContainers(options);
  if (!registryCredentialProbe) return { counts };
  return { counts, credentialProbe: await probeRegistryCredentials(options) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.env.REGISTRY_CREDENTIAL_PROBE;
    if (mode !== undefined && mode !== "false" && mode !== "true")
      throw new Error("container_preflight_probe_mode");
    const result = await containerPreflight({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      registryCredentialProbe: mode === "true",
    });
    console.log(JSON.stringify(result.counts));
    if (result.credentialProbe) console.log(JSON.stringify(result.credentialProbe));
  } catch (error) {
    console.error(
      /^(?:container_preflight|cf_container)_[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : "container_preflight_failed",
    );
    process.exitCode = 1;
  }
}
