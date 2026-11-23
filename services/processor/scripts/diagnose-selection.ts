// Parser-version selection for the read-only diagnostics `diagnose.ts` and
// `diagnose-global-pass.ts`. Pure: no bindings, no I/O, so the selection is
// unit-tested without wrangler (test/diagnose-selection.test.ts).
//
// Both scripts look at the failed parse jobs of one parser release. That
// release is the one the parser registry of the checkout declares, so a
// parser version bump moves the scripts with it instead of leaving them on a
// release whose jobs the processor no longer runs. `diagnose-global-pass.ts`
// also takes `--parser-version MAJOR.MINOR.PATCH` to look at another release
// (for example the deployed one while a newer release is not yet deployed).
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";

/** A parser release as `parse_runs` and `observation_parse_jobs` store it. */
export const PARSER_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;

/** The parsers `diagnose.ts --remaining` and `--remaining-all` select. */
export const REMAINING_PARSERS = ["sbi-yen-detail-history", "global-pass-activity"] as const;

/** The parser `diagnose-global-pass.ts` replays. */
export const GLOBAL_PASS_ACTIVITY = "global-pass-activity";

/**
 * The version the registry declares for `name`. Throws unless exactly one
 * registered parser has that name and its version is MAJOR.MINOR.PATCH, so a
 * version never reaches SQL unchecked.
 */
export function registeredParserVersion(name: string): string {
  const matches = PARSERS.filter((parser) => parser.name === name);
  if (matches.length !== 1) throw new Error("diagnostic parser is not registered exactly once");
  const { version } = matches[0]!;
  if (!PARSER_VERSION.test(version))
    throw new Error("registered parser version must be MAJOR.MINOR.PATCH");
  return version;
}

/**
 * The `observation_parse_jobs` predicate of `diagnose.ts --remaining`: jobs of
 * the `REMAINING_PARSERS` at the release the registry declares for each.
 */
export function remainingJobsPredicate(): string {
  return `(${REMAINING_PARSERS.map(
    (name) => `(parser_name='${name}' AND parser_version='${registeredParserVersion(name)}')`,
  ).join(" OR ")})`;
}

/**
 * The release `diagnose-global-pass.ts` selects: the value of
 * `--parser-version` (`--parser-version X.Y.Z` or `--parser-version=X.Y.Z`)
 * when given, else the registry's `global-pass-activity` release. A missing,
 * repeated or malformed value is refused before any SQL is built.
 */
export function globalPassParserVersion(argv: readonly string[]): string {
  const values: (string | undefined)[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--parser-version") values.push(argv[index + 1]);
    else if (arg.startsWith("--parser-version="))
      values.push(arg.slice("--parser-version=".length));
  });
  if (values.length === 0) return registeredParserVersion(GLOBAL_PASS_ACTIVITY);
  if (values.length > 1) throw new Error("--parser-version may be given once");
  const [version] = values;
  if (version === undefined || !PARSER_VERSION.test(version))
    throw new Error("parser version must be MAJOR.MINOR.PATCH");
  return version;
}

/**
 * The read-only selection of `diagnose-global-pass.ts`: stored artifacts with
 * a failed `global-pass-activity` job at `version`, and what the script needs
 * to read and verify each raw object.
 */
export function globalPassFailedJobsSql(version: string): string {
  if (!PARSER_VERSION.test(version)) throw new Error("parser version must be MAJOR.MINOR.PATCH");
  return `SELECT a.*,o.blob_key,o.byte_size FROM observation_fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256
 JOIN observation_parse_jobs j ON j.fetch_artifact_id=a.id WHERE j.parser_name='${GLOBAL_PASS_ACTIVITY}' AND j.parser_version='${version}' AND j.last_error_code IS NOT NULL ORDER BY a.id`;
}
