// Acceptance G4-01 (a scripts field, even an empty one, is rejected),
// G4-02 (a task, workflow, Dockerfile or document that still calls a package
// script is detected) and G4-09 (a new workspace cannot miss the CI matrix).
import { describe, expect, test } from "bun:test";
import {
  check,
  ciTaskMismatches,
  dryRunTargets,
  ledgerMismatches,
  manifestViolations,
  scriptInvocations,
  toolDownloads,
  unaccountedConfigs,
  uncoveredWorkspaces,
  workspaceDirectories,
} from "./check-manifests.ts";

describe("package manifests (G4-01)", () => {
  test("a manifest without scripts passes", () => {
    expect(manifestViolations({ name: "x" }, "package.json")).toEqual([]);
  });

  test("an empty scripts object is still a violation", () => {
    expect(manifestViolations({ scripts: {} }, "a/package.json")).toHaveLength(1);
  });

  test("a populated scripts object is a violation", () => {
    expect(manifestViolations({ scripts: { test: "bun test" } }, "a/package.json")).toHaveLength(1);
  });

  test("a manifest that is not an object is a violation", () => {
    expect(manifestViolations(null, "a/package.json")).toHaveLength(1);
    expect(manifestViolations([], "a/package.json")).toHaveLength(1);
  });
});

describe("package script invocations (G4-02)", () => {
  test("a bare script name is rejected for every package manager", () => {
    for (const line of [
      "bun run test",
      "npm run build:evidence",
      "pnpm run typecheck",
      "yarn run cf:check",
      "bun run --silent test",
    ]) {
      expect(scriptInvocations(line, "README.md")).toHaveLength(1);
    }
  });

  test("running a file with Bun stays allowed", () => {
    expect(scriptInvocations("bun run src/demo.ts", "README.md")).toEqual([]);
    expect(scriptInvocations("bun scripts/load-fixture.ts", "README.md")).toEqual([]);
    expect(scriptInvocations("bun run ./probe.mjs", "README.md")).toEqual([]);
  });

  test("a mise task invocation is not a package script", () => {
    expect(scriptInvocations("mise run ci:app", "README.md")).toEqual([]);
    expect(scriptInvocations("mise run check --lint", "README.md")).toEqual([]);
  });

  test("on-demand tool downloads are rejected inside task and workflow definitions", () => {
    expect(toolDownloads("run = 'npx wrangler deploy'", "tasks.toml")).toHaveLength(1);
    expect(toolDownloads("        run: bunx vitest run", ".github/workflows/ci.yml")).toHaveLength(
      1,
    );
    expect(toolDownloads("./node_modules/.bin/wrangler deploy", "tasks.toml")).toEqual([]);
  });

  test("npm ci and bun install are not script invocations", () => {
    expect(scriptInvocations("npm ci --ignore-scripts", "tasks.toml")).toEqual([]);
    expect(scriptInvocations("bun install --frozen-lockfile", "tasks.toml")).toEqual([]);
  });
});

describe("workspace CI coverage (G4-09)", () => {
  const manifests = [
    "package.json",
    "packages/domain/package.json",
    "poc/thing/package.json",
    "poc/thing/container/package.json",
    "node_modules/x/package.json",
  ];

  test("only the directories the workspace globs select are workspaces", () => {
    expect(workspaceDirectories(["packages/*", "poc/*"], manifests)).toEqual([
      "packages/domain",
      "poc/thing",
    ]);
  });

  test("a workspace reached through a ci: task's dependencies is covered", () => {
    const tasks = [
      { name: "domain:test", dir: "/repo/packages/domain" },
      { name: "ci:domain", depends: ["domain:test"], dir: null },
    ];
    expect(uncoveredWorkspaces(["packages/domain"], tasks, "/repo")).toEqual([]);
  });

  test("a workspace whose tasks no ci: task depends on is reported", () => {
    const tasks = [
      { name: "thing:test", dir: "/repo/poc/thing" },
      { name: "ci:domain", depends: ["domain:test"], dir: null },
      { name: "domain:test", dir: "/repo/packages/domain" },
    ];
    expect(uncoveredWorkspaces(["packages/domain", "poc/thing"], tasks, "/repo")).toEqual([
      "poc/thing",
    ]);
  });

  test("a workspace with no task at all is reported", () => {
    expect(uncoveredWorkspaces(["poc/thing"], [], "/repo")).toEqual(["poc/thing"]);
  });
});

