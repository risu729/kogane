import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./repo-root.ts";

const release = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");

describe("release task migration preserves old rollback commits", () => {
  // Execute the adapters extracted from the workflow, with fake interpreters.
  // A rollback target may legitimately contain only the old script layout.
  const adapters = [
    ...release.matchAll(
      /release_tool=\(node \.github\/scripts\/(release-[a-z]+)\.mjs\)\n\s+if \[\[ -f tasks\/automation\/\1 \]\]; then\n\s+release_tool=\(mise run --no-deps automation:\1\)\n\s+fi\n\s+"\$\{release_tool\[@\]\}"/gu,
    ),
  ];

  test("all release entrypoints have a layout adapter", () => {
    expect(new Set(adapters.map((match) => match[1]))).toEqual(
      new Set(["release-ledger", "release-manifest", "release-sha"]),
    );
    expect(release).not.toMatch(/^\s+(?:run: )?mise run --no-deps automation:release-/mu);
  });

  for (const modern of [false, true]) {
    test(`the ${modern ? "mise" : "legacy"} layout forwards arguments and never masks failure`, () => {
      const root = mkdtempSync(join(tmpdir(), "kogane-release-adapter-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        for (const tool of ["node", "mise"]) {
          writeFileSync(
            join(bin, tool),
            `#!/usr/bin/env bash\nprintf '%s\n' ${tool} "$@"\nexit "${"${ADAPTER_EXIT_CODE:-0}"}"\n`,
            { mode: 0o755 },
          );
        }
        if (modern) {
          mkdirSync(join(root, "tasks/automation"), { recursive: true });
          for (const task of ["release-ledger", "release-manifest", "release-sha"])
            writeFileSync(join(root, "tasks/automation", task), "");
        }
        for (const match of adapters) {
          const task = match[1];
          for (const code of [0, 23]) {
            const result = Bun.spawnSync(
              ["bash", "-c", `${match[0]} first 'argument with spaces'`],
              {
                cwd: root,
                env: {
                  ...process.env,
                  PATH: `${bin}:${process.env.PATH ?? ""}`,
                  ADAPTER_EXIT_CODE: String(code),
                },
              },
            );
            expect(result.exitCode).toBe(code);
            expect(result.stdout.toString().trim().split("\n")).toEqual([
              ...(modern
                ? ["mise", "run", "--no-deps", `automation:${task}`]
                : ["node", `.github/scripts/${task}.mjs`]),
              "first",
              "argument with spaces",
            ]);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("automation tasks cannot join legacy ci:* task discovery", () => {
  const result = Bun.spawnSync(["mise", "tasks", "ls", "--json"], { cwd: REPO_ROOT });
  expect(result.exitCode).toBe(0);
  const tasks = JSON.parse(result.stdout.toString()) as { name: string }[];
  const names = tasks.map((task) => task.name.replace(/^\/\/:/u, ""));
  for (const name of ["automerge", "release-ledger", "release-manifest", "release-sha"]) {
    expect(names).toContain(`automation:${name}`);
    expect(names).not.toContain(`ci:${name}`);
  }
});
