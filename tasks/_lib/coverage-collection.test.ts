import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import istanbulCoverage from "istanbul-lib-coverage";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";

test("every native coverage invocation belongs to the expected collection manifest", () => {
  const expected = JSON.parse(
    readFileSync(join(REPO_ROOT, "tasks/_lib/coverage-suites.json"), "utf8"),
  );
  const actual = trackedFiles("mise.toml", "**/mise.toml").flatMap((path) => {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    expect(source).not.toMatch(/"(?:bun test|\.\/node_modules\/\.bin\/vitest run)/);
    const workspace = path === "mise.toml" ? "." : path.slice(0, -"/mise.toml".length);
    return ["bun", "vitest"]
      .filter((suite) => source.includes("coverage-run.mjs " + suite + " "))
      .map((suite) => ({ workspace, suite }));
  });
  expect(actual).toEqual(expected);
});

test("summary refuses failed, missing, stale and truncated native reports", () => {
  const root = mkdtempSync(join(tmpdir(), "kogane-coverage-summary-"));
  try {
    mkdirSync(join(root, "tasks/_lib"), { recursive: true });
    mkdirSync(join(root, "services/processor/src"), { recursive: true });
    const directory = join(root, "services/processor/coverage/bun/1-of-2");
    mkdirSync(directory, { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
    copyFileSync(join(REPO_ROOT, "package.json"), join(root, "package.json"));
    copyFileSync(
      join(REPO_ROOT, "tasks/_lib/coverage-summary.mjs"),
      join(root, "tasks/_lib/coverage-summary.mjs"),
    );
    writeFileSync(
      join(root, "tasks/_lib/coverage-suites.json"),
      JSON.stringify([{ workspace: "services/processor", suite: "bun" }]),
    );
    writeFileSync(join(root, "services/processor/src/reached.ts"), "export const reached = 1;\n");
    writeFileSync(join(root, "services/processor/src/unloaded.ts"), "export const unloaded = 1;\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init");
    git("add", "services/processor/src");
    git(
      "-c",
      "user.name=Coverage Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const metadata = {
      schema: "kogane-test-coverage-v1",
      workspace: "services/processor",
      suite: "bun",
      runtime: "bun-host",
      checkoutSha: git("rev-parse", "HEAD"),
      shard: "1/2",
      baseline: false,
      runId: "run-current",
      attempt: "2",
      requestedHeadSha: "pr-current",
      baseSha: "base-current",
      versions: {
        bun: "1.4.2",
        node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim().slice(1),
        provider: "bun-native",
        vitest: null,
        workersPlugin: null,
      },
      state: "passed",
      exitCode: 0,
      signal: null,
    };
    const lcov = "SF:src/reached.ts\nFNF:0\nFNH:0\nDA:1,1\nLF:1\nLH:1\nend_of_record\n";
    const run = (partition = "processor-1") =>
      Bun.spawnSync(["node", "tasks/_lib/coverage-summary.mjs", partition], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: "",
          GITHUB_RUN_ID: "run-current",
          GITHUB_RUN_ATTEMPT: "2",
          COVERAGE_HEAD_SHA: "pr-current",
          COVERAGE_BASE_SHA: "base-current",
        },
        timeout: 10_000,
      });
    const save = (value: unknown) =>
      writeFileSync(join(directory, "metadata.json"), JSON.stringify(value));
    save(metadata);
    writeFileSync(join(directory, "lcov.info"), lcov);
    expect(run().exitCode).toBe(0);
    const collection = JSON.parse(
      readFileSync(join(root, "coverage/processor-1/collection.json"), "utf8"),
    );
    expect(collection.complete).toBe(true);
    expect(collection.suites[0].sourcesAbsentFromReport).toEqual([
      "services/processor/src/unloaded.ts",
    ]);
    save({ ...metadata, state: "failed", exitCode: 1 });
    expect(run().exitCode).toBe(1);
    save({ ...metadata, state: "started", exitCode: null });
    expect(run().exitCode).toBe(1);
    save({ ...metadata, checkoutSha: "stale" });
    expect(run().exitCode).toBe(1);
    save(metadata);
    writeFileSync(join(directory, "lcov.info"), lcov.replace("end_of_record\n", ""));
    expect(run().exitCode).toBe(1);
    writeFileSync(join(directory, "lcov.info"), lcov.replace("LF:1", "LF:not-a-counter"));
    expect(run().exitCode).toBe(1);
    for (const key of ["runId", "attempt", "requestedHeadSha", "baseSha"]) {
      save({ ...metadata, [key]: "old-invocation" });
      writeFileSync(join(directory, "lcov.info"), lcov);
      expect(run().exitCode).toBe(1);
    }
    save({ ...metadata, versions: { ...metadata.versions, bun: "old" } });
    expect(run().exitCode).toBe(1);
    save(metadata);
    for (const malformed of [
      lcov.replace("FNH:0", "FNH:100"),
      lcov.replace("LF:1\n", ""),
      lcov.replace("LF:1", "LF:1\nLF:1"),
      lcov.replace("LH:1", "LH:99"),
      lcov.replace("DA:1,1\n", ""),
      lcov.replace("src/reached.ts", "src/nonexistent.ts"),
      lcov.replace("src/reached.ts", "../../package.json"),
      lcov.replace("DA:1,1", "DA:999,1"),
      lcov.replace("DA:1,1", "DA:1,-1"),
    ]) {
      writeFileSync(join(directory, "lcov.info"), malformed);
      expect(run().exitCode).toBe(1);
    }
    rmSync(join(directory, "lcov.info"));
    expect(run().exitCode).toBe(1);
    rmSync(join(directory, "metadata.json"));
    expect(run().exitCode).toBe(1);

    const worker = "packages/native-worker";
    const workerDirectory = join(root, worker, "coverage/workerd/serial");
    mkdirSync(workerDirectory, { recursive: true });
    mkdirSync(join(root, worker, "src"), { recursive: true });
    const file = join(root, worker, "src/reached.ts");
    writeFileSync(file, "export const reached = 1;\n");
    writeFileSync(
      join(root, worker, "package.json"),
      JSON.stringify({
        devDependencies: {
          vitest: "4.1.11",
          "@vitest/coverage-istanbul": "4.1.11",
          "@cloudflare/vitest-plugin": "1.3.6",
        },
      }),
    );
    git("add", worker);
    git(
      "-c",
      "user.name=Coverage Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "worker fixture",
    );
    writeFileSync(
      join(root, "tasks/_lib/coverage-suites.json"),
      JSON.stringify([{ workspace: worker, suite: "vitest" }]),
    );
    writeFileSync(
      join(workerDirectory, "metadata.json"),
      JSON.stringify({
        ...metadata,
        workspace: worker,
        suite: "vitest",
        runtime: "workerd",
        shard: "serial",
        checkoutSha: git("rev-parse", "HEAD"),
        versions: {
          ...metadata.versions,
          provider: "4.1.11",
          vitest: "4.1.11",
          workersPlugin: "1.3.6",
        },
      }),
    );
    writeFileSync(
      join(workerDirectory, "lcov.info"),
      lcov.replace("FNH:0\n", "FNH:0\nBRF:0\nBRH:0\n"),
    );
    const nativeCoverage = {
      [file]: {
        path: file,
        statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
        fnMap: {},
        branchMap: {},
        s: { "0": 1 },
        f: {},
        b: {},
      },
    };
    const map = istanbulCoverage.createCoverageMap(nativeCoverage);
    const nativeSummary = {
      total: map.getCoverageSummary().toJSON(),
      [file]: map.fileCoverageFor(file).toSummary().toJSON(),
    };
    const writeJson = (name: string, data: unknown) =>
      writeFileSync(join(workerDirectory, name), JSON.stringify(data));
    writeJson("coverage-final.json", nativeCoverage);
    writeJson("coverage-summary.json", nativeSummary);
    expect(run("checks").exitCode).toBe(0);
    writeJson("coverage-final.json", { [file]: {} });
    expect(run("checks").exitCode).toBe(1);
    writeJson("coverage-final.json", nativeCoverage);
    const empty = istanbulCoverage.createCoverageMap({}).getCoverageSummary().toJSON();
    writeJson("coverage-summary.json", { total: empty, [file]: empty });
    expect(run("checks").exitCode).toBe(1);
    writeJson("coverage-summary.json", nativeSummary);
    writeFileSync(
      join(workerDirectory, "lcov.info"),
      lcov.replace("DA:1,1", "DA:1,0").replace("LH:1", "LH:0"),
    );
    expect(run("checks").exitCode).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
