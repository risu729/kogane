import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson } from "./ci/release-manifest.mjs";
import {
  CONTAINER_TARGETS,
  waitForApplicationRollout,
  verifyApplicationRollout,
  currentRegistryNamespace,
  verifyApplicationBaseline,
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
  streamArtifact,
  waitForPublicationCandidate,
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

describe("exact publication readback and the bounded convergence window", () => {
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
      [
        { version: 4, percentage: 50, configuration: { image } },
        { version: 5, percentage: 50, configuration: { image } },
      ],
    ])
      expect(() => publicationCandidate(before, versions, "synthetic", target)).toThrow(
        "publication_ambiguous",
      );
    for (const versions of [[], [{ version: 3, percentage: 100, configuration: { image } }]])
      expect(() => publicationCandidate(before, versions, "synthetic", target)).toThrow(
        "publication_pending",
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
    expect(() =>
      verifyResumeContainerState(
        before,
        undefined,
        { ...before, activeRolloutId: "synthetic-active" },
        versions,
      ),
    ).toThrow("rollout_pending");
    expect(() =>
      verifyResumeContainerState(before, undefined, before, [{ ...versions[0]!, percentage: 50 }]),
    ).toThrow("rollout_unverified");
    verifyResumeContainerState(
      before,
      { ...before, version: 4 },
      { ...before, activeRolloutId: "synthetic-active" },
      [{ version: 4, configuration: { image }, percentage: 50 }],
    );
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
  test("a permanently old but complete application still fails at exactly 600 seconds", async () => {
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
    expect(now).toBe(600000);
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
        '#!/bin/sh\ncase "$1 $2" in "image save") printf "synthetic Docker archive" > "$4";; "image load") test -s "$4";; "image inspect") test "$#" -eq 3 || exit 1; printf "%s\\n" "$MOCK_IMAGE_ID";; "info --format") printf "restored-daemon\\n";; *) exit 1;; esac\n',
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
        MOCK_IMAGE_ID: JSON.stringify([{ Id: imageId, Os: "linux", Architecture: "amd64" }]),
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
      rmSync(resolve(temp, "prepared"), { recursive: true });
      rmSync(resolve(temp, "prepared.tar"));
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
          if(process.env.MOCK_FETCH_FAIL==='true')throw Error('https://secret.invalid/private-token');
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
      expect(readdirSync(temp).filter((entry) => entry.startsWith("release-resume-"))).toEqual([]);
      expect(readdirSync(temp)).not.toContain("docker-images.tar");
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
      expect(readdirSync(temp).filter((entry) => entry.startsWith("release-resume-"))).toEqual([]);
      expect(run({ MOCK_FETCH_FAIL: "true" }).stderr.trim()).toBe("release_resume_artifact_fetch");
      expect(
        run({
          MOCK_IMAGE_ID: JSON.stringify([
            { Id: `sha256:${"a".repeat(64)}`, Os: "linux", Architecture: "amd64" },
          ]),
        }).stderr.trim(),
      ).toBe("release_resume_restored_image");
      writeFileSync(resolve(root, target.path, "container/source.mjs"), "changed input");
      expect(run().stderr.trim()).toBe("release_resume_restored_image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("streamed artifact stays private until complete checksum and never overwrites promotion", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "kogane-stream-"));
  try {
    const chunks = [Buffer.alloc(70001, 0x5a), Buffer.from("synthetic final bytes")];
    const digest = `sha256:${createHash("sha256").update(chunks[0]!).update(chunks[1]!).digest("hex")}`;
    async function* source() {
      yield chunks[0]!;
      const directory = readdirSync(temp).find((entry) =>
        readdirSync(resolve(temp, entry)).includes("artifact.part"),
      )!;
      expect(readdirSync(resolve(temp, directory))).toEqual(["artifact.part"]);
      expect(statSync(resolve(temp, directory)).mode & 0o777).toBe(0o700);
      yield chunks[1]!;
    }
    const artifact = await streamArtifact(source(), digest, temp);
    expect(readFileSync(artifact.zip)).toEqual(Buffer.concat(chunks));
    expect(readdirSync(artifact.directory)).toEqual(["artifact.zip"]);
    // Subsequent attempts get a new private path, leaving existing verified files intact.
    const second = await streamArtifact(source(), digest, temp);
    expect(second.directory).not.toBe(artifact.directory);
    expect(readFileSync(artifact.zip)).toEqual(Buffer.concat(chunks));
    const sentinel = resolve(temp, "sentinel");
    writeFileSync(sentinel, "original");
    await expect(
      streamArtifact(
        (async function* () {
          yield chunks[0]!;
          yield chunks[1]!;
        })(),
        digest,
        temp,
        {
          beforePromote: (directory: string) =>
            symlinkSync(sentinel, resolve(directory, "artifact.zip")),
        },
      ),
    ).rejects.toThrow("release_resume_artifact_promote");
    expect(readFileSync(sentinel, "utf8")).toBe("original");
    expect(readdirSync(temp).length).toBe(3); // two verified directories + sentinel
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("tamper and interrupted streams remove quarantine without promotion or raw diagnostics", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "kogane-stream-"));
  try {
    const bytes = Buffer.from("synthetic bytes");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await expect(
      streamArtifact(
        (async function* () {
          yield Buffer.from("tampered");
        })(),
        digest,
        temp,
      ),
    ).rejects.toThrow("release_resume_artifact_digest");
    expect(readdirSync(temp)).toEqual([]);
    await expect(
      streamArtifact(
        (async function* () {
          yield bytes;
          throw Error("https://secret.invalid/private-token");
        })(),
        digest,
        temp,
      ),
    ).rejects.toThrow("release_resume_artifact_body");
    expect(readdirSync(temp)).toEqual([]);
    await expect(
      streamArtifact(
        (async function* () {
          yield "invalid chunk";
        })(),
        digest,
        temp,
      ),
    ).rejects.toThrow("release_resume_artifact_chunk");
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native Node refuses oversized incoming chunks without touching or materializing them", () => {
  const { spawnSync } = require("node:child_process");
  const code = `import {streamArtifact} from ${JSON.stringify(resolve(REPO_ROOT, "tasks/_lib/ci/release-resume.mjs"))};
    import {mkdtempSync,readdirSync,rmSync} from 'node:fs'; import {tmpdir} from 'node:os';
    const directory=mkdtempSync(tmpdir()+'/kogane-hash-limit-');
    try {
      try { await streamArtifact((async function*(){yield Buffer.allocUnsafe(2**31);})(),'sha256:'+'a'.repeat(64),directory); throw Error('unexpected acceptance'); }
      catch(error){if(error.message!=='release_resume_artifact_chunk')throw error;}
      if(readdirSync(directory).length || process.resourceUsage().maxRSS>256*1024)throw Error('resource boundary');
    } finally {rmSync(directory,{recursive:true,force:true});}`;
  const result = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

describe("allocation capture waits only for zero within an absolute deadline", () => {
  const unique = [{ version: 4, percentage: 0, configuration: { image } }];
  const state = (versions = unique, snapshot = before) => ({
    snapshot,
    versions,
    registryNamespace: "synthetic",
  });
  const options = (now: () => number, wait: (ms: number) => Promise<void>) => ({
    before,
    target,
    publishedVersion: versionId,
    deadline: 30000,
    now,
    wait,
  });
  test("zero becomes unique at 29 seconds but late 30 seconds cannot bind", async () => {
    let clock = 0,
      calls = 0;
    const result = await waitForPublicationCandidate(
      async (deadline: number) => {
        expect(deadline).toBe(30000);
        calls++;
        if (calls === 2) {
          clock = 29000;
          return state();
        }
        return state([]);
      },
      options(
        () => clock,
        async (ms) => {
          clock += ms;
        },
      ),
    );
    expect(result.candidate.version).toBe(4);
    expect(calls).toBe(2);
    clock = 0;
    await expect(
      waitForPublicationCandidate(
        async () => {
          clock = 30000;
          return state();
        },
        options(
          () => clock,
          async (ms) => {
            clock += ms;
          },
        ),
      ),
    ).rejects.toThrow("publication_pending");
    clock = 0;
    calls = 0;
    await expect(
      waitForPublicationCandidate(
        async () => {
          calls++;
          return state([]);
        },
        options(
          () => clock,
          async (ms) => {
            clock += ms;
          },
        ),
      ),
    ).rejects.toThrow("publication_pending");
    expect(clock).toBe(30000);
    expect(calls).toBe(6);
  });
  test("ambiguity/schema/read and exact identity drift are immediate refusals", async () => {
    const failures = [
      () => state([...unique, { ...unique[0]!, version: 5 }]),
      () => state([{ ...unique[0]!, version: "4" }]),
      () => state([{ version: 3, percentage: 100 }]),
      () => state(unique, { ...before, image: "synthetic-other" }),
      () => state(unique, { ...before, workerVersion: "ffffffff-ffff-4fff-afff-ffffffffffff" }),
      () => state(unique, { ...before, namespaces: [] }),
      () => state(unique, { ...before, version: 5 }),
      () =>
        state(unique, {
          ...before,
          version: 4,
          image: image.replace("c".repeat(64), "d".repeat(64)),
        }),
      () => ({ ...state(), registryNamespace: "alien" }),
      () => {
        throw Error("synthetic read failure");
      },
    ];
    for (const read of failures) {
      let waits = 0;
      await expect(
        waitForPublicationCandidate(
          async () => read(),
          options(
            () => 0,
            async () => {
              waits++;
            },
          ),
        ),
      ).rejects.toThrow();
      expect(waits).toBe(0);
    }
  });
  test("original prepublication baseline rejects every unstable or changed state", () => {
    const stable = [{ version: 3, percentage: 100, configuration: { image } }];
    verifyApplicationBaseline(before, before, stable);
    for (const patch of [
      { activeRolloutId: "synthetic-active" },
      { workerVersion: "f".repeat(36) },
      { version: 4 },
      { image: "synthetic-other" },
      { namespaces: [] },
    ])
      expect(() => verifyApplicationBaseline(before, { ...before, ...patch }, stable)).toThrow();
    for (const versions of [
      [],
      [{ ...stable[0]!, percentage: 50 }],
      [...stable, { ...stable[0]!, version: 4, percentage: 0 }],
      [{ ...stable[0]!, version: "3" }],
    ])
      expect(() => verifyApplicationBaseline(before, before, versions)).toThrow();
    const workflow = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/_deploy-workers.yml"),
      "utf8",
    );
    for (const selected of CONTAINER_TARGETS) {
      const guard = workflow.indexOf(`id: verify-publication-baseline-${selected.name}`);
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(workflow.indexOf(`id: deploy-${selected.name}`));
      expect(guard).toBeLessThan(workflow.indexOf(`id: cf-deploy-${selected.name}`));
    }
  });
});

test("real Node capture waits for allocation visibility and rechecks proof before writing", () => {
  const { spawnSync } = require("node:child_process");
  const temp = mkdtempSync(resolve(tmpdir(), "kogane-publication-cli-"));
  try {
    const imageId = `sha256:${"f".repeat(64)}`;
    const registryBytes = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: imageId },
    });
    const newImage = `registry.cloudflare.com/synthetic/${target.appName}@sha256:${createHash("sha256").update(registryBytes).digest("hex")}`;
    writeFileSync(
      resolve(temp, "container-baseline.json"),
      JSON.stringify({ registryNamespace: "synthetic", snapshots: [before] }),
    );
    writeFileSync(
      resolve(temp, "container-manifest.json"),
      JSON.stringify([{ name: target.name, imageId, legacy: false }]),
    );
    writeFileSync(resolve(temp, "release-record.json"), JSON.stringify(deployment().payload));
    writeFileSync(resolve(temp, "release-plan.json"), JSON.stringify({ selected: [target.name] }));
    const bootstrap = resolve(temp, "bootstrap.mjs");
    writeFileSync(
      bootstrap,
      `
      let clock=0,reads=0,versionReads=0; Date.now=()=>clock;
      globalThis.setTimeout=(done,ms)=>{clock+=ms;queueMicrotask(done);return {unref(){}}};
      const mode=process.env.MOCK_MODE;
      globalThis.fetch=async(url,options={})=>{
        const text=String(url);let value;
        if(text.startsWith('https://registry.cloudflare.com/')){if(mode==='registry-late')clock=30000;return new Response(mode==='image'?'synthetic tampered manifest':${JSON.stringify(registryBytes)});}
        if(text.endsWith('/containers/me'))value={external_account_id:mode==='namespace'||(mode==='final-namespace'&&reads===2)?'alien':'synthetic'};
        else if(text.endsWith('/credentials'))value={account_id:'synthetic',registry_host:'registry.cloudflare.com',username:'synthetic',password:'synthetic'};
        else if(text.endsWith('/deployments')){reads++;value={deployments:[{versions:[{version_id:mode==='worker'||(mode==='legacy-drift'&&reads>=2)||(mode==='final-worker'&&reads===2)?'ffffffff-ffff-4fff-afff-ffffffffffff':${JSON.stringify(versionId)},percentage:100}]}]};}
        else if(text.includes('/workers/scripts/'))value={resources:{bindings:[{type:'durable_object_namespace',class_name:${JSON.stringify(target.className)},namespace_id:${JSON.stringify("e".repeat(32))}}]}};
        else if(text.endsWith('/versions')){
          versionReads++;
          if(mode==='late')clock=30000;
          const versions=[{version:3,percentage:100,configuration:{image:${JSON.stringify(image)}}}];
          if(mode!=='zero' && mode!=='unstable' && !((mode==='delayed'||mode==='legacy-drift')&&versionReads===1))versions.push({version:4,percentage:0,configuration:{image:${JSON.stringify(newImage)}}});
          if(mode==='ambiguous')versions.push({version:5,percentage:0,configuration:{image:${JSON.stringify(newImage)}}});
          if(mode==='final-app'&&versionReads===2)versions[1].configuration.image=${JSON.stringify(image)};
          value=versions;
        } else if(text.includes('/containers/applications/'))value={id:${JSON.stringify(target.appId)},name:${JSON.stringify(target.appName)},account_id:${JSON.stringify("b".repeat(32))},scheduling_policy:'default',max_instances:2,configuration:{vcpu:0.25,memory_mib:1024,disk:{size_mb:4000},image:mode==='final-old-image'&&reads===2?${JSON.stringify(newImage)}:${JSON.stringify(image)}},constraints:{regions:['APAC']},durable_objects:{namespace_id:${JSON.stringify("e".repeat(32))}},version:mode==='final-newer'&&reads===2?5:mode==='final-older'&&reads===2?2:3,active_rollout_id:mode==='unstable'?'11111111-1111-4111-a111-111111111111':null};
        else throw Error('unexpected request');
        return Response.json({success:true,result:value});
      };`,
    );
    const env = {
      ...process.env,
      RUNNER_TEMP: temp,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      SHA: sha,
      TRUSTED_SHA: trustedSha,
      CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic",
      PUBLISHED_WORKER_VERSION: versionId,
      DEPLOYMENT_ID: "42",
      STEPS_JSON: JSON.stringify(receipt().steps),
    };
    const resume = resolve(REPO_ROOT, "tasks/_lib/ci/release-resume.mjs");
    const run = (mode: string, command = "capture", helper = resume) =>
      spawnSync("node", ["--import", bootstrap, helper, command, target.name], {
        cwd: REPO_ROOT,
        env: {
          ...env,
          MOCK_MODE: mode,
          ...(mode === "legacy-drift"
            ? { PUBLISHED_WORKER_VERSION: "", LEGACY_PUBLICATION: "true" }
            : {}),
        },
        encoding: "utf8",
      });
    const saved = resolve(temp, "resume-receipt.json");
    const delayed = run("delayed");
    expect(delayed.stderr).toBe("");
    expect(delayed.status).toBe(0);
    expect(JSON.parse(readFileSync(saved, "utf8")).targets[0]).toMatchObject({
      version: 4,
      image: newImage,
      workerVersion: versionId,
    });
    for (const [mode, code] of [
      ["final-older", "application_superseded"],
      ["final-old-image", "application_superseded"],
      ["registry-late", "publication_pending"],
      ["image", "registry_digest_mismatch"],
      ["final-newer", "application_superseded"],
      ["final-namespace", "registry_namespace_changed"],
      ["legacy-drift", "published_worker_mismatch"],
      ["zero", "publication_pending"],
      ["late", "publication_pending"],
      ["ambiguous", "publication_ambiguous"],
      ["worker", "published_worker_mismatch"],
      ["namespace", "registry_namespace_changed"],
      ["final-worker", "worker_superseded"],
      ["final-app", "application_superseded"],
    ]) {
      rmSync(saved, { force: true });
      const result = run(mode!);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(code!);
      expect(readdirSync(temp)).not.toContain("resume-receipt.json");
    }
    const manifestId = newImage.split("@")[1];
    for (const [id, kind, success] of [
      [manifestId, "manifest", true],
      [imageId, "config", true],
      [manifestId, undefined, false],
      [imageId, "manifest", false],
    ] as const) {
      rmSync(saved, { force: true });
      writeFileSync(
        resolve(temp, "container-manifest.json"),
        JSON.stringify([{ name: target.name, imageId: id, imageIdKind: kind, legacy: false }]),
      );
      const result = run("success");
      expect(result.status).toBe(success ? 0 : 1);
      expect(readdirSync(temp).includes("resume-receipt.json")).toBe(success);
      if (!success) expect(result.stderr).toContain("registry_image_mismatch");
    }
    expect(run("unstable", "verify-publication-baseline").stderr).toContain("rollout_pending");
    const original = readFileSync(resolve(temp, "container-baseline.json"));
    writeFileSync(
      resolve(temp, "container-manifest.json"),
      JSON.stringify([
        { name: target.name, imageId, legacy: true, localTag: "synthetic-original" },
      ]),
    );
    expect(
      run("unstable", "prepare", resolve(REPO_ROOT, "tasks/_lib/ci/cf-container-release.mjs"))
        .stderr,
    ).toContain("rollout_pending");
    expect(readFileSync(resolve(temp, "container-baseline.json"))).toEqual(original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const phase of [
  "success",
  "namespace-late",
  "credentials-late",
  "registry-fetch-late",
  "registry-child-late",
  "cf-body-late",
  "registry-body-late",
  "final-late",
  "final-namespace",
  "final-worker",
  "final-image",
  "final-older",
  "unknown",
  "malformed-other",
  "malformed-array",
] as const)
  test(
    "native postcheck shares 600 seconds across CF, registry and final readback: " + phase,
    () => {
      const { spawnSync } = require("node:child_process");
      const temp = mkdtempSync(resolve(tmpdir(), "kogane-postcheck-cli-"));
      try {
        const imageId = `sha256:${"f".repeat(64)}`;
        const registryBytes = JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: { digest: imageId },
        });
        const childDigest = `sha256:${createHash("sha256").update(registryBytes).digest("hex")}`;
        const indexBytes = JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [{ digest: childDigest, platform: { os: "linux", architecture: "amd64" } }],
        });
        const indexDigest = `sha256:${createHash("sha256").update(indexBytes).digest("hex")}`;
        const newImage = `registry.cloudflare.com/synthetic/${target.appName}@${indexDigest}`;
        writeFileSync(
          resolve(temp, "container-baseline.json"),
          JSON.stringify({ registryNamespace: "synthetic", snapshots: [before] }),
        );
        writeFileSync(
          resolve(temp, "resume-receipt.json"),
          JSON.stringify({ targets: [{ ...before, version: 4, image: newImage }] }),
        );
        writeFileSync(
          resolve(temp, "release-plan.json"),
          JSON.stringify({ selected: [target.name] }),
        );
        const trace = resolve(temp, "trace.json"),
          bootstrap = resolve(temp, "bootstrap.mjs");
        writeFileSync(
          bootstrap,
          `
      import {writeFileSync} from 'node:fs';
      let clock=0,reads=0,registryReads=0; const signals=[]; Date.now=()=>clock;
      const nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout=(ms)=>{signals.push(ms);return nativeTimeout(ms)};
      globalThis.setTimeout=(done,ms)=>{clock+=ms;queueMicrotask(done);return {unref(){}}};
      const mode=process.env.MOCK_MODE;
      process.on('exit',()=>writeFileSync(${JSON.stringify(trace)},JSON.stringify({clock,reads,registryReads,signals})));
      globalThis.fetch=async(url,options={})=>{
        const text=String(url);let value;
        if(text.startsWith('https://registry.cloudflare.com/')){
          registryReads++;
          const bytes=text.endsWith(${JSON.stringify(indexDigest)})?${JSON.stringify(indexBytes)}:${JSON.stringify(registryBytes)};
          if(mode==='registry-fetch-late'||mode==='registry-child-late'&&registryReads===2)clock=600000;
          if(mode==='registry-body-late')return new Response(new ReadableStream({pull(controller){clock=600000;controller.enqueue(new TextEncoder().encode(bytes));controller.close()}}));
          return new Response(bytes);
        }
        if(text.endsWith('/containers/me')){
          if(mode==='namespace-late')clock=600000;
          value={external_account_id:mode==='final-namespace'&&registryReads>0?'alien':'synthetic'};
        } else if(text.endsWith('/credentials')){
          if(mode==='credentials-late')clock=600000;
          value={account_id:'synthetic',registry_host:'registry.cloudflare.com',username:'synthetic',password:'synthetic'};
        } else if(text.endsWith('/deployments')){
          reads++;
          if(mode==='unknown')return new Response('synthetic', {status:403});
          value={deployments:[{versions:[{version_id:mode==='final-worker'&&registryReads>0?'ffffffff-ffff-4fff-afff-ffffffffffff':${JSON.stringify(versionId)},percentage:100}]}]};
        } else if(text.includes('/workers/scripts/'))value={resources:{bindings:[{type:'durable_object_namespace',class_name:${JSON.stringify(target.className)},namespace_id:${JSON.stringify("e".repeat(32))}}]}};
        else if(text.endsWith('/versions')){value=[{version:mode==='delayed'&&reads===1?3:4,percentage:100,configuration:{image:mode==='delayed'&&reads===1?${JSON.stringify(image)}:${JSON.stringify(newImage)}}}];if(mode==='malformed-other')value.push({version:'bogus',percentage:0,configuration:{image:${JSON.stringify(newImage)}}});if(mode==='malformed-array')value={versions:value};}
        else if(text.includes('/containers/applications/')){
          if(mode==='delayed'&&reads===1)clock=590000;
          if(mode==='final-late'&&registryReads>0)clock=600000;
          value={id:${JSON.stringify(target.appId)},name:${JSON.stringify(target.appName)},account_id:${JSON.stringify("b".repeat(32))},scheduling_policy:'default',max_instances:2,configuration:{vcpu:0.25,memory_mib:1024,disk:{size_mb:4000},image:(mode==='delayed'&&reads===1)||(mode==='final-image'&&registryReads>0)||mode==='final-older'&&registryReads>0?${JSON.stringify(image)}:${JSON.stringify(newImage)}},constraints:{regions:['APAC']},durable_objects:{namespace_id:${JSON.stringify("e".repeat(32))}},version:mode==='final-older'&&registryReads>0?2:mode==='delayed'&&reads===1?3:4,active_rollout_id:mode==='final-active'&&reads===2?'11111111-1111-4111-a111-111111111111':null};
        } else throw Error('unexpected request');
        if(mode==='cf-body-late')return {status:200,json:async()=>{clock=600000;return {success:true,result:value}}};
        return Response.json({success:true,result:value});
      };`,
        );
        const saved = resolve(temp, `container-${target.name}-verified.json`);
        const run = (mode: string) => {
          rmSync(saved, { force: true });
          writeFileSync(
            resolve(temp, "container-manifest.json"),
            JSON.stringify([
              {
                name: target.name,
                imageId:
                  mode === "typed-manifest"
                    ? childDigest
                    : mode === "typed-index"
                      ? indexDigest
                      : imageId,
                imageIdKind:
                  mode === "typed-manifest"
                    ? "manifest"
                    : mode === "typed-index"
                      ? "index"
                      : undefined,
                legacy: mode === "legacy",
                registryImage: newImage,
              },
            ]),
          );
          return spawnSync(
            "node",
            [
              "--import",
              bootstrap,
              resolve(REPO_ROOT, "tasks/_lib/ci/cf-container-release.mjs"),
              "post",
              target.name,
            ],
            {
              cwd: REPO_ROOT,
              env: {
                ...process.env,
                RUNNER_TEMP: temp,
                MOCK_MODE: mode,
                CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
                CLOUDFLARE_API_TOKEN: "synthetic",
              },
              encoding: "utf8",
            },
          );
        };
        for (const mode of phase === "success"
          ? ["success", "delayed", "legacy", "typed-manifest", "typed-index", "final-active"]
          : []) {
          const result = run(mode);
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(readFileSync(saved, "utf8"))).toMatchObject({
            version: 4,
            image: newImage,
            workerVersion: versionId,
            activeRolloutId: null,
          });
          const observed = JSON.parse(readFileSync(trace, "utf8"));
          expect(observed.reads).toBeGreaterThanOrEqual(2);
          if (mode === "delayed") {
            expect(observed.clock).toBe(595000);
            expect(observed.signals).toContain(5000);
          }
          if (mode === "final-active") {
            expect(observed.clock).toBe(5000);
            expect(observed.registryReads).toBe(4);
          }
        }
        for (const [mode, code] of [
          ["namespace-late", "rollout_pending"],
          ["credentials-late", "rollout_pending"],
          ["registry-fetch-late", "rollout_pending"],
          ["registry-child-late", "rollout_pending"],
          ["cf-body-late", "rollout_pending"],
          ["registry-body-late", "rollout_pending"],
          ["final-late", "rollout_pending"],
          ["final-namespace", "registry_namespace_changed"],
          ["final-worker", "publication_superseded"],
          ["final-image", "publication_superseded"],
          ["final-older", "publication_superseded"],
          ["unknown", "api_http"],
          ["malformed-other", "version_shape"],
          ["malformed-array", "version_shape"],
        ].filter(([mode]) => mode === phase)) {
          const result = run(mode!);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(`cf_container_${code}`);
          expect(readdirSync(temp)).not.toContain(`container-${target.name}-verified.json`);
          expect(result.stderr).not.toContain("synthetic-token");
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
