// The single-task-runner guard (unified plan 08, acceptance G4-01, G4-02,
// G4-09). mise owns every development, build and test entry point, so:
//
//   * no repository-owned package.json may carry a `scripts` field. An empty
//     object is rejected too: it is the shape a half-finished migration leaves
//     behind, and the next edit fills it in;
//   * no tracked workflow, task file, wrangler config, Dockerfile, script or
//     document may invoke a package script (`bun run <name>`, `npm run …`) or
//     download a tool on the fly (`npx`, `bunx`). Running a *file* with Bun
//     (`bun scripts/x.ts`, `bun run src/x.ts`) stays allowed: that is a path,
//     not an entry point that has to be declared twice;
//   * every workspace directory must be reachable from a `ci:<short>` task, so
//     a new workspace cannot be added without joining the CI matrix, which is
//     generated from exactly these task names; and every `ci:<short>` other
//     than `ci:root` must belong to exactly one workspace, so a matrix entry
//     that runs nothing cannot pass vacuously;
//   * every tracked Wrangler configuration is either validated by a dry-run
//     task and listed in `infra/workers-ci.json`, or excluded there with a
//     reason. A config can not simply be forgotten.
//
// It validates what this repository declares, never what a dependency ships:
// node_modules is out of scope because git does not track it.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";

/** A mise task as `mise tasks ls --json` reports it. */
export interface TaskRecord {
  name: string;
  depends?: string[];
  dir?: string | null;
  run?: string[];
  /** The file that defines the task, absolute. */
  source?: string | null;
}

/** One Wrangler configuration the CI `workers` matrix validates. */
export interface WorkerEntry {
  name: string;
  path: string;
  config: string;
  /** Task that builds what the config serves; defaults to the frozen install. */
  prepare?: string;
}

/** A tracked Wrangler configuration that deliberately has no dry run. */
export interface ExcludedConfig {
  path: string;
  config: string;
  reason: string;
}

export function manifestViolations(manifest: unknown, file: string): string[] {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    return [`${file}: manifest must be a JSON object`];
  return Object.hasOwn(manifest, "scripts")
    ? [`${file}: package scripts are not allowed; declare a mise task instead`]
    : [];
}

