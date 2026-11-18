import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { workflowSteps } from "./deploy-order.ts";
import { REPO_ROOT } from "./repo-root.ts";

const workflow = await Bun.file(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`).text();
const steps = workflowSteps(workflow);
const names = steps.map((step) => step.name);
const gate = steps.find((step) => step.name === "Confirm the target writes cf Build Output v1");
const command = (gate?.body.split("        run: |\n")[1] ?? "")
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

describe("the trusted workflow rejects targets that write cf Build Output v0", () => {
  test("the check runs before target code, the adapter, credentials or an upload", () => {
    expect(command).not.toBe("");
    expect(gate?.body).not.toContain("if:");
    expect(gate?.body).not.toContain("secrets.");
    const index = names.indexOf(gate!.name);
    for (const name of [
      "Load the trusted Container compatibility adapter",
      "Checkout the exact commit",
      "Read the release ledger",
      "Confirm the production credentials reached this job",
      "Open the deployment record",
      "Deploy the Processor",
    ])
      expect(index).toBeLessThan(names.indexOf(name));
  });

  const cases = [
    {
      name: "cf release candidate",
      manifest: { devDependencies: { cf: "1.0.0-rc.0" } },
      accepted: true,
    },
    { name: "stable cf", manifest: { devDependencies: { cf: "1.2.0" } }, accepted: true },
    {
      name: "Wrangler-only target",
      manifest: { devDependencies: { wrangler: "4.100.0" } },
      accepted: true,
    },
    { name: "cf beta", manifest: { devDependencies: { cf: "1.0.0-beta.32" } }, accepted: false },
    {
      name: "cf beta as a dependency",
      manifest: { dependencies: { cf: "1.0.0-beta.12" } },
      accepted: false,
    },
    { name: "unreadable manifest", manifest: "not json", accepted: false },
    {
      name: "API failure",
      manifest: { devDependencies: { cf: "1.0.0-rc.0" } },
      apiExit: 7,
      accepted: false,
    },
  ];
  for (const scenario of cases) {
    test(scenario.name, () => {
      const root = mkdtempSync(join(tmpdir(), "kogane-build-output-floor-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        const body =
          typeof scenario.manifest === "string"
            ? scenario.manifest
            : JSON.stringify(scenario.manifest);
        writeFileSync(
          join(bin, "gh"),
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            `printf '%s\\n' '${Buffer.from(body).toString("base64")}'`,
            'exit "$API_EXIT_CODE"',
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const marker = join(root, "target-started");
        const result = Bun.spawnSync(
          ["bash", "-e", "-c", `${command}\nprintf started > "$TARGET_STARTED"`],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              SHA: "a".repeat(40),
              GITHUB_REPOSITORY: "owner/repository",
              API_EXIT_CODE: String(scenario.apiExit ?? 0),
              TARGET_STARTED: marker,
            },
          },
        );
        expect(result.exitCode === 0).toBe(scenario.accepted);
        expect(Bun.file(marker).size > 0).toBe(scenario.accepted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
