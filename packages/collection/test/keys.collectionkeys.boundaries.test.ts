import { describe, expect, test } from "bun:test";
import {
  CollectionKeyError,
  assertRef,
  assertRelativePath,
  assertRunId,
  assertSha256Hex,
  assertSource,
  parseTerminalKey,
  projectionInputKey,
  reportKey,
  terminalKey,
} from "../src/keys";

const DIGEST = "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8";

describe("collection key boundaries", () => {
  test("source and run identifiers round-trip at the published length bounds", () => {
    const source = "a".repeat(100);
    const runId = `a._${"b".repeat(197)}`;
    expect(source).toHaveLength(100);
    expect(runId).toHaveLength(200);
    const key = terminalKey(source, runId);
    expect(key).toBe(`runs/${source}/${runId}/terminal.json`);
    expect(parseTerminalKey(key)).toEqual({ source, runId });

    expect(terminalKey("1", "a")).toBe("runs/1/a/terminal.json");
    expect(parseTerminalKey("runs/1/a/terminal.json")).toEqual({ source: "1", runId: "a" });
    expect(terminalKey("1", "ab.cd")).toBe("runs/1/ab.cd/terminal.json");
    expect(parseTerminalKey("runs/1/ab.cd/terminal.json")).toEqual({
      source: "1",
      runId: "ab.cd",
    });
    expect(() => terminalKey("ab.cd", "a")).toThrow(new CollectionKeyError("invalid_source"));
  });

  test("raw separators and control characters are rejected without decoding", () => {
    expect(() => terminalKey("-a", "a")).toThrow(new CollectionKeyError("invalid_source"));
    expect(parseTerminalKey("runs/-a/a/terminal.json")).toBeNull();

    expect(() => terminalKey("ab%2Dcd", "run-1")).toThrow(new CollectionKeyError("invalid_source"));
    expect(parseTerminalKey("runs/ab%2Dcd/run-1/terminal.json")).toBeNull();
    expect(() => terminalKey("1", "ab%2Ecd")).toThrow(new CollectionKeyError("invalid_run_id"));
    expect(parseTerminalKey("runs/1/ab%2Ecd/terminal.json")).toBeNull();

    for (const path of ["a%2Fb", "a\0b", "a\nb"]) {
      expect(() => assertRelativePath(path)).toThrow(new CollectionKeyError("invalid_path"));
      expect(() => reportKey("report-1", path)).toThrow(new CollectionKeyError("invalid_path"));
      expect(() => projectionInputKey(DIGEST, path)).toThrow(
        new CollectionKeyError("invalid_path"),
      );
    }
    for (const source of ["a\0b", "a\nb"]) {
      expect(() => terminalKey(source, "run-1")).toThrow(new CollectionKeyError("invalid_source"));
      expect(parseTerminalKey(`runs/${source}/run-1/terminal.json`)).toBeNull();
    }
    for (const runId of ["a\0b", "a\nb"]) {
      expect(() => terminalKey("ab", runId)).toThrow(new CollectionKeyError("invalid_run_id"));
      expect(parseTerminalKey(`runs/ab/${runId}/terminal.json`)).toBeNull();
    }
  });

  test("report and projection keys accept a path at the published limits", () => {
    expect(assertRelativePath("a".repeat(200))).toBe("a".repeat(200));
    expect(() => assertRelativePath("a".repeat(201))).toThrow(
      new CollectionKeyError("invalid_path"),
    );

    const path512 = `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(110)}`;
    expect(path512).toHaveLength(512);
    expect(assertRelativePath(path512)).toBe(path512);
    expect(reportKey("report-1", path512)).toBe(`reports/report-1/${path512}`);
    expect(projectionInputKey(DIGEST, path512)).toBe(`projection-inputs/${DIGEST}/${path512}`);

    const path513 = `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(111)}`;
    expect(path513).toHaveLength(513);
    expect(() => assertRelativePath(path513)).toThrow(new CollectionKeyError("invalid_path"));
    expect(() => reportKey("report-1", path513)).toThrow(new CollectionKeyError("invalid_path"));
    expect(() => projectionInputKey(DIGEST, path513)).toThrow(
      new CollectionKeyError("invalid_path"),
    );

    const reportRef = "a".repeat(200);
    expect(reportKey(reportRef, "a.json")).toBe(`reports/${reportRef}/a.json`);
    expect(() => reportKey("a".repeat(201), "a.json")).toThrow(
      new CollectionKeyError("invalid_report_ref"),
    );
  });

  test("non-strings are rejected before pattern coercion", () => {
    expect(() => assertSource(null)).toThrow(new CollectionKeyError("invalid_source"));
    expect(() => assertRunId(null)).toThrow(new CollectionKeyError("invalid_run_id"));
    expect(() => assertRef(null, "invalid_report_ref")).toThrow(
      new CollectionKeyError("invalid_report_ref"),
    );
    // A boxed string would satisfy length, split, and PATH_SEGMENT if the typeof guard were absent.
    expect(() => assertRelativePath(Object("a/b"))).toThrow(new CollectionKeyError("invalid_path"));
    expect(() => assertSha256Hex({ toString: () => DIGEST })).toThrow(
      new CollectionKeyError("invalid_sha256"),
    );
  });
});
