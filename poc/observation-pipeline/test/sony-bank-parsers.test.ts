import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS } from "../src/parsers/registry.ts";
import {
  sonyBankGrossBalance,
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "../src/parsers/sony-bank.ts";
import type { ArtifactMeta, Parser } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "sony-bank-parser-boundaries");
const bytes = (name: string) => readFileSync(join(FIXTURES, name));
const meta = (dataset: string, mime = "application/json"): ArtifactMeta => ({
  id: 88,
  sourceId: "sony-bank",
  runStatus: "success",
  runFailureCount: 0,
  dataset,
  url: null,
  mime,
  fetchedAt: "2026-09-01T00:00:00Z",
  sha256: "0".repeat(64),
});
const json = (name: string) =>
  JSON.parse(new TextDecoder().decode(bytes(name))) as Record<string, unknown>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("Sony Bank parser registry and provenance", () => {
  const cases: Array<[Parser, string, string]> = [
    [sonyBankGrossBalance, "gross-balance", "gross-balance.json"],
    [sonyBankHistoryJson, "yen-history-page-0001", "yen-history-page-0001.json"],
    [sonyBankHistoryCsv, "yen-history-csv", "yen-history.csv"],
    [sonyBankWalletHistory, "wallet-history-202609", "wallet-history-2026-09.html"],
  ];
  test("registers every source-separated parser and is deterministic", () => {
    for (const [parser, dataset, file] of cases) {
      expect(PARSERS.filter((entry) => entry === parser)).toHaveLength(1);
      const artifact = meta(
        dataset,
        file.endsWith(".csv")
          ? "text/csv"
          : file.endsWith(".html")
            ? "text/html; charset=UTF-8"
            : "application/json",
      );
      expect(parser.accepts(artifact)).toBeTrue();
      expect(parser.parse(bytes(file), artifact)).toEqual(parser.parse(bytes(file), artifact));
    }
  });
  test("maps gross balances and totals with raw locators", () => {
    const result = sonyBankGrossBalance.parse(bytes("gross-balance.json"), meta("gross-balance"));
    expect(result.observations).toHaveLength(17);
    expect(result.observations.filter((entry) => entry.kind === "balance")).toHaveLength(15);
    expect(result.observations.filter((entry) => entry.kind === "valuation")).toHaveLength(2);
    expect(result.observations[0]?.rawLocator).toBe("json:$.assetBalAcTypTyp[0]");
  });
  test("maps signed JSON transactions and after-balances without dropping source fields", () => {
    const result = sonyBankHistoryJson.parse(
      bytes("yen-history-page-0001.json"),
      meta("yen-history-page-0001"),
    );
    expect(result.observations).toHaveLength(4);
    expect(
      result.observations
        .filter((entry) => entry.kind === "transaction")
        .map((entry) => (entry.kind === "transaction" ? entry.amountMinor : null)),
    ).toEqual([1000, -500]);
    expect(result.observations[2]?.extra).toHaveProperty("applicationExchRt");
  });
  test("maps the exact official CSV header and both directions", () => {
    const result = sonyBankHistoryCsv.parse(
      bytes("yen-history.csv"),
      meta("yen-history-csv", "text/csv"),
    );
    expect(result.observations).toHaveLength(4);
    expect(result.observations[0]?.rawLocator).toBe("csv:row=2");
  });
  test("maps WALLET rows and retains the paired desktop cells", () => {
    const result = sonyBankWalletHistory.parse(
      bytes("wallet-history-2026-09.html"),
      meta("wallet-history-202609", "text/html; charset=UTF-8"),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      amountMinor: 1200,
      currency: "JPY",
      rawLocator: "html:table=0,row=1",
    });
    expect(result.observations[0]?.extra).toHaveProperty("supplement");
  });
});

describe("Sony Bank fail-closed boundaries", () => {
  test("rejects schema, enum, cardinality, and pagination drift", () => {
    const extra = json("yen-history-page-0001.json");
    extra.unknown = true;
    expect(() => sonyBankHistoryJson.parse(encode(extra), meta("yen-history-page-0001"))).toThrow(
      "schema drift",
    );
    const enumDrift = json("yen-history-page-0001.json");
    (
      enumDrift.transactionHistInfo as Array<Record<string, unknown>>
    )[0]!.additionAndSubtractionSegment = "3";
    expect(() =>
      sonyBankHistoryJson.parse(encode(enumDrift), meta("yen-history-page-0001")),
    ).toThrow("enum drift");
    const cardinality = json("gross-balance.json");
    (cardinality.assetBalAcTypTyp as unknown[]).pop();
    expect(() => sonyBankGrossBalance.parse(encode(cardinality), meta("gross-balance"))).toThrow(
      "cardinality drift",
    );
    const pagination = json("yen-history-page-0001.json");
    pagination.countCnt = 4;
    expect(() =>
      sonyBankHistoryJson.parse(encode(pagination), meta("yen-history-page-0001")),
    ).toThrow("pagination is incomplete");
    const csv = new TextDecoder()
      .decode(bytes("yen-history.csv"))
      .replace("預入額,引出額", "引出額,預入額");
    expect(() =>
      sonyBankHistoryCsv.parse(new TextEncoder().encode(csv), meta("yen-history-csv", "text/csv")),
    ).toThrow("header drift");
  });
});
