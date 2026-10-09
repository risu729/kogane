import { expect, test } from "bun:test";
import { prettyJson } from "../src/json-format.ts";

const inputLimit = 512 * 1024;
const expandedLimit = 1024 * 1024;

test("accepts nesting at the depth limit", () => {
  const input = "[".repeat(64) + "0" + "]".repeat(64);
  const formatted = prettyJson(input);
  expect(formatted).not.toBeNull();
  expect(formatted?.replace(/\s/g, "")).toBe(input);
});

function jsonTextOfLength(length: number): string {
  const prefix = '{"k":"';
  const suffix = '"}';
  return prefix + "a".repeat(length - prefix.length - suffix.length) + suffix;
}

test("accepts a valid document at the 512 KiB input limit", () => {
  const input = jsonTextOfLength(inputLimit);
  expect(input).toHaveLength(inputLimit);
  const formatted = prettyJson(input);
  expect(formatted).not.toBeNull();
  expect(formatted?.replace(/\s/g, "")).toBe(input);
});

test("rejects a valid document one byte over the 512 KiB input limit", () => {
  const input = jsonTextOfLength(inputLimit + 1);
  expect(input).toHaveLength(inputLimit + 1);
  expect(prettyJson(input)).toBeNull();
});

test("accepts a document whose formatted length is 1 MiB", () => {
  // n single-digit zeros format to 5n+2 bytes. 209715 zeros are 1 MiB + 1.
  // One fewer zero, with the last lexeme four bytes longer, is exactly 1 MiB.
  const input = "[" + "0,".repeat(209713) + "10000]";
  expect(input.length).toBeLessThanOrEqual(inputLimit);
  const formatted = prettyJson(input);
  expect(formatted).not.toBeNull();
  expect(formatted?.length).toBe(expandedLimit);
  expect(formatted?.replace(/\s/g, "")).toBe(input);
});

test("rejects a document one byte over the 1 MiB formatted limit", () => {
  const input = "[" + "0,".repeat(209714) + "0]";
  expect(input.length).toBeLessThanOrEqual(inputLimit);
  expect(prettyJson(input)).toBeNull();
});

test("preserves other numeric lexemes, escape spellings and duplicate keys", () => {
  const input = '{"v":1.50,"e":1E+2,"p":1e-02,"s":"a\\/b\\u0041","\\u007a":1,"z":2}';
  expect(prettyJson(input)).toBe(
    '{\n  "v": 1.50,\n  "e": 1E+2,\n  "p": 1e-02,\n  "s": "a\\/b\\u0041",\n  "\\u007a": 1,\n  "z": 2\n}',
  );
});
