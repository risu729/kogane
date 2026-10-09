import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./ci/release-manifest.mjs";
import {
  CONTAINER_TARGETS,
  waitForApplicationRollout,
  verifyApplicationRollout,
  currentRegistryNamespace,
} from "./ci/cf-container-release.mjs";
import {
  selectResumeDeployment,
  verifyArtifactMetadata,
  verifyArtifactBytes,
  parseCheckpointStatus,
  mergePublicationSteps,
  verifyReceipt,
  publicationCandidate,
  verifyBoundPublication,
  verifyResumeContainerState,
  validatePreparedPaths,
  copyPrepared,
  positiveId,
} from "./ci/release-resume.mjs";
import { workflowSteps } from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";

const sha = "a".repeat(40),
  trustedSha = "b".repeat(40);
const context = { runId: "123", sha, trustedSha, attempt: 2 };
const digest = `sha256:${"c".repeat(64)}`;
const target = CONTAINER_TARGETS[0]!;
const image = `registry.cloudflare.com/synthetic/${target.appName}@${digest}`;
const versionId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const before = {
  name: target.name,
  appId: target.appId,
  appName: target.appName,
  namespaces: [{ className: target.className, namespaceId: "e".repeat(32) }],
  version: 3,
  image,
  workerVersion: versionId,
  activeRolloutId: null,
};
const deployment = () => ({
  id: 42,
  sha,
  payload: {
    manifestVersion: "release-manifest-v2",
    sha,
    runId: "123",
    workers: [{ name: target.name, outcome: "planned" }],
    resume: { ...context, attempt: 1, artifactId: 100, artifactDigest: digest },
  },
});
const receipt = () => ({
  version: "release-resume-v1",
  deploymentId: 42,
  recordSha256: createHash("sha256").update(canonicalJson(deployment().payload)).digest("hex"),
  ...context,
  originalAttempt: 1,
  steps: {
    [`cf-deploy-${target.name}`]: { outcome: "success", outputs: { "version-id": versionId } },
  },
  targets: [{ ...before, version: 4 }],
});

