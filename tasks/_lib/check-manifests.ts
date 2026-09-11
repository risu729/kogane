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
//     reason. A config can not simply be forgotten;
//   * a workspace whose `src/**` imports a generated file declares the task
//     that writes it in the `depends` of its `typecheck`, `test` and `dry-run`
//     tasks. `infra/generated-files.json` is the declaration of which files
//     those are. A missing edge is not a build error but a race: mise runs
//     independent tasks in parallel, so the check passes whenever the export
//     happens to have run first and fails on a clean checkout (unified plan
//     U15, the U02/U03 follow-up).
//
// It validates what this repository declares, never what a dependency ships:
// node_modules is out of scope because git does not track it.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { relativeImports } from "./import-boundaries.ts";
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

/** One entry of `infra/generated-files.json`. */
export interface GeneratedFile {
  /** Repository-relative path of the file the producing task writes. */
  path: string;
  /** The mise task that writes it. */
  producedBy: string;
  reason?: string;
}

/** A `<workspace>/src/**` module and what its relative specifiers resolve to. */
export interface SourceImports {
  file: string;
  imports: readonly string[];
}

/**
 * The task kinds that must reach the producer. `types` and `build` are not on
 * the list on purpose: neither reads the generated file, and a dependency they
 * do not need would serialise work that can run in parallel.
 */
const GENERATED_INPUT_TASKS = ["typecheck", "test", "dry-run"] as const;

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

/**
 * The `<short>` each workspace's task family uses, taken from the `ci:<short>`
 * tasks. `ciTaskMismatches` already fails when that mapping is not one to one,
 * so an ambiguous entry is left out here rather than reported twice.
 */
export function workspaceShortNames(
  directories: readonly string[],
  tasks: readonly TaskRecord[],
  root: string = REPO_ROOT,
): Map<string, string> {
  const shorts = new Map<string, string>();
  for (const task of tasks) {
    if (!task.name.startsWith("ci:") || task.name === "ci:root") continue;
    const short = task.name.slice("ci:".length);
    const workspaces = new Set<string>();
    for (const member of tasks) {
      if (!member.name.startsWith(`${short}:`) || member.dir == null) continue;
      const workspace = workspaceOf(relative(root, member.dir), directories);
      if (workspace !== undefined) workspaces.add(workspace);
    }
    if (workspaces.size === 1) shorts.set([...workspaces][0] as string, short);
  }
  return shorts;
}

/** Every task name reachable from `name` through `depends`, itself included. */
function dependencyClosure(name: string, byName: ReadonlyMap<string, TaskRecord>): Set<string> {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(byName.get(current)?.depends ?? []));
  }
  return seen;
}

/**
 * Whether a resolved specifier names the generated file. An extension-less
 * specifier resolves to the path without its suffix, which is how a `.ts`
 * module would be imported; a `.json` one is named in full.
 */
function namesGenerated(resolved: string, path: string): boolean {
  return resolved === path || path.startsWith(`${resolved}.`);
}

/**
 * Workspaces whose `src/**` imports a generated file without their checks
 * depending on the task that writes it.
 *
 * The dependency is not optional and it is not cosmetic: mise runs independent
 * tasks in parallel, so a missing edge does not fail — it races. It passes on a
 * machine where the export ran once and fails on a clean checkout, which is the
 * worst shape a CI failure can have.
 *
 * The whole `depends` closure counts, not just the direct list: a task that
 * depends on the workspace's build, which depends on the export, has declared
 * it.
 */
export function generatedInputViolations(
  generated: readonly GeneratedFile[],
  sources: readonly SourceImports[],
  directories: readonly string[],
  tasks: readonly TaskRecord[],
  root: string = REPO_ROOT,
): string[] {
  const errors: string[] = [];
  const byName = new Map(tasks.map((task) => [task.name, task]));
  for (const file of generated) {
    if (!byName.has(file.producedBy))
      errors.push(
        `infra/generated-files.json: ${file.path} names the producing task "${file.producedBy}", which does not exist`,
      );
  }
  const shorts = workspaceShortNames(directories, tasks, root);
  const importedBy = new Map<string, GeneratedFile[]>();
  for (const source of sources) {
    const workspace = workspaceOf(source.file, directories);
    if (workspace === undefined) continue;
    for (const file of generated) {
      if (!source.imports.some((resolved) => namesGenerated(resolved, file.path))) continue;
      const listed = importedBy.get(workspace) ?? [];
      if (!listed.includes(file)) listed.push(file);
      importedBy.set(workspace, listed);
    }
  }
  const ordered = [...importedBy].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [workspace, files] of ordered) {
    // A workspace with no single `ci:` task is already `ciTaskMismatches`'s
    // failure; reporting it a second time here would only hide that one.
    const short = shorts.get(workspace);
    if (short === undefined) continue;
    for (const file of files) {
      if (!byName.has(file.producedBy)) continue;
      for (const kind of GENERATED_INPUT_TASKS) {
        const name = `${short}:${kind}`;
        if (!byName.has(name)) continue;
        if (dependencyClosure(name, byName).has(file.producedBy)) continue;
        errors.push(
          `${name}: ${workspace}/src imports the generated ${file.path}; add "${file.producedBy}", which writes it, to this task's depends`,
        );
      }
    }
  }
  return errors;
}

/**
 * Declared generated files that git tracks. Either the file stopped being
 * generated or someone committed an export; both make the declaration a lie,
 * and a lie here relaxes the check above for everyone.
 */
export function trackedGeneratedFiles(
  generated: readonly GeneratedFile[],
  tracked: readonly string[],
): string[] {
  const set = new Set(tracked);
  return generated
    .filter((file) => set.has(file.path))
    .map(
      (file) =>
        `infra/generated-files.json: ${file.path} is tracked by git, so it is not generated; drop the entry or stop committing the file`,
    );
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
  const generated = (
    JSON.parse(readFileSync(`${REPO_ROOT}/infra/generated-files.json`, "utf8")) as {
      files: GeneratedFile[];
    }
  ).files;
  const sources = trackedFiles(
    "apps/*/src/**",
    "experiments/*/src/**",
    "packages/*/src/**",
    "poc/*/src/**",
    "services/*/src/**",
  )
    .filter((file) => /\.[cm]?[jt]sx?$/u.test(file))
    .map((file) => ({
      file,
      imports: relativeImports(file, readFileSync(`${REPO_ROOT}/${file}`, "utf8")),
    }));
  errors.push(
    ...trackedGeneratedFiles(
      generated,
      generated.length === 0 ? [] : trackedFiles(...generated.map((file) => file.path)),
    ),
    ...generatedInputViolations(generated, sources, directories, tasks),
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
