import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../../scripts/jsonc.ts";
import { readDeployOrder, workflowSteps } from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { releaseProgress } from "./ci/release-ledger.mjs";
import { spawnSync } from "node:child_process";

const order = readDeployOrder();
const targets = order.workers.filter((worker) => worker.deployBackend === "cf");
const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");
const steps = workflowSteps(workflow);
const camel = (value: unknown): any =>
  Array.isArray(value)
    ? value.map(camel)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key.replace(/_([a-z])/gu, (_all, char) => char.toUpperCase()),
            camel(item),
          ]),
        )
      : value;

describe("cf migration preserves the canonical Wrangler deployment contract", () => {
  test("only compatible Workers use cf; legacy DO and Containers stay on v1", () => {
    expect(targets.map((worker) => worker.name)).toEqual([
      "mobile-suica-worker",
      "moneyforward-worker",
      "myjcb-worker",
      "sbi-securities-worker",
      "mizuho-worker",
      "sony-bank-worker",
      "vpass-json",
      "vpoint-pay-worker",
      "vpoint-worker",
      "app",
    ]);
  });
  for (const target of targets) {
    test(`${target.name} keeps bindings, settings and existing exports`, async () => {
      const old = parseJsonc(readFileSync(`${REPO_ROOT}/${target.path}/${target.config}`, "utf8"));
      const config = (await import(`${REPO_ROOT}/${target.path}/cloudflare.config.ts`)).default;
      const worker = config.worker;
      expect(
        Object.keys(old).filter(
          (key) =>
            ![
              "$schema",
              "name",
              "account_id",
              "main",
              "compatibility_date",
              "compatibility_flags",
              "workers_dev",
              "preview_urls",
              "observability",
              "vars",
              "secrets",
              "r2_buckets",
              "browser",
              "triggers",
              "d1_databases",
              "exports",
              "durable_objects",
              "services",
              "assets",
            ].includes(key),
        ),
      ).toEqual([]);
      expect(old.migrations).toBeUndefined();
      expect(old.containers).toBeUndefined();
      expect(config.accountId).toBe(old.account_id);
      expect(worker.name).toBe(old.name);
      expect(worker.entrypoint).toBe(old.main);
      expect(worker.compatibilityDate).toBe(old.compatibility_date);
      expect(worker.compatibilityFlags).toEqual(old.compatibility_flags);
      expect(worker.workersDev).toBe(old.workers_dev);
      expect(worker.previewUrls).toBe(false);
      expect(worker.observability).toEqual(camel(old.observability));
      for (const [key, value] of Object.entries(old.vars ?? {}))
        expect(worker.env[key]).toEqual({ type: "text", value });
      for (const key of old.secrets?.required ?? [])
        expect(worker.env[key]).toEqual({ type: "secret" });
      for (const binding of old.r2_buckets ?? [])
        expect(worker.env[binding.binding]).toEqual({ type: "r2", name: binding.bucket_name });
      for (const binding of old.d1_databases ?? [])
        expect(worker.env[binding.binding]).toEqual({
          type: "d1",
          name: binding.database_name,
          id: binding.database_id,
        });
      for (const binding of old.services ?? [])
        expect(worker.env[binding.binding]).toEqual({ type: "worker", worker: binding.service });
      for (const binding of old.durable_objects?.bindings ?? [])
        expect(worker.env[binding.name]).toEqual({
          type: "durable-object",
          worker: old.name,
          exportName: binding.class_name,
        });
      expect(worker.exports ?? {}).toEqual(old.exports ?? {});
      if (old.browser)
        expect(worker.env[old.browser.binding]).toEqual({
          type: "browser",
          ...(old.browser.remote ? { dev: { remote: true } } : {}),
        });
      if (old.assets) {
        expect(worker.env[old.assets.binding]).toEqual({ type: "assets" });
        expect(worker.assets).toEqual({
          runWorkerFirst: old.assets.run_worker_first,
          notFoundHandling: old.assets.not_found_handling,
        });
        const buildConfig = (await import(`${REPO_ROOT}/${target.path}/wrangler.config.ts`))
          .default;
        expect(buildConfig.assetsDirectory).toBe(old.assets.directory);
      }
      expect(worker.triggers ?? []).toEqual([]);
      expect(Object.keys(worker.env).sort()).toEqual(
        [
          ...Object.keys(old.vars ?? {}),
          ...(old.secrets?.required ?? []),
          ...(old.r2_buckets ?? []).map((binding: any) => binding.binding),
          ...(old.d1_databases ?? []).map((binding: any) => binding.binding),
          ...(old.services ?? []).map((binding: any) => binding.binding),
          ...(old.durable_objects?.bindings ?? []).map((binding: any) => binding.name),
          ...(old.browser ? [old.browser.binding] : []),
          ...(old.assets ? [old.assets.binding] : []),
        ].sort(),
      );
    });
    test(`${target.name} selects exactly one pinned backend for the target checkout`, () => {
      const legacy = steps.find((step) => step.body.includes(`id: deploy-${target.name}\n`));
      const cf = steps.find((step) => step.body.includes(`id: cf-deploy-${target.name}\n`));
      expect(legacy?.body).toContain(
        `!contains(fromJson(steps.select.outputs.cf-selected), '${target.name}')`,
      );
      expect(cf?.body).toContain(
        `&& contains(fromJson(steps.select.outputs.cf-selected), '${target.name}')`,
      );
      expect(cf?.body).toContain("@0d45a001e87e556e88dcf4aa6111a2dab05ea42b # v2.1.1");
      expect(cf?.body).toContain(`worker: ${target.worker}`);
      expect(cf?.body).toContain("deploy-triggers: 'false'");
      expect(steps.indexOf(cf!)).toBe(steps.indexOf(legacy!) + 1);
    });
  }
  test("the trusted progress adapter works with a legacy ledger on rollback", () => {
    const progress = steps.find((step) => step.name === "Record what this run deployed")!;
    const expression = /STEPS_JSON=\$\(jq -c '([^']+)'/u.exec(progress.body)![1]!;
    for (const outcome of ["success", "failure", "skipped"]) {
      const context = { "deploy-app": { outcome: "skipped" }, "cf-deploy-app": { outcome } };
      const result = spawnSync("jq", ["-c", expression], {
        input: JSON.stringify(context),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const adapted = JSON.parse(result.stdout);
      expect(adapted["deploy-app"].outcome).toBe(outcome);
      const record = {
        recordVersion: "release-record-v2",
        sha: "a".repeat(40),
        workers: [
          {
            name: "app",
            worker: "kogane-evidence-browser",
            sha: "a".repeat(40),
            outcome: "planned",
          },
        ],
        coreMigrations: [],
        readMigrations: null,
      };
      expect((releaseProgress(record, adapted).workers as any[])[0].outcome).toBe(
        outcome === "success" ? "deployed" : outcome === "failure" ? "failed" : "skipped",
      );
    }
    expect(workflow).toContain('select(.deployBackend == "cf")');
  });
});
