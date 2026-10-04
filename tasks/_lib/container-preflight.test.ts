import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inspectContainers } from "./ci/container-preflight.mjs";

const accountId = "a".repeat(32);
const token = "synthetic-token-must-not-appear";
const namespace = "b".repeat(32);
const imageDigest = `sha256:${"c".repeat(64)}`;
const shapes = [
  ["kogane-globalpass-collector-poc", "GlobalPassCollectorContainer", 2],
  ["kogane-sbi-shinsei-collector-poc", "SbiShinseiCollectorContainer", 2],
  ["kogane-st-george-collector", "StGeorgeCollectorContainer", 1],
] as const;

test("Container preflight only issues fixed-account GETs and returns counts", async () => {
  const calls: string[] = [];
  let current = -1;
  const fetchImpl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(url.pathname.startsWith(`/client/v4/accounts/${accountId}/`)).toBe(true);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}` });
    calls.push(url.pathname);
    let result;
    if (url.pathname.endsWith("/containers/me")) {
      result = { id: "synthetic-internal-account", external_account_id: "synthetic-registry" };
    } else {
      if (/\/containers\/applications\/[^/]+$/u.test(url.pathname)) current++;
      const [worker, className, maxInstances] = shapes[current];
      const appName = `${worker}-${className.toLowerCase()}`;
      const image = `registry.cloudflare.com/synthetic-registry/${appName}@${imageDigest}`;
      if (/\/containers\/applications\/[^/]+$/u.test(url.pathname)) {
        result = {
          id: url.pathname.split("/").at(-1),
          name: appName,
          account_id: "synthetic-internal-account",
          scheduling_policy: "default",
          configuration: { image, vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } },
          max_instances: maxInstances,
          constraints: { regions: ["APAC"] },
          durable_objects: { namespace_id: namespace },
          version: 7,
          active_rollout_id: current === 2 ? "synthetic-rollout" : null,
        };
      } else if (url.pathname.includes("/containers/applications/")) {
        result = [{ version: 7, percentage: 100, configuration: { image } }];
      } else if (url.pathname.endsWith("/deployments")) {
        result = {
          deployments: [
            { versions: [{ version_id: "dddddddd-dddd-4ddd-addd-dddddddddddd", percentage: 100 }] },
          ],
        };
      } else {
        result = {
          resources: {
            bindings: [
              { type: "durable_object_namespace", class_name: className, namespace_id: namespace },
            ],
          },
        };
      }
    }
    return Response.json({ success: true, result });
  };
  const result = await inspectContainers({ accountId, token, fetchImpl });
  expect(result).toEqual({
    targets: 3,
    applicationIdentityMatches: 3,
    cloudflareAccountMatches: 0,
    containersAccountMatches: 3,
    externalRegistryDigestMatches: 3,
    defaultPolicyAndResourcesMatch: 3,
    defaultSchedulingPolicies: 3,
    missingSchedulingPolicies: 0,
    basicInstanceTypes: 0,
    basicResourceSizesMatch: 3,
    missingInstanceTypes: 3,
    maxInstanceLimitsMatch: 3,
    missingMaxInstanceLimits: 0,
    apacRegionConstraints: 3,
    missingRegionConstraints: 0,
    zeroActiveInstances: 0,
    zeroAssignedInstances: 0,
    activeRolloutsCompleted: 0,
    activeRolloutsPending: 0,
    activeRolloutsProgressing: 0,
    activeRolloutsOther: 1,
    rolloutTargetVersionMatches: 0,
    rolloutTargetImageMatches: 0,
    rolloutTargetPercentageAt100: 0,
    applicationsWithActiveRollout: 1,
    applicationVersionListsAreArrays: 3,
    desiredApplicationVersionAt100: 3,
    workerVersionAt100: 3,
    applicationNamespaceMatches: 3,
  });
  expect(calls).toHaveLength(13);
  expect(Object.values(result).every((value) => Number.isInteger(value))).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(namespace);
});

test("Container preflight sanitizes API, redirect and transport failures", async () => {
  for (const status of [302, 403, 500]) {
    let calls = 0;
    await expect(
      inspectContainers({
        accountId,
        token,
        fetchImpl: async () => {
          calls++;
          return new Response(token, { status, headers: { location: "https://example.invalid" } });
        },
      }),
    ).rejects.toThrow(`container_preflight_account_http_${status}`);
    expect(calls).toBe(1);
  }
  await expect(
    inspectContainers({
      accountId,
      token,
      fetchImpl: () => {
        throw new Error(token);
      },
    }),
  ).rejects.toThrow("container_preflight_account_unavailable");
});

test("Container preflight refuses a missing credential before any request", async () => {
  let called = false;
  await expect(
    inspectContainers({
      accountId,
      token: "",
      fetchImpl: () => {
        called = true;
        throw new Error("unexpected");
      },
    }),
  ).rejects.toThrow("container_preflight_credentials_missing");
  expect(called).toBe(false);
});

test("Container preflight rejects malformed envelopes without provider text", async () => {
  for (const body of [
    "not-json",
    "null",
    JSON.stringify({ success: false, errors: [{ message: token }] }),
    JSON.stringify({ success: true, result: null }),
    JSON.stringify({ success: true, result: token }),
  ]) {
    await expect(
      inspectContainers({
        accountId,
        token,
        fetchImpl: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toThrow("container_preflight_account_response");
  }
});

test("unknown shapes and invalid allocation UUIDs are not counted as matches", async () => {
  let calls = 0;
  const result = await inspectContainers({
    accountId,
    token,
    fetchImpl: async (input: string) => {
      calls++;
      const path = new URL(input).pathname;
      let result: unknown = {};
      if (path.endsWith("/versions")) result = [null];
      if (path.endsWith("/deployments"))
        result = { deployments: [{ versions: [{ version_id: "d".repeat(36), percentage: 100 }] }] };
      return Response.json({ success: true, result });
    },
  });
  expect(calls).toBe(10);
  expect(result.targets).toBe(3);
  expect(result.applicationVersionListsAreArrays).toBe(3);
  expect(result.desiredApplicationVersionAt100).toBe(0);
  expect(result.workerVersionAt100).toBe(0);
  expect(result.applicationNamespaceMatches).toBe(0);
  expect(result.applicationIdentityMatches).toBe(0);
});

test("manual preflight stays on exact main and cannot displace production releases", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/container-preflight.yml", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  expect(workflow).toContain("ref: ${{ github.sha }}");
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).toContain("group: container-readonly-preflight");
  expect(workflow).not.toContain("group: production-deploy");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toContain("environment: production");
  expect(workflow).toContain("run: node tasks/_lib/ci/container-preflight.mjs");
  expect(workflow).not.toContain("workflow_call:");
  expect(workflow).not.toContain("secrets: inherit");
});

test("resource shapes and active rollouts are diagnosed without accepting missing settings", async () => {
  let current = -1;
  let rolloutReads = 0;
  const result = await inspectContainers({
    accountId,
    token,
    fetchImpl: async (input: string, init: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      let result: unknown = {};
      if (/\/containers\/applications\/[^/]+$/u.test(url.pathname)) {
        current++;
        result = {
          configuration: { image: "synthetic-image" },
          version: 7,
          active_rollout_id: "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee",
          health: { instances: { active: 0, assigned: 0 } },
        };
      } else if (url.pathname.endsWith("/versions")) result = [];
      else if (url.pathname.includes("/rollouts/")) {
        rolloutReads++;
        expect(url.pathname).toEndWith("/rollouts/eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee");
        result = {
          status: ["pending", "progressing", "completed"][current],
          target_version: 7,
          target_configuration: { image: "synthetic-image" },
          ...(current === 0
            ? { percentage: 100 }
            : current === 1
              ? { version_distribution: { target_version_percentage: 100 } }
              : { progress: { version_distribution: { target_version_percentage: 100 } } }),
        };
      }
      return Response.json({ success: true, result });
    },
  });
  expect(rolloutReads).toBe(3);
  expect(result.defaultPolicyAndResourcesMatch).toBe(0);
  expect(result.missingSchedulingPolicies).toBe(3);
  expect(result.missingInstanceTypes).toBe(3);
  expect(result.missingMaxInstanceLimits).toBe(3);
  expect(result.missingRegionConstraints).toBe(3);
  expect(result.zeroActiveInstances).toBe(3);
  expect(result.zeroAssignedInstances).toBe(3);
  expect(result.activeRolloutsPending).toBe(1);
  expect(result.activeRolloutsProgressing).toBe(1);
  expect(result.activeRolloutsCompleted).toBe(1);
  expect(result.activeRolloutsOther).toBe(0);
  expect(result.rolloutTargetVersionMatches).toBe(3);
  expect(result.rolloutTargetImageMatches).toBe(3);
  expect(result.rolloutTargetPercentageAt100).toBe(3);
  expect(Object.values(result).every((value) => Number.isInteger(value))).toBe(true);
});

test("missing or malformed rollout targets cannot match missing application values", async () => {
  for (const [version, image] of [
    [undefined, undefined],
    [null, null],
    ["7", ""],
    [7.5, ""],
  ]) {
    const result = await inspectContainers({
      accountId,
      token,
      fetchImpl: async (input: string) => {
        const path = new URL(input).pathname;
        let result: unknown = {};
        if (/\/containers\/applications\/[^/]+$/u.test(path))
          result = {
            version,
            configuration: { image },
            active_rollout_id: "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee",
          };
        else if (path.includes("/rollouts/"))
          result = { target_version: version, target_configuration: { image } };
        return Response.json({ success: true, result });
      },
    });
    expect(result.rolloutTargetVersionMatches).toBe(0);
    expect(result.rolloutTargetImageMatches).toBe(0);
    expect(result.rolloutTargetPercentageAt100).toBe(0);
    expect(result.zeroActiveInstances).toBe(0);
    expect(result.zeroAssignedInstances).toBe(0);
  }
});

test("malformed rollout identifiers never become GET paths or output", async () => {
  const uuid = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
  for (const activeRolloutId of [[uuid], { id: uuid }, `${uuid}/../${token}`, token, ""]) {
    let rolloutReads = 0;
    let calls = 0;
    const result = await inspectContainers({
      accountId,
      token,
      fetchImpl: async (input: string, init: RequestInit) => {
        calls++;
        const url = new URL(input);
        expect(url.origin).toBe("https://api.cloudflare.com");
        expect(url.pathname.startsWith(`/client/v4/accounts/${accountId}/`)).toBe(true);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(init.body).toBeUndefined();
        if (url.pathname.includes("/rollouts/")) rolloutReads++;
        const result = /\/containers\/applications\/[^/]+$/u.test(url.pathname)
          ? { active_rollout_id: activeRolloutId }
          : {};
        return Response.json({ success: true, result });
      },
    });
    expect(rolloutReads).toBe(0);
    expect(calls).toBe(10);
    expect(result.applicationsWithActiveRollout).toBe(3);
    expect(result.activeRolloutsOther).toBe(3);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(uuid);
  }
});

test("rollout GET failures remain closed codes without provider text", async () => {
  for (const [mode, expected] of [
    ["http", "container_preflight_rollout_http_403"],
    ["transport", "container_preflight_rollout_unavailable"],
    ["shape", "container_preflight_rollout_response"],
  ]) {
    await expect(
      inspectContainers({
        accountId,
        token,
        fetchImpl: async (input: string, init: RequestInit) => {
          const url = new URL(input);
          expect(url.origin).toBe("https://api.cloudflare.com");
          expect(init.method).toBe("GET");
          expect(init.redirect).toBe("manual");
          expect(init.body).toBeUndefined();
          expect(init.headers).toEqual({ Authorization: `Bearer ${token}` });
          if (url.pathname.includes("/rollouts/")) {
            if (mode === "transport") throw new Error(token);
            if (mode === "http") return new Response(token, { status: 403 });
            return Response.json({ success: false, errors: [{ message: token }] });
          }
          const result = /\/containers\/applications\/[^/]+$/u.test(url.pathname)
            ? { active_rollout_id: "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee" }
            : {};
          return Response.json({ success: true, result });
        },
      }),
    ).rejects.toThrow(expected);
  }
});

test("shared resource guard rejects partial, numeric-string, alias and conflicting API sizes", async () => {
  const expected = { vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } };
  for (const config of [
    { ...expected, vcpu: "0.25" },
    { ...expected, memory_mib: 2048 },
    { ...expected, disk: { size_mb: 4096 } },
    { ...expected, disk: undefined },
    { ...expected, instance_type: null },
    { ...expected, instance_type: "lite" },
    { ...expected, instance_type: "basic", vcpu: 1 },
  ]) {
    let current = -1;
    const counts = await inspectContainers({
      accountId,
      token,
      fetchImpl: async (input: string) => {
        const path = new URL(input).pathname;
        let result: unknown = {};
        if (/\/containers\/applications\/[^/]+$/u.test(path)) {
          current++;
          result = {
            scheduling_policy: "default",
            configuration: config,
            max_instances: shapes[current][2],
            constraints: { regions: ["APAC"] },
          };
        } else if (path.endsWith("/versions")) result = [];
        return Response.json({ success: true, result });
      },
    });
    expect(counts.defaultSchedulingPolicies).toBe(3);
    expect(counts.maxInstanceLimitsMatch).toBe(3);
    expect(counts.apacRegionConstraints).toBe(3);
    expect(counts.basicResourceSizesMatch).toBe(0);
    expect(counts.defaultPolicyAndResourcesMatch).toBe(0);
  }
});

test("plain Node imports the shared resource guard without running its CLI or issuing requests", () => {
  const resource = new URL("./ci/cf-container-release.mjs", import.meta.url).href;
  const stdout = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    globalThis.fetch = () => { throw new Error("unexpected network request"); };
    const resource = process.argv[1];
    process.argv[1] = new URL("./container-preflight.mjs", resource).pathname;
    const { isBasicApplicationConfiguration } = await import(resource);
    if (!isBasicApplicationConfiguration({vcpu:0.25,memory_mib:1024,disk:{size_mb:4000}})) process.exit(1);
    process.stdout.write("guard-only");
  `,
      resource,
    ],
    { encoding: "utf8" },
  );
  expect(stdout).toBe("guard-only");
});
