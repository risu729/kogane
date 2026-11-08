// Logs and stored operational records carry counts and closed codes only,
// never provider text or amounts (AGENTS.md, docs/processor.md §6.1,
// docs/observation-lanes.md, packages/collector-diagnostics). The sanitizers
// that enforce it (`safeErrorDetails`, each collector's closed failure codes)
// only help where a log line goes through them; this guard keeps the raw
// material out of the log calls themselves, across every deployed source of
// the services (`src/`, `container/`) and of the packages they bundle:
//
//   * no log call's arguments read an exception's `.message` or `.stack`,
//     stringify it (`String(error)`, `JSON.stringify(error)`, `${error}`,
//     `error.toString()`) or pass the error object itself — a closed code or
//     `safeErrorDetails(error)` goes there instead, and a local wrapper that
//     takes the error and reduces it is listed below;
//   * no source reads `.stack` at all;
//   * every `.message` a source reads is listed below with the reason it is
//     safe (a classifier that matches the text against closed codes and
//     emits only the code, a field that already holds a closed code). A new
//     read fails here until someone has looked at where its value goes.
//
// The scan is textual, like `tasks/_lib/import-boundaries.ts`: comments are
// dropped and a call's arguments are its balanced parentheses. It does not
// see an exception that escapes a Worker handler, which the runtime records
// with its message: what a thrown message may hold is each source's own
// concern (its closed codes and `safeErrorDetails`), not this guard's.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../scripts/config-bootstrap.ts";

const ROOTS = [
  ...readdirSync(join(REPO_ROOT, "services")).flatMap((service) =>
    ["src", "container"].map((dir) => join("services", service, dir)),
  ),
  // Every package: the Workers bundle them (`packages/application` and
  // `packages/read-model` into the app and processor, `packages/collection`
  // into the collectors), so their sources are deployed sources too.
  ...readdirSync(join(REPO_ROOT, "packages")).map((pkg) => join("packages", pkg, "src")),
];
const SOURCE = /\.(?:ts|mjs)$/u;
const NOT_SOURCE = /(?:\.d\.ts|\.test\.ts|\.test\.mjs|\.node-test\.mjs)$/u;

/**
 * Every `.message` read in the scanned sources, by file, with how many reads
 * the file has and why each is safe. Adding a read means adding (or raising)
 * its entry here, with the reason.
 */
const MESSAGE_READS: Readonly<Record<string, { count: number; reason: string }>> = {
  "packages/application/src/collection/seal-refusal.ts": {
    count: 3,
    reason: "a D1 trigger refusal's RAISE code is kept only when it is a code-shaped token",
  },
  "packages/application/src/command/commit.ts": {
    count: 1,
    reason: "economicGuardCode finds one of the closed guard codes in it; the text is dropped",
  },
  "packages/application/src/ingest/objects.ts": {
    count: 1,
    reason: "tested for a checksum refusal; only the closed object_checksum_mismatch is thrown",
  },
  "packages/application/src/query/reconstructed-state-read.ts": {
    count: 2,
    reason: "a ReconstructedStateRefusedError's message is its own closed *_exceeded code",
  },
  "packages/collection/src/manifest.ts": {
    count: 1,
    reason: "a CollectionKeyError's message is its closed key-refusal code",
  },
  "packages/collection/src/schedule-result.ts": {
    count: 1,
    reason:
      "compared with the lease refusal constant and the closed lease stop codes; only a " +
      "closed code is returned",
  },
  "packages/collection/src/writer.ts": {
    count: 1,
    reason: "tested for a checksum refusal; only a closed object_* code is returned",
  },
  "packages/collector-diagnostics/src/index.ts": {
    count: 1,
    reason: "safeErrorDetails matches known shapes and emits only closed codes and statuses",
  },
  "packages/domain/src/coverage.ts": {
    count: 1,
    reason: "a validator checks a parse issue's `message` field shape; no exception is read",
  },
  "packages/domain/src/result.ts": {
    count: 1,
    reason: "a validator checks a financial error's `message` field shape; no exception is read",
  },
  "packages/parsers/src/parsers/coverage.ts": {
    count: 2,
    reason: "a parse issue's own `message` field, which the parser wrote; no exception is read",
  },
  "packages/parsers/src/parsers/sbi-domestic-cash-positions.ts": {
    count: 1,
    reason: "the string `trailing.message` names a record field for the reader; not a read",
  },
  "services/collector-globalpass/container/server.mjs": {
    count: 1,
    reason: "a page error is reduced to a category and numeric challenge codes",
  },
  "services/collector-moneyforward/src/shared-collection.ts": {
    count: 1,
    reason: "a failure's message field, which the collector already sets to its failure code",
  },
  "services/collector-sbi-shinsei/src/diagnostics.ts": {
    count: 1,
    reason: "matched against exact runtime phrases; only the mapped closed reason is kept",
  },
  "services/collector-sbi-shinsei/src/local/cli.ts": {
    count: 1,
    reason:
      "local operator CLI on the operator's own terminal: the collector's own literal messages, " +
      "credential-shaped values redacted and bounded; nothing from the provider is thrown with text",
  },
  "services/collector-sbi-vc-trade/src/worker.ts": {
    count: 2,
    reason: "classifyError keeps a message only when it is already a code-shaped token",
  },
  "services/collector-smbc-direct/src/session.ts": {
    count: 2,
    reason: "classifyError and safeSharedErrorCode keep only allowlisted or code-shaped tokens",
  },
  "services/collector-smbc-direct/src/ui.ts": {
    count: 1,
    reason: "the operator page shows its own request's closed error code in the browser",
  },
  "services/collector-smbc-direct/src/worker.ts": {
    count: 1,
    reason: "classifyError keeps a message only when it is already a code-shaped token",
  },
  "services/collector-st-george/container/browser.mjs": {
    count: 2,
    reason: "a CollectionError's message is one of its closed FAILURE_CODES",
  },
  "services/collector-st-george/src/result.ts": {
    count: 1,
    reason:
      "compared with the two lease stop codes, otherwise passed to safeFailureCode, which " +
      "admits only the closed failure codes",
  },
  "services/collector-st-george/src/worker-policy.ts": {
    count: 1,
    reason: "compared with the lease refusal code only; the message is never logged or returned",
  },
  "services/collector-vpoint-pay/src/state.ts": {
    count: 1,
    reason:
      "the redacted failure message of a run the disabled app path can no longer start; " +
      "the terminal and the log line carry closed codes only",
  },
  "services/processor/src/invocation-probe.ts": {
    count: 1,
    reason: "tested against the platform-limit phrase; only a boolean is kept",
  },
  "services/processor/src/metadata-extractors/index.ts": {
    count: 1,
    reason: "a MetadataError's message is its closed code",
  },
  "services/processor/src/worker.ts": {
    count: 8,
    reason:
      "PipelineError, MetadataError and ReleaseCommandError messages are closed codes; the " +
      "publication repair keeps only publication_* codes; parse_issues.message is a SQL path",
  },
};

