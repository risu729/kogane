// Acceptance G5-09 (CI never holds a Cloudflare token), G5-10 (no preview or
// staging lane exists), G5-14 (consumers deploy before producers), G5-15 (a
// directory move never becomes a resource rename) and G5-17 (CD never
// synchronises a collector secret).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  automationFiles,
  automationViolations,
  collectorSecretNames,
  configOf,
  coverageViolations,
  type DeployEntry,
  deploySteps,
  deployStepMismatches,
  entryViolations,
  orderViolations,
  readDeployOrder,
  workflowSteps,
} from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";

const order = readDeployOrder();
const ledger = JSON.parse(readFileSync(`${REPO_ROOT}/infra/workers-ci.json`, "utf8")) as {
  workers: { name: string; path: string; config: string }[];
  excluded?: { path: string; config: string; reason: string }[];
};
const resources = JSON.parse(readFileSync(`${REPO_ROOT}/infra/resources.json`, "utf8")) as unknown;
const deployWorkflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");

function entry(overrides: Partial<DeployEntry> = {}): DeployEntry {
  return {
    name: "processor",
    path: "services/processor",
    config: "wrangler.jsonc",
    worker: "kogane-observation-pipeline",
    role: "consumer",
    deploy: false,
    healthPath: "",
    ...overrides,
  };
}

