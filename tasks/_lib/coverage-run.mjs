import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const baseline = args[0] === "--baseline";
if (baseline) args.shift();
const runner = args.shift();
if (!["bun", "vitest"].includes(runner) || args[0] !== (runner === "bun" ? "test" : "run"))
  throw new Error("Expected native bun test or vitest run");
const workspace = relative(root, process.cwd()).replaceAll("\\", "/") || ".";
if (workspace.startsWith("../")) throw new Error("Test workspace must be inside repository");
const shard = args.find((arg) => arg.startsWith("--shard="))?.slice(8) ?? "serial";
const enabled = baseline || process.env.KOGANE_TEST_COVERAGE === "true";
const directory = resolve(
  "coverage",
  runner === "bun" ? "bun" : "workerd",
  baseline ? "baseline" : shard.replace("/", "-of-"),
);
const binary = runner === "bun" ? "bun" : "./node_modules/.bin/vitest";
let metadata;
if (enabled) {
  // Remove only this invocation's report directory, preventing stale success.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  metadata = {
    schema: "kogane-test-coverage-v1",
    workspace,
    suite: runner,
    runtime: runner === "bun" ? "bun-host" : "workerd",
    shard,
    baseline,
    command: [binary, ...args],
    checkoutSha: git("rev-parse", "HEAD"),
    requestedHeadSha: process.env.COVERAGE_HEAD_SHA || null,
    baseSha: process.env.COVERAGE_BASE_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    versions: {
      bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
      node: process.versions.node,
      vitest:
        runner === "vitest"
          ? JSON.parse(readFileSync("node_modules/vitest/package.json", "utf8")).version
          : null,
      provider:
        runner === "vitest"
          ? JSON.parse(readFileSync("node_modules/@vitest/coverage-istanbul/package.json", "utf8"))
              .version
          : "bun-native",
      workersPlugin:
        runner === "vitest"
          ? JSON.parse(readFileSync("node_modules/@cloudflare/vitest-plugin/package.json", "utf8"))
              .version
          : null,
    },
    startedAt: new Date().toISOString(),
    state: "started",
    exitCode: null,
    signal: null,
  };
  writeFileSync(resolve(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  args.push("--coverage");
  if (runner === "bun")
    args.push(
      "--coverage-reporter=text",
      "--coverage-reporter=lcov",
      "--coverage-dir=" + directory,
    );
  else args.push("--coverage.reportsDirectory=" + directory);
}
const started = performance.now();
const child = spawn(binary, args, { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
function finish(code, signal, error) {
  if (metadata) {
    Object.assign(metadata, {
      finishedAt: new Date().toISOString(),
      elapsedSeconds: (performance.now() - started) / 1000,
      state: code === 0 && !signal && !error ? "passed" : "failed",
      exitCode: code,
      signal: signal ?? null,
      error: error?.message ?? null,
    });
    writeFileSync(resolve(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  }
  process.exitCode = code === 0 && !signal && !error ? 0 : code || 1;
}
child.once("error", (error) => finish(null, null, error));
child.once("exit", (code, signal) => finish(code, signal));
