import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sbiForeignCashHistory } from "../src/parsers/sbi-foreign-cash-history.ts";
import { sbiYenDetailHistory } from "../src/parsers/sbi-yen-detail-history.ts";
import {
  CASH_HISTORY_SCHEMA,
  cashRetentionRange,
  parseCashHistoryJson,
} from "../src/parsers/sbi-cash-history-schema.ts";
import type { ArtifactMeta } from "../src/types.ts";

const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const foreignFixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/foreign-cash-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
export const cashMeta = (dataset: string): ArtifactMeta => ({
  id: 1,
  sourceId: "sbi-securities",
  dataset,
  runStatus: "success",
  runFailureCount: 0,
  sha256: "a".repeat(64),
  fetchedAt: "2099-12-31T00:00:00Z",
  url: null,
  mime: "application/json",
  fetchUnitKey: "domestic",
});

export function yenFixture() {
  const records = Array.from({ length: 11 }, (_, i) => ({
    did: 1001 + i,
    detailKbn: "金融機関からの入金",
    payDepKbn: "入金",
    payDepDate: "2099/09/03",
    payAmount: "100",
    dispAbstract: "synthetic deposit",
  }));
  return {
    schemaVersion: CASH_HISTORY_SCHEMA,
    kind: "yen",
    requestedRange: cashRetentionRange("2099-12-31", "yen"),
    pageSize: 10,
    totalCount: records.length,
    pages: [records.slice(0, 10), records.slice(10)].map((depositRecordList, i) => ({
      depositRecordList,
      detailsConditions: ["入金：すべて", "出金：すべて"],
      exceededMaxCount: false,
      isExceededMaxCount: false,
      pageCount: 2,
      pageNumber: i + 1,
      pageSize: 10,
      totalCount: 11,
      totalDepositAmount: "1100",
      totalDepositCount: "11",
      totalPaymentAmount: "0",
      totalPaymentCount: "0",
      totalTransDepositAmount: "0",
      totalTransDepositCount: "0",
      totalTransPaymentAmount: "0",
      totalTransPaymentCount: "0",
    })),
  };
}

test("whole-retention requests use the UI anniversary presets, including leap-day boundaries", () => {
  expect(cashRetentionRange("2099-12-31", "yen")).toEqual({ from: "2098-01-01", to: "2099-12-31" });
  expect(cashRetentionRange("2096-02-29", "yen")).toEqual({ from: "2094-03-01", to: "2096-02-29" });
  expect(cashRetentionRange("2099-12-31", "foreign")).toEqual({
    from: "2095-01-01",
    to: "2099-12-31",
  });
});

test("yen two-page history preserves did identities and proves every retained row", () => {
  const result = sbiYenDetailHistory.parse(encoded(yenFixture()), cashMeta("yen-detail-history"));
  expect(result.observations).toHaveLength(11);
  expect(result.observations[10]).toMatchObject({
    externalId: "sbi-yen-detail:1011",
    amountMinor: 100,
    rawLocator: "json:$.pages[1].depositRecordList[0]",
  });
  expect(result.coverage?.[0]).toMatchObject({
    completeness: "complete",
    membershipComplete: true,
    observedCount: 11,
    expectedCount: 11,
  });
});

