import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  preservedDoTargets,
  readDoIdentity,
  verifyDoIdentity,
  verifyPreservedDoArtifact,
} from "./ci/cf-do-identity.mjs";
import { REPO_ROOT } from "./repo-root.ts";

const target = {
  name: "session",
  worker: "kogane-session",
  migrationTag: "v1",
  bindings: [{ name: "SESSION", className: "Session" }],
};
const namespace = "a".repeat(32);
const version1 = "11111111-1111-4111-8111-111111111111";
const version2 = "22222222-2222-4222-8222-222222222222";
const options = { targets: [target], accountId: "b".repeat(32), token: "test-secret" };
function mock({
  tag = "v1",
  versions = [{ version_id: version1, percentage: 100 }],
  bindings = [
    {
      type: "durable_object_namespace",
      name: "SESSION",
      class_name: "Session",
      namespace_id: namespace,
    },
  ],
  secondBindings = bindings,
  status = 200,
  invalidJson = false,
} = {}) {
  const paths: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    paths.push(url);
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
    if (invalidJson) return new Response("{", { status });
    const result = url.endsWith("/services/kogane-session")
      ? { default_environment: { script: { migration_tag: tag } } }
      : url.endsWith("/deployments")
        ? { deployments: [{ versions }] }
        : { resources: { bindings: url.endsWith(version2) ? secondBindings : bindings } };
    return Response.json({ success: true, result }, { status });
  };
  return { fetchImpl, paths };
}

describe("code-only DO publication preserves live lifecycle and namespace", () => {
  test("only selected cf lifecycle owners require a baseline", () => {
    const order = JSON.parse(readFileSync(`${REPO_ROOT}/infra/deploy-order.json`, "utf8"));
    expect(preservedDoTargets({ root: REPO_ROOT, order, selected: ["app"] })).toEqual([]);
    expect(preservedDoTargets({ root: REPO_ROOT, order, selected: ["processor"] })).toEqual([
      {
        name: "processor",
        worker: "kogane-observation-pipeline",
        migrationTag: "alarm-v1",
        bindings: [{ name: "SCHEDULE_ALARMS", className: "ScheduleAlarm" }],
      },
    ]);
    expect(
      preservedDoTargets({
        root: REPO_ROOT,
        order,
        selected: order.workers.map((entry: any) => entry.name),
      }),
    ).toHaveLength(3);
  });
  test("all live allocations resolve the same exact self namespace", async () => {
    const api = mock();
    const before = await readDoIdentity({ ...options, fetchImpl: api.fetchImpl });
    expect(before).toEqual([
      { ...target, bindings: [{ ...target.bindings[0], namespaceId: namespace }] },
    ]);
    verifyDoIdentity(before, before);
    expect(api.paths).toHaveLength(3);
  });
  test("pending lifecycle fails before any deployment or version read", async () => {
    const api = mock({ tag: "earlier" });
    await expect(readDoIdentity({ ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(
      "pending_lifecycle",
    );
    expect(api.paths).toHaveLength(1);
  });
  test("namespace must be present and must belong to the canonical class", async () => {
    for (const binding of [
      { type: "durable_object_namespace", name: "SESSION", class_name: "Session" },
      {
        type: "durable_object_namespace",
        name: "SESSION",
        class_name: "Wrong",
        namespace_id: namespace,
      },
      {
        type: "durable_object_namespace",
        name: "SESSION",
        class_name: "Session",
        script_name: "another-worker",
        namespace_id: namespace,
      },
    ]) {
      await expect(
        readDoIdentity({ ...options, fetchImpl: mock({ bindings: [binding] } as any).fetchImpl }),
      ).rejects.toThrow("namespace_missing");
    }
    await expect(
      readDoIdentity({ ...options, fetchImpl: mock({ bindings: [] }).fetchImpl }),
    ).rejects.toThrow("binding_set_changed");
  });
  test("multiple active versions may share a namespace but may not conflict", async () => {
    const versions = [
      { version_id: version1, percentage: 50 },
      { version_id: version2, percentage: 50 },
    ];
    const baseline = await readDoIdentity({ ...options, fetchImpl: mock({ versions }).fetchImpl });
    expect(baseline).toHaveLength(1);
    await expect(
      readDoIdentity({
        ...options,
        fetchImpl: mock({
          versions,
          secondBindings: [
            {
              type: "durable_object_namespace",
              name: "SESSION",
              class_name: "Session",
              namespace_id: "c".repeat(32),
            },
          ],
        }).fetchImpl,
      }),
    ).rejects.toThrow("active_namespace_conflict");
    await expect(
      readDoIdentity({
        ...options,
        fetchImpl: mock({ versions: [{ version_id: version1, percentage: 50 }] }).fetchImpl,
      }),
    ).rejects.toThrow("invalid_allocation");
  });
  test("postcheck refuses a replaced namespace", async () => {
    const before = await readDoIdentity({ ...options, fetchImpl: mock().fetchImpl });
    const after = await readDoIdentity({
      ...options,
      fetchImpl: mock({
        bindings: [
          {
            type: "durable_object_namespace",
            name: "SESSION",
            class_name: "Session",
            namespace_id: "c".repeat(32),
          },
        ],
      }).fetchImpl,
    });
    expect(() => verifyDoIdentity(before, after)).toThrow("identity_changed");
  });
  test("denied, malformed and unavailable API responses fail closed", async () => {
    await expect(
      readDoIdentity({ ...options, fetchImpl: mock({ status: 403 }).fetchImpl }),
    ).rejects.toThrow("http_403");
    await expect(
      readDoIdentity({ ...options, fetchImpl: mock({ invalidJson: true }).fetchImpl }),
    ).rejects.toThrow("invalid_response");
    await expect(
      readDoIdentity({
        ...options,
        fetchImpl: async () => {
          throw new Error("sensitive failure");
        },
      }),
    ).rejects.toThrow("unavailable");
    await expect(readDoIdentity({ ...options, token: "" })).rejects.toThrow("credentials_missing");
  });
  test("compiled artifact refuses lifecycle payloads and changed self bindings", () => {
    const artifact = {
      name: target.worker,
      env: { SESSION: { type: "durable-object", worker: target.worker, exportName: "Session" } },
    };
    verifyPreservedDoArtifact(target, artifact);
    expect(() => verifyPreservedDoArtifact(target, { ...artifact, migrations: [] })).toThrow(
      "lifecycle_changed",
    );
    expect(() => verifyPreservedDoArtifact(target, { ...artifact, exports: {} })).toThrow(
      "lifecycle_changed",
    );
    expect(() => verifyPreservedDoArtifact(target, { ...artifact, env: {} })).toThrow(
      "binding_changed",
    );
    expect(() =>
      verifyPreservedDoArtifact(target, {
        ...artifact,
        env: { SESSION: { ...artifact.env.SESSION, worker: "other" } },
      }),
    ).toThrow("binding_changed");
  });
});
