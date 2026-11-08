import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_NOTICE_CHARS,
  RUN_ERROR_TYPES,
  RUN_REFUSALS,
  RUN_STAGES,
  parseRunDiagnostic,
  redactNotice,
} from "../src/run-diagnostic";
import { parseCollectionOutput } from "../src/worker-policy";
import type { RunDiagnostic } from "../src/run-diagnostic";

const valid: RunDiagnostic = {
  stage: "login-result-state",
  errorType: "CollectionError",
  refusal: "unknown",
  loginPostCount: 1,
  durationMs: 41_000,
  notices: ["Log on"],
};

/** The string members of `const NAME = new Set([...])` in the container source. */
function containerSet(name: string): string[] {
  const source = readFileSync(new URL("../container/browser.mjs", import.meta.url), "utf8");
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, "u").exec(source);
  if (!match) throw new Error(`${name} missing`);
  return [...match[1]!.matchAll(/"([^"]+)"/gu)].map((value) => value[1]!);
}

/** The regular expressions and replacements of `redactNotice` in a source file. */
function redactionSteps(source: string): string[] {
  const start = source.indexOf("function redactNotice(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [...body.matchAll(/\.replace\((\/[^\n]*?\/gu), ("[^"]*")\)/gu)].map(
    (match) => `${match[1]} -> ${match[2]}`,
  );
}

describe("St.George run diagnostic", () => {
  test("the Worker redacts and bounds notices exactly as the container does", () => {
    const container = readFileSync(new URL("../container/browser.mjs", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../src/run-diagnostic.ts", import.meta.url), "utf8");
    expect(redactionSteps(container).length).toBe(5);
    expect(redactionSteps(worker)).toEqual(redactionSteps(container));
    for (const constant of ["MAX_NOTICES", "MAX_NOTICE_CHARS"]) {
      const pattern = new RegExp(`export const ${constant} = (\\d+);`, "u");
      expect(pattern.exec(worker)?.[1]).toBe(pattern.exec(container)?.[1]);
    }
  });
  test("the Worker's closed labels are the container's, plus unknown", () => {
    expect([...RUN_STAGES].sort()).toEqual([...containerSet("RUNTIME_STAGES"), "unknown"].sort());
    expect([...RUN_REFUSALS].sort()).toEqual(
      [...containerSet("RUNTIME_REFUSALS"), "unknown"].sort(),
    );
    expect([...RUN_ERROR_TYPES].sort()).toEqual(
      [...containerSet("RUNTIME_ERROR_TYPES"), "CollectionError", "unknown"].sort(),
    );
  });
  test("a valid diagnostic passes and its notices are redacted again", () => {
    expect(parseRunDiagnostic(valid)).toEqual(valid);
    expect(
      parseRunDiagnostic({
        ...valid,
        notices: ["Call 13 33 30", "Call 13 33 30", "Mail me@example.invalid", "z".repeat(160)],
      })?.notices,
    ).toEqual(["Call #", "Mail [email]", "z".repeat(MAX_NOTICE_CHARS)]);
    expect(redactNotice("\u202eA\u0000B")).toBe("A B");
    // Numbers in any script, and an address cut right after its "@".
    expect(redactNotice("No \uff11\uff12\uff13 \u0661\u0662 \u2460\u2461 \u{1d7cf}")).toBe("No #");
    expect(redactNotice("cut at john.smith@")).toBe("cut at [email]");
  });
  test("anything outside the closed shape is dropped whole", () => {
    for (const value of [
      undefined,
      null,
      "x",
      [],
      { ...valid, stage: "SYNTHETIC_PASSWORD" },
      { ...valid, errorType: "SYNTHETIC_PASSWORD" },
      { ...valid, refusal: "SYNTHETIC_PASSWORD" },
      { ...valid, loginPostCount: 3 },
      { ...valid, durationMs: -1 },
      { ...valid, durationMs: 1.5 },
      { ...valid, notices: "Log on" },
      { ...valid, notices: ["a", "b", "c", "d", "e"] },
      { ...valid, notices: ["a", 5] },
      { ...valid, notices: ["z".repeat(MAX_NOTICE_CHARS + 1)] },
      { ...valid, extra: "SYNTHETIC_PASSWORD" },
    ])
      expect(parseRunDiagnostic(value)).toBeUndefined();
  });
  test("the container's failed result carries the diagnostic; a bad one keeps the failure", () => {
    expect(
      parseCollectionOutput({ status: "failed", reason: "login-rejected", diagnostic: valid }),
    ).toEqual({ status: "failed", reason: "login-rejected", diagnostic: valid });
    expect(
      parseCollectionOutput({
        status: "failed",
        reason: "login-rejected",
        diagnostic: { ...valid, stage: "SYNTHETIC_PASSWORD" },
      }),
    ).toEqual({ status: "failed", reason: "login-rejected" });
  });
});
