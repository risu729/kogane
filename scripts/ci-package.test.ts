import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
    const plan = packagePlan("poc/observation-pipeline", options).map((step) =>
      step.command.join(" "),
    );
    expect(plan).toContain("node node_modules/playwright/cli.js install --with-deps chromium");
    expect(plan.indexOf("bun run build")).toBeLessThan(plan.indexOf("bun run test"));
    const local = packagePlan("poc/observation-pipeline", { ...options, ci: false }).map((step) =>
      step.command.join(" "),
    );
    expect(local.some((command) => command.includes("playwright install"))).toBe(false);
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
