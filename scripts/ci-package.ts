import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_PACKAGES,
  STANDALONE_TESTS,
  SYNTAX_ONLY_PACKAGE,
  type PackagePolicy,
} from "./ci-packages.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export interface Step {
  cwd: string;
  command: string[];
}
export interface PlanOptions {
  root: string;
  ci: boolean;
  platform: string;
}

export function selectPolicy(name: string): PackagePolicy {
  const policy = CI_PACKAGES.find((entry) => entry.path === name);
  if (!policy)
    throw new Error(
      "Unknown CI package; select an explicit offline package from scripts/ci-packages.ts",
    );
  return policy;
}

export function validateScripts(policy: PackagePolicy, manifest: unknown): void {
  if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest))
    throw new Error(`Missing scripts for ${policy.path}`);
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null)
    throw new Error(`Missing scripts for ${policy.path}`);
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    ...Object.keys(policy.scripts).flatMap((name) => [`pre${name}`, `post${name}`]),
  ]) {
    if (Object.hasOwn(scripts, hook))
      throw new Error(`Unreviewed CI lifecycle hook: ${policy.path}/${hook}`);
  }
  for (const [name, expected] of Object.entries(policy.scripts)) {
    if (!Object.hasOwn(scripts, name) || (scripts as Record<string, unknown>)[name] !== expected) {
      throw new Error(
        `CI script changed: ${policy.path}/${name}; review the offline allowlist before running it`,
      );
    }
  }
}

function syntaxChecks(root: string, relativeDirectory: string): Step[] {
  const directory = join(root, relativeDirectory);
  const steps: Step[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && entry.name !== "node_modules")
      steps.push(...syntaxChecks(root, `${relativeDirectory}/${entry.name}`));
    if (entry.isFile() && /\.(?:mjs|cjs|js)$/u.test(entry.name))
      steps.push({ cwd: directory, command: ["node", "--check", entry.name] });
  }
  return steps;
}

export function packagePlan(name: string, options: PlanOptions): Step[] {
  const policy = selectPolicy(name);
  const cwd = join(options.root, policy.path);
  validateScripts(policy, JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")));
  if (!existsSync(join(cwd, "bun.lock")))
    throw new Error(`Missing frozen Bun lockfile for ${policy.path}`);
  const steps: Step[] = [{ cwd, command: ["bun", "install", "--frozen-lockfile"] }];
  if (policy.container) {
    const container = join(options.root, policy.container);
    if (!existsSync(join(container, "package-lock.json")))
      throw new Error(`Missing container npm lockfile for ${policy.path}`);
    steps.push(
      { cwd: container, command: ["npm", "ci", "--ignore-scripts"] },
      ...syntaxChecks(options.root, policy.container),
    );
  }
  if (policy.browser && options.ci && options.platform === "linux") {
    // Resolve the package's installed, locked executable; never bunx-download a
    // different Playwright version or start a live browser probe.
    steps.push({
      cwd,
      command: ["node", "node_modules/playwright/cli.js", "install", "--with-deps", "chromium"],
    });
  }
  steps.push(...policy.checks.map((check) => ({ cwd, command: ["bun", "run", check] })));
  if (policy.additionalDryRun)
    steps.push({
      cwd,
      command: ["node", "node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run"],
    });
  return steps;
}

export function standalonePlan(root: string): Step[] {
  return [
    { cwd: root, command: ["bun", "test", ...STANDALONE_TESTS] },
    ...syntaxChecks(root, SYNTAX_ONLY_PACKAGE),
  ];
}

export async function runPlan(
  steps: Step[],
  execute: (step: Step) => Promise<number>,
): Promise<void> {
  for (const step of steps) {
    const code = await execute(step);
    if (code !== 0) throw new Error(`Offline check failed (${code}): ${step.command.join(" ")}`);
  }
}

export async function main(
  args: string[],
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const name = args[0] ?? environment.usage_package ?? environment.CI_PACKAGE;
  if (!name || args.length > 1)
    throw new Error("Usage: bun scripts/ci-package.ts <package-path|--standalone>");
  const steps =
    name === "--standalone"
      ? standalonePlan(REPO_ROOT)
      : packagePlan(name, {
          root: REPO_ROOT,
          ci: environment.CI === "true",
          platform: process.platform,
        });
  await runPlan(steps, async (step) => {
    console.log(
      `[offline CI] ${step.cwd.slice(REPO_ROOT.length + 1) || "."}: ${step.command.join(" ")}`,
    );
    const child = Bun.spawn(step.command, {
      cwd: step.cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...environment, WRANGLER_SEND_METRICS: "false" },
    });
    return await child.exited;
  });
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Offline CI failed");
    process.exitCode = 1;
  }
}
