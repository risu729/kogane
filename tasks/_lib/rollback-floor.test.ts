import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { workflowSteps } from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";

const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");
const steps = workflowSteps(workflow);
const gate = steps.find(
  (step) => step.name === "Confirm the target meets the production compatibility floor",
);
const floor =
  /^          COMPATIBILITY_FLOOR_SHA: ([0-9a-f]{40})$/mu.exec(gate?.body ?? "")?.[1] ?? "";
const command = (gate?.body.split("        run: |\n")[1] ?? "")
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

// #207 includes both the #206 CORE/ingestion retirement and demo retirement.
const retirement = "87da571c7aa35dd76f9b00737a886ac41e6d3491";

describe("the trusted workflow enforces the production compatibility floor", () => {
  test("the floor is not supplied by an input or the target checkout", () => {
    expect(floor).toBe(retirement);
    expect(command).not.toBe("");
    expect(gate?.body).not.toContain("if:");
    expect(gate?.body).not.toContain("secrets.");
    expect(gate?.body).not.toContain("inputs.targets");
    expect(gate?.body).not.toContain("inputs.mode");
    expect(gate?.body).toContain("GH_TOKEN: ${{ github.token }}");
    expect(gate?.body).toContain("SHA: ${{ inputs.sha }}");
  });

  test("the check runs before target code, the ledger, credentials or an upload", () => {
    const names = steps.map((step) => step.name);
    const index = names.indexOf(gate?.name ?? "");
    expect(index).toBeGreaterThan(names.indexOf("Confirm the commit is on the release branch"));
    for (const name of [
      "Checkout the exact commit",
      "Install node",
      "Read the release ledger",
      "Confirm the production credentials reached this job",
      "Open the deployment record",
      "Deploy the Processor",
    ])
      expect(index).toBeLessThan(names.indexOf(name));
  });

  const cases = [
    {
      name: "pre-CORE-retirement target",
      sha: "bdee142d49f840f8c53603702d783d2421eda5e6",
      status: "behind",
      accepted: false,
    },
    {
      name: "#206 before demo retirement",
      sha: "49d5d65e511101923127e874dcb16129237bfd9d",
      status: "behind",
      accepted: false,
    },
    {
      name: "#207 floor itself with legacy scripts",
      sha: retirement,
      status: "identical",
      accepted: true,
    },
    {
      name: "compatible legacy script layout",
      sha: "294ab4e5184d225d66e8264949ae2a617d445a90",
      status: "ahead",
      accepted: true,
    },
    {
      name: "current mise layout",
      sha: "fbc0f59799673d3f6c528ccd528e12bca201ebdf",
      status: "ahead",
      accepted: true,
    },
    { name: "diverged history", sha: "d".repeat(40), status: "diverged", accepted: false },
    { name: "missing comparison result", sha: retirement, status: "", accepted: false },
    { name: "unexpected comparison result", sha: retirement, status: "unknown", accepted: false },
    {
      name: "API failure despite plausible output",
      sha: retirement,
      status: "ahead",
      apiExit: 7,
      accepted: false,
    },
  ];
  for (const mode of ["release", "rollback"]) {
    for (const scenario of cases) {
      test(`${mode}: ${scenario.name}`, () => {
        const root = mkdtempSync(join(tmpdir(), "kogane-rollback-floor-"));
        try {
          const bin = join(root, "bin");
          mkdirSync(bin);
          writeFileSync(
            join(bin, "gh"),
            [
              "#!/usr/bin/env bash",
              "set -euo pipefail",
              'printf \'%s\\n\' "$@" > "$API_ARGUMENTS"',
              "printf '%s\\n' \"$COMPARE_STATUS\"",
              'exit "$COMPARE_EXIT_CODE"',
              "",
            ].join("\n"),
            { mode: 0o755 },
          );
          const marker = join(root, "target-started");
          const result = Bun.spawnSync(
            ["bash", "-eo", "pipefail", "-c", `${command}\nprintf started > "$TARGET_STARTED"`],
            {
              cwd: root,
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                MODE: mode,
                TARGETS: "processor",
                SHA: scenario.sha,
                COMPATIBILITY_FLOOR_SHA: floor,
                GITHUB_REPOSITORY: "owner/repository",
                GITHUB_STEP_SUMMARY: join(root, "summary"),
                API_ARGUMENTS: join(root, "api-arguments"),
                COMPARE_STATUS: scenario.status,
                COMPARE_EXIT_CODE: String(scenario.apiExit ?? 0),
                TARGET_STARTED: marker,
              },
            },
          );
          expect(result.exitCode === 0).toBe(scenario.accepted);
          expect(readFileSync(join(root, "api-arguments"), "utf8").trim().split("\n")).toEqual([
            "api",
            `repos/owner/repository/compare/${retirement}...${scenario.sha}`,
            "--jq",
            ".status",
          ]);
          expect(Bun.file(marker).size > 0).toBe(scenario.accepted);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
