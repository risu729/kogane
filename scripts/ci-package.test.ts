import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CI_PACKAGES, coveredManifests, STANDALONE_TESTS } from "./ci-packages.ts";
import {
  packagePlan,
  REPO_ROOT,
  runPlan,
  selectPolicy,
  standalonePlan,
  validateScripts,
} from "./ci-package.ts";

const options = { root: REPO_ROOT, ci: true, platform: "linux" };
describe("offline CI coverage", () => {
  test("Git executable modes require a shebang even when checked on Windows", () => {
    const result = Bun.spawnSync(["git", "ls-files", "--stage", "-z"], { cwd: REPO_ROOT });
    expect(result.exitCode).toBe(0);
    const invalid = result.stdout
      .toString()
      .split("\0")
      .flatMap((entry) => {
        const match = /^100755 [0-9a-f]+ 0\t(.+)$/u.exec(entry);
        if (!match) return [];
        const path = match[1]!;
        if (/^(?:data\/)|\/(?:fixtures|patches)\//u.test(path)) return [];
        return readFileSync(join(REPO_ROOT, path), "utf8").startsWith("#!") ? [] : [path];
      });
    expect(invalid).toEqual([]);
  });

  test("every tracked package manifest has an explicit coverage decision", () => {
    const result = Bun.spawnSync(["git", "ls-files", "--", "**/package.json", "package.json"], {
      cwd: REPO_ROOT,
    });
    expect(result.exitCode).toBe(0);
    const manifests = result.stdout.toString().trim().split(/\r?\n/u).filter(Boolean).sort();
    expect(manifests).toEqual(coveredManifests());
    expect(new Set(CI_PACKAGES.map((entry) => entry.path)).size).toBe(CI_PACKAGES.length);
  });
  test("unknown paths cannot select scripts or escape the checkout", () => {
    for (const name of [
      "",
      "../outside",
      "/tmp/package",
      "poc/sony-bank-worker/../moneyforward-worker",
      "poc/sony-bank-worker; echo secret",
      "__proto__",
      "poc/new-collector",
    ])
      expect(() => selectPolicy(name)).toThrow("Unknown CI package");
  });
  test("all raw-evidence route shell regressions are included in the reviewed offline script", () => {
    const policy = selectPolicy("services/raw-evidence");
    const scripts = readdirSync(join(REPO_ROOT, policy.path, "test"))
      .filter((name) => /^verify-.*-route\.test\.sh$/u.test(name))
      .sort();
    const selected = [
      ...policy.scripts.test!.matchAll(/bash test\/(verify-[\w-]+-route\.test\.sh)/gu),
    ]
      .map((match) => match[1]!)
      .sort();
    expect(scripts).toContain("verify-vpass-route.test.sh");
    expect(selected).toEqual(scripts);
  });
  test("shared contract packages run only pure test and typecheck steps", () => {
    for (const name of ["packages/evidence-contract"]) {
      const policy = selectPolicy(name);
      expect(policy.checks).toEqual(["test", "typecheck"]);
      expect(policy.scripts).toEqual({ test: "bun test", typecheck: "tsc --noEmit" });
      const plan = packagePlan(name, options).map((step) => step.command.join(" "));
      expect(plan).toEqual(["bun install --frozen-lockfile", "bun run test", "bun run typecheck"]);
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, name, "package.json"), "utf8"));
      expect(manifest.dependencies).toBeUndefined();
      expect(Object.keys(manifest.devDependencies).sort()).toEqual(["@types/bun", "typescript"]);
    }
  });
  test("Vpass raw integration retains its dry-run check without scheduling live backfill", () => {
    const policy = selectPolicy("poc/vpass-json");
    expect(policy.scripts["cf:check"]).toBe("wrangler deploy --dry-run");
    const commands = packagePlan(policy.path, options).map((step) => step.command.join(" "));
    expect(commands).toContain("node node_modules/wrangler/bin/wrangler.js deploy --dry-run");
    expect(commands.some((command) => command.includes("backfill"))).toBe(false);
    expect(Object.hasOwn(policy.scripts, "backfill:raw-evidence")).toBe(false);
  });
  test("workflow matrix and final guard cover every offline package and required job", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          strategy?: { matrix: { package: string[] } };
          needs?: string[];
          steps?: { run?: string }[];
        }
      >;
    };
    expect([...workflow.jobs.packages!.strategy!.matrix.package].sort()).toEqual(
      CI_PACKAGES.map((policy) => policy.path).sort(),
    );
    expect(
      workflow.jobs.standalone!.steps!.some((step) => step.run === "mise run ci:standalone"),
    ).toBe(true);
    expect([...workflow.jobs["ci-check"]!.needs!].sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((name) => name !== "ci-check" && name !== "actions-timeline")
        .sort(),
    );
  });
  test("changed test scripts cannot silently start live collection", () => {
    const policy = selectPolicy("poc/sony-bank-worker");
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, policy.path, "package.json"), "utf8"));
    validateScripts(policy, manifest);
    manifest.scripts.test = "bun scripts/live-smoke.ts";
    expect(() => validateScripts(policy, manifest)).toThrow("review the offline allowlist");
  });
  test("unreviewed lifecycle hooks cannot run before an approved check or install", () => {
    const policy = selectPolicy("poc/sony-bank-worker");
    for (const hook of ["pretest", "postcf:check", "postinstall", "prepare"]) {
      expect(() =>
        validateScripts(policy, {
          scripts: { ...policy.scripts, [hook]: "bun scripts/live-smoke.ts" },
        }),
      ).toThrow("Unreviewed CI lifecycle hook");
    }
  });
  test("all selected package checks match the reviewed manifest and use frozen installs", () => {
    for (const policy of CI_PACKAGES) {
      const plan = packagePlan(policy.path, options);
      expect(plan[0]?.command).toEqual(["bun", "install", "--frozen-lockfile"]);
      for (const name of policy.checks) expect(Object.hasOwn(policy.scripts, name)).toBe(true);
      for (const step of plan) {
        expect(step.command.join(" ")).not.toMatch(
          /(?:smoke:live|local:collect|live:email-login|credential:|bw:|auth:select|verify:production|ingest:file)/u,
        );
      }
    }
  });
  test("browser CI installs locked Chromium and builds before tests; local runs do not install browsers", () => {
    const steps = packagePlan("poc/observation-pipeline", options);
    const plan = steps.map((step) => step.command.join(" "));
    // The PoC re-exports the parser registry, so its type check compiles two
    // parsers that import parse5 from packages/parsers: without that frozen
    // install a clean checkout fails on "cannot find module 'parse5'".
    expect(steps[1]).toEqual({
      cwd: join(REPO_ROOT, "packages/parsers"),
      command: ["bun", "install", "--frozen-lockfile"],
    });
    expect(plan.indexOf("bun run typecheck")).toBeGreaterThan(1);
    expect(plan).toContain("node node_modules/playwright/cli.js install --with-deps chromium");
    expect(plan.indexOf("bun run build")).toBeLessThan(plan.indexOf("bun run test"));
    expect(plan.indexOf("bun run build:evidence")).toBeLessThan(plan.indexOf("bun run test"));
    expect(plan.indexOf("bun run build:production")).toBeGreaterThan(-1);
    expect(plan.indexOf("bun run build:production")).toBeLessThan(plan.indexOf("bun run test"));
    const local = packagePlan("poc/observation-pipeline", { ...options, ci: false }).map((step) =>
      step.command.join(" "),
    );
    expect(local.some((command) => command.includes("playwright install"))).toBe(false);
  });
  test("pure domain package runs only frozen install, typecheck and tests; no Worker, build or browser steps", () => {
    const policy = selectPolicy("packages/domain");
    expect(policy.checks).toEqual(["typecheck", "test"]);
    expect(policy.scripts).toEqual({ test: "bun test", typecheck: "tsc --noEmit" });
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, policy.path, "package.json"), "utf8"));
    expect(manifest.name).toBe("@kogane/domain");
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["@types/bun", "typescript"]);
    const frontend = JSON.parse(
      readFileSync(join(REPO_ROOT, "poc/observation-pipeline/package.json"), "utf8"),
    );
    for (const name of Object.keys(manifest.devDependencies))
      expect(manifest.devDependencies[name]).toBe(frontend.devDependencies[name]);
    const plan = packagePlan(policy.path, options).map((step) => step.command.join(" "));
    expect(plan).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]);
  });
  test("shared pure packages run frozen install, typecheck and bun tests without Workers tooling", () => {
    for (const name of [
      "packages/read-model",
      "packages/application",
      "packages/storage-d1",
      "packages/observation-shared",
      "packages/identity",
    ]) {
      const plan = packagePlan(name, options).map((step) => step.command.join(" "));
      expect(plan).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]);
      expect(selectPolicy(name).scripts).toEqual({ test: "bun test", typecheck: "tsc --noEmit" });
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, name, "package.json"), "utf8"));
      expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
      expect(Object.keys(manifest.devDependencies)).not.toContain("wrangler");
    }
  });
  test("production parser CI installs shared parser dependencies before checking without building UI", () => {
    const plan = packagePlan("services/observation-pipeline", options);
    // Since design review D07 the parsers live in packages/parsers, and parse5
    // resolves from that package rather than from the PoC frontend.
    expect(plan[1]).toEqual({
      cwd: join(REPO_ROOT, "packages/parsers"),
      command: ["bun", "install", "--frozen-lockfile"],
    });
    expect(plan[2]?.command).toEqual(["bun", "run", "typecheck"]);
    expect(plan.some((step) => step.cwd === join(REPO_ROOT, "poc/observation-pipeline"))).toBe(
      false,
    );
    expect(
      plan.some((step) =>
        step.command.some((part) => part.startsWith("build") || part.includes("playwright")),
      ),
    ).toBe(false);
  });

  test("every plan that compiles the shared parsers installs their frozen dependencies", () => {
    // packages/parsers itself is where they are installed, so it must not
    // recurse; every other consumer of its modules must declare the need.
    expect(selectPolicy("packages/parsers").sharedParserDependencies).toBeUndefined();
    const declared = CI_PACKAGES.filter((policy) => policy.sharedParserDependencies).map(
      (policy) => policy.path,
    );
    expect(declared.sort()).toEqual(["poc/observation-pipeline", "services/observation-pipeline"]);
    for (const name of declared) {
      const plan = packagePlan(name, options);
      const install = plan.findIndex((step) => step.cwd === join(REPO_ROOT, "packages/parsers"));
      expect(install, name).toBeGreaterThan(-1);
      expect(plan[install]!.command).toEqual(["bun", "install", "--frozen-lockfile"]);
      // Before every check the package runs, and never a build of the parsers.
      const firstCheck = plan.findIndex(
        (step) => step.cwd === join(REPO_ROOT, name) && step.command[1] === "run",
      );
      expect(install, name).toBeLessThan(firstCheck);
      expect(plan.filter((step) => step.cwd === join(REPO_ROOT, "packages/parsers"))).toHaveLength(
        1,
      );
    }
  });

  test("the shared parser package is the only pure package with a runtime dependency", () => {
    const policy = selectPolicy("packages/parsers");
    expect(policy.checks).toEqual(["typecheck", "test"]);
    expect(policy.scripts).toEqual({ test: "bun test", typecheck: "tsc --noEmit" });
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, policy.path, "package.json"), "utf8"));
    // Two HTML parsers import parse5 at runtime; nothing else may creep in.
    expect(Object.keys(manifest.dependencies)).toEqual(["parse5"]);
    const frontend = JSON.parse(
      readFileSync(join(REPO_ROOT, "poc/observation-pipeline/package.json"), "utf8"),
    );
    expect(manifest.dependencies.parse5).toBe(frontend.dependencies.parse5);
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["@types/bun", "typescript"]);
    const plan = packagePlan(policy.path, options).map((step) => step.command.join(" "));
    expect(plan).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]);
  });
  test("reader CI builds all three isolated frontends and synthetic data before Worker checks", () => {
    const productionConfig = JSON.parse(
      readFileSync(join(REPO_ROOT, "services/evidence-browser/wrangler.jsonc"), "utf8"),
    );
    expect(productionConfig.assets.directory).toBe(
      "../../poc/observation-pipeline/web/dist-production",
    );
    expect(productionConfig.assets.run_worker_first).toBe(true);
    expect(productionConfig.preview_urls).toBe(false);
    expect(selectPolicy("poc/observation-pipeline").scripts["build:production"]).toBe(
      "vite build --mode production --outDir dist-production",
    );
    const plan = packagePlan("services/evidence-browser", options);
    const assetBuild = plan.findIndex(
      (step) => step.command.join(" ") === "bun run build:evidence",
    );
    expect(assetBuild).toBeGreaterThan(0);
    expect(plan[assetBuild]!.cwd).toBe(join(REPO_ROOT, "poc/observation-pipeline"));
    expect(plan[assetBuild - 1]!).toEqual({
      cwd: join(REPO_ROOT, "poc/observation-pipeline"),
      command: ["bun", "install", "--frozen-lockfile"],
    });
    expect(assetBuild).toBeLessThan(
      plan.findIndex((step) => step.command.join(" ") === "bun run cf:check"),
    );
    const firstWorkerCheck = plan.findIndex(
      (step) => step.command.join(" ") === "bun run typecheck",
    );
    for (const command of ["build:evidence", "build:production", "build", "export:demo"]) {
      const producer = plan.findIndex((step) => step.command.join(" ") === `bun run ${command}`);
      expect(producer).toBeGreaterThan(0);
      expect(producer).toBeLessThan(firstWorkerCheck);
      expect(plan[producer]!.cwd).toBe(join(REPO_ROOT, "poc/observation-pipeline"));
    }
    expect(selectPolicy("services/evidence-browser").scripts["cf:check"]).toBe(
      "wrangler deploy --dry-run && wrangler deploy --dry-run --config wrangler.demo.jsonc",
    );

    const root = mkdtempSync(join(tmpdir(), "kogane-ci-assets-"));
    try {
      for (const path of ["services/evidence-browser", "poc/observation-pipeline"]) {
        mkdirSync(join(root, path), { recursive: true });
        writeFileSync(
          join(root, path, "package.json"),
          readFileSync(join(REPO_ROOT, path, "package.json")),
        );
        writeFileSync(join(root, path, "bun.lock"), "unused frozen-lock presence fixture");
      }
      const manifestPath = join(root, "poc/observation-pipeline/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const name of ["build:evidence", "build:production", "build", "export:demo"]) {
        const changed = { ...manifest, scripts: { ...manifest.scripts } };
        changed.scripts[name] = "bun run live-collector";
        writeFileSync(manifestPath, JSON.stringify(changed));
        expect(() => packagePlan("services/evidence-browser", { ...options, root })).toThrow(
          "review the offline allowlist",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("direct tool invocations cannot resolve same-named package scripts or lifecycle hooks", () => {
    for (const [name, tool, executable] of [
      ["poc/observation-pipeline", "playwright", "node_modules/playwright/cli.js"],
      ["poc/vpass-json", "wrangler", "node_modules/wrangler/bin/wrangler.js"],
    ]) {
      const policy = selectPolicy(name!);
      // Package scripts may have these names; CI must execute the locked CLI
      // file directly rather than dispatch through Bun's script resolution.
      validateScripts(policy, {
        scripts: {
          ...policy.scripts,
          [tool!]: "unexpected-command",
          [`pre${tool}`]: "unexpected-command",
          [`post${tool}`]: "unexpected-command",
        },
      });
      const plan = packagePlan(name!, options);
      const direct = plan.find((step) => step.command[1] === executable);
      expect(direct?.command[0]).toBe("node");
      expect(plan.some((step) => step.command[0] === "bun" && step.command.includes(tool!))).toBe(
        false,
      );
    }
  });
  test("container manifests are lock-checked without running their servers", () => {
    for (const name of ["poc/globalpass-worker", "poc/sbi-shinsei-worker"]) {
      const plan = packagePlan(name, options);
      expect(plan.some((step) => step.command.join(" ") === "npm ci --ignore-scripts")).toBe(true);
      expect(plan.some((step) => step.command.join(" ") === "node --check server.mjs")).toBe(true);
      expect(plan.some((step) => step.command.join(" ") === "node server.mjs")).toBe(false);
    }
  });
  test("every repository-wide guard under scripts/ runs in the standalone step", () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "scripts/*.test.ts"], {
      cwd: REPO_ROOT,
    });
    expect(result.exitCode).toBe(0);
    const guards = result.stdout.toString().split("\0").filter(Boolean).sort();
    expect(guards).toContain("scripts/publication-gate-predicates.test.ts");
    expect(guards).toContain("scripts/import-boundaries.test.ts");
    // These suites belong to no package, so nothing else would run them: a
    // guard missing from the list is a guard CI never executes.
    expect(
      guards.filter((path) => !(STANDALONE_TESTS as readonly string[]).includes(path)),
    ).toEqual([]);
  });
  test("standalone coverage runs pure suites and syntax-checks OCI without launching it", () => {
    const plan = standalonePlan(REPO_ROOT);
    expect(plan[0]?.command).toEqual(["bun", "test", ...STANDALONE_TESTS]);
    expect(plan.some((step) => step.command.join(" ") === "node --check probe.mjs")).toBe(true);
    expect(plan.every((step) => step.command[1] === "test" || step.command[1] === "--check")).toBe(
      true,
    );
  });
  test("a failed offline check prevents later commands from running", async () => {
    const calls: string[] = [];
    await expect(
      runPlan(
        [
          { cwd: REPO_ROOT, command: ["first"] },
          { cwd: REPO_ROOT, command: ["second"] },
        ],
        async (step) => {
          calls.push(step.command[0]!);
          return 2;
        },
      ),
    ).rejects.toThrow("Offline check failed (2)");
    expect(calls).toEqual(["first"]);
  });
});
