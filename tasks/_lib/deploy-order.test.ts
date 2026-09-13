// Acceptance G5-09 (CI never holds a Cloudflare token), G5-10 (no preview or
// staging lane exists), G5-14 (consumers deploy before producers), G5-15 (a
// directory move never becomes a resource rename) and G5-17 (CD never
// synchronises a collector secret).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  automationFiles,
  automationViolations,
  collectorSecretNames,
  configOf,
  coverageViolations,
  credentialWiringViolations,
  type DeployEntry,
  deploySteps,
  deployStepMismatches,
  entryViolations,
  orderViolations,
  readDeployOrder,
  workflowSteps,
} from "./deploy-order.ts";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";

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
    healthAuth: "none",
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
    expect(
      entryViolations(entry({ healthPath: "health", healthIdentity: "schemaVersion" })),
    ).toHaveLength(1);
    expect(
      entryViolations(entry({ healthPath: "/health", healthIdentity: "schemaVersion" })),
    ).toEqual([]);
  });

  test("a health route says how CD authenticates it and what it must answer", () => {
    // The postcheck reads these three fields and nothing else (plan 11 §6): a
    // route with no identity field would be checked for 200 alone, and a route
    // whose authentication is unstated would be requested anonymously.
    expect(entryViolations(entry({ healthPath: "/health" }))).toHaveLength(1);
    expect(
      entryViolations(entry({ healthPath: "/health", healthIdentity: "not a field" })),
    ).toHaveLength(1);
    expect(
      entryViolations(
        entry({
          healthPath: "/api/ops/v1/health",
          healthAuth: "access",
          healthIdentity: "releaseSha",
        }),
      ),
    ).toEqual([]);
    // And a Worker CD does not request must not claim a check it never makes.
    expect(entryViolations(entry({ healthAuth: "access" }))).toHaveLength(1);
    expect(entryViolations(entry({ healthIdentity: "releaseSha" }))).toHaveLength(1);
  });

  test("the App's health route is the authenticated one, and the only one", () => {
    // Finding 4: the App authenticates every request, so its postcheck needs
    // the Access service token; every other requested route is public.
    const authenticated = order.workers.filter((worker) => worker.healthAuth === "access");
    expect(authenticated.map((worker) => worker.name)).toEqual(["app"]);
    expect(authenticated[0]?.healthPath).toBe("/api/ops/v1/health");
    expect(authenticated[0]?.healthIdentity).toBe("releaseSha");
    // The Processor is requested by nobody: it has no hostname, and the App's
    // answer carries its health (services/processor/src/internal-health.ts).
    const processor = order.workers.find((worker) => worker.name === "processor");
    expect(processor?.healthPath).toBe("");
    // Every collector that has a public health route is checked through it.
    const checked = order.workers.filter(
      (worker) => worker.role === "producer" && worker.healthPath !== "",
    );
    expect(checked).toHaveLength(11);
    expect(checked.every((worker) => worker.healthAuth === "none")).toBe(true);
  });

  test("every path the two ledgers name exists in the checkout", () => {
    // A directory rename (services/evidence-browser -> services/app,
    // services/observation-pipeline -> services/processor) that misses a
    // ledger entry would only surface in CD, from the Worker's
    // `working-directory` or the migration step's `--config`. CI excludes are
    // never dry-run, so they are checked here too.
    const named = [
      ...Object.values(order.schema).filter((target) => target !== null),
      ...order.workers,
      ...ledger.workers,
      ...(ledger.excluded ?? []),
    ];
    expect(named.length).toBeGreaterThan(0);
    const missing = named
      .flatMap((target) => [target.path, configOf(target)])
      .filter((path) => !existsSync(`${REPO_ROOT}/${path}`));
    expect(missing).toEqual([]);
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
      "globalpass-worker",
      "mobile-suica-worker",
      "moneyforward-worker",
      "myjcb-worker",
      "sbi-securities-worker",
      "sbi-shinsei-worker",
      "sbi-vc-trade-worker",
      "smbc-direct-backfill-worker",
      "sony-bank-worker",
      "vpass-json",
      "vpoint-pay-worker",
      "vpoint-worker",
    ]);
    // The two consumers of the shared contract come first, then every
    // collector: a reader understands the contract before a writer uses it.
    expect(deployed.slice(0, 2).every((worker) => worker.role === "consumer")).toBe(true);
    expect(deployed.slice(2).every((worker) => worker.role === "producer")).toBe(true);
  });

  test("every collector is a CD target, and only the experiments are not", () => {
    // Deploying a collector replaces its script; it starts no collection, no
    // re-authentication and no backfill, and a change to what one bundles
    // passes CI and the existing branch rules before it merges.
    // What stays out of CD is the probe role: the experiments and the
    // bootstrap, audit and test-harness configurations.
    const producers = order.workers.filter((worker) => worker.role === "producer");
    expect(producers.length).toBe(12);
    expect(producers.every((worker) => worker.deploy)).toBe(true);
    expect(producers.every((worker) => worker.path.startsWith("services/collector-"))).toBe(true);
    expect(order.workers.filter((worker) => worker.role === "probe").length).toBeGreaterThan(0);
    expect(order.workers.some((worker) => worker.role === "probe" && worker.deploy)).toBe(false);
    // Every collector directory in the checkout is in the ledger: a new one
    // cannot be forgotten here and then never deployed. The importer is a
    // consumer, so it is excluded from the producer count above.
    const directories = trackedFiles("services")
      .map((file) => /^(services\/collector-[^/]+)\//u.exec(file)?.[1] ?? "")
      .filter((directory) => directory !== "" && directory !== "services/collector-r2-importer");
    expect(new Set(directories).size).toBe(12);
    for (const directory of new Set(directories))
      expect(producers.some((worker) => worker.path === directory)).toBe(true);
  });

  test("every deployed Worker's bundle task exists in its workspace", () => {
    // The release manifest digests `bundleDir`, which only exists if
    // `mise run bundle` has a task that writes it (plan 11 §2).
    for (const worker of order.workers.filter((entry) => entry.deploy)) {
      const tasks = readFileSync(`${REPO_ROOT}/${worker.path}/tasks.toml`, "utf8");
      expect(tasks).toContain(`["${String(worker.bundleTask)}"]`);
      expect(tasks).toContain(`--outdir ../../${String(worker.bundleDir)}`);
    }
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
          id: "deploy-processor",
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
          id: "deploy-processor",
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

  test("a step without the id the release record reads is reported", () => {
    // `release-ledger.mjs progress` looks each Worker up by `deploy-<name>` in
    // the job's `steps` context; a step without that id would drop out of the
    // record silently (finding 2).
    const violations = deployStepMismatches(
      [entry({ deploy: true, bundleTask: "processor:bundle", bundleDir: "dist/processor" })],
      [
        {
          name: "Deploy",
          id: "",
          mode: "production",
          workingDirectory: "services/processor",
          config: "wrangler.jsonc",
          usesToken: true,
        },
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("id: deploy-processor");
  });

  test("the record of what the run did comes after every upload", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const progress = names.indexOf("Record what this run deployed");
    expect(progress).toBeGreaterThan(-1);
    const lastDeploy = Math.max(
      ...steps.map((step) => names.indexOf(step.name)),
      names.indexOf("Apply the CORE migrations"),
    );
    expect(progress).toBeGreaterThan(lastDeploy);
  });

  test("the migration steps carry the ids the record reads", () => {
    for (const [name, id] of [
      ["Apply the CORE migrations", "migrate-core"],
      ["Apply the READ migrations", "migrate-read"],
    ]) {
      const step = workflowSteps(deployWorkflow).find((candidate) => candidate.name === name);
      expect(step?.body).toContain(`id: ${String(id)}`);
    }
  });

  test("a release deploys the whole set: no workflow offers a subset input", () => {
    // A partial release used to complete the commit in the ledger, so the next
    // full release of the same commit was skipped and the Workers it had not
    // deployed stayed behind (finding 2). Narrowing the set is a rollback.
    expect(deployWorkflow).not.toContain("inputs.only");
    expect(readFileSync(`${REPO_ROOT}/.github/workflows/deploy.yml`, "utf8")).not.toMatch(
      /^\s+(only|targets):/mu,
    );
    expect(readFileSync(`${REPO_ROOT}/.github/workflows/rollback.yml`, "utf8")).toMatch(
      /^\s+targets: \$\{\{ inputs\.targets \}\}$/mu,
    );
  });

  test("only the preflight, migration and deploy steps see the Cloudflare token (G5-17)", () => {
    const usingToken = workflowSteps(deployWorkflow)
      .filter((step) => step.body.includes("secrets.CLOUDFLARE_API_TOKEN"))
      .map((step) => step.name);
    expect(usingToken).toEqual([
      "Confirm the production credentials reached this job",
      "Apply the CORE migrations",
      "Apply the READ migrations",
      "Deploy the Processor",
      "Deploy the App",
      "Deploy the GlobalPass collector",
      "Deploy the Mobile Suica collector",
      "Deploy the Money Forward collector",
      "Deploy the MyJCB collector",
      "Deploy the SBI Securities collector",
      "Deploy the SBI Shinsei collector",
      "Deploy the SBI VC Trade collector",
      "Deploy the SMBC Direct collector",
      "Deploy the Sony Bank collector",
      "Deploy the Vpass collector",
      "Deploy the V Point Pay collector",
      "Deploy the V Point collector",
    ]);
  });

  test("the build and validation steps run before any credential is in scope (G5-09)", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const validate = names.indexOf("Validate every Worker without uploading");
    const firstCredential = names.indexOf("Confirm the production credentials reached this job");
    expect(validate).toBeGreaterThan(-1);
    expect(firstCredential).toBe(validate + 1);
  });

  test("the credentials are checked before a deployment record or a migration", () => {
    // The preflight exists so that a missing environment secret costs one
    // failed step instead of an open deployment record and an unexplained
    // wrangler error (run 34635388395).
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const preflight = names.indexOf("Confirm the production credentials reached this job");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(names.indexOf("Open the deployment record"));
    expect(preflight).toBeLessThan(names.indexOf("Apply the CORE migrations"));
  });

  test("each migration step lists the pending migrations before and after it applies", () => {
    // The release log has to say which migrations a run applied; wrangler only
    // reports that per invocation, so the step brackets the apply with the
    // list of what is still pending (finding 5).
    for (const name of ["Apply the CORE migrations", "Apply the READ migrations"]) {
      const step = workflowSteps(deployWorkflow).find((candidate) => candidate.name === name);
      expect(step).toBeDefined();
      const body = step?.body ?? "";
      expect(body.match(/wrangler d1 migrations list /gu)?.length).toBe(2);
      expect(body.match(/wrangler d1 migrations apply /gu)?.length).toBe(1);
    }
  });

  test("the release sha is stamped before the manifest is computed", () => {
    // The deployed Workers report which commit they are, so the sha is written
    // into their configurations; doing it after the manifest was computed would
    // make the re-verification before the first upload fail (plan 11 §6).
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const stamp = names.indexOf("Stamp the release sha into the deployed configurations");
    expect(stamp).toBeGreaterThan(names.indexOf("Validate every Worker without uploading"));
    expect(stamp).toBeLessThan(names.indexOf("Compute the release manifest"));
  });

  test("both postchecks run after the last upload, and only one holds the Access token", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    const lastDeploy = names.lastIndexOf("Deploy the V Point collector");
    expect(lastDeploy).toBeGreaterThan(-1);
    expect(names.indexOf("Postcheck the public health routes")).toBeGreaterThan(lastDeploy);
    expect(names.indexOf("Postcheck the App and the Processor")).toBeGreaterThan(
      names.indexOf("Postcheck the public health routes"),
    );
    // The Access service token is the App's postcheck credential and nothing
    // else's: it reaches exactly one step (plan 12 §5, the same rule the
    // Cloudflare deploy token follows).
    for (const secret of ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) {
      const usingToken = workflowSteps(deployWorkflow)
        .filter((step) => step.body.includes(`secrets.${secret}`))
        .map((step) => step.name);
      expect(usingToken).toEqual(["Postcheck the App and the Processor"]);
    }
  });

  test("the manifest is re-verified immediately before the first upload (G5-11)", () => {
    const names = workflowSteps(deployWorkflow).map((step) => step.name);
    expect(names.indexOf("Re-verify the release manifest")).toBe(
      names.indexOf("Deploy the Processor") - 1,
    );
  });
});

