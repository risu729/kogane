import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { realpathSync, chmodSync, symlinkSync, openSync, renameSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseJsonc } from "../../scripts/jsonc.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { workflowSteps, readDeployOrder } from "./deploy-order.ts";
import { releaseProgress } from "./ci/release-ledger.mjs";
import {
  CONTAINER_TARGETS,
  requireExportsWrangler,
  normalizeContainerRollback,
  localContainerImages,
  verifyLocalContainerImages,
  dockerImageId,
  containerInputDigest,
  readRegularFile,
  applicationSnapshot,
  isBasicApplicationConfiguration,
  verifyApplicationIdentity,
  verifyApplicationRollout,
  registryImage,
  verifyRegistryImage,
  cloudflareApi,
  containerProgress,
} from "./ci/cf-container-release.mjs";

const hash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const target = CONTAINER_TARGETS[0]!;
const imageId = `sha256:${"a".repeat(64)}`;
const account = "b".repeat(32);
const namespace = "c".repeat(32);
const app = () => ({
  id: target.appId,
  name: target.appName,
  account_id: account,
  scheduling_policy: "default",
  max_instances: 2,
  configuration: {
    vcpu: 0.25,
    memory_mib: 1024,
    disk: { size_mb: 4000 },
    image: `registry.cloudflare.com/${account}/${target.appName}@${imageId}`,
  },
  constraints: { regions: ["APAC"] },
  durable_objects: { namespace_id: namespace },
  version: 3,
  active_rollout_id: null,
});
const bindings = () => [
  {
    type: "durable_object_namespace",
    name: "COLLECTOR_CONTAINER",
    class_name: target.className,
    script_name: target.worker,
    namespace_id: namespace,
  },
];

describe("only the three admitted Container configurations change deployment backend", () => {
  const order = readDeployOrder();
  const workflow = readFileSync(
    resolve(REPO_ROOT, ".github/workflows/_deploy-workers.yml"),
    "utf8",
  );
  const steps = workflowSteps(workflow);
  test("all deployed Workers use cf; only three use full deploy and consent to trigger synchronization", () => {
    expect(order.workers.filter((entry) => entry.deployBackend === "cf")).toHaveLength(
      order.workers.filter((entry) => entry.deploy).length,
    );
    expect(
      order.workers
        .filter((entry) => entry.productionStrategy === "deploy")
        .map((entry) => entry.name),
    ).toEqual(CONTAINER_TARGETS.map((entry) => entry.name));
    for (const item of CONTAINER_TARGETS) {
      const deploy = steps.find((step) => step.body.includes(`id: cf-deploy-${item.name}\n`))!;
      const verify = steps.find((step) =>
        step.body.includes(`id: verify-container-${item.name}\n`),
      )!;
      expect(deploy.body).toContain("production-strategy: deploy");
      expect(deploy.body).toContain("deploy-triggers: 'true'");
      expect(deploy.body).toContain("@251e42de418f3f5aece2789cc1c0f76d3f8264f5");
      expect(steps.indexOf(verify)).toBe(steps.indexOf(deploy) + 1);
    }
  });
  for (const item of CONTAINER_TARGETS) {
    test(`${item.name} preserves existing app/settings/bindings and SQLite storage`, async () => {
      const old = parseJsonc(readFileSync(resolve(REPO_ROOT, item.path, "wrangler.jsonc"), "utf8"));
      const config = (await import(`${REPO_ROOT}/${item.path}/cloudflare.config.ts`)).default;
      const loaderPath = resolve(
        realpathSync(resolve(REPO_ROOT, "node_modules/cf")),
        "../@cloudflare/config/dist/index.mjs",
      );
      const converted = JSON.parse(
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `
        const {loadAndParseConfig,convertToWranglerConfig}=await import(process.argv[1]);
        const loaded=await loadAndParseConfig(process.argv[2],{mode:"production",isPreview:false});
        if (!loaded.result.success) process.exit(1);
        process.stdout.write(JSON.stringify(convertToWranglerConfig(loaded.result.data)));
      `,
            loaderPath,
            resolve(REPO_ROOT, item.path, "cloudflare.config.ts"),
          ],
          { encoding: "utf8" },
        ),
      );
      expect(config.containers).toHaveLength(1);
      expect(config.containers[0]).toMatchObject({
        name: item.appName,
        schedulingPolicy: "default",
        instanceType: "basic",
        maxInstances: item.maxInstances,
        constraints: { regions: ["APAC"] },
      });
      expect(config.worker.name).toBe(old.name);
      for (const cls of item.classes)
        expect(config.worker.exports[cls]).toMatchObject({
          type: "durable-object",
          storage: "sqlite",
        });
      expect(config.worker.exports[item.className].container.name).toBe(item.appName);
      expect(old.migrations).toEqual([{ tag: "v1", new_sqlite_classes: item.classes }]);
      // Separate code-only parity suite still covers every non-Container Worker.
      expect(converted.exports[item.className]).toMatchObject({
        type: "durable-object",
        storage: "sqlite",
        container: item.appName,
      });
      // The converter makes self-worker script_name explicit. No other canonical field may drift.
      const normalize = (value: any) => {
        const result = structuredClone(value);
        delete result.$schema;
        if (JSON.stringify(result.triggers) === JSON.stringify({ crons: [] }))
          delete result.triggers;
        delete result.migrations;
        delete result.exports;
        for (const binding of result.durable_objects?.bindings ?? [])
          if (binding.script_name === result.name) delete binding.script_name;
        for (const container of result.containers ?? []) {
          delete container.name;
          delete container.class_name;
          if (container.scheduling_policy === "default") delete container.scheduling_policy;
          if (container.image_build_context === ".") delete container.image_build_context;
        }
        return result;
      };
      expect(normalize(converted)).toEqual(normalize(old));
      expect(containerInputDigest(REPO_ROOT, item)).toMatch(/^[a-f0-9]{64}$/u);
    });
  }
  test("trusted helper is fetched before old target checkout; image record is bound and checked", () => {
    const names = steps.map((step) => step.name);
    expect(names.indexOf("Load the trusted Container compatibility adapter")).toBeLessThan(
      names.indexOf("Checkout the exact commit"),
    );
    expect(workflow).toContain("${{ github.workflow_sha }}");
    expect(names.indexOf("Normalize admitted Container rollback exports")).toBeLessThan(
      names.indexOf("Build every deployable bundle"),
    );
    expect(
      names.indexOf("Bind the Container image manifest to the release record"),
    ).toBeGreaterThan(names.indexOf("Compute the release manifest"));
    expect(workflow).toContain('node "${CONTAINER_GUARD}" verify-pre');
  });
});

