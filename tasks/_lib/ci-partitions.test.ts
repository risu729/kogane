import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { dependencyClosure, type TaskRecord } from "./check-manifests.ts";
import { REPO_ROOT } from "./repo-root.ts";

// Used only to reject empty native shards, never to select files for execution.
// Cross-check the documented default discovery against the actual Bun fixture.
function defaultFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return defaultFiles(join(directory, entry.name), `${name}/`);
      return entry.isFile() &&
        /[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/u.test(entry.name)
        ? [name]
        : [];
    })
    .sort();
}

function nonemptyShards(directory: string): boolean {
  return defaultFiles(directory).length >= 2;
}

function native(command: string[], cwd = REPO_ROOT): string {
  const result = Bun.spawnSync(command, {
    cwd,
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_COLOR: "1", MISE_TASK_SHOW_FULL_CMD: "true" },
  });
  expect(result.exitedDueToTimeout).not.toBe(true);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString() + result.stderr.toString();
}

test("hosted partitions cover exactly the executable leaves of local full verification", () => {
  const tasks = JSON.parse(
    native(["mise", "tasks", "ls", "--all", "--json", "--hidden"]),
  ) as TaskRecord[];
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const leaves = (root: string) =>
    [...dependencyClosure(root, byName)].filter((name) => (byName.get(name)?.run?.length ?? 0) > 0);
  const processor = `${REPO_ROOT}/services/processor`;
  // An empty Bun shard returns success by default. Required coverage validation
  // rejects that state before the aggregate can accept the two shard results.
  expect(nonemptyShards(processor)).toBe(true);
  const config = Bun.TOML.parse(readFileSync(`${processor}/bunfig.toml`, "utf8")) as {
    test?: Record<string, unknown>;
  };
  for (const key of ["root", "pathIgnorePatterns", "onlyFailures"])
    expect(config.test?.[key]).toBeUndefined();
  const full = leaves("//:checks").sort();
  const remainder = leaves("//:ci:remainder");
  expect(remainder).not.toContain("//services/processor:test");
  expect(remainder).toContain("//packages/storage-d1:test");
  const combined = new Set(remainder);
  for (const index of [1, 2]) {
    const name = `//services/processor:test-shard-${index}`;
    const task = byName.get(name);
    expect(task?.run).toEqual([`bun test --shard=${index}/2`]);
    expect(task?.dir).toBe(`${REPO_ROOT}/services/processor`);
    for (const leaf of leaves(name))
      combined.add(leaf === name ? "//services/processor:test" : leaf);
  }
  expect([...combined].sort()).toEqual(full);
  expect(byName.get("//services/processor:test")?.run).toEqual(["bun test"]);

  const plan = native(["mise", "run", "--dry-run", "--jobs", "1", "ci:remainder"]);
  const commands = plan.split("\n").filter((line) => line.includes("] $ "));
  const storage = commands.findIndex((line) => line.includes("[//packages/storage-d1:test]"));
  expect(storage).toBeGreaterThan(0);
  // Storage is the last workspace command; the four existing Docker bodies
  // and both isolated Container API verification variants follow.
  expect(commands.slice(storage + 1)).toHaveLength(6);
  for (const line of commands.slice(storage + 1))
    expect(line).toContain("$ ./node_modules/.bin/wrangler deploy --dry-run");
  expect(plan).not.toContain("[//services/processor:test]");
}, 30_000);

test("native Bun shards discover every default test suffix with a disjoint complete union", () => {
  const directory = mkdtempSync(join(tmpdir(), "kogane-bun-shards-"));
  try {
    expect(nonemptyShards(directory)).toBe(false);
    writeFileSync(join(directory, "solo.test.ts"), "");
    expect(nonemptyShards(directory)).toBe(false);
    rmSync(join(directory, "solo.test.ts"));
    writeFileSync(join(directory, "bunfig.toml"), '[test]\npreload = ["./preload.ts"]\n');
    writeFileSync(
      join(directory, "preload.ts"),
      "globalThis.preloads = (globalThis.preloads ?? 0) + 1;\n",
    );
    const files: string[] = [];
    for (const suffix of [".test", "_test", ".spec", "_spec"]) {
      for (const extension of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
        const file = `nested/${extension}/example${suffix}.${extension}`;
        mkdirSync(join(directory, "nested", extension), { recursive: true });
        writeFileSync(
          join(directory, file),
          `
import { expect, test } from "bun:test";
console.log("FILE=${file}");
test("${file}", async () => {
  expect(globalThis.preloads).toBe(1);
  expect(globalThis.active ?? false).toBe(false);
  globalThis.active = true;
  await Bun.sleep(1);
  globalThis.active = false;
});
`,
        );
        files.push(file);
      }
    }
    for (const excluded of [".hidden", "node_modules"]) {
      mkdirSync(join(directory, excluded));
      writeFileSync(
        join(directory, excluded, "excluded.test.ts"),
        'throw new Error("excluded file ran");\n',
      );
    }
    const discovered = (args: string[]) =>
      [...native(["bun", "test", ...args], directory).matchAll(/FILE=([^\s]+)/gu)]
        .map((match) => match[1])
        .sort();
    expect(defaultFiles(directory)).toEqual(files.sort());
    expect(discovered([])).toEqual(defaultFiles(directory));
    const first = discovered(["--shard=1/2"]);
    const second = discovered(["--shard=2/2"]);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.filter((file) => second.includes(file))).toEqual([]);
    expect([...first, ...second].sort()).toEqual(files);
    const empty = Bun.spawnSync(["bun", "test", "--shard=33/33"], {
      cwd: directory,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect(empty.exitedDueToTimeout).not.toBe(true);
    // Record the native empty-shard behavior the required discovery guard covers.
    expect(empty.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
