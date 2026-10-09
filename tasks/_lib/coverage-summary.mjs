import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import parseLcov from "lcov-parse";
import istanbulCoverage from "istanbul-lib-coverage";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requested = process.argv[2] ?? "checks";
if (!["checks", "processor-1", "processor-2", "baseline"].includes(requested))
  throw new Error("Unknown coverage partition");
const all = JSON.parse(readFileSync(resolve(root, "tasks/_lib/coverage-suites.json"), "utf8"));
const selected =
  requested === "checks"
    ? all.filter((s) => s.workspace !== "services/processor")
    : all.filter((s) => s.workspace === "services/processor");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const trackedSet = new Set(tracked);
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const shard = requested.startsWith("processor-") ? requested.slice(-1) + "/2" : "serial";
const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedBun = packageManifest.packageManager.slice("bun@".length);
const expectedProvenance = {
  runId: process.env.GITHUB_RUN_ID || null,
  attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  requestedHeadSha: process.env.COVERAGE_HEAD_SHA || null,
  baseSha: process.env.COVERAGE_BASE_SHA || null,
};
const rows = [];
let invalid = false;
for (const suite of selected) {
  const kind = suite.suite === "bun" ? "bun" : "workerd";
  const directory = resolve(
    root,
    suite.workspace,
    "coverage",
    kind,
    requested === "baseline" ? "baseline" : shard.replace("/", "-of-"),
  );
  let metadata = null;
  let problem = null;
  try {
    metadata = JSON.parse(readFileSync(resolve(directory, "metadata.json"), "utf8"));
  } catch {
    problem = "missing metadata";
  }
  const report = resolve(directory, "lcov.info");
  const normalized = [];
  const lcovBySource = new Map();
  if (existsSync(report)) {
    try {
      const raw = readFileSync(report, "utf8");
      if (!raw.trim().endsWith("end_of_record")) throw new Error("truncated LCOV");
      const rawRecords = raw.split("end_of_record").filter((record) => record.trim());
      for (const record of rawRecords)
        if (
          !["SF", "FNF", "FNH", "LF", "LH"].every(
            (key) => record.split("\n").filter((line) => line.startsWith(key + ":")).length === 1,
          )
        )
          throw new Error("missing or repeated native record fields");
      const records = await new Promise((accept, reject) =>
        parseLcov(raw, (error, data) => (error ? reject(error) : accept(data))),
      );
      if (records.length !== rawRecords.length) throw new Error("native record count mismatch");
      const integer = (n) => Number.isSafeInteger(n) && n >= 0;
      for (const record of records) {
        const absolute = realpathSync(resolve(root, suite.workspace, record.file));
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (path.startsWith("../") || path === ".." || !existsSync(absolute))
          throw new Error("source path missing or outside repository");
        if (!trackedSet.has(path) || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path))
          throw new Error("source path is not tracked executable code");
        const sourceLines = readFileSync(absolute, "utf8").split("\n").length;
        for (const counters of [record.lines, record.functions])
          if (!integer(counters.found) || !integer(counters.hit) || counters.hit > counters.found)
            throw new Error("invalid native counters");
        const details = record.lines.details;
        if (
          details.length !== record.lines.found ||
          details.filter((line) => line.hit > 0).length !== record.lines.hit ||
          new Set(details.map((line) => line.line)).size !== details.length ||
          details.some(
            (line) =>
              !integer(line.line) || line.line < 1 || line.line > sourceLines || !integer(line.hit),
          )
        )
          throw new Error("invalid line identities or counters");
        if (suite.suite === "vitest") {
          for (const counters of [record.functions, record.branches])
            if (
              !integer(counters.found) ||
              !integer(counters.hit) ||
              counters.hit > counters.found ||
              counters.details.length !== counters.found
            )
              throw new Error("invalid Workers counter identities");
          if (
            record.functions.details.filter((fn) => fn.hit > 0).length !== record.functions.hit ||
            record.functions.details.some(
              (fn) => !integer(fn.line) || fn.line < 1 || fn.line > sourceLines || !integer(fn.hit),
            ) ||
            record.branches.details.filter((branch) => branch.taken > 0).length !==
              record.branches.hit ||
            record.branches.details.some(
              (branch) =>
                !integer(branch.line) ||
                branch.line < 1 ||
                branch.line > sourceLines ||
                !integer(branch.taken),
            )
          )
            throw new Error("invalid Workers function or branch counters");
        }
        normalized.push(path);
        lcovBySource.set(path, record);
      }
    } catch (error) {
      problem ??= error.message ?? String(error);
    }
  } else problem ??= "missing LCOV";
  if (normalized.length === 0) problem ??= "empty LCOV";
  if (new Set(normalized).size !== normalized.length) problem ??= "duplicate source identity";
  if (
    metadata &&
    (metadata.schema !== "kogane-test-coverage-v1" ||
      metadata.workspace !== suite.workspace ||
      metadata.suite !== suite.suite ||
      metadata.runtime !== (suite.suite === "bun" ? "bun-host" : "workerd") ||
      metadata.checkoutSha !== sha ||
      metadata.shard !== shard ||
      metadata.baseline !== (requested === "baseline") ||
      Object.entries(expectedProvenance).some(([key, value]) => metadata[key] !== value))
  )
    problem ??= "metadata identity or provenance mismatch";
  const versions = metadata?.versions;
  if (
    !versions ||
    versions.bun !== expectedBun ||
    versions.node !== process.versions.node ||
    (suite.suite === "bun" &&
      (versions.provider !== "bun-native" ||
        versions.vitest !== null ||
        versions.workersPlugin !== null))
  )
    problem ??= "runtime version mismatch";
  if (suite.suite === "vitest") {
    const dependencies = JSON.parse(
      readFileSync(resolve(root, suite.workspace, "package.json"), "utf8"),
    ).devDependencies;
    if (
      versions?.vitest !== dependencies.vitest ||
      versions?.provider !== dependencies["@vitest/coverage-istanbul"] ||
      versions?.workersPlugin !== dependencies["@cloudflare/vitest-plugin"]
    )
      problem ??= "Workers provider version mismatch";
    try {
      const nativeSummary = JSON.parse(
        readFileSync(resolve(directory, "coverage-summary.json"), "utf8"),
      );
      const nativeCoverage = JSON.parse(
        readFileSync(resolve(directory, "coverage-final.json"), "utf8"),
      );
      // Use the same standard coverage-map implementation as Istanbul's reporter.
      // Validate within this one suite only; never merge runtimes/workspaces/shards.
      const map = istanbulCoverage.createCoverageMap(nativeCoverage);
      const equalSummary = (actual, expected) =>
        ["lines", "functions", "branches", "statements"].every((metric) =>
          ["total", "covered", "skipped", "pct"].every(
            (key) => actual?.[metric]?.[key] === expected?.[metric]?.[key],
          ),
        );
      if (!equalSummary(nativeSummary.total, map.getCoverageSummary().toJSON()))
        throw new Error("Istanbul summary does not match native coverage map");
      const jsonSources = [];
      for (const file of map.files()) {
        const path = relative(root, realpathSync(resolve(root, suite.workspace, file))).replaceAll(
          "\\",
          "/",
        );
        jsonSources.push(path);
        const computed = map.fileCoverageFor(file).toSummary().toJSON();
        if (!equalSummary(nativeSummary[file], computed))
          throw new Error("Istanbul file summary does not match native coverage map");
        const lcov = lcovBySource.get(path);
        if (
          !lcov ||
          !["lines", "functions", "branches"].every(
            (metric) =>
              computed[metric].total === lcov[metric].found &&
              computed[metric].covered === lcov[metric].hit,
          )
        )
          throw new Error("Istanbul JSON/LCOV counters disagree");
      }
      if (JSON.stringify(jsonSources.sort()) !== JSON.stringify([...normalized].sort()))
        throw new Error("Istanbul JSON/LCOV source identity mismatch");
    } catch (error) {
      problem ??= error.message ?? String(error);
    }
  }
  if (metadata?.state !== "passed" || metadata?.exitCode !== 0 || metadata?.signal !== null)
    problem ??= "test not passed";
  const prefix = suite.workspace === "." ? "" : suite.workspace + "/";
  const own = tracked
    .filter(
      (p) =>
        p.startsWith(prefix + "src/") || (suite.workspace === "." && /^(tasks|scripts)\//.test(p)),
    )
    .filter(
      (p) =>
        /\.(?:[cm]?[jt]s|[jt]sx)$/.test(p) &&
        !/\.d\.[cm]?ts$|[._](?:test|spec)\.|(?:^|\/)(?:fixtures?|generated|test|tests)\//.test(p),
    );
  const missing = own.filter((p) => !normalized.includes(p));
  const outsideScope = normalized.filter((p) => !own.includes(p));
  const row = {
    ...suite,
    partition: requested,
    state: problem ?? "passed",
    metadata,
    report: relative(root, report),
    sourceInventory: own,
    reportedSources: normalized,
    sourcesAbsentFromReport: missing,
    outsideOwnedSourceScope: outsideScope,
  };
  rows.push(row);
  if (problem) invalid = true;
}
const output = resolve(root, "coverage", requested);
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, "collection.json"),
  JSON.stringify(
    {
      schema: "kogane-coverage-collection-v1",
      partition: requested,
      checkoutSha: sha,
      complete: !invalid,
      suites: rows,
    },
    null,
    2,
  ) + "\n",
);
const lines = [
  "# Native coverage: " + requested,
  "",
  "Checkout: \x60" +
    sha +
    "\x60. Reports belong to this checkout, not necessarily the requested PR head.",
  "Collection: **" +
    (invalid ? "incomplete / failed" : "all expected suites passed") +
    "**. No threshold is enforced.",
  "",
  "| Workspace | Runtime | Shard | Test/report state | Reported files | Owned source files absent | Seconds |",
  "| --- | --- | --- | --- | ---: | ---: | ---: |",
  ...rows.map(
    (r) =>
      "| " +
      r.workspace +
      " | " +
      (r.suite === "bun" ? "Bun host" : "workerd / Istanbul") +
      " | " +
      (requested === "baseline" ? "full serial baseline" : shard) +
      " | " +
      r.state +
      " | " +
      r.reportedSources.length +
      " | " +
      r.sourcesAbsentFromReport.length +
      " | " +
      (r.metadata?.elapsedSeconds?.toFixed(2) ?? "N/A") +
      " |",
  ),
  "",
  "- Each runtime/workspace has its own untouched native LCOV; Istanbul additionally emits JSON and JSON summary. Native text is in the test job log.",
  "- Bun line/function counters cover loaded files only. Unloaded owned sources are listed in collection.json, not zero-filled into the denominator. Branch/statement coverage is N/A.",
  "- Bun text All files is an unweighted file mean, not a repository-weighted rate. Native shards are diagnostic only: do not average rates or merge incomplete function counters.",
  "- Workers include owned src sources, including unexecuted files. Shared imports outside that scope are not a repository total. File identities and absent owned sources are recorded, not summed across suites.",
  "- Child processes (including other Bun/Node processes), Chromium/browser checks and workerd children of Bun tests are unmeasured by Bun-host coverage; a passing test is not coverage of those runtimes.",
  "- A failed, interrupted, missing, stale or malformed report never becomes a successful collection. Cancelled jobs can have no artifact; consult the unchanged CI gate.",
  "",
];
const markdown = lines.join("\n");
writeFileSync(resolve(output, "summary.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
if (invalid) process.exitCode = 1;
