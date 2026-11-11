import { expect, test } from "bun:test";
import {
  parseAssetHistoryJson,
  auditAssetHistoryJson,
  ASSET_HISTORY_JSON_LIMITS,
} from "../src/parsers/sbi-asset-history-json.ts";

test("exact integer values survive decimal and scientific JSON spellings without a rounding step", () => {
  for (const [token, expected] of [
    ["1", 1],
    ["1.000", 1],
    ["1e0", 1],
    ["100e-2", 1],
    ["-0", 0],
    ["9.007199254740991e15", Number.MAX_SAFE_INTEGER],
  ] as const)
    expect(parseAssetHistoryJson(`{"valuation":${token}}`)).toEqual({ valuation: expected });
});

test("decoded duplicate keys are rejected in every object before last-wins can hide a value", () => {
  for (const text of [
    '{"balances":{"accessToken":"SYNTHETIC_SENTINEL"},"balances":[]}',
    '{"balanc\\u0065s":{"accessToken":"SYNTHETIC_SENTINEL"},"balances":[]}',
    '{"outer":[{"valuation":{"accessToken":"SYNTHETIC_SENTINEL"},"valuation":7}]}',
    '{"outer":{"valua\\u0074ion":{"accessToken":"SYNTHETIC_SENTINEL"},"valuation":7}}',
    '{"__proto__":1,"__proto__":2}',
  ]) {
    expect(() => JSON.parse(text)).not.toThrow();
    for (const read of [parseAssetHistoryJson, auditAssetHistoryJson])
      expect(() => read(text)).toThrow("sbi_asset_history_schema");
  }
  expect(parseAssetHistoryJson('{"a":{"valuation":1},"b":{"valuation":2}}')).toEqual({
    a: { valuation: 1 },
    b: { valuation: 2 },
  });
});

test("original invalid syntax is never repaired by numeric normalization", () => {
  for (const text of [
    '{"profitLoss":10e0e0}',
    '{"profitLoss":10.0.0}',
    '{"valuation":01}',
    "1e+",
    "1e2.3",
    "-",
    "+1",
    ".1",
    "1.",
    "truefalse",
    "[false true]",
    "[1,]",
    '{"a":1,}',
    '{"a":}',
    '{"a"::1}',
    '{"a" 1}',
    "{[0]}",
    '"\\x01"',
    '"unescaped\ncontrol"',
    '"unterminated',
    "",
    " ",
    "undefined",
    "NaN",
  ]) {
    expect(() => JSON.parse(text)).toThrow();
    for (const read of [parseAssetHistoryJson, auditAssetHistoryJson])
      expect(() => read(text)).toThrow("sbi_asset_history_schema");
  }
  for (const text of [
    "null",
    "true",
    "false",
    "-0",
    "[1,-2,null,true,false,{}]",
    '{"a":[{"b":"escaped \\\" quote \\\\ slash { [ , : ] } \\ud83d\\ude00"}]}',
    ' \r\n {"a":1e+2,"profitLossRate":0.125} \t',
  ])
    for (const read of [parseAssetHistoryJson, auditAssetHistoryJson])
      expect(JSON.stringify(read(text))).toBe(JSON.stringify(JSON.parse(text)));
});

test("structural parsing is bounded before constructing or normalizing a document", () => {
  const limits = ASSET_HISTORY_JSON_LIMITS;
  expect(() =>
    auditAssetHistoryJson("[".repeat(limits.depth) + "0" + "]".repeat(limits.depth)),
  ).not.toThrow();
  for (const text of [
    "[".repeat(limits.depth + 1) + "0" + "]".repeat(limits.depth + 1),
    " ".repeat(limits.bytes + 1),
    '"' + "界".repeat(Math.floor(limits.bytes / 3)) + '"',
    "[" + "0,".repeat(limits.numbers) + "0]",
    "[" + "null,".repeat(limits.nodes) + "null]",
  ])
    for (const read of [parseAssetHistoryJson, auditAssetHistoryJson])
      expect(() => read(text)).toThrow("sbi_asset_history_bound");
});

test("malformed secret strings never escape inside a native decoder cause", () => {
  const text = '{"balances":{"accessToken":"SYNTHETIC_SENTINEL\\x"},"balances":[]}';
  for (const read of [parseAssetHistoryJson, auditAssetHistoryJson]) {
    expect(() => read(text)).toThrow("sbi_asset_history_schema");
    try {
      read(text);
    } catch (error) {
      expect(String(error)).not.toContain("SYNTHETIC_SENTINEL");
      expect(Object.getOwnPropertyDescriptor(error as Error, "cause")).toBeUndefined();
    }
  }
});

test("fractional and unsafe financial tokens cannot round, overflow or underflow into an integer", () => {
  for (const token of [
    "0.99999999999999999",
    "1.00000000000000001",
    "-0.99999999999999999",
    "9007199254740991.1",
    "9007199254740992",
    "1e-999",
    "1e999",
  ])
    for (const source of [
      `{"profitLoss":${token}}`,
      `{"balances":[[4071049200000,${token}]]}`,
      `{"profitLossRate":0.25,"acquisitionCosts":[[4071049200000,${token}]]}`,
    ])
      expect(() => parseAssetHistoryJson(source)).toThrow("sbi_asset_history_money");
});

test("rate metadata is finite but cannot exempt an adjacent amount from exactness", () => {
  expect(parseAssetHistoryJson('{"profitLossRate":0.125,"valuation":1}')).toEqual({
    profitLossRate: 0.125,
    valuation: 1,
  });
  expect(
    parseAssetHistoryJson(
      '{"profitLossRate":0.125,"literal":"\\\"valuation\\\":0.99999999999999999"}',
    ),
  ).toEqual({ profitLossRate: 0.125, literal: '"valuation":0.99999999999999999' });
  expect(() => parseAssetHistoryJson('{"profitLossRate":1e999}')).toThrow(
    "sbi_asset_history_schema",
  );
  expect(() =>
    parseAssetHistoryJson('{"profitLossRate":0.125,"profit\\u004coss":0.99999999999999999}'),
  ).toThrow("sbi_asset_history_money");
});

test("shape-only audit retains strings and field names without granting financial validity", () => {
  const text = '{"profitLoss":0.99999999999999999,"unknownSecret":"synthetic"}';
  expect(auditAssetHistoryJson(text)).toEqual({
    profitLoss: 1000000000000,
    unknownSecret: "synthetic",
  });
  expect(() => parseAssetHistoryJson(text)).toThrow("sbi_asset_history_money");
  for (const invalid of [
    '{"valuation":01}',
    '{"valuation":1,}',
    '{"valuation":NaN}',
    '{"valuation":"unterminated}',
  ])
    expect(() => parseAssetHistoryJson(invalid)).toThrow("sbi_asset_history_schema");
});