/**
 * Log calls that pass the error object itself to a local wrapper which reduces
 * it to a closed field before anything is emitted, by file, with how many such
 * calls the file has and where the reduction happens. Only the "logs the error
 * object" rule is waived for them; reading `.message` or interpolating the
 * error in the same call still fails.
 */
const ERROR_TO_SANITIZING_WRAPPER: Readonly<Record<string, { count: number; reason: string }>> = {
  "services/collector-sbi-shinsei/src/tcp-relay.ts": {
    count: 2,
    reason: "the relay's local `log` keeps only `errorType: safeErrorType(error)`",
  },
  "services/collector-st-george/src/tcp-relay.ts": {
    count: 2,
    reason: "the relay's local `log` keeps only `errorType: safeErrorType(error)`",
  },
};

// The names a caught exception goes by in these sources: the short ones and
// any camelCase `…Error`/`…Err` binding (`originalError`, `authError`). A
// capitalised name is a class (`TypeError`), not a value, and is left alone.
const ERRORISH = "(?:error|err|e|cause|caught|[a-z][\\w$]*(?:Error|Err))";
const LOG_CALL =
  /\b(?:console\s*\.\s*(?:log|info|warn|error|debug)|console\s*\[[^\]]+\]|logEvent|emitDiagnostic|logMizuhoRecord|logVpassDiagnostic|logError|log)\s*\(/gu;
const FORBIDDEN_IN_LOG: readonly [RegExp, string][] = [
  [/\.\s*message\b/u, "reads an exception message"],
  [/\.\s*stack\b/u, "reads a stack"],
  [
    new RegExp(`\\b(?:String|JSON\\s*\\.\\s*stringify|inspect)\\(\\s*${ERRORISH}\\s*[,)]`, "u"),
    "stringifies an error",
  ],
  [new RegExp(`\\b${ERRORISH}\\s*\\.\\s*(?:toString|toJSON)\\s*\\(`, "u"), "stringifies an error"],
  [new RegExp(`\\$\\{\\s*${ERRORISH}\\s*\\}`, "u"), "interpolates an error"],
  // The error as a whole argument (`console.error("failed", error)`), an
  // object value (`{ error: e }`) or a shorthand property (`{ error }`); not
  // an argument of another call, where a sanitizer such as
  // `safeErrorDetails(error)` takes it.
  [
    new RegExp(`(?:^|,|:|(?:^|[^$])\\{)\\s*${ERRORISH}\\s*(?:$|[,}]|\\bas\\b)`, "u"),
    "logs the error object",
  ],
];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name)) files.push(path);
    }
  };
  for (const root of ROOTS) {
    try {
      if (!statSync(join(REPO_ROOT, root)).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root);
  }
  return files.sort();
}