describe("legacy SQLite rollback conversion fails closed", () => {
  test("minimum pinned Wrangler is supported without installing an override", () => {
    for (const value of ["4.145.0", "4.146.0"])
      expect(() => requireExportsWrangler(value)).not.toThrow();
    for (const value of ["4.144.9", "^4.145.0", "4.145.0-beta.1", "5.0.0", null])
      expect(() => requireExportsWrangler(value)).toThrow("wrangler_exports_unsupported");
  });
  for (const item of CONTAINER_TARGETS)
    test(`${item.name} converts only exact known history and retains every class`, () => {
      const old = parseJsonc(readFileSync(resolve(REPO_ROOT, item.path, "wrangler.jsonc"), "utf8"));
      const normalized = normalizeContainerRollback(item, old);
      const { migrations: history, ...rest } = old;
      expect(normalized).toEqual({
        ...rest,
        exports: Object.fromEntries(
          item.classes.map((name) => [name, { type: "durable-object", storage: "sqlite" }]),
        ),
      });
      expect(old.migrations).toEqual(history);
      for (const patch of [
        { migrations: [{ tag: "v2", new_sqlite_classes: item.classes }] },
        { migrations: [...old.migrations, { tag: "v2", deleted_classes: item.classes }] },
        { exports: {} },
        { name: "another-worker" },
        { durable_objects: { bindings: [] } },
        { containers: [{ ...old.containers[0], scheduling_policy: "durable_object" }] },
      ])
        expect(() => normalizeContainerRollback(item, { ...old, ...patch })).toThrow();
    });
});

