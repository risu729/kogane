import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { loadBundleFixture } from "../../services/processor/test/bundle-module-fixture.ts";

const source =
  "export const url = import.meta.url; export function fixture(value) { return value + 1; }\n// " +
  "x".repeat(12000);

test("short bundle fixture preserves exports, isolates simultaneous loads and cleans up", async () => {
  const [a, b] = await Promise.all([
    loadBundleFixture<{ url: string; fixture(value: number): number }>(source),
    loadBundleFixture<{ url: string; fixture(value: number): number }>(source),
  ]);
  try {
    expect(a.module.fixture(4)).toBe(5);
    expect(b.module.fixture(4)).toBe(5);
    expect(a.module.url).not.toBe(b.module.url);
    expect(a.module.url.length).toBeLessThan(4096);
    expect(existsSync(fileURLToPath(a.module.url))).toBe(true);
    expect(existsSync(fileURLToPath(b.module.url))).toBe(true);
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
  }
  expect(existsSync(fileURLToPath(a.module.url))).toBe(false);
  expect(existsSync(fileURLToPath(b.module.url))).toBe(false);
});

test("bundle fixture cleanup also runs after an import failure", async () => {
  let failedUrl: string | undefined;
  try {
    await loadBundleFixture("throw new Error(import.meta.url);");
    throw new Error("expected_import_failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    failedUrl = (error as Error).message;
    expect(failedUrl).toStartWith("file:");
  }
  expect(existsSync(fileURLToPath(failedUrl!))).toBe(false);
});

test("Bun native coverage omits only the generated test module, retaining the ordinary source", () => {
  const directory = mkdtempSync(join(tmpdir(), "kogane-short-bundle-probe-"));
  try {
    writeFileSync(join(directory, "schedule-alarm.test.mjs"), source);
    writeFileSync(
      join(directory, "ordinary.ts"),
      "export function ordinary(value: number) { return value + 1; }\n",
    );
    writeFileSync(
      join(directory, "bunfig.toml"),
      '[test]\ncoverageSkipTestFiles = true\ncoverageDir = "coverage"\n',
    );
    writeFileSync(
      join(directory, "probe.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { fixture } from "./schedule-alarm.test.mjs";',
        'import { ordinary } from "./ordinary.ts";',
        'test("same input and exports", () => { expect(fixture(4)).toBe(5); expect(ordinary(4)).toBe(5); });',
      ].join("\n"),
    );
    for (const covered of [false, true]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "test",
          "./probe.test.ts",
          ...(covered
            ? ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"]
            : []),
        ],
        { cwd: directory, timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } },
      );
      expect(result.exitedDueToTimeout).toBe(false);
      expect(result.exitCode).toBe(0);
      if (covered) {
        const report = readFileSync(join(directory, "coverage/lcov.info"), "utf8");
        expect(report).toContain("SF:ordinary.ts");
        expect(report).not.toContain("schedule-alarm.test.mjs");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
