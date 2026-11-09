import { expect, test } from "bun:test";
import {
  parseAssetHistoryJson,
  auditAssetHistoryJson,
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
