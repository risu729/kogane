import { existsSync, readFileSync } from "node:fs";
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
  test("compatible Workers use cf while Container applications stay on v1", () => {
    expect(targets.map((worker) => worker.name)).toEqual([
      "mobile-suica-worker",
      "moneyforward-worker",
      "myjcb-worker",
      "sbi-securities-worker",
      "sbi-vc-trade-worker",
      "smbc-direct-backfill-worker",
      "mizuho-worker",
      "sony-bank-worker",
      "vpass-json",
      "vpoint-pay-worker",
      "vpoint-worker",
      "processor",
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
              "migrations",
              "vpc_networks",
              "limits",
              "queues",
            ].includes(key),
        ),
      ).toEqual([]);
      if (old.migrations) {
        expect(target.doLifecycle).toBe("preserve");
        expect(worker.exports).toBeUndefined();
        expect((worker as any).migrations).toBeUndefined();
      } else expect(target.doLifecycle).toBeUndefined();
      const example = `${REPO_ROOT}/${target.path}/.dev.vars.example`;
      const inferredSecrets =
        target.doLifecycle === "preserve" && existsSync(example)
          ? [...readFileSync(example, "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map(
              (match) => match[1]!,
            )
          : [];
      const secretNames = [...new Set([...(old.secrets?.required ?? []), ...inferredSecrets])];
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
      for (const key of secretNames) expect(worker.env[key]).toEqual({ type: "secret" });
      for (const binding of old.r2_buckets ?? [])
        expect(worker.env[binding.binding]).toEqual({ type: "r2", name: binding.bucket_name });
      for (const binding of old.d1_databases ?? [])
        expect(worker.env[binding.binding]).toEqual({
          type: "d1",
          name: binding.database_name,
          id: binding.database_id,
        });
      for (const binding of old.services ?? [])
        expect(worker.env[binding.binding]).toEqual({
          type: "worker",
          worker: binding.service,
          ...(binding.entrypoint ? { exportName: binding.entrypoint } : {}),
        });
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
      for (const binding of old.vpc_networks ?? [])
        expect(worker.env[binding.binding]).toEqual({
          type: "vpc-network",
          tunnelId: binding.tunnel_id,
          ...(binding.remote ? { dev: { remote: true } } : {}),
        });
      expect(worker.limits).toEqual(old.limits ? camel(old.limits) : undefined);
      expect(worker.triggers ?? []).toEqual(
        (old.queues?.consumers ?? []).map(({ queue, ...settings }: any) => ({
          type: "queue",
          name: queue,
          ...camel(settings),
        })),
      );
      expect(Object.keys(worker.env).sort()).toEqual(
        [
          ...Object.keys(old.vars ?? {}),
          ...secretNames,
          ...(old.r2_buckets ?? []).map((binding: any) => binding.binding),
          ...(old.d1_databases ?? []).map((binding: any) => binding.binding),
          ...(old.services ?? []).map((binding: any) => binding.binding),
          ...(old.vpc_networks ?? []).map((binding: any) => binding.binding),
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
      expect(cf?.body).toContain(
        `deploy-triggers: '${target.name === "processor" ? "true" : "false"}'`,
      );
      expect(steps.indexOf(cf!)).toBe(steps.indexOf(legacy!) + 1);
    });
  }
  test("legacy lifecycle stays canonical and is checked around publication", () => {
    const history: Record<string, unknown[]> = {
      "sbi-vc-trade-worker": [{ tag: "v1", new_sqlite_classes: ["SbiVcSessionState"] }],
      "smbc-direct-backfill-worker": [{ tag: "v1", new_sqlite_classes: ["SmbcBackfillSession"] }],
      processor: [{ tag: "alarm-v1", new_sqlite_classes: ["ScheduleAlarm"] }],
    };
    for (const target of targets.filter((entry) => entry.doLifecycle === "preserve")) {
      const old = parseJsonc(readFileSync(`${REPO_ROOT}/${target.path}/${target.config}`, "utf8"));
      expect(old.migrations).toEqual(history[target.name]);
    }
    const capture = steps.find(
      (step) => step.name === "Capture the existing DO namespaces and lifecycle",
    )!;
    const verify = steps.find(
      (step) => step.name === "Verify the existing DO namespaces and lifecycle",
    )!;
    expect(capture.body).toContain("cf-do-identity.mjs capture");
    expect(verify.body).toContain("cf-do-identity.mjs verify");
    expect(steps.indexOf(capture)).toBeLessThan(
      steps.findIndex((step) => step.name === "Open the deployment record"),
    );
    expect(steps.indexOf(verify)).toBeGreaterThan(
      steps.findIndex((step) => step.body.includes("id: cf-deploy-app")),
    );
  });
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