describe("immutable local image and application identity", () => {
  test("tag swaps and child errors cannot pass or leak raw credentials", () => {
    const tag = `cloudflare-build/${"d".repeat(12)}/${target.appName}:${"e".repeat(12)}`;
    expect(dockerImageId(tag, () => `${imageId}\n`)).toBe(imageId);
    expect(() =>
      dockerImageId(tag, () => {
        throw new Error("secret-token stdout");
      }),
    ).toThrow("cf_container_local_image_unavailable");
    expect(() => dockerImageId("otherhost/image:latest", () => imageId)).toThrow(
      "local_tag_invalid",
    );
    expect(() => verifyLocalContainerImages({ imageId }, { imageId: hash("changed") })).toThrow(
      "local_image_changed",
    );
  });
  test("build output requires exact app/policy/resources and one local image", () => {
    const root = mkdtempSync(resolve(tmpdir(), "container-guard-"));
    try {
      const dir = resolve(root, target.path, ".cloudflare/output/v0/containers/app");
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, "container.config.json");
      const config = {
        name: target.appName,
        schedulingPolicy: "default",
        maxInstances: 2,
        instanceType: "basic",
        constraints: { regions: ["APAC"] },
        image: {
          localReference: `cloudflare-build/${"d".repeat(12)}/${target.appName}:${"e".repeat(12)}`,
        },
      };
      writeFileSync(path, JSON.stringify(config));
      expect(localContainerImages(root, target, () => imageId)).toMatchObject({
        imageId,
        appId: target.appId,
      });
      writeFileSync(path, JSON.stringify({ ...config, maxInstances: 3 }));
      expect(() => localContainerImages(root, target, () => imageId)).toThrow("output_identity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("namespace/app identity changes and uncompleted rollouts fail, sleeping instances are irrelevant", () => {
    const before = applicationSnapshot(target, app(), bindings(), account);
    verifyApplicationRollout(before, [
      { version: 3, percentage: 100, configuration: { image: before.image } },
    ]);
    for (const patch of [{ activeRolloutId: "pending" }, { version: 4 }])
      expect(() =>
        verifyApplicationRollout({ ...before, ...patch }, [
          { version: 3, percentage: 100, configuration: { image: before.image } },
        ]),
      ).toThrow();
    expect(() =>
      verifyApplicationRollout(before, [
        { version: 3, percentage: 90, configuration: { image: before.image } },
        { version: 2, percentage: 10, configuration: { image: before.image } },
      ]),
    ).toThrow("rollout_unverified");
    expect(() =>
      applicationSnapshot(target, { ...app(), max_instances: 3 }, bindings(), account),
    ).toThrow("application_identity");
    expect(() =>
      verifyApplicationIdentity(before, {
        ...before,
        namespaces: [{ className: target.className, namespaceId: "f".repeat(32) }],
      }),
    ).toThrow("namespace_changed");
  });
  test("unverified Container publication remains failed in legacy release ledger", () => {
    for (const verification of [undefined, "failure", "skipped", "success"]) {
      const context = {
        [`cf-deploy-${target.name}`]: { outcome: "success" },
        ...(verification ? { [`verify-container-${target.name}`]: { outcome: verification } } : {}),
      };
      const adapted = containerProgress(context);
      const record = {
        recordVersion: "release-record-v2",
        sha: "a".repeat(40),
        workers: [{ name: target.name, sha: "a".repeat(40), outcome: "planned" }],
        coreMigrations: [],
        readMigrations: null,
      };
      expect(releaseProgress(record, adapted).workers[0].outcome).toBe(
        verification === "success" ? "deployed" : "failed",
      );
    }
  });
});

describe("registry verification keeps credentials on the controlled host and repository", () => {
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: imageId } });
  const digest = hash(manifest);
  const image = `registry.cloudflare.com/${account}/${target.appName}@${digest}`;
  const args = {
    target,
    image,
    imageId,
    registryNamespace: account,
    username: "synthetic-user",
    password: "synthetic-token",
  };
  test("exact manifest and config digest match the local Docker image ID", async () => {
    await verifyRegistryImage({
      ...args,
      fetchImpl: async (url, options) => {
        expect(url).toBe(
          `https://registry.cloudflare.com/v2/${account}/${target.appName}/manifests/${digest}`,
        );
        expect(options.redirect).toBe("manual");
        expect(options.signal).toBeDefined();
        return new Response(manifest);
      },
    });
  });
  test("uncontrolled hosts/accounts/repositories/tags are refused before fetch", () => {
    for (const bad of [
      image.replace("registry.cloudflare.com", "attacker.test"),
      image.replace(account, "other"),
      image.replace(target.appName, "other-app"),
      image.replace(digest, "latest"),
    ])
      expect(() => registryImage(target, bad, account)).toThrow("registry_image_invalid");
  });
  test("redirects, digest mismatch and wrong image fail closed", async () => {
    for (const response of [new Response("", { status: 302 }), new Response("{}")])
      await expect(
        verifyRegistryImage({ ...args, fetchImpl: async () => response }),
      ).rejects.toThrow();
    await expect(
      verifyRegistryImage({
        ...args,
        imageId: hash("other"),
        fetchImpl: async () => new Response(manifest),
      }),
    ).rejects.toThrow("registry_image_mismatch");
  });
  test("OCI index admits exactly linux/amd64 and verifies both immutable manifests", async () => {
    const index = JSON.stringify({
      manifests: [
        { digest, platform: { os: "linux", architecture: "amd64" } },
        { digest: hash("arm"), platform: { os: "linux", architecture: "arm64" } },
      ],
    });
    await verifyRegistryImage({
      ...args,
      image: `registry.cloudflare.com/${account}/${target.appName}@${hash(index)}`,
      fetchImpl: async (url) => new Response(url.endsWith(hash(index)) ? index : manifest),
    });
    const bad = JSON.stringify({
      manifests: [{ digest, platform: { os: "linux", architecture: "arm64" } }],
    });
    await expect(
      verifyRegistryImage({
        ...args,
        image: `registry.cloudflare.com/${account}/${target.appName}@${hash(bad)}`,
        fetchImpl: async () => new Response(bad),
      }),
    ).rejects.toThrow("registry_platform_unknown");
  });
  test("API diagnostics distinguish only admitted operations, methods and HTTP status", async () => {
    const version = "dddddddd-dddd-4ddd-addd-dddddddddddd";
    const cases = [
      ["containers/me", undefined, "containers_account", "GET"],
      [`containers/applications/${target.appId}`, undefined, "application", "GET"],
      [
        `containers/applications/${target.appId}/versions`,
        undefined,
        "application_versions",
        "GET",
      ],
      [`workers/scripts/${target.worker}/deployments`, undefined, "worker_deployments", "GET"],
      [`workers/scripts/${target.worker}/versions/${version}`, undefined, "worker_version", "GET"],
      [
        "containers/registries/registry.cloudflare.com/credentials",
        { expiration_minutes: 5, permissions: ["pull"] },
        "registry_pull_credentials",
        "POST",
      ],
    ] as const;
    for (const [path, body, operation, method] of cases) {
      for (const status of method === "POST"
        ? [202, 204, 302, 401, 403, 429, 500]
        : [201, 202, 204, 302, 401, 403, 429, 500]) {
        const diagnostics: unknown[] = [];
        let calls = 0;
        const api = cloudflareApi({
          accountId: account,
          token: "synthetic-private-token",
          reportDiagnostic: (entry: unknown) => diagnostics.push(entry),
          fetchImpl: async (_url: string, init: RequestInit) => {
            calls++;
            expect(init.method).toBe(method);
            expect(init.redirect).toBe("manual");
            return {
              status,
              json: async () => {
                throw new Error("unexpected private body read");
              },
            };
          },
        });
        await expect(api(path, body)).rejects.toThrow("cf_container_api_http");
        expect(calls).toBe(1);
        expect(diagnostics).toEqual([
          { code: "cf_container_api_http", operation, method, httpStatus: status },
        ]);
        expect(JSON.stringify(diagnostics)).not.toContain("synthetic-private");
        expect(JSON.stringify(diagnostics)).not.toContain(target.worker);
        expect(JSON.stringify(diagnostics)).not.toContain(target.appId);
      }
    }
  });
  test("API failures sanitize transport and malformed envelopes without reading non-200 bodies", async () => {
    for (const failure of ["transport", "json", "envelope", "status"]) {
      const diagnostics: unknown[] = [];
      let readBody = false;
      const api = cloudflareApi({
        accountId: account,
        token: "synthetic-private-token",
        reportDiagnostic: (entry: unknown) => diagnostics.push(entry),
        fetchImpl: async () => {
          if (failure === "transport") throw new Error("synthetic-private-token");
          return {
            status: failure === "status" ? 403 : 200,
            json: async () => {
              readBody = true;
              if (failure === "json") throw new Error("synthetic-private-body");
              return { success: false, errors: [{ message: "synthetic-private-body" }] };
            },
          };
        },
      });
      const code =
        failure === "transport"
          ? "api_unavailable"
          : failure === "status"
            ? "api_http"
            : "api_response";
      await expect(api("containers/me")).rejects.toThrow(`cf_container_${code}`);
      expect(diagnostics).toEqual([
        {
          code: `cf_container_${code}`,
          operation: "containers_account",
          method: "GET",
          httpStatus: failure === "transport" ? null : failure === "status" ? 403 : 200,
        },
      ]);
      expect(readBody).toBe(failure === "json" || failure === "envelope");
    }
  });
  test("API refuses unadmitted routes and credential parameters before sending the token", async () => {
    let calls = 0;
    const api = cloudflareApi({
      accountId: account,
      token: "synthetic-token",
      fetchImpl: async () => {
        calls++;
        return Response.json({ success: true, result: {} });
      },
    });
    for (const [path, body] of [
      ["containers/applications/unknown", undefined],
      [`workers/scripts/${target.worker}/versions/unknown`, undefined],
      ["containers/me", {}],
      [
        "containers/registries/registry.cloudflare.com/credentials",
        { expiration_minutes: 5, permissions: ["push"] },
      ],
      [
        "containers/registries/registry.cloudflare.com/credentials",
        { expiration_minutes: 10, permissions: ["pull"] },
      ],
      [
        "containers/registries/example.invalid/credentials",
        { expiration_minutes: 5, permissions: ["pull"] },
      ],
    ])
      await expect(api(path, body)).rejects.toThrow("cf_container_api_request_unknown");
    expect(calls).toBe(0);
  });
  test("only the fixed credential POST accepts validated 200 or 201 and reports actual metadata", async () => {
    const result = {
      account_id: "synthetic-internal-id",
      username: "synthetic-private-user",
      password: "synthetic-private-password",
      registry_host: "registry.cloudflare.com",
    };
    for (const status of [200, 201]) {
      const metadata: unknown[] = [];
      const diagnostics: unknown[] = [];
      const api = cloudflareApi({
        accountId: account,
        token: "synthetic-private-token",
        reportDiagnostic: (entry: unknown) => diagnostics.push(entry),
        reportResponse: (entry: unknown) => metadata.push(entry),
        fetchImpl: async () => Response.json({ success: true, result }, { status }),
      });
      expect(
        await api("containers/registries/registry.cloudflare.com/credentials", {
          expiration_minutes: 5,
          permissions: ["pull"],
        }),
      ).toEqual(result);
      expect(metadata).toEqual([
        { operation: "registry_pull_credentials", method: "POST", httpStatus: status },
      ]);
      expect(diagnostics).toEqual([]);
      expect(JSON.stringify(metadata)).not.toContain("synthetic-private");
      expect(JSON.stringify(metadata)).not.toContain(result.account_id);
    }
  });
  test("credential 201 fails closed for malformed envelope or response shape before success metadata", async () => {
    const valid = {
      account_id: "private-account",
      username: "private-user",
      password: "private-password",
      registry_host: "registry.cloudflare.com",
    };
    const cases = [
      ["not-json", "api_response"],
      [
        JSON.stringify({
          success: false,
          result: valid,
          errors: [{ message: "private-provider-text" }],
        }),
        "api_response",
      ],
      [JSON.stringify({ success: true }), "api_response"],
      ...[
        null,
        [],
        "private-provider-text",
        {},
        { ...valid, account_id: "" },
        { ...valid, username: null },
        { ...valid, password: 0 },
        { ...valid, registry_host: "example.invalid" },
      ].map((result) => [JSON.stringify({ success: true, result }), "registry_credential_shape"]),
    ];
    for (const [body, code] of cases) {
      const metadata: unknown[] = [],
        diagnostics: unknown[] = [];
      const api = cloudflareApi({
        accountId: account,
        token: "private-token",
        reportResponse: (entry: unknown) => metadata.push(entry),
        reportDiagnostic: (entry: unknown) => diagnostics.push(entry),
        fetchImpl: async () => new Response(body, { status: 201 }),
      });
      await expect(
        api("containers/registries/registry.cloudflare.com/credentials", {
          expiration_minutes: 5,
          permissions: ["pull"],
        }),
      ).rejects.toThrow(`cf_container_${code}`);
      expect(metadata).toEqual([]);
      expect(diagnostics).toEqual([
        {
          code: `cf_container_${code}`,
          operation: "registry_pull_credentials",
          method: "POST",
          httpStatus: 201,
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("private-");
    }
  });
  test("API errors expose closed codes only", async () => {
    const api = cloudflareApi({
      accountId: account,
      token: "synthetic-token",
      reportDiagnostic: () => {},
      fetchImpl: async () => {
        throw new Error("synthetic-token private-data");
      },
    });
    await expect(api("containers/me")).rejects.toThrow("cf_container_api_unavailable");
  });
});

test("real Node CLI binds and rechecks the image manifest, daemon, source and tag", () => {
  const root = mkdtempSync(resolve(tmpdir(), "container-cli-"));
  try {
    const temp = resolve(root, "temp");
    const tools = resolve(root, "bin");
    mkdirSync(temp, { recursive: true });
    mkdirSync(tools, { recursive: true });
    mkdirSync(resolve(root, "infra"));
    writeFileSync(
      resolve(root, "infra/deploy-order.json"),
      JSON.stringify({ workers: [{ name: target.name, deployBackend: "cf" }] }),
    );
    writeFileSync(resolve(temp, "release-plan.json"), JSON.stringify({ selected: [target.name] }));
    writeFileSync(resolve(temp, "release-record.json"), "{}");
    const service = resolve(root, target.path);
    mkdirSync(resolve(service, "container"), { recursive: true });
    writeFileSync(
      resolve(service, "Dockerfile"),
      "FROM scratch\nCOPY container/source.mjs /source.mjs\n",
    );
    writeFileSync(resolve(service, "container/source.mjs"), "synthetic source");
    const output = resolve(service, ".cloudflare/output/v0/containers/app");
    mkdirSync(output, { recursive: true });
    writeFileSync(
      resolve(output, "container.config.json"),
      JSON.stringify({
        name: target.appName,
        schedulingPolicy: "default",
        maxInstances: 2,
        instanceType: "basic",
        constraints: { regions: ["APAC"] },
        image: {
          localReference: `cloudflare-build/${"d".repeat(12)}/${target.appName}:${"e".repeat(12)}`,
        },
      }),
    );
    writeFileSync(
      resolve(tools, "docker"),
      '#!/bin/sh\ncase "$1 $2" in "info --format") printf "%s\\n" "$MOCK_DAEMON" ;; "image inspect") printf "%s\\n" "$MOCK_IMAGE_ID" ;; *) exit 1 ;; esac\n',
    );
    chmodSync(resolve(tools, "docker"), 0o755);
    const guard = resolve(REPO_ROOT, "tasks/_lib/ci/cf-container-release.mjs");
    const env = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      MOCK_DAEMON: "synthetic-daemon",
      MOCK_IMAGE_ID: imageId,
    };
    const run = (command: string, patch = {}) =>
      spawnSync("node", [guard, command], {
        cwd: root,
        env: { ...env, ...patch },
        encoding: "utf8",
      });
    expect(run("capture").status).toBe(0);
    expect(run("bind").status).toBe(0);
    expect(run("verify-pre").status).toBe(0);
    expect(run("verify-pre", { MOCK_IMAGE_ID: hash("swap") }).stderr.trim()).toBe(
      "cf_container_local_image_changed",
    );
    expect(run("verify-pre", { MOCK_DAEMON: "another-daemon" }).stderr.trim()).toBe(
      "cf_container_local_image_changed",
    );
    writeFileSync(resolve(service, "container/source.mjs"), "changed source");
    expect(run("verify-pre").stderr.trim()).toBe("cf_container_local_image_changed");
    const recorded = JSON.parse(readFileSync(resolve(temp, "container-manifest.json"), "utf8"));
    expect(recorded[0].daemonId).toBe("synthetic-daemon");
    writeFileSync(resolve(temp, "container-manifest.json"), "[]");
    expect(run("verify-pre").stderr.trim()).toBe("cf_container_manifest_changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated dependencies are excluded; every COPY source must remain a regular file", () => {
  const root = mkdtempSync(resolve(tmpdir(), "container-inputs-"));
  try {
    const service = resolve(root, target.path);
    mkdirSync(resolve(service, "container"), { recursive: true });
    const dockerfile = resolve(service, "Dockerfile");
    const source = resolve(service, "container/source.mjs");
    writeFileSync(dockerfile, "FROM scratch\nCOPY container/source.mjs /source.mjs\n");
    writeFileSync(source, "original source");
    const before = containerInputDigest(root, target);
    mkdirSync(resolve(service, "container/node_modules/.bin"), { recursive: true });
    symlinkSync("../package/tool.js", resolve(service, "container/node_modules/.bin/tool"));
    expect(containerInputDigest(root, target)).toBe(before);
    writeFileSync(source, "changed consumed source");
    expect(containerInputDigest(root, target)).not.toBe(before);
    writeFileSync(dockerfile, "FROM scratch\nCOPY container/node_modules /dependencies\n");
    expect(() => containerInputDigest(root, target)).toThrow("context_shape");
    rmSync(resolve(service, "container/node_modules"), { recursive: true });
    writeFileSync(resolve(service, "container/node_modules"), "regular consumed file");
    const fileBefore = containerInputDigest(root, target);
    writeFileSync(resolve(service, "container/node_modules"), "changed consumed file");
    expect(containerInputDigest(root, target)).not.toBe(fileBefore);
    writeFileSync(dockerfile, "FROM scratch\nCOPY container/source.mjs /source.mjs\n");
    symlinkSync("source.mjs", resolve(service, "container/linked.mjs"));
    expect(() => containerInputDigest(root, target)).toThrow("context_symlink");
    writeFileSync(dockerfile, "FROM scratch\nCOPY container/linked.mjs /linked.mjs\n");
    expect(() => containerInputDigest(root, target)).toThrow("context_symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input measurement reads the same opened inode and rejects symlinks", () => {
  const root = mkdtempSync(resolve(tmpdir(), "container-open-"));
  try {
    const path = resolve(root, "source");
    const other = resolve(root, "other");
    writeFileSync(path, "measured source");
    writeFileSync(other, "unrelated source");
    const bytes = readRegularFile(path, {
      openImpl: (file, flags) => {
        const fd = openSync(file, flags);
        renameSync(path, resolve(root, "original"));
        symlinkSync(other, path);
        return fd;
      },
    });
    expect(bytes.toString()).toBe("measured source");
    expect(() => readRegularFile(path)).toThrow("context_symlink");
    expect(() => readRegularFile(root)).toThrow("context_shape");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("application snapshots reject text and unknown image/rollout shapes before persistence", () => {
  for (const altered of [
    {
      ...app(),
      configuration: { ...app().configuration, image: "https://uncontrolled.invalid/source" },
    },
    { ...app(), version: "3" },
    { ...app(), active_rollout_id: "provider text" },
  ])
    expect(() => applicationSnapshot(target, altered, bindings(), account)).toThrow(
      "snapshot_shape",
    );
  const closed = applicationSnapshot(
    target,
    { ...app(), provider_text: "untrusted" },
    bindings(),
    account,
  );
  expect(Object.keys(closed).sort()).toEqual([
    "activeRolloutId",
    "appId",
    "appName",
    "image",
    "name",
    "namespaces",
    "version",
  ]);
});

test("the basic application preset requires all three exact expanded numeric resources", () => {
  const expanded = { vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } };
  expect(isBasicApplicationConfiguration(expanded)).toBe(true);
  expect(isBasicApplicationConfiguration({ ...expanded, instance_type: "basic" })).toBe(true);
  for (const invalid of [
    null,
    { instance_type: "basic" },
    { ...expanded, instance_type: null },
    { ...expanded, instance_type: "lite" },
    { ...expanded, instance_type: "standard" },
    { ...expanded, vcpu: "0.25" },
    { ...expanded, vcpu: undefined },
    { ...expanded, vcpu: 0.5 },
    { ...expanded, memory_mib: "1024" },
    { ...expanded, memory_mib: undefined },
    { ...expanded, memory_mib: 2048 },
    { ...expanded, disk: undefined },
    { ...expanded, disk: { size_mb: "4000" } },
    { ...expanded, disk: { size_mb: 4096 } },
    { ...expanded, instance_type: "basic", vcpu: 1 },
  ]) {
    expect(isBasicApplicationConfiguration(invalid)).toBe(false);
    expect(() =>
      applicationSnapshot(
        target,
        {
          ...app(),
          configuration: {
            ...app().configuration,
            vcpu: undefined,
            memory_mib: undefined,
            disk: undefined,
            ...invalid,
          },
        },
        bindings(),
        account,
      ),
    ).toThrow("application_identity");
  }
});