// `bun run <target>`, optionally preceded by flags. A target that names a path
// (it contains a slash or a file extension) runs a file and is allowed.
const RUN_PATTERN = /\b(bun|npm|pnpm|yarn)\s+run\s+((?:--[\w-]+(?:=\S+)?\s+)*)([^\s"'`;&|)]+)/gu;
const DOWNLOAD_PATTERN = /(?:^|[\s"'`(])(npx|bunx)\s/gu;

/** Package-script invocations inside one file. */
export function scriptInvocations(text: string, file: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(RUN_PATTERN)) {
    const target = match[3] ?? "";
    if (target.includes("/") || /\.[cm]?[jt]sx?$/u.test(target)) continue;
    found.push(
      `${file}: "${match[1]} run ${target}" invokes a package script; run the mise task instead`,
    );
  }
  return found;
}

/**
 * On-demand tool downloads inside a task or workflow definition. A task must
 * run the locked binary, so that a checkout without network still fails loudly
 * instead of silently installing a different version (unified plan 08 §4).
 * Operational shell scripts that a human runs by hand are out of scope.
 */
export function toolDownloads(text: string, file: string): string[] {
  return [...text.matchAll(DOWNLOAD_PATTERN)].map(
    (match) =>
      `${file}: "${match[1]}" downloads a tool on demand; call the locked binary in node_modules/.bin`,
  );
}

/** Directories a `workspaces` glob of the root manifest selects. */
export function workspaceDirectories(globs: readonly string[], manifests: string[]): string[] {
  const patterns = globs.map(
    (glob) => new RegExp(`^${glob.replaceAll(".", "\\.").replaceAll("*", "[^/]+")}$`, "u"),
  );
  return manifests
    .map((file) => file.slice(0, -"/package.json".length))
    .filter((directory) => patterns.some((pattern) => pattern.test(directory)))
    .sort();
}

/** Workspace directories that no `ci:*` task reaches. */
export function uncoveredWorkspaces(
  directories: readonly string[],
  tasks: readonly TaskRecord[],
  root: string = REPO_ROOT,
): string[] {
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const directoryOf = (task: TaskRecord): string | undefined =>
    task.dir == null ? undefined : relative(root, task.dir) || ".";
  const reached = new Set<string>();
  for (const task of tasks) {
    if (!task.name.startsWith("ci:")) continue;
    const queue = [task.name];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const current = byName.get(name);
      if (current === undefined) continue;
      const directory = directoryOf(current);
      if (directory !== undefined) reached.add(directory);
      queue.push(...(current.depends ?? []));
    }
  }
  return directories.filter((directory) => !reached.has(directory));
}

/** The workspace directory a task runs in, or undefined when it runs elsewhere. */
function workspaceOf(directory: string, directories: readonly string[]): string | undefined {
  return directories.find(
    (candidate) => directory === candidate || directory.startsWith(`${candidate}/`),
  );
}

/**
 * Every `ci:<short>` task other than `ci:root` stands for exactly one workspace:
 * the tasks named `<short>:*` run inside it and no other `ci:` task claims it.
 * The CI matrix is `[.name[3:]]`, so a `ci:` task that reaches no workspace
 * would be a matrix entry that passes without running anything.
 */
export function ciTaskMismatches(
  directories: readonly string[],
  tasks: readonly TaskRecord[],
  root: string = REPO_ROOT,
): string[] {
  const errors: string[] = [];
  const claimed = new Map<string, string>();
  for (const task of tasks) {
    if (!task.name.startsWith("ci:") || task.name === "ci:root") continue;
    const short = task.name.slice("ci:".length);
    const workspaces = new Set<string>();
    for (const member of tasks) {
      if (!member.name.startsWith(`${short}:`) || member.dir == null) continue;
      const workspace = workspaceOf(relative(root, member.dir), directories);
      if (workspace !== undefined) workspaces.add(workspace);
    }
    if ((task.depends ?? []).length === 0) {
      errors.push(`${task.name}: depends on nothing; a ci: task must run the workspace's checks`);
    }
    if (workspaces.size !== 1) {
      errors.push(
        `${task.name}: the ${short}:* tasks run in ${workspaces.size === 0 ? "no workspace" : [...workspaces].sort().join(", ")}; a ci: task belongs to exactly one`,
      );
      continue;
    }
    const workspace = [...workspaces][0] as string;
    const other = claimed.get(workspace);
    if (other !== undefined) {
      errors.push(`${task.name}: ${workspace} already has ${other}; one ci: task per workspace`);
    } else {
      claimed.set(workspace, task.name);
    }
  }
  return errors;
}

/**
 * Every tracked Wrangler configuration is accounted for: listed as a worker
 * (and so validated by the CI matrix) or excluded with a reason. Bootstrap,
 * test-harness and `wrangler dev` helper configs are the excluded kind.
 */
export function unaccountedConfigs(
  configs: readonly string[],
  workers: readonly WorkerEntry[],
  excluded: readonly ExcludedConfig[],
): string[] {
  const listed = new Set(workers.map((worker) => `${worker.path}/${worker.config}`));
  const skipped = new Map(excluded.map((entry) => [`${entry.path}/${entry.config}`, entry.reason]));
  const tracked = new Set(configs);
  return [
    ...configs
      .filter((config) => !listed.has(config) && !skipped.has(config))
      .map(
        (config) =>
          `infra/workers-ci.json: ${config} is neither a worker entry nor excluded with a reason`,
      ),
    ...[...skipped]
      .filter(
        ([config, reason]) => listed.has(config) || !tracked.has(config) || reason.trim() === "",
      )
      .map(
        ([config]) => `infra/workers-ci.json: the exclusion of ${config} is stale or has no reason`,
      ),
  ];
}

/**
 * The `<path>/<config>` pairs the `*:dry-run` tasks validate. `infra/workers-ci.json`
 * must list exactly these, because the CI `workers` matrix is built from the
 * ledger while a developer runs the tasks (acceptance G4-09, G5-09).
 */
export function dryRunTargets(tasks: readonly TaskRecord[], root: string = REPO_ROOT): string[] {
  const targets: string[] = [];
  for (const task of tasks) {
    if (!task.name.endsWith(":dry-run") || task.dir == null) continue;
    const directory = relative(root, task.dir);
    for (const command of task.run ?? []) {
      const config = /--config (\S+)/u.exec(command)?.[1] ?? "wrangler.jsonc";
      targets.push(`${directory}/${config}`);
    }
  }
  return targets.sort();
}

/** Differences between the dry-run tasks and the CI worker ledger. */
export function ledgerMismatches(
  targets: readonly string[],
  workers: readonly WorkerEntry[],
  taskNames: readonly string[] = [],
): string[] {
  const listed = new Set(workers.map((worker) => `${worker.path}/${worker.config}`));
  const declared = new Set(targets);
  const known = new Set(taskNames);
  return [
    ...workers
      .filter((worker) => worker.prepare !== undefined && !known.has(worker.prepare))
      .map(
        (worker) =>
          `infra/workers-ci.json: ${worker.name} names the prepare task "${worker.prepare}", which does not exist`,
      ),
    ...targets
      .filter((target) => !listed.has(target))
      .map((target) => `infra/workers-ci.json: ${target} has a dry-run task but is not listed`),
    ...[...listed]
      .filter((target) => !declared.has(target))
      .sort()
      .map((target) => `infra/workers-ci.json: ${target} is listed but has no dry-run task`),
  ];
}

const SCANNED = [
  "*.md",
  "*.yml",
  "*.yaml",
  "*.toml",
  "*.json",
  "*.jsonc",
  "*.sh",
  "*.ts",
  "*.tsx",
  "*.mjs",
  "*.cjs",
  "*.js",
  "Dockerfile",
  "*/Dockerfile",
  "**/Dockerfile",
  "*.Dockerfile",
];

function miseTasks(): TaskRecord[] {
  const result = Bun.spawnSync(["mise", "tasks", "ls", "--json", "--hidden"], {
    cwd: REPO_ROOT,
    env: { ...process.env, MISE_TASK_RUN_AUTO_INSTALL: "0" },
  });
  if (result.exitCode !== 0)
    throw new Error(`mise tasks ls failed: ${result.stderr.toString().trim()}`);
  // mise also lists tasks from parent and global configs; only this checkout's
  // task files define what CI runs.
  return (JSON.parse(result.stdout.toString()) as TaskRecord[]).filter(
    (task) => task.source != null && task.source.startsWith(`${REPO_ROOT}/`),
  );
}

export function check(): string[] {
  const errors: string[] = [];
  const manifests = trackedFiles("package.json", "*/package.json", "**/package.json");
  for (const file of manifests) {
    try {
      errors.push(
        ...manifestViolations(JSON.parse(readFileSync(`${REPO_ROOT}/${file}`, "utf8")), file),
      );
    } catch {
      errors.push(`${file}: invalid JSON`);
    }
  }
  for (const file of trackedFiles(...SCANNED)) {
    // The guard states the forbidden forms in order to recognise them.
    if (file.startsWith("tasks/_lib/check-manifests")) continue;
    errors.push(...scriptInvocations(readFileSync(`${REPO_ROOT}/${file}`, "utf8"), file));
  }
  for (const file of trackedFiles(
    "mise.toml",
    "tasks.toml",
    "**/tasks.toml",
    ".github/workflows",
  )) {
    errors.push(...toolDownloads(readFileSync(`${REPO_ROOT}/${file}`, "utf8"), file));
  }
  const root = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8")) as {
    workspaces?: string[];
  };
  const directories = workspaceDirectories(root.workspaces ?? [], manifests);
  const tasks = miseTasks();
  for (const directory of uncoveredWorkspaces(directories, tasks)) {
    errors.push(
      `${directory}: no ci:<short> task runs in this workspace; add ${directory}/tasks.toml and list it in mise.toml`,
    );
  }
  errors.push(...ciTaskMismatches(directories, tasks));
  const ledger = JSON.parse(readFileSync(`${REPO_ROOT}/infra/workers-ci.json`, "utf8")) as {
    workers: WorkerEntry[];
    excluded?: ExcludedConfig[];
  };
  errors.push(
    ...ledgerMismatches(
      dryRunTargets(tasks),
      ledger.workers,
      tasks.map((task) => task.name),
    ),
    ...unaccountedConfigs(
      trackedFiles("**/wrangler*.json", "**/wrangler*.jsonc", "**/wrangler*.toml"),
      ledger.workers,
      ledger.excluded ?? [],
    ),
  );
  return errors;
}

if (import.meta.main) {
  try {
    const errors = check();
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "manifest check failed");
    process.exitCode = 1;
  }
}
