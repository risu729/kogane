import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
          configuration: { image, instance_type: "basic" },
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
