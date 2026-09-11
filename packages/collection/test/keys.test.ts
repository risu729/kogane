import { describe, expect, test } from "bun:test";
import {
  CollectionKeyError,
  assertRelativePath,
  isObjectKeyFor,
  objectKey,
  parseTerminalKey,
  projectionInputKey,
  reportKey,
  runPrefix,
  terminalKey,
} from "../src/keys";

const DIGEST = "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8";

describe("collection key layout", () => {
  test("objects are addressed by their own digest", () => {
    expect(objectKey(DIGEST)).toBe(`objects/cb/${DIGEST}`);
    expect(isObjectKeyFor(objectKey(DIGEST), DIGEST)).toBe(true);
    expect(isObjectKeyFor(`objects/ab/${DIGEST}`, DIGEST)).toBe(false);
  });

  test("only lower-case hex digests address an object", () => {
    for (const value of [
      DIGEST.toUpperCase(),
      DIGEST.slice(0, 63),
      `${DIGEST}0`,
      "../../etc/passwd",
      "",
    ]) {
      expect(() => objectKey(value)).toThrow(CollectionKeyError);
    }
  });

  test("terminal keys round-trip and reject anything else", () => {
    const key = terminalKey("kogane-synthetic", "2026-09-01T00-00-00-000Z");
    expect(key).toBe("runs/kogane-synthetic/2026-09-01T00-00-00-000Z/terminal.json");
    expect(parseTerminalKey(key)).toEqual({
      source: "kogane-synthetic",
      runId: "2026-09-01T00-00-00-000Z",
    });
    for (const other of [
      "runs/kogane-synthetic/run-1/snapshot.json",
      "runs/kogane-synthetic/terminal.json",
      "runs/kogane-synthetic/a/b/terminal.json",
      "objects/cb/terminal.json",
      "runs/Bad-Source/run-1/terminal.json",
    ]) {
      expect(parseTerminalKey(other)).toBeNull();
    }
  });

  test("source and run identifiers cannot smuggle a path", () => {
    for (const source of ["../evil", "kogane/synthetic", "UPPER", "", "a".repeat(101)]) {
      expect(() => terminalKey(source, "run-1")).toThrow(CollectionKeyError);
    }
    for (const runId of ["../evil", "run/1", "..", ".", "", "a".repeat(201)]) {
      expect(() => terminalKey("kogane-synthetic", runId)).toThrow(CollectionKeyError);
    }
  });

  test("run prefixes are bounded scan prefixes, not free text", () => {
    expect(runPrefix()).toBe("runs/");
    expect(runPrefix("kogane-synthetic")).toBe("runs/kogane-synthetic/");
    expect(runPrefix("kogane-synthetic", "run-1")).toBe("runs/kogane-synthetic/run-1/");
  });

  test("report and projection-input paths refuse traversal", () => {
    expect(reportKey("report-1", "summary.json")).toBe("reports/report-1/summary.json");
    expect(projectionInputKey(DIGEST, "rows/part-001.json")).toBe(
      `projection-inputs/${DIGEST}/rows/part-001.json`,
    );
    for (const path of ["../x", "a/../b", "./a", "/a", "a//b", "", "a\\b"]) {
      expect(() => assertRelativePath(path)).toThrow(CollectionKeyError);
      expect(() => reportKey("report-1", path)).toThrow(CollectionKeyError);
    }
    expect(() => projectionInputKey("not-a-digest", "a.json")).toThrow(CollectionKeyError);
  });
});
