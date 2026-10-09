import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("Bun 1.4.2 coverage: fixed reporters, unloaded files and LCOV-only threshold exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "kogane-coverage-fixture-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "src/probe.ts"),
      [
        "export function reached(value: boolean) {",
        "  if (value) return 1;",
        "  return 2;",
        "}",
        "export function neverCalled() {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(directory, "src/unloaded.ts"), "export function unloaded() { return 9; }\n");
    writeFileSync(
      join(directory, "probe.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'import { reached } from "./src/probe";',
        'test("synthetic", () => expect(reached(true)).toBe(1));',
        "",
      ].join("\n"),
    );
    const run = (reporters: string[], threshold = false) => {
      writeFileSync(
        join(directory, "bunfig.toml"),
        [
          "[test]",
          'coverageDir = "coverage"',
          "coverageSkipTestFiles = true",
          ...(threshold ? ["coverageThreshold = { lines = 0.99, functions = 0.99 }"] : []),
          "",
        ].join("\n"),
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          "test",
          "--coverage",
          ...reporters.map((reporter) => `--coverage-reporter=${reporter}`),
        ],
        { cwd: directory, timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } },
      );
      expect(result.exitedDueToTimeout).toBe(false);
      const report = readFileSync(join(directory, "coverage/lcov.info"), "utf8");
      return { result, report, text: result.stdout.toString() + result.stderr.toString() };
    };
    const normal = run(["text", "lcov"]);
    expect(normal.result.exitCode).toBe(0);
    expect(normal.text).toContain("All files");
    expect(normal.report).toContain("SF:src/probe.ts");
    expect(normal.report).not.toContain("unloaded.ts");
    expect(normal.report).toContain("FNF:");
    expect(normal.report).toContain("FNH:");
    expect(normal.report).not.toMatch(/^(?:FN|FNDA|BRDA|BRF|BRH):/mu);
    const lcovOnly = run(["lcov"], true);
    expect(lcovOnly.result.exitCode).toBe(1);
    expect(lcovOnly.report).toContain("SF:src/probe.ts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
