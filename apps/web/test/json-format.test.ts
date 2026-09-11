import { expect, test } from "bun:test";
import { prettyJson } from "../src/json-format.ts";

test("formats whitespace while preserving numeric lexemes, escapes and duplicate keys", () => {
  const input =
    '{"n":9007199254740993123456789,"n":-0,"exp":1e+99,"s":"\\u65e5本語","a":[true,null]}';
  expect(prettyJson(input)).toBe(
    '{\n  "n": 9007199254740993123456789,\n  "n": -0,\n  "exp": 1e+99,\n  "s": "\\u65e5本語",\n  "a": [\n    true,\n    null\n  ]\n}',
  );
});

test("rejects invalid JSON and excessive nesting or expansion", () => {
  for (const input of [
    '{"a":}',
    '{/*x*/"a":1}',
    '{"a":1,}',
    "{}\n{}",
    "[".repeat(65) + "0" + "]".repeat(65),
    " ".repeat(512 * 1024 + 1),
  ]) {
    expect(prettyJson(input)).toBeNull();
  }
  expect(prettyJson("[".repeat(63) + "[" + "0,".repeat(10000) + "0]" + "]".repeat(63))).toBeNull();
  expect(prettyJson("null")).toBe("null");
});

test("formats a large flat array within the preview limit", () => {
  const input = "[" + "0,".repeat(99_999) + "0]";
  const result = prettyJson(input);
  expect(result).not.toBeNull();
  expect(result?.split("\n")).toHaveLength(100_002);
  expect(result?.replace(/\s/g, "")).toBe(input);
}, 2000);
