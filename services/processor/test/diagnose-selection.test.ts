// The parser-version selection of the read-only diagnostics `diagnose.ts` and
// `diagnose-global-pass.ts` (scripts/diagnose-selection.ts). Only the pure
// helpers are imported: the scripts themselves open remote bindings on load
// and are read here as text, never run.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalPassActivity } from "../../../packages/parsers/src/parsers/global-pass-activity-parser.ts";
import { sbiYenDetailHistory } from "../../../packages/parsers/src/parsers/sbi-yen-detail-history.ts";
import {
  GLOBAL_PASS_ACTIVITY,
  globalPassFailedJobsSql,
  globalPassParserVersion,
  registeredParserVersion,
  remainingJobsPredicate,
  REMAINING_PARSERS,
} from "../scripts/diagnose-selection.ts";

const script = (name: string) =>
  readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

describe("diagnostic parser releases follow the registry", () => {
  test("each selected parser resolves to the release its module declares", () => {
    expect<readonly string[]>(REMAINING_PARSERS).toEqual([
      sbiYenDetailHistory.name,
      globalPassActivity.name,
    ]);
    expect(GLOBAL_PASS_ACTIVITY).toBe(globalPassActivity.name);
    expect(registeredParserVersion(sbiYenDetailHistory.name)).toBe(sbiYenDetailHistory.version);
    expect(registeredParserVersion(globalPassActivity.name)).toBe(globalPassActivity.version);
  });

  test("--remaining selects the registered release of each parser", () => {
    expect(remainingJobsPredicate()).toBe(
      `((parser_name='${sbiYenDetailHistory.name}' AND parser_version='${sbiYenDetailHistory.version}')` +
        ` OR (parser_name='${globalPassActivity.name}' AND parser_version='${globalPassActivity.version}'))`,
    );
  });

  test("diagnose-global-pass defaults to the registered release", () => {
    expect(globalPassParserVersion([])).toBe(globalPassActivity.version);
    expect(globalPassFailedJobsSql(globalPassParserVersion([]))).toContain(
      `j.parser_name='global-pass-activity' AND j.parser_version='${globalPassActivity.version}'`,
    );
  });

  test("an unregistered parser name is refused", () => {
    expect(() => registeredParserVersion("not-a-parser")).toThrow(
      "diagnostic parser is not registered exactly once",
    );
  });

  test("neither script states a parser release itself", () => {
    // Whatever the operator (`=`, `IN`, `LIKE`) or quoting (', ", `): the
    // scripts leave every parser_version predicate to the helper and carry no
    // version-shaped text at all.
    for (const name of ["diagnose.ts", "diagnose-global-pass.ts"]) {
      const source = script(name);
      expect(source).not.toMatch(/parser_version/u);
      expect(source).not.toMatch(/\d+\.\d+\.\d+/u);
    }
    expect(script("diagnose.ts")).toContain("${remainingJobsPredicate()}");
    expect(script("diagnose-global-pass.ts")).toContain("globalPassFailedJobsSql(parserVersion)");
  });
});

describe("diagnose-global-pass --parser-version", () => {
  test("names another release in either spelling", () => {
    expect(globalPassParserVersion(["--parser-version", "1.0.0"])).toBe("1.0.0");
    expect(globalPassParserVersion(["--parser-version=12.34.5678"])).toBe("12.34.5678");
  });

  test("a missing, repeated or malformed value is refused before any SQL", () => {
    for (const argv of [
      ["--parser-version"],
      ["--parser-version="],
      ["--parser-version", "1.0"],
      ["--parser-version", "1.0.0'"],
      ["--parser-version", "1.0.0 OR 1=1"],
      ["--parser-version", "12345.0.0"],
      ["--parser-version=v1.0.0"],
    ])
      expect(() => globalPassParserVersion(argv)).toThrow(
        "parser version must be MAJOR.MINOR.PATCH",
      );
    expect(() =>
      globalPassParserVersion(["--parser-version", "1.0.0", "--parser-version=1.2.1"]),
    ).toThrow("--parser-version may be given once");
    expect(() => globalPassFailedJobsSql("1.0.0'--")).toThrow(
      "parser version must be MAJOR.MINOR.PATCH",
    );
  });
});
