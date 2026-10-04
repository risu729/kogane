// Read-only Container API shape checks. Output contains aggregate counts only.
import { pathToFileURL } from "node:url";

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
      app.configuration?.instance_type === "basic" &&
      app.max_instances === target.maxInstances &&
      JSON.stringify(app.constraints?.regions) === JSON.stringify(["APAC"])
    )
      counts.defaultPolicyAndResourcesMatch++;
    if (app.active_rollout_id != null) counts.applicationsWithActiveRollout++;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(
        await inspectContainers({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          token: process.env.CLOUDFLARE_API_TOKEN,
        }),
      ),
    );
  } catch (error) {
    console.error(
      /^container_preflight_[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : "container_preflight_failed",
    );
    process.exitCode = 1;
  }
}