/**
 * Blanks comment lines (`//`, and the `/*`, ` *` lines of a block comment) and
 * trailing ` // ` comments. Line-based on purpose: a string such as `"**\/*"`
 * or a URL must not open or close a comment, and these sources are formatted
 * so that every comment starts its own line or follows code after a space.
 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (/^(?:\/\/|\/\*|\*)/u.test(trimmed)) return "";
      return line.replace(/\s\/\/\s.*$/u, "");
    })
    .join("\n");
}

/** The text between a call's opening parenthesis (at `open`) and its matching close. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    // A template literal is skipped whole too: a parenthesis or an apostrophe
    // in its text must not end the call or open a string.
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

const files = sourceFiles().map((path) => ({
  path: relative(REPO_ROOT, join(REPO_ROOT, path)),
  text: withoutComments(readFileSync(join(REPO_ROOT, path), "utf8")),
}));

describe("log hygiene", () => {
  test("scans the deployed sources of every service and collection package", () => {
    expect(files.length).toBeGreaterThan(250);
    for (const root of ROOTS.filter((root) => root.endsWith("/src")))
      expect(files.some((file) => file.path.startsWith(`${root}/`))).toBe(true);
  });

  test("no log call carries an exception's message, stack or the error itself", () => {
    const findings: string[] = [];
    const wrapped: Record<string, number> = {};
    let calls = 0;
    for (const { path, text } of files) {
      for (const match of text.matchAll(LOG_CALL)) {
        calls += 1;
        const open = match.index + match[0].length - 1;
        const args = callArguments(text, open);
        for (const [pattern, why] of FORBIDDEN_IN_LOG) {
          if (pattern.test(args)) {
            if (why === "logs the error object" && path in ERROR_TO_SANITIZING_WRAPPER) {
              wrapped[path] = (wrapped[path] ?? 0) + 1;
              continue;
            }
            const line = text.slice(0, match.index).split("\n").length;
            findings.push(`${path}:${line} ${why}`);
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(100);
    expect(findings).toEqual([]);
    expect(wrapped).toEqual(
      Object.fromEntries(
        Object.entries(ERROR_TO_SANITIZING_WRAPPER).map(([path, entry]) => [path, entry.count]),
      ),
    );
  });

  test("no source reads a stack", () => {
    expect(files.filter(({ text }) => /\.\s*stack\b/u.test(text)).map(({ path }) => path)).toEqual(
      [],
    );
  });

  test("every `.message` read is listed with the reason it is safe", () => {
    const reads = Object.fromEntries(
      files
        .map(({ path, text }) => [path, text.match(/\.\s*message\b/gu)?.length ?? 0] as const)
        .filter(([, count]) => count > 0),
    );
    const listed = Object.fromEntries(
      Object.entries(MESSAGE_READS).map(([path, entry]) => [path, entry.count]),
    );
    expect(reads).toEqual(listed);
    for (const entry of Object.values(MESSAGE_READS))
      expect(entry.reason.length).toBeGreaterThan(20);
  });

  test("the scanner finds what it is meant to find", () => {
    const sample = withoutComments(
      [
        "// console.log(error.message) in a comment is not a call",
        'console.error(JSON.stringify({ event: "x", message: error.message }));',
        "console[level](`failed: ${error}`);",
        "logEvent({ event: 'x', error });",
        'console.log(JSON.stringify({ event: "ok", ...safeErrorDetails(error) }));',
        'console.error("failed:", error);',
        "console.error(\n  JSON.stringify(error),\n);",
        "console.warn(`can't (yet) ${err.toString()}`);",
        'log(JSON.stringify({ event: "x", reason: String(originalError) }));',
        'console.log(JSON.stringify({ event: "x", code: classify(error), errorType: "TypeError" }));',
        'fetch("https://example.invalid/");',
      ].join("\n"),
    );
    const hits = [...sample.matchAll(LOG_CALL)].map((match) => {
      const args = callArguments(sample, match.index + match[0].length - 1);
      return FORBIDDEN_IN_LOG.filter(([pattern]) => pattern.test(args)).map(([, why]) => why);
    });
    expect(hits).toEqual([
      ["reads an exception message"],
      ["interpolates an error"],
      ["logs the error object"],
      [],
      ["logs the error object"],
      ["stringifies an error"],
      ["stringifies an error"],
      ["stringifies an error"],
      [],
    ]);
    expect(sample).toContain("https://example.invalid/");
  });
});
