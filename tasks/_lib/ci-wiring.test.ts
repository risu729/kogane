import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { workflowSteps } from "./deploy-order.ts";
import type { TaskRecord } from "./check-manifests.ts";
import { REPO_ROOT } from "./repo-root.ts";

const ci = readFileSync(`${REPO_ROOT}/.github/workflows/ci.yml`, "utf8");

describe("the required CI status fails closed", () => {
  const gate = workflowSteps(ci).find(
    (step) => step.name === "Require every check to have succeeded",
  );
  const command = /^        run: (.+)$/mu.exec(gate?.body ?? "")?.[1] ?? "";

  test("the gate always waits on the complete hk check", () => {
    expect(ci).toContain("mise exec -- hk check --all --skip-step repository --no-fail-fast");
    expect(ci).toContain("mise run --continue-on-error ci:remainder");
    expect(ci).toContain("fail-fast: false");
    expect(ci).toContain("shard: [1, 2]");
    expect(ci).toContain(
      "name: CI Check\n    needs:\n      - checks\n      - processor\n    if: ${{ always() }}",
    );
    expect(gate?.body).toContain("CHECKS_RESULT: ${{ needs.checks.result }}");
    expect(gate?.body).toContain("PROCESSOR_RESULT: ${{ needs.processor.result }}");
    expect(command).not.toBe("");
  });

  for (const status of ["success", "failure", "cancelled", "skipped", ""]) {
    test(`the actual gate command handles ${status || "an absent result"}`, () => {
      const result = Bun.spawnSync(["bash", "-c", command], {
        env: { ...process.env, CHECKS_RESULT: status, PROCESSOR_RESULT: "success" },
      });
      expect(result.exitCode === 0).toBe(status === "success");
    });
  }
  for (const status of ["failure", "cancelled", "skipped", ""]) {
    test(`a processor shard result of ${status || "absent"} fails the gate`, () => {
      const result = Bun.spawnSync(["bash", "-c", command], {
        env: { ...process.env, CHECKS_RESULT: "success", PROCESSOR_RESULT: status },
      });
      expect(result.exitCode).not.toBe(0);
    });
  }
});

test("the processor matrix dispatches both distinct native shard tasks", () => {
  const processor = ci.split("\n  processor:\n")[1]?.split(/\n  [\w-]+:\n/u)[0] ?? "";
  expect(processor).toContain(
    "    strategy:\n      fail-fast: false\n      matrix:\n        shard: [1, 2]\n    steps:",
  );
  expect(processor.split("    steps:")[0]).not.toMatch(
    /^\s*(?:include|exclude|if|continue-on-error):/mu,
  );
  const postSteps = ["Validate and summarize native coverage", "Upload native coverage"];
  for (const candidate of workflowSteps(processor)) {
    if (postSteps.includes(candidate.name)) {
      expect(candidate.body).toContain("if: ${{ always() }}");
      expect(candidate.body).not.toMatch(/^\s*continue-on-error:/mu);
    } else {
      expect(candidate.body).not.toMatch(/^\s*(?:if|continue-on-error):/mu);
    }
  }
  expect(
    workflowSteps(processor).filter((candidate) => postSteps.includes(candidate.name)),
  ).toHaveLength(2);
  const step = workflowSteps(processor).find(
    (candidate) => candidate.name === "Run the complete native processor shard",
  );
  expect(step).toBeDefined();
  const command = /^        run: (.+)$/mu.exec(step?.body ?? "")?.[1];
  expect(command).toBe('mise run --continue-on-error "//services/processor:test-shard-${SHARD}"');
  expect(step?.body).toContain("SHARD: ${{ matrix.shard }}");
});

test("hk's full plan preserves linters alongside the repository graph", () => {
  const result = Bun.spawnSync(["hk", "check", "--all", "--plan", "--json"], { cwd: REPO_ROOT });
  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout.toString()) as {
    steps: { name: string; status: string }[];
  };
  const included = plan.steps.filter((step) => step.status === "included").map((step) => step.name);
  for (const name of ["oxlint", "oxfmt", "actionlint", "repository"])
    expect(included).toContain(name);
});

test("hk still schedules repository checks with an empty Git change selection", () => {
  const result = Bun.spawnSync(
    ["hk", "check", "--from-ref", "HEAD", "--to-ref", "HEAD", "--plan", "--json"],
    { cwd: REPO_ROOT },
  );
  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout.toString()) as {
    steps: { name: string; status: string }[];
  };
  expect(plan.steps.find((step) => step.name === "repository")?.status).toBe("included");
});

