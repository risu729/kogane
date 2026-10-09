// Manual negative control: deliberately reproduces a fixed-version Bun panic.
// This is not a passing CI suite; only the short-file counterpart belongs to CI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== "1.4.2") {
  throw new Error("reproduction_requires_pinned_bun_1_4_2");
}
const directory = mkdtempSync(join(tmpdir(), "kogane-data-url-repro-"));
try {
  const source = "export function fixture(value) { return value + 1; }\n// " + "x".repeat(12000);
  const dataUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  writeFileSync(join(directory, "schedule-alarm.test.mjs"), source);
  writeFileSync(
    join(directory, "ordinary.ts"),
    "export function ordinary(value) { return value + 1; }\n",
  );
  writeFileSync(
    join(directory, "bunfig.toml"),
    '[test]\ncoverageSkipTestFiles = true\ncoverageDir = "coverage"\n',
  );
  const results = [];
  for (const [name, moduleUrl, covered] of [
    ["data-url-uncovered", dataUrl, false],
    ["data-url-covered", dataUrl, true],
    ["short-file-covered", "./schedule-alarm.test.mjs", true],
  ]) {
    rmSync(join(directory, "coverage"), { recursive: true, force: true });
    writeFileSync(
      join(directory, "probe.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        "import { fixture } from " + JSON.stringify(moduleUrl) + ";",
        'import { ordinary } from "./ordinary.ts";',
        'test("synthetic", () => { expect(fixture(4)).toBe(5); expect(ordinary(4)).toBe(5); });',
      ].join("\n"),
    );
    const args = [
      "test",
      "./probe.test.ts",
      ...(covered ? ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"] : []),
    ];
    const result = spawnSync("bash", ["-c", 'ulimit -c 0; exec bun "$@"', "repro", ...args], {
      cwd: directory,
      timeout: 15000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = result.stdout + result.stderr;
    let report;
    try {
      report = readFileSync(join(directory, "coverage/lcov.info"), "utf8");
    } catch {}
    results.push({
      name,
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.error?.code === "ETIMEDOUT",
      panic:
        output.match(/panic: range end index \d+ out of range for slice of length \d+/u)?.[0] ??
        null,
      lcov: report !== undefined,
      ordinaryMeasured: report?.includes("SF:ordinary.ts") ?? false,
      generatedMeasured: report?.includes("schedule-alarm.test.mjs") ?? false,
    });
  }
  console.log(
    JSON.stringify({ bun: version.stdout.trim(), dataUrlLength: dataUrl.length, results }, null, 2),
  );
  if (
    results[0].exitCode !== 0 ||
    !results[1].panic ||
    results[2].exitCode !== 0 ||
    !results[2].ordinaryMeasured ||
    results[2].generatedMeasured
  )
    process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