test("USD keeps exact signed-direction semantics and identical-row multiplicity across overlapping captures", () => {
  const fixture = foreignFixture();
  const first = sbiForeignCashHistory.parse(encoded(fixture), cashMeta("foreign-cash-history"));
  const again = sbiForeignCashHistory.parse(encoded(fixture), cashMeta("foreign-cash-history"));
  expect(first).toEqual(again);
  expect(
    first.observations
      .map((row) => (row.kind === "transaction" ? row.externalId : undefined))
      .every((id) => id !== undefined),
  ).toBe(true);
  expect(
    new Set(
      first.observations.map((row) => (row.kind === "transaction" ? row.externalId : undefined)),
    ).size,
  ).toBe(3);
  expect(first.observations[0]).toMatchObject({
    amountMinor: 1234,
    amountText: "12.34",
    currency: "USD",
    extra: { _kogane: { direction: "credit", identityOrigin: "row-occurrence" } },
  });
  expect(first.observations[2]).toMatchObject({
    amountMinor: 567,
    extra: { _kogane: { direction: "debit" } },
  });
  expect(first.coverage?.[0]).toMatchObject({
    completeness: "complete",
    expectedCount: 3,
    observedCount: 3,
  });
  // Prepending a different new row leaves each older occurrence unchanged.
  fixture.pages[0].items.unshift({
    ...fixture.pages[0].items[0],
    valueDate: "2099/09/04",
    amount: "9.99",
  });
  fixture.totalCount += 1;
  fixture.pages[0].totalCount += 1;
  expect(
    sbiForeignCashHistory
      .parse(encoded(fixture), cashMeta("foreign-cash-history"))
      .observations.slice(1)
      .map((row) => (row.kind === "transaction" ? row.externalId : undefined)),
  ).toEqual(
    first.observations.map((row) => (row.kind === "transaction" ? row.externalId : undefined)),
  );
});

test("schema, unknown codes, numeric rounding, totals, dates and pagination fail closed without provider text", () => {
  for (const mutate of [
    (b: any) => b.pages.pop(),
    (b: any) => b.pages.reverse(),
    (b: any) => b.pages[1].depositRecordList.pop(),
    (b: any) => (b.pages[1].depositRecordList[0].did = 1001),
    (b: any) => (b.pages[1].totalDepositAmount = "1101"),
    (b: any) => (b.pages[0].isExceededMaxCount = true),
    (b: any) => (b.pages[0].depositRecordList[0].payDepKbn = "synthetic-private-unknown"),
    (b: any) => (b.pages[0].depositRecordList[0].payAmount = "0.00000000000000000001"),
    (b: any) => (b.pages[0].depositRecordList[0].payDepDate = "2099/02/30"),
    (b: any) => (b.pages[0].depositRecordList[0].payDepDate = "2097/12/31"),
    (b: any) => (b.requestedRange.from = "2099-01-01"),
  ]) {
    const fixture = yenFixture();
    mutate(fixture);
    expect(() =>
      sbiYenDetailHistory.parse(encoded(fixture), cashMeta("yen-detail-history")),
    ).toThrow(/sbi_cash_history_/u);
  }
  expect(() => parseCashHistoryJson('{"totalCount":0.999999999999999999999}')).toThrow(
    "sbi_cash_history_schema",
  );
  expect(() => parseCashHistoryJson('{"did":9007199254740993}')).toThrow("sbi_cash_history_schema");
  for (const text of [
    '{"did":10e0e0}',
    '{"did":10.0.0}',
    '{"did":1,"did":2}',
    '{"x":{"syntheticToken":"private"},"x":null}',
    '{"did":1,"\\u0064id":2}',
  ])
    expect(() => parseCashHistoryJson(text)).toThrow("sbi_cash_history_schema");
  for (const mutate of [
    (b: any) => (b.pages[0].businessErrorMessage = "synthetic-private-error"),
    (b: any) => (b.pages[0].items[0].cometCurrencyCode = "999"),
    (b: any) => (b.pages[0].items[0].cashType = "synthetic-private-unknown"),
    (b: any) => (b.pages[0].items[0].amount = "-1.00"),
    (b: any) => (b.pages[0].totalCount = 4),
    (b: any) => (b.pages[0].unexpected = "synthetic-private"),
  ]) {
    const fixture = foreignFixture();
    mutate(fixture);
    expect(() =>
      sbiForeignCashHistory.parse(encoded(fixture), cashMeta("foreign-cash-history")),
    ).toThrow(/sbi_cash_history_/u);
  }
});

test("malformed private JSON fragments are absent from the closed error and its causes", () => {
  for (const raw of [
    '{"synthetic-private-token":"\\uQQQQ"}',
    '{"synthetic-private-token":"unterminated}',
  ]) {
    try {
      parseCashHistoryJson(raw);
      throw new Error("invalid input unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("sbi_cash_history_schema");
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain("synthetic-private-token");
    }
  }
});
