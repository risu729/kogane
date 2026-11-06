// Logs and stored operational records carry counts and closed codes only,
// never provider text or amounts (AGENTS.md, docs/processor.md §6.1,
// docs/observation-lanes.md, packages/collector-diagnostics). The sanitizers
// that enforce it (`safeErrorDetails`, each collector's closed failure codes)
// only help where a log line goes through them; this guard keeps the raw
// material out of the log calls themselves, across every deployed source of
// the services and of the collection packages:
//
//   * no log call's arguments read an exception's `.message` or `.stack`,
//     stringify it (`String(error)`, `${error}`) or pass the error object
//     itself — a closed code or `safeErrorDetails(error)` goes there instead;
//   * no source reads `.stack` at all;
//   * every `.message` a source reads is listed below with the reason it is
//     safe (a classifier that matches the text against closed codes and
//     emits only the code, a field that already holds a closed code). A new
//     read fails here until someone has looked at where its value goes.
//
// The scan is textual, like `tasks/_lib/import-boundaries.ts`: comments are
// dropped and a call's arguments are its balanced parentheses.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../scripts/config-bootstrap.ts";

const ROOTS = [
  ...readdirSync(join(REPO_ROOT, "services")).flatMap((service) =>
    ["src", "container"].map((dir) => join("services", service, dir)),
  ),
  "packages/collection/src",
  "packages/collector-diagnostics/src",
  "packages/sbi-vc-trade-client/src",
];
const SOURCE = /\.(?:ts|mjs)$/u;
const NOT_SOURCE = /(?:\.d\.ts|\.test\.ts|\.test\.mjs|\.node-test\.mjs)$/u;

/**
 * Every `.message` read in the scanned sources, by file, with how many reads
 * the file has and why each is safe. Adding a read means adding (or raising)
 * its entry here, with the reason.
 */
const MESSAGE_READS: Readonly<Record<string, { count: number; reason: string }>> = {
  "packages/collection/src/manifest.ts": {
    count: 1,
    reason: "a CollectionKeyError's message is its closed key-refusal code",
  },
  "packages/collection/src/schedule-result.ts": {
    count: 1,
    reason: "compared with the lease refusal constant; only a closed code is returned",
  },
  "packages/collection/src/writer.ts": {
    count: 1,
    reason: "tested for a checksum refusal; only a closed object_* code is returned",
  },
  "packages/collector-diagnostics/src/index.ts": {
    count: 1,
    reason: "safeErrorDetails matches known shapes and emits only closed codes and statuses",
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
  "services/collector-st-george/src/worker-policy.ts": {
    count: 1,
    reason: "passed to safeFailureCode, which admits only the closed failure codes",
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

// The names a caught exception goes by in these sources.
const ERRORISH = "(?:error|err|e|cause|caught)";
const LOG_CALL =
  /\b(?:console\s*\.\s*(?:log|info|warn|error|debug)|console\s*\[[^\]]+\]|logEvent|emitDiagnostic|logMizuhoRecord|logVpassDiagnostic|logError|log)\s*\(/gu;
const FORBIDDEN_IN_LOG: readonly [RegExp, string][] = [
  [/\.\s*message\b/u, "reads an exception message"],
  [/\.\s*stack\b/u, "reads a stack"],
  [new RegExp(`\\bString\\(\\s*${ERRORISH}\\s*\\)`, "u"), "stringifies an error"],
  [new RegExp(`\\$\\{\\s*${ERRORISH}\\s*\\}`, "u"), "interpolates an error"],
  [new RegExp(`^\\s*${ERRORISH}\\s*$`, "u"), "logs the error object"],
  [new RegExp(`(?:^|[^$])[{,]\\s*${ERRORISH}\\s*[,}]`, "u"), "logs the error object"],
  [new RegExp(`:\\s*${ERRORISH}\\s*[,}]`, "u"), "logs the error object"],
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
    if (char === '"' || char === "'") quote = char;
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
    let calls = 0;
    for (const { path, text } of files) {
      for (const match of text.matchAll(LOG_CALL)) {
        calls += 1;
        const open = match.index + match[0].length - 1;
        const args = callArguments(text, open);
        for (const [pattern, why] of FORBIDDEN_IN_LOG) {
          if (pattern.test(args)) {
            const line = text.slice(0, match.index).split("\n").length;
            findings.push(`${path}:${line} ${why}`);
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(100);
    expect(findings).toEqual([]);
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
    ]);
    expect(sample).toContain("https://example.invalid/");
  });
});