describe("prepared file descriptor and network ID boundaries", () => {
  test("registry requests use the current authenticated namespace only after original baseline equality", async () => {
    const api = async (path: string) => {
      expect(path).toBe("containers/me");
      return { external_account_id: "synthetic" };
    };
    expect(await currentRegistryNamespace(api, "synthetic")).toBe("synthetic");
    await expect(currentRegistryNamespace(api, "changed")).rejects.toThrow("namespace_changed");
    for (const namespace of ["../escape", "https://invalid", "", "a".repeat(65), null])
      await expect(
        currentRegistryNamespace(async () => ({ external_account_id: namespace }), namespace),
      ).rejects.toThrow("namespace_invalid");
  });
  test("only positive safe numeric IDs reach fixed artifact/deployment endpoints", () => {
    expect(positiveId(42)).toBe(42);
    for (const value of ["42", "42/zip", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => positiveId(value)).toThrow("identity_invalid");
  });
  test("held file/directory descriptors retain original bytes after source replacement and refuse symlinks", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, renameSync, openSync, symlinkSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const directory = mkdtempSync(resolve(tmpdir(), "synthetic-prepared-"));
    try {
      for (const shape of ["file", "directory"]) {
        const source = resolve(directory, shape);
        if (shape === "directory") mkdirSync(source);
        writeFileSync(shape === "file" ? source : resolve(source, "input"), "original");
        let swapped = false;
        copyPrepared(source, resolve(directory, `copied-${shape}`), {
          openImpl(path: string, flags: number) {
            const fd = openSync(path, flags);
            if (!swapped) {
              swapped = true;
              renameSync(source, `${source}-original`);
              if (shape === "directory") mkdirSync(source);
              writeFileSync(shape === "file" ? source : resolve(source, "input"), "replacement");
            }
            return fd;
          },
        });
        expect(
          readFileSync(
            resolve(directory, `copied-${shape}`, ...(shape === "directory" ? ["input"] : [])),
            "utf8",
          ),
        ).toBe("original");
        symlinkSync(source, `${source}-link`);
        expect(() => copyPrepared(`${source}-link`, `${source}-copy-link`)).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("same-run ledger and immutable artifact trust", () => {
  test("a new run uses ordinary release decisions; same run resumes only its exact ledger binding", () => {
    expect(selectResumeDeployment([], context)).toBeNull();
    expect(selectResumeDeployment([deployment()], context)?.id).toBe(42);
    for (const patch of [
      { sha: "f".repeat(40) },
      { runId: "124" },
      { trustedSha: "f".repeat(40) },
    ]) {
      const value = deployment();
      Object.assign(value.payload.resume, patch);
      expect(() => selectResumeDeployment([value], context)).toThrow("binding_invalid");
    }
  });
  test("newer successful, failed, pending and identical-content publications all refuse the old resume", () => {
    for (const state of ["success", "failure", "in_progress", "cancelled"]) {
      const newer = {
        ...deployment(),
        id: 43,
        state,
        payload: { ...deployment().payload, runId: "124" },
      };
      expect(() => selectResumeDeployment([deployment(), newer], context)).toThrow("superseded");
    }
    // GitHub's automatic environment job records are not release-ledger records.
    expect(selectResumeDeployment([deployment(), { id: 99, payload: {} }], context)?.id).toBe(42);
  });
  test("artifact metadata cannot substitute names, another run, an expired artifact or a different digest", () => {
    const binding = { artifactId: 100, artifactDigest: digest };
    const metadata = { id: 100, digest, expired: false, workflow_run: { id: 123 } };
    verifyArtifactMetadata(metadata, binding, "123");
    for (const patch of [
      { id: 101 },
      { expired: true },
      { digest: `sha256:${"f".repeat(64)}` },
      { workflow_run: { id: 124 } },
    ])
      expect(() => verifyArtifactMetadata({ ...metadata, ...patch }, binding, "123")).toThrow(
        "artifact_identity",
      );
    const bytes = Buffer.from("synthetic immutable ZIP bytes");
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    verifyArtifactBytes(bytes, checksum);
    expect(() =>
      verifyArtifactBytes(Buffer.concat([bytes, Buffer.from("tamper")]), checksum),
    ).toThrow("artifact_digest");
  });
  test("checkpoint audit association uses a closed artifact id/digest shape", () => {
    expect(parseCheckpointStatus(`kogane-resume-v1:100:${"c".repeat(64)}`)).toEqual({
      artifactId: 100,
      artifactDigest: digest,
    });
    for (const value of [
      "success",
      `kogane-resume-v1:0:${"c".repeat(64)}`,
      `kogane-resume-v1:100:${"z".repeat(64)}`,
      `kogane-resume-v1:9007199254740999:${"c".repeat(64)}`,
    ])
      expect(parseCheckpointStatus(value)).toBeNull();
  });
  test("receipt binds release id, original attempt, target, trusted source and immutable ledger payload", () => {
    expect(verifyReceipt(receipt(), deployment(), context)).toEqual([target.name]);
    for (const patch of [
      { deploymentId: 43 },
      { recordSha256: "f".repeat(64) },
      { sha: "f".repeat(40) },
      { trustedSha: "f".repeat(40) },
      { runId: "124" },
      { originalAttempt: 2 },
      { attempt: 3 },
      { targets: [] },
    ])
      expect(() => verifyReceipt({ ...receipt(), ...patch }, deployment(), context)).toThrow(
        "receipt_identity",
      );
    expect(() =>
      verifyReceipt(
        { ...receipt(), targets: [...receipt().targets, ...receipt().targets] },
        deployment(),
        context,
      ),
    ).toThrow("receipt_target");
  });
  test("prepared archive paths cannot escape the restored checkout/temp trees", () => {
    validatePreparedPaths([
      "checkout/services/test/.cloudflare/output/v0/a.js",
      "temp/docker-images.tar",
    ]);
    for (const path of [
      "../other",
      "checkout/../../other",
      "/etc/passwd",
      "checkout/a//b",
      "checkout/a/./b",
      "temp/a\\b",
    ])
      expect(() => validatePreparedPaths([path])).toThrow("archive_path");
  });
});

describe("exact publication readback and the unchanged convergence window", () => {
  test("uniquely captures intended new version even while current desired version is old", () => {
    expect(
      publicationCandidate(
        before,
        [
          { version: 3, percentage: 50, configuration: { image } },
          { version: 4, percentage: 50, configuration: { image } },
        ],
        "synthetic",
        target,
      ).version,
    ).toBe(4);
    for (const versions of [
      [],
      [{ version: 3, percentage: 100, configuration: { image } }],
      [
        { version: 4, percentage: 50, configuration: { image } },
        { version: 5, percentage: 50, configuration: { image } },
      ],
    ])
      expect(() => publicationCandidate(before, versions, "synthetic", target)).toThrow(
        "publication_ambiguous",
      );
    expect(() =>
      publicationCandidate(
        before,
        [{ version: 4, percentage: 50, configuration: { image: "https://foreign.invalid/image" } }],
        "synthetic",
        target,
      ),
    ).toThrow("registry_image_invalid");
  });
  test("unpublished future Container drift is refused before resumed mutations", () => {
    const versions = [{ version: 3, configuration: { image }, percentage: 100 }];
    verifyResumeContainerState(before, undefined, before, versions);
    for (const patch of [
      { workerVersion: "ffffffff-ffff-4fff-afff-ffffffffffff" },
      { version: 4 },
      { image: image.replace("c".repeat(64), "f".repeat(64)) },
      { namespaces: [] },
    ])
      expect(() =>
        verifyResumeContainerState(before, undefined, { ...before, ...patch }, versions),
      ).toThrow();
    expect(() =>
      verifyResumeContainerState(before, undefined, before, [
        { version: 4, configuration: { image }, percentage: 0 },
      ]),
    ).toThrow("application_superseded");
    expect(() =>
      verifyResumeContainerState(before, { ...before, version: 4 }, before, versions),
    ).toThrow("publication_missing");
  });
  test("same-image later Worker publication and later app version are supersessions", () => {
    const bound = { ...before, version: 4 };
    verifyBoundPublication(bound, before);
    for (const snapshot of [
      { ...before, workerVersion: "ffffffff-ffff-4fff-afff-ffffffffffff" },
      { ...before, version: 5 },
      { ...before, namespaces: [] },
    ])
      expect(() => verifyBoundPublication(bound, snapshot)).toThrow();
  });
  test("old complete version cannot pass while bound version is pending; exact bound completion can pass", async () => {
    let now = 0,
      reads = 0;
    const publication = { version: 4, image };
    const snapshot = await waitForApplicationRollout(
      async () => {
        reads++;
        const version = now < 130000 ? 3 : 4;
        return {
          snapshot: { ...before, version },
          versions: [{ version, percentage: 100, configuration: { image } }],
        };
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
        publication,
      },
    );
    expect(snapshot.version).toBe(4);
    expect(reads).toBe(27);
    expect(now).toBe(130000);
    verifyApplicationRollout(snapshot, [{ version: 4, percentage: 100, configuration: { image } }]);
  });
  test("a permanently old but complete application still fails at exactly 180 seconds", async () => {
    let now = 0;
    await expect(
      waitForApplicationRollout(
        async () => ({
          snapshot: before,
          versions: [{ version: 3, percentage: 100, configuration: { image } }],
        }),
        {
          now: () => now,
          wait: async (ms: number) => {
            now += ms;
          },
          publication: { version: 4, image },
        },
      ),
    ).rejects.toThrow("rollout_pending");
    expect(now).toBe(180000);
  });
});

describe("serial workflow resumes publication once without bypassing a Container gate", () => {
  const workflow = readFileSync(
    resolve(REPO_ROOT, ".github/workflows/_deploy-workers.yml"),
    "utf8",
  );
  const steps = workflowSteps(workflow);
  test("direct inner-job concurrency applies to releases, rollback and selected-job reruns", () => {
    expect(workflow).toContain(
      "concurrency:\n      group: production-deploy\n      cancel-in-progress: false",
    );
    for (const caller of ["deploy.yml", "rollback.yml"])
      expect(readFileSync(resolve(REPO_ROOT, ".github/workflows", caller), "utf8")).not.toContain(
        "group: production-deploy",
      );
  });
  test("original native publication order and gate order survive simulated failures at every boundary", () => {
    const publications = steps.filter((s) => s.body.includes("id: cf-deploy-"));
    const allNames = publications.map((s) => /id: cf-deploy-([^\n]+)/u.exec(s.body)![1]!);
    const count = new Map<string, number>();
    let saved: Record<string, { outcome: string }> = {};
    for (const failureAt of [...CONTAINER_TARGETS.map((t) => t.name), null]) {
      const current: Record<string, { outcome: string }> = {};
      let failed = false;
      for (const step of steps) {
        const match = /id: cf-deploy-([^\n]+)/u.exec(step.body);
        if (match) {
          const name = match[1]!,
            id = `cf-deploy-${name}`;
          if (CONTAINER_TARGETS.some((target) => target.name === name))
            expect(step.body).toContain(
              `!contains(fromJson(steps.resume.outputs.published || '[]'), '${name}')`,
            );
          else expect(step.body).not.toContain("steps.resume.outputs.published");
          const skipped =
            CONTAINER_TARGETS.some((target) => target.name === name) &&
            saved[id]?.outcome === "success";
          current[id] = { outcome: skipped ? "skipped" : "success" };
          if (!skipped) count.set(name, (count.get(name) ?? 0) + 1);
        }
        const checkpoint = /run: node "\$\{RELEASE_RESUME\}" capture ([^\n]+)/u.exec(step.body);
        if (checkpoint) {
          saved = mergePublicationSteps(saved, current);
        }
        if (failureAt && step.body.includes(`id: verify-container-${failureAt}\n`)) {
          failed = true;
          break;
        }
      }
      if (failureAt) expect(failed).toBe(true);
    }
    expect(count.size).toBe(17);
    for (const name of allNames) {
      if (CONTAINER_TARGETS.some((target) => target.name === name)) expect(count.get(name)).toBe(1);
      else {
        const position = allNames.indexOf(name);
        const expected = [
          ...CONTAINER_TARGETS.map((target) => allNames.indexOf(target.name)),
          allNames.length,
        ].filter((boundary) => position <= boundary).length;
        expect(count.get(name)).toBe(expected);
      }
    }
  });
  test("resume skips building/image preparation and bound Containers; ordinary publications and migrations still run", () => {
    for (const name of [
      "Build every deployable bundle",
      "Validate every Worker without uploading",
      "Capture the exact local Container images",
      "Capture Container identity and pin rollback images",
    ])
      expect(steps.find((s) => s.name === name)?.body).toContain(
        "steps.resume.outputs.resume != 'true'",
      );
    for (const name of [
      "Compare the schema with the recorded release",
      "Apply the CORE migrations",
      "Apply the READ migrations",
    ])
      expect(steps.find((s) => s.name === name)?.body).not.toContain(
        "steps.resume.outputs.resume != 'true'",
      );
    for (const target of CONTAINER_TARGETS) {
      const guard = steps.find((s) => s.body.includes(`id: verify-container-${target.name}\n`))!;
      expect(guard.body).not.toContain("steps.resume.outputs.published");
      expect(guard.body).toContain(`post ${target.name}`);
    }
  });
  test("saved publication proof cannot turn a failed current guard into release success", () => {
    const result = mergePublicationSteps(
      {
        "cf-deploy-globalpass-worker": { outcome: "success" },
        "verify-container-globalpass-worker": { outcome: "success" },
      },
      {
        "cf-deploy-globalpass-worker": { outcome: "skipped" },
        "verify-container-globalpass-worker": { outcome: "failure" },
      },
    );
    expect(result["cf-deploy-globalpass-worker"]?.outcome).toBe("success");
    expect(result["verify-container-globalpass-worker"]?.outcome).toBe("failure");
  });
});

test("real Node restores native and legacy prepared bytes with exact artifact/image proof", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { execFileSync, spawnSync } = require("node:child_process");
  const { containerInputDigest } = require("./ci/cf-container-release.mjs");
  for (const native of [false, true]) {
    const dir = mkdtempSync(resolve(tmpdir(), "kogane-resume-cli-"));
    try {
      const root = resolve(dir, "checkout"),
        temp = resolve(dir, "temp"),
        tools = resolve(dir, "tools");
      for (const path of [
        root,
        temp,
        tools,
        resolve(root, target.path, "container"),
        resolve(root, "dist/test"),
      ])
        mkdirSync(path, { recursive: true });
      const config = resolve(root, target.path, "wrangler.jsonc");
      writeFileSync(config, '{"synthetic":"original stamped config"}');
      writeFileSync(resolve(root, "dist/test/entry.js"), "synthetic original bundle");
      writeFileSync(
        resolve(root, target.path, "Dockerfile"),
        "FROM scratch\nCOPY container/source.mjs /source.mjs\n",
      );
      writeFileSync(resolve(root, target.path, "container/source.mjs"), "synthetic image input");
      const cf = resolve(root, target.path, ".cloudflare/output/v0");
      mkdirSync(cf, { recursive: true });
      writeFileSync(resolve(cf, "metadata.json"), "synthetic exact cf output");
      const manifest = {
        configs: [{ path: target.path + "/wrangler.jsonc" }],
        bundles: [{ directory: "dist/test" }],
        workers: [{ name: target.name, path: target.path }],
        ...(native ? { cfArtifacts: [{ name: target.name }] } : {}),
      };
      writeFileSync(resolve(temp, "release-manifest.json"), JSON.stringify(manifest));
      writeFileSync(
        resolve(temp, "release-plan.json"),
        JSON.stringify({ selected: [target.name] }),
      );
      writeFileSync(resolve(temp, "previous-record.json"), "null");
      writeFileSync(
        resolve(temp, "container-baseline.json"),
        JSON.stringify({ registryNamespace: "synthetic", snapshots: [before] }),
      );
      const imageId = `sha256:${"f".repeat(64)}`;
      const localTag = `cloudflare-build/${"d".repeat(12)}/${target.appName}:${"e".repeat(12)}`;
      writeFileSync(
        resolve(temp, "container-manifest.json"),
        JSON.stringify([
          {
            name: target.name,
            imageId,
            localTag,
            inputs: containerInputDigest(root, target),
            daemonId: "original-daemon",
          },
        ]),
      );
      writeFileSync(
        resolve(tools, "docker"),
        '#!/bin/sh\ncase "$1 $2" in "image save") printf "synthetic Docker archive" > "$4";; "image load") test -s "$4";; "image inspect") printf "%s\\n" "$MOCK_IMAGE_ID";; "info --format") printf "restored-daemon\\n";; *) exit 1;; esac\n',
      );
      chmodSync(resolve(tools, "docker"), 0o755);
      const guard = resolve(REPO_ROOT, "tasks/_lib/ci/release-resume.mjs");
      const env = {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_ENV: resolve(temp, "env"),
        GITHUB_OUTPUT: resolve(temp, "outputs"),
        GITHUB_TOKEN: "synthetic-token",
        GITHUB_REPOSITORY: "synthetic/repository",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        SHA: sha,
        TRUSTED_SHA: trustedSha,
        CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
        CLOUDFLARE_API_TOKEN: "synthetic-cf-token",
        MOCK_IMAGE_ID: imageId,
      };
      const packed = spawnSync("node", [guard, "pack"], { cwd: root, env, encoding: "utf8" });
      expect(packed.stderr).toBe("");
      expect(packed.status).toBe(0);
      const zip = resolve(dir, "prepared.zip");
      execFileSync("python3", [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],'prepared.tar'); z.close()",
        zip,
        resolve(temp, "prepared.tar"),
      ]);
      const bytes = readFileSync(zip),
        artifactDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const record = {
        ...deployment().payload,
        resume: { ...deployment().payload.resume, artifactDigest },
        containerManifestSha256: createHash("sha256")
          .update(readFileSync(resolve(temp, "container-manifest.json")))
          .digest("hex"),
        containerBaselineSha256: createHash("sha256")
          .update(readFileSync(resolve(temp, "container-baseline.json")))
          .digest("hex"),
      };
      writeFileSync(resolve(temp, "release-record.json"), JSON.stringify(record));
      writeFileSync(
        resolve(temp, "resume-receipt.json"),
        JSON.stringify({ ...receipt(), targets: [{ ...before, version: 4 }] }),
      );
      writeFileSync(config, "changed local config");
      writeFileSync(resolve(root, "dist/test/entry.js"), "changed local bundle");
      const bootstrap = resolve(dir, "bootstrap.mjs");
      writeFileSync(
        bootstrap,
        `import {readFileSync} from 'node:fs';
      globalThis.fetch=async(url,options={})=>{
        const text=String(url);
        if(text==='https://artifact.invalid/archive'){
          if(options.headers?.Authorization)throw Error('credential redirected');
          const bytes=readFileSync(${JSON.stringify(zip)});
          if(process.env.MOCK_TAMPER==='true')bytes[0]^=1;
          return new Response(bytes,{status:200});
        }
        if(text.endsWith('/actions/artifacts/100/zip'))return new Response(null,{status:302,headers:{location:'https://artifact.invalid/archive'}});
        let value;
        if(text.endsWith('/actions/artifacts/100'))value={id:100,digest:${JSON.stringify(artifactDigest)},expired:false,workflow_run:{id:123}};
        else if(text.endsWith('/deployments'))value={success:true,result:{deployments:[{versions:[{version_id:${JSON.stringify(versionId)},percentage:100}]}]}};
        else if(text.includes('/workers/scripts/')&&text.includes('/versions/'))value={success:true,result:{resources:{bindings:[{type:'durable_object_namespace',class_name:${JSON.stringify(target.className)},namespace_id:${JSON.stringify("e".repeat(32))}}]}}};
        else if(text.includes('/containers/applications/') && text.endsWith('/versions'))value={success:true,result:[{version:4,configuration:{image:${JSON.stringify(image)}},percentage:100}]};
        else if(text.includes('/containers/applications/'))value={success:true,result:{id:${JSON.stringify(target.appId)},name:${JSON.stringify(target.appName)},account_id:${JSON.stringify("b".repeat(32))},scheduling_policy:'default',max_instances:2,configuration:{vcpu:0.25,memory_mib:1024,disk:{size_mb:4000},image:${JSON.stringify(image)}},constraints:{regions:['APAC']},durable_objects:{namespace_id:${JSON.stringify("e".repeat(32))}},version:4,active_rollout_id:null}};
        else throw Error('unexpected request');
        return Response.json(value);
      };`,
      );
      const run = (patch = {}) =>
        spawnSync("node", ["--import", bootstrap, guard, "restore"], {
          cwd: root,
          env: { ...env, ...patch },
          encoding: "utf8",
        });
      const restored = run();
      expect(restored.stderr).toBe("");
      expect(restored.status).toBe(0);
      expect(readFileSync(config, "utf8")).toContain("original stamped config");
      expect(readFileSync(resolve(root, "dist/test/entry.js"), "utf8")).toBe(
        "synthetic original bundle",
      );
      if (native)
        expect(readFileSync(resolve(cf, "metadata.json"), "utf8")).toBe(
          "synthetic exact cf output",
        );
      expect(readFileSync(resolve(temp, "env"), "utf8")).toContain(
        "CONTAINER_RESTORED_DAEMON=restored-daemon",
      );
      expect(run({ MOCK_TAMPER: "true" }).stderr.trim()).toBe("release_resume_artifact_digest");
      expect(run({ MOCK_IMAGE_ID: `sha256:${"a".repeat(64)}` }).stderr.trim()).toBe(
        "release_resume_restored_image",
      );
      writeFileSync(resolve(root, target.path, "container/source.mjs"), "changed input");
      expect(run().stderr.trim()).toBe("release_resume_restored_image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