test("the complete native plan schedules shared type and client preparation once", () => {
  const listed = Bun.spawnSync(["mise", "tasks", "ls", "--all", "--json", "--hidden"], {
    cwd: REPO_ROOT,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(listed.exitedDueToTimeout).not.toBe(true);
  expect(listed.exitCode).toBe(0);
  const tasks = (JSON.parse(listed.stdout.toString()) as TaskRecord[]).filter((task) =>
    task.source?.startsWith(`${REPO_ROOT}/`),
  );
  const workers = JSON.parse(readFileSync(`${REPO_ROOT}/infra/workers-ci.json`, "utf8")) as {
    workers: { path: string; config: string }[];
  };
  const containerTasks = [
    ...new Set(
      workers.workers
        .filter((worker) =>
          /"containers"\s*:/u.test(
            readFileSync(`${REPO_ROOT}/${worker.path}/${worker.config}`, "utf8"),
          ),
        )
        .map((worker) => `//${worker.path}:dry-run`),
    ),
  ];
  expect(containerTasks.length).toBeGreaterThan(0);
  for (const name of containerTasks)
    expect(tasks.find((task) => task.name === name)?.wait_for).toContain("//:ci:workspaces");
  const plan = Bun.spawnSync(["mise", "run", "--dry-run", "--jobs", "1", "checks"], {
    cwd: REPO_ROOT,
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_COLOR: "1", MISE_TASK_SHOW_FULL_CMD: "true" },
  });
  expect(plan.exitedDueToTimeout).not.toBe(true);
  expect(plan.exitCode).toBe(0);
  const output = plan.stdout.toString() + plan.stderr.toString();
  // The real selected plan must put every Docker invocation after workspace
  // commands, including children of the workspace aggregate. A barrier on the
  // dry-run parent alone would leave its children free to start early.
  const commands = output.split("\n").filter((line) => line.includes("] $ "));
  const tail = commands.slice(-containerTasks.length);
  for (const name of containerTasks)
    expect(
      tail.some((line) => {
        // mise may abbreviate long task labels even when commands are complete.
        const prefix = line.slice(1, line.indexOf("]")).replace(/…$/u, "");
        return name.startsWith(prefix) && line.includes("$ ./node_modules/.bin/wrangler deploy");
      }),
    ).toBe(true);
  // Two synchronous mise subprocesses can exceed Bun's default five seconds
  // under the full verification load. Bound each process and this guard only;
  // retain the existing runtime tests' deadlines.
  // Inspect mise's actual execution plan. A separate post graph used to launch
  // every shared types task twice and the production client build twice.
  for (const command of ["./node_modules/.bin/wrangler types", "./node_modules/.bin/vite build"]) {
    const expected = tasks
      .flatMap((task) => task.run ?? [])
      .filter((run) => run.startsWith(command)).length;
    expect(expected).toBeGreaterThan(0);
    expect(output.split(`$ ${command}`).length - 1).toBe(expected);
  }
}, 30_000);

test("native wait_for orders selected aggregate children without selecting them standalone", () => {
  const directory = mkdtempSync(join(tmpdir(), "kogane-ci-order-"));
  try {
    writeFileSync(
      join(directory, "mise.toml"),
      `
[tasks.types]
run = "printf 'types\\n' >> order"
[tasks.test]
depends = ["types"]
run = "sleep 0.1; printf 'test-finished\\n' >> order"
[tasks."ci:workspaces"]
depends = ["test"]
[tasks."dry-run"]
depends = ["types"]
wait_for = ["ci:workspaces"]
run = "printf 'docker\\n' >> order"
[tasks.checks]
depends = ["ci:workspaces", "dry-run"]
`,
    );
    for (const [task, expected] of [
      ["checks", ["types", "test-finished", "docker"]],
      ["dry-run", ["types", "docker"]],
    ] as const) {
      writeFileSync(join(directory, "order"), "");
      const result = Bun.spawnSync(["mise", "run", "--jobs", "2", task], {
        cwd: directory,
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: directory },
      });
      expect(result.exitedDueToTimeout).not.toBe(true);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(directory, "order"), "utf8").trim().split("\n")).toEqual(expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the native standalone dry-run plan does not select workspace checks", () => {
  const result = Bun.spawnSync(["mise", "run", "--dry-run", "dry-run"], {
    cwd: REPO_ROOT,
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_COLOR: "1", MISE_TASK_SHOW_FULL_CMD: "true" },
  });
  expect(result.exitedDueToTimeout).not.toBe(true);
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString() + result.stderr.toString();
  expect(output).toContain("$ ./node_modules/.bin/wrangler deploy --dry-run");
  for (const command of ["$ bun test", "vitest run", "node --test", "tsc --noEmit", "knip"])
    expect(output).not.toContain(command);
}, 15_000);
