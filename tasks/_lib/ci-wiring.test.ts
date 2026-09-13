import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { workflowSteps } from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";

const ci = readFileSync(`${REPO_ROOT}/.github/workflows/ci.yml`, "utf8");

describe("the required CI status fails closed", () => {
  const gate = workflowSteps(ci).find(
    (step) => step.name === "Require every check to have succeeded",
  );
  const command = /^        run: (.+)$/mu.exec(gate?.body ?? "")?.[1] ?? "";

  test("the gate always waits on the complete hk check", () => {
    expect(ci).toContain("run: mise exec -- hk check --all --no-fail-fast");
    expect(ci).toContain("name: CI Check\n    needs:\n      - checks\n    if: ${{ always() }}");
    expect(gate?.body).toContain("CHECKS_RESULT: ${{ needs.checks.result }}");
    expect(command).not.toBe("");
  });

  for (const status of ["success", "failure", "cancelled", "skipped", ""]) {
    test(`the actual gate command handles ${status || "an absent result"}`, () => {
      const result = Bun.spawnSync(["bash", "-c", command], {
        env: { ...process.env, CHECKS_RESULT: status },
      });
      expect(result.exitCode === 0).toBe(status === "success");
    });
  }
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
