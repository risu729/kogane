// The merge hazard the dependency ledger's static notes used to be, and the
// guarantee that catches it if it comes back. Unified plan U15, chapter 07 §5.
//
// `MIGRATION_NOTE` is a ~100-line template literal. While it sat inside
// `dependency-ledger.ts`, two branches that each added it merged without a
// conflict marker and left two top-level declarations of the same name in one
// file. Nothing in this repository type-checks `scripts/`, so the only thing
// standing between that merge and `main` is the linter hk runs over every
// tracked TypeScript file.
//
// This suite pins both halves: the note has exactly one home, and a duplicate
// top-level `const` really is rejected.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { MIGRATION_NOTE } from "./dependency-ledger-notes.ts";
import { LEDGER_MARKDOWN_PATH, REPO_ROOT, renderDependencyMarkdown } from "./dependency-ledger.ts";

const NOTES_MODULE = "scripts/dependency-ledger-notes.ts";
const GENERATOR = "scripts/dependency-ledger.ts";

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("the ledger notes have exactly one home", () => {
  test("the notes module declares each constant once", () => {
    const text = source(NOTES_MODULE);
    // A merge that re-added the note would leave a second declaration in this
    // file. Counting the declarations is what the linter below would also
    // catch; asserting it here names the reason.
    expect([...text.matchAll(/^export const (\w+)/gmu)].map((match) => match[1])).toEqual([
      "MIGRATION_NOTE",
    ]);
  });

  test("the generator imports the notes and declares none of its own", () => {
    const text = source(GENERATOR);
    expect(text).toContain('import { MIGRATION_NOTE } from "./dependency-ledger-notes.ts";');
    expect(text).not.toMatch(/^(?:export )?const MIGRATION_NOTE\b/mu);
  });

  test("the committed ledger carries the note exactly once", () => {
    const markdown = source(LEDGER_MARKDOWN_PATH);
    const heading = MIGRATION_NOTE.split("\n", 1)[0] as string;
    expect(heading).toBe("## Post-workspace resolution (U03)");
    expect(markdown.split(heading).length - 1).toBe(1);
    expect(markdown).toContain(MIGRATION_NOTE.trimEnd());
  });

  test("the renderer is what puts it there, so a dropped note fails here too", () => {
    expect(renderDependencyMarkdown([]).split("\n")).toContain(
      "## Post-workspace resolution (U03)",
    );
  });
});

describe("a duplicate top-level declaration is rejected by the linter", () => {
  // `hk check --lint` runs oxlint over every tracked TypeScript file, so this
  // is the check a merge-produced duplicate would actually hit. oxc reports it
  // before any rule runs, which is why no `.oxlintrc.json` setting can turn it
  // off — but a test that never ran the linter would prove nothing, so the
  // clean fixture is asserted as well.
  const directory = mkdtempSync(join(tmpdir(), "kogane-redeclare-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function lint(name: string, code: string): { exitCode: number; output: string } {
    const file = join(directory, name);
    writeFileSync(file, code);
    const result = Bun.spawnSync(["oxlint", "--config", join(REPO_ROOT, ".oxlintrc.json"), file], {
      cwd: directory,
    });
    if (result.exitCode === null) {
      throw new Error("oxlint did not run; use `mise run root:test` so the pinned binary is found");
    }
    return {
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  }

  test("two top-level constants of the same name fail", () => {
    const duplicate = lint(
      "duplicate.ts",
      "export const NOTE = `a`;\nexport const OTHER = 1;\nexport const NOTE = `b`;\n",
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.output).toContain("NOTE");
  });

  test("the same file with one declaration passes, so the check is not vacuous", () => {
    expect(lint("single.ts", "export const NOTE = `a`;\nexport const OTHER = 1;\n").exitCode).toBe(
      0,
    );
  });
});