describe("the deployment ledger describes every Worker CI validates", () => {
  test("every validated configuration has exactly one deploy decision", () => {
    expect(coverageViolations(order.workers, ledger.workers, ledger.excluded ?? [])).toEqual([]);
  });

  test("every entry is well formed", () => {
    expect(order.workers.flatMap(entryViolations)).toEqual([]);
  });

  test("a configuration CI excludes may not be deployed", () => {
    const excluded = [{ path: "services/processor", config: "wrangler.ops.jsonc" }];
    const violations = coverageViolations(
      [entry({ name: "ops", config: "wrangler.ops.jsonc", deploy: true })],
      [{ name: "ops", path: "services/processor", config: "wrangler.ops.jsonc" }],
      excluded,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("must not be deployed");
  });

  test("a Worker CI validates but the ledger forgets is reported", () => {
    const violations = coverageViolations(
      [],
      [{ name: "new", path: "services/new", config: "wrangler.jsonc" }],
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("has no deploy decision");
  });

  test("a deployed Worker must name the bundle the manifest digests", () => {
    expect(entryViolations(entry({ deploy: true }))).toHaveLength(1);
    expect(
      entryViolations(
        entry({ deploy: true, bundleTask: "processor:bundle", bundleDir: "dist/processor" }),
      ),
    ).toEqual([]);
    expect(
      entryViolations(
        entry({ deploy: true, bundleTask: "processor:bundle", bundleDir: "dist/wrong" }),
      ),
    ).toHaveLength(1);
  });

  test("a health path is empty or absolute", () => {
    expect(entryViolations(entry({ healthPath: "health" }))).toHaveLength(1);
    expect(entryViolations(entry({ healthPath: "/health" }))).toEqual([]);
  });

  test("every deployed Worker keeps the name the live account already has", () => {
    // A directory move must never become a resource rename (G5-15): the ledger
    // records the Wrangler `name`, and this asserts it is the one in the config.
    for (const worker of order.workers) {
      const config = readFileSync(`${REPO_ROOT}/${configOf(worker)}`, "utf8");
      expect(/"name"\s*:\s*"([^"]+)"/u.exec(config)?.[1]).toBe(worker.worker);
    }
  });
});

describe("consumers deploy before producers (G5-14)", () => {
  test("the ledger is ordered", () => {
    expect(orderViolations(order.workers)).toEqual([]);
  });

  test("a producer listed before a consumer is reported", () => {
    const violations = orderViolations([
      entry({ name: "collector", role: "producer" }),
      entry({ name: "processor", role: "consumer" }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("consumers deploy first");
  });

  test("the deployed Workers are the consumers of the shared contract", () => {
    const deployed = order.workers.filter((worker) => worker.deploy);
    expect(deployed.map((worker) => worker.name)).toEqual([
      "processor",
      "app",
      "app-demo",
      "ingest",
      "importer",
    ]);
    expect(deployed.every((worker) => worker.role === "consumer")).toBe(true);
  });

  test("the PoC-era collectors are not deployed by CD yet", () => {
    // U09 flips them one source at a time, after the Processor consumes the
    // shared contract (plan 11 §4).
    const producers = order.workers.filter((worker) => worker.role === "producer");
    expect(producers.length).toBeGreaterThan(0);
    expect(producers.some((worker) => worker.deploy)).toBe(false);
  });
});

describe("the deploy workflow follows the ledger", () => {
  const steps = deploySteps(deployWorkflow);

  test("its deploy steps are the ledger's deployed Workers, in order", () => {
    expect(deployStepMismatches(order.workers, steps)).toEqual([]);
  });

  test("a step that deploys the wrong configuration is reported", () => {
    const violations = deployStepMismatches(
      [entry({ deploy: true, bundleTask: "processor:bundle", bundleDir: "dist/processor" })],
      [
        {
          name: "Deploy",
          mode: "production",
          workingDirectory: "services/app",
          config: "wrangler.jsonc",
          usesToken: true,
        },
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("the ledger expects");
  });

  test("a step without the environment token is reported", () => {
    const violations = deployStepMismatches(
      [entry({ deploy: true, bundleTask: "processor:bundle", bundleDir: "dist/processor" })],
      [
        {
          name: "Deploy",
          mode: "production",
          workingDirectory: "services/processor",
          config: "wrangler.jsonc",
          usesToken: false,
        },
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("passes no deploy token");
  });

  test("only the deploy and migration steps see the Cloudflare token (G5-17)", () => {
    const usingToken = workflowSteps(deployWorkflow)
      .filter((step) => step.body.includes("secrets.CLOUDFLARE_API_TOKEN"))
      .map((step) => step.name);
    expect(usingToken).toEqual([
      "Apply the CORE migrations",
      "Apply the READ migrations",
      "Deploy the Processor",
      "Deploy the App",
      "Deploy the demo App",
      "Deploy the legacy ingest adapter",
      "Deploy the collector importer",
    ]);
  });

  test("the build and validation steps run before any credential is in scope (G5-09)", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const validate = names.indexOf("Validate every Worker without uploading");
    const firstCredential = names.indexOf("Apply the CORE migrations");
    expect(validate).toBeGreaterThan(-1);
    expect(firstCredential).toBeGreaterThan(validate);
  });

  test("the manifest is re-verified immediately before the first upload (G5-11)", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    expect(names.indexOf("Re-verify the release manifest")).toBe(
      names.indexOf("Deploy the Processor") - 1,
    );
  });
});

describe("no preview lane and no collector secret in automation (G5-10, G5-17)", () => {
  const files = automationFiles();
  const secrets = collectorSecretNames(resources);

  test("the resource ledger yields the collector secret names", () => {
    expect(secrets).toContain("RAW_EVIDENCE_TOKEN");
    expect(secrets).toContain("VPASS_PASSWORD");
  });

  test("every Actions file passes", () => {
    expect(automationViolations(files, secrets)).toEqual([]);
  });

  test("a preview deployment is refused", () => {
    const text = [
      "jobs:",
      "  x:",
      "    steps:",
      "      - name: Preview",
      "        uses: risu729/wrangler-deploy-action@0000000000000000000000000000000000000000",
      "        with:",
      "          mode: preview-or-dry-run",
      "          preview-alias: pr",
      "",
    ].join("\n");
    expect(automationViolations([{ file: "x.yml", text }], [])).toHaveLength(2);
  });

  test("a second environment is refused", () => {
    const text = "jobs:\n  x:\n    environment: staging\n";
    expect(automationViolations([{ file: "x.yml", text }], [])).toHaveLength(1);
  });

  test("a bank secret named in a workflow is refused", () => {
    const text = "jobs:\n  x:\n    env:\n      T: ${{ secrets.VPASS_PASSWORD }}\n";
    expect(automationViolations([{ file: "x.yml", text }], ["VPASS_PASSWORD"])).toHaveLength(1);
  });

  test("the deploy Action's secret synchronisation is refused", () => {
    const text = "        with:\n          secrets-json: '{}'\n";
    expect(automationViolations([{ file: "x.yml", text }], [])).toHaveLength(1);
  });
});