describe("the release job can reach the production credentials", () => {
  const files = automationFiles();

  test("every caller of the release workflow inherits the environment secrets", () => {
    // Release 34635388395 built everything, opened a deployment record and
    // then failed inside `wrangler d1 migrations apply` because
    // `secrets.CLOUDFLARE_API_TOKEN` was the empty string: a called workflow
    // sees only the secrets its caller passed, and `deploy.yml` passed none.
    expect(credentialWiringViolations(files)).toEqual([]);
    expect(files.some(({ file }) => file === ".github/workflows/deploy.yml")).toBe(true);
  });

  test("a caller that passes no secrets is reported", () => {
    const text = [
      "jobs:",
      "  release:",
      "    uses: ./.github/workflows/_deploy-workers.yml",
      "    with:",
      "      sha: x",
      "",
    ].join("\n");
    const violations = credentialWiringViolations([{ file: "x.yml", text }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("secrets: inherit");
  });

  test("a workflow that does not call the release job is not asked to", () => {
    expect(
      credentialWiringViolations([{ file: "x.yml", text: "jobs:\n  x:\n    steps: []\n" }]),
    ).toEqual([]);
  });
});

describe("no preview lane and no collector secret in automation (G5-10, G5-17)", () => {
  const files = automationFiles();
  const secrets = collectorSecretNames(resources);

  test("the resource ledger yields the collector secret names", () => {
    expect(secrets).not.toContain("RAW_EVIDENCE_TOKEN");
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
