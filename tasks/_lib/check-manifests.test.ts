// Acceptance G4-01 (a scripts field, even an empty one, is rejected),
// G4-02 (a task, workflow, Dockerfile or document that still calls a package
// script is detected) and G4-09 (a new workspace cannot miss the CI matrix).
import { describe, expect, test } from "bun:test";
import {
  check,
  aggregateCheckViolations,
  ciTaskMismatches,
  dryRunTargets,
  generatedInputViolations,
  ledgerMismatches,
  manifestViolations,
  scriptInvocations,
  toolDownloads,
  trackedGeneratedFiles,
  unaccountedConfigs,
  uncoveredWorkspaces,
  workspaceDirectories,
  workspaceTaskPrefixes,
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
    expect(scriptInvocations("mise run //services/app:ci", "README.md")).toEqual([]);
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

describe("native workspace CI coverage", () => {
  const directories = ["packages/domain", "experiments/thing"];
  const tasks = [
    { name: "//packages/domain:test", dir: "/repo/packages/domain", run: ["bun test"] },
    {
      name: "//packages/domain:ci",
      depends: ["//packages/domain:test"],
      dir: "/repo/packages/domain",
    },
    { name: "//:ci:root", depends: ["root:test"], dir: "/repo" },
  ];

  test("only manifest directories selected by workspace globs are workspaces", () => {
    expect(
      workspaceDirectories(
        ["packages/*", "experiments/*"],
        [
          "package.json",
          "packages/domain/package.json",
          "experiments/thing/package.json",
          "experiments/thing/container/package.json",
          "node_modules/x/package.json",
        ],
      ),
    ).toEqual([...directories].sort());
  });

  test("native CI must reach an executable check in its own workspace", () => {
    expect(uncoveredWorkspaces(directories, tasks, "/repo")).toEqual(["experiments/thing"]);
    expect(ciTaskMismatches(directories, tasks, "/repo")).toEqual([]);
  });

  test("empty tasks and flat compatibility aliases cannot provide coverage", () => {
    expect(
      uncoveredWorkspaces(
        ["experiments/thing"],
        [
          { name: "//experiments/thing:ci", dir: "/repo/experiments/thing" },
          { name: "ci:thing", depends: ["thing:test"] },
          { name: "thing:test", dir: "/repo/experiments/thing", run: ["bun test"] },
        ],
        "/repo",
      ),
    ).toEqual(["experiments/thing"]);
  });

  test("a native CI task cannot claim an absent workspace or depend on nothing", () => {
    expect(ciTaskMismatches(directories, [{ name: "//packages/ghost:ci" }], "/repo")).toEqual([
      "//packages/ghost:ci: no matching package workspace",
      "//packages/ghost:ci: depends on nothing; a workspace ci task must run checks",
    ]);
  });

  test("a task family cannot run in another workspace", () => {
    expect(
      ciTaskMismatches(
        directories,
        [
          ...tasks,
          { name: "//packages/domain:build", dir: "/repo/experiments/thing", run: ["bun build"] },
        ],
        "/repo",
      ),
    ).toEqual(["//packages/domain:build: runs outside its named workspace packages/domain"]);
  });

  test("the hk aggregate expands native globs and includes post dependencies", () => {
    const all = [
      ...tasks,
      { name: "//experiments/thing:ci", depends: ["//experiments/thing:typecheck"] },
      { name: "//experiments/thing:dry-run", run: ["wrangler deploy --dry-run"] },
      {
        name: "//:checks",
        depends: ["ci:root", "//packages/...:ci", "//experiments/...:ci"],
        depends_post: ["dry-run"],
      },
      { name: "//:dry-run", depends: ["//experiments/...:dry-run"] },
    ];
    expect(aggregateCheckViolations(directories, all)).toEqual([]);
    expect(
      aggregateCheckViolations(
        directories,
        all.filter((task) => task.name !== "//:dry-run"),
      ),
    ).toEqual(["//:checks: does not reach //experiments/thing:dry-run"]);
  });

  test("the hk aggregate cannot omit a workspace or call hk recursively", () => {
    expect(
      aggregateCheckViolations(
        ["packages/domain"],
        [
          { name: "//:checks", depends: ["ci:root", "check"] },
          { name: "//:ci:root" },
          { name: "//:check", run: ["hk check --all"] },
          tasks[0]!,
          tasks[1]!,
        ],
      ),
    ).toEqual([
      "//:checks: does not reach //packages/domain:ci",
      "//:checks: must not call //:check; hk would recurse",
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

describe("generated files a workspace imports (unified plan U15)", () => {
  const directories = ["experiments/local", "services/app"];
  const generated = [
    { path: "services/app/demo-snapshot.json", producedBy: "//experiments/local:export-demo" },
  ];
  const sources = [
    {
      file: "services/app/test/snapshot-worker.ts",
      imports: ["services/app/demo-snapshot.json", "packages/domain/src/money.ts"],
    },
  ];
  const producer = { name: "//experiments/local:export-demo", dir: "/repo/experiments/local" };
  const family = [
    { name: "//services/app:types", dir: "/repo/services/app" },
    {
      name: "//services/app:ci",
      depends: ["//services/app:typecheck", "//services/app:test"],
      dir: null,
    },
    { name: "//experiments/local:ci", depends: ["//experiments/local:export-demo"], dir: null },
  ];

  test("a workspace prefix comes from its native ci task", () => {
    expect([
      ...workspaceTaskPrefixes(directories, [
        ...family,
        producer,
        { name: "//services/app:test", dir: "/repo/services/app" },
      ]),
    ]).toEqual([
      ["experiments/local", "//experiments/local"],
      ["services/app", "//services/app"],
    ]);
  });

  test("the three checks that read the file must declare the task that writes it", () => {
    const tasks = [
      ...family,
      producer,
      {
        name: "//services/app:typecheck",
        depends: ["//services/app:types"],
        dir: "/repo/services/app",
      },
      { name: "//services/app:test", depends: ["//services/app:types"], dir: "/repo/services/app" },
      {
        name: "//services/app:dry-run",
        depends: ["//services/app:types"],
        dir: "/repo/services/app",
      },
    ];
    expect(generatedInputViolations(generated, sources, directories, tasks)).toEqual([
      '//services/app:typecheck: services/app imports the generated services/app/demo-snapshot.json; add "//experiments/local:export-demo", which writes it, to this task\'s depends',
      '//services/app:test: services/app imports the generated services/app/demo-snapshot.json; add "//experiments/local:export-demo", which writes it, to this task\'s depends',
      '//services/app:dry-run: services/app imports the generated services/app/demo-snapshot.json; add "//experiments/local:export-demo", which writes it, to this task\'s depends',
    ]);
  });

  test("an indirect dependency counts, and a task that does not exist is not demanded", () => {
    // `//services/app:test` reaches the export through `//services/app:build`; there is no
    // `//services/app:dry-run` at all, and a package without one must not fail here.
    const tasks = [
      ...family,
      producer,
      {
        name: "//services/app:typecheck",
        depends: ["//services/app:types", "//experiments/local:export-demo"],
        dir: "/repo/services/app",
      },
      {
        name: "//services/app:build",
        depends: ["//experiments/local:export-demo"],
        dir: "/repo/services/app",
      },
      { name: "//services/app:test", depends: ["//services/app:build"], dir: "/repo/services/app" },
    ];
    expect(generatedInputViolations(generated, sources, directories, tasks)).toEqual([]);
  });

  test("a workspace that does not import the file is not asked to depend on it", () => {
    const tasks = [
      ...family,
      producer,
      { name: "//services/app:typecheck", dir: "/repo/services/app" },
      { name: "//services/app:test", dir: "/repo/services/app" },
    ];
    const unrelated = [
      { file: "services/app/src/routes.ts", imports: ["packages/application/src/index.ts"] },
    ];
    expect(generatedInputViolations(generated, unrelated, directories, tasks)).toEqual([]);
  });

  test("an extension-less specifier for a generated module still counts", () => {
    const tasks = [...family, producer, { name: "//services/app:test", dir: "/repo/services/app" }];
    const module = [{ file: "services/app/src/a.ts", imports: ["services/app/generated"] }];
    expect(
      generatedInputViolations(
        [{ path: "services/app/generated.ts", producedBy: "//experiments/local:export-demo" }],
        module,
        directories,
        tasks,
      ),
    ).toEqual([
      '//services/app:test: services/app imports the generated services/app/generated.ts; add "//experiments/local:export-demo", which writes it, to this task\'s depends',
    ]);
  });

  test("a producing task that does not exist is reported once", () => {
    expect(generatedInputViolations(generated, sources, directories, family)).toEqual([
      'infra/generated-files.json: services/app/demo-snapshot.json names the producing task "//experiments/local:export-demo", which does not exist',
    ]);
  });

  test("a declared file that git tracks is a stale declaration", () => {
    expect(trackedGeneratedFiles(generated, ["README.md"])).toEqual([]);
    expect(trackedGeneratedFiles(generated, ["services/app/demo-snapshot.json"])).toHaveLength(1);
  });
});

describe("this repository", () => {
  test("has no package scripts, no package-script callers, one native ci task per workspace and every wrangler config accounted for", () => {
    expect(check()).toEqual([]);
  });
});