describe("one ci: task per workspace (G4-09)", () => {
  const directories = ["packages/domain", "poc/thing"];

  test("a ci: task whose family runs in one workspace, a subdirectory included, passes", () => {
    const tasks = [
      { name: "thing:test", dir: "/repo/poc/thing" },
      { name: "thing:container", dir: "/repo/poc/thing/container" },
      { name: "ci:thing", depends: ["thing:test", "thing:container"], dir: null },
      { name: "ci:root", depends: ["root:test"], dir: null },
    ];
    expect(ciTaskMismatches(directories, tasks, "/repo")).toEqual([]);
  });

  test("a ci: task that depends on nothing or reaches no workspace is reported", () => {
    const tasks = [{ name: "ci:package", dir: null }];
    expect(ciTaskMismatches(directories, tasks, "/repo")).toEqual([
      "ci:package: depends on nothing; a ci: task must run the workspace's checks",
      "ci:package: the package:* tasks run in no workspace; a ci: task belongs to exactly one",
    ]);
  });

  test("two ci: tasks for the same workspace are reported", () => {
    const tasks = [
      { name: "thing:test", dir: "/repo/poc/thing" },
      { name: "other:test", dir: "/repo/poc/thing" },
      { name: "ci:thing", depends: ["thing:test"], dir: null },
      { name: "ci:other", depends: ["other:test"], dir: null },
    ];
    expect(ciTaskMismatches(directories, tasks, "/repo")).toEqual([
      "ci:other: poc/thing already has ci:thing; one ci: task per workspace",
    ]);
  });

  test("a family spread over two workspaces is reported", () => {
    const tasks = [
      { name: "thing:test", dir: "/repo/poc/thing" },
      { name: "thing:build", dir: "/repo/packages/domain" },
      { name: "ci:thing", depends: ["thing:test", "thing:build"], dir: null },
    ];
    expect(ciTaskMismatches(directories, tasks, "/repo")).toEqual([
      "ci:thing: the thing:* tasks run in packages/domain, poc/thing; a ci: task belongs to exactly one",
    ]);
  });
});

describe("the CI worker ledger (G4-09, G5-09)", () => {
  const tasks = [
    {
      name: "importer:dry-run",
      dir: "/repo/services/importer",
      run: [
        "./node_modules/.bin/wrangler deploy --dry-run",
        "./node_modules/.bin/wrangler deploy --dry-run --config wrangler.audit.jsonc",
      ],
    },
    { name: "importer:test", dir: "/repo/services/importer", run: ["bun test"] },
  ];

  test("every config a dry-run task validates is a ledger target", () => {
    expect(dryRunTargets(tasks, "/repo")).toEqual([
      "services/importer/wrangler.audit.jsonc",
      "services/importer/wrangler.jsonc",
    ]);
  });

  test("a config with a dry-run task but no ledger entry is reported", () => {
    const workers = [{ name: "importer", path: "services/importer", config: "wrangler.jsonc" }];
    expect(ledgerMismatches(dryRunTargets(tasks, "/repo"), workers)).toEqual([
      "infra/workers-ci.json: services/importer/wrangler.audit.jsonc has a dry-run task but is not listed",
    ]);
  });

  test("a prepare task that does not exist is reported", () => {
    const workers = [
      {
        name: "app",
        path: "services/app",
        config: "wrangler.jsonc",
        prepare: "web:build-nothing",
      },
    ];
    expect(ledgerMismatches(["services/app/wrangler.jsonc"], workers, ["web:build"])).toEqual([
      'infra/workers-ci.json: app names the prepare task "web:build-nothing", which does not exist',
    ]);
  });

  test("a ledger entry with no dry-run task is reported", () => {
    const workers = [{ name: "ghost", path: "services/ghost", config: "wrangler.jsonc" }];
    expect(ledgerMismatches([], workers)).toEqual([
      "infra/workers-ci.json: services/ghost/wrangler.jsonc is listed but has no dry-run task",
    ]);
  });

  const configs = [
    "services/app/wrangler.jsonc",
    "services/app/wrangler.ops.jsonc",
    "poc/thing/wrangler.toml",
  ];
  const workers = [{ name: "app", path: "services/app", config: "wrangler.jsonc" }];
  const excluded = [
    { path: "services/app", config: "wrangler.ops.jsonc", reason: "wrangler dev helper, no main" },
  ];

  test("every tracked wrangler config is a worker entry or an excluded one", () => {
    expect(unaccountedConfigs(configs, workers, excluded)).toEqual([
      "infra/workers-ci.json: poc/thing/wrangler.toml is neither a worker entry nor excluded with a reason",
    ]);
    expect(unaccountedConfigs(configs.slice(0, 2), workers, excluded)).toEqual([]);
  });

  test("an exclusion that is listed anyway, gone from disk or unexplained is reported", () => {
    expect(
      unaccountedConfigs(configs.slice(0, 2), workers, [
        { path: "services/app", config: "wrangler.jsonc", reason: "x" },
        { path: "services/app", config: "wrangler.ops.jsonc", reason: " " },
        { path: "services/gone", config: "wrangler.jsonc", reason: "x" },
      ]),
    ).toEqual([
      "infra/workers-ci.json: the exclusion of services/app/wrangler.jsonc is stale or has no reason",
      "infra/workers-ci.json: the exclusion of services/app/wrangler.ops.jsonc is stale or has no reason",
      "infra/workers-ci.json: the exclusion of services/gone/wrangler.jsonc is stale or has no reason",
    ]);
  });
});

describe("this repository", () => {
  test("has no package scripts, no package-script callers, one ci: task per workspace and every wrangler config accounted for", () => {
    expect(check()).toEqual([]);
  });
});
