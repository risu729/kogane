import { describe, expect, test } from "bun:test";
import { bundleYenHistoryPages } from "../src/main-site";

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    depositRecordList: [record(101), record(102)],
    detailsConditions: [],
    exceededMaxCount: false,
    isExceededMaxCount: false,
    nextBusinessDate: "20260908",
    pageCount: 1,
    pageNumber: 1,
    pageSize: 100,
    totalCount: 2,
    totalDepositAmount: "2000",
    totalDepositCount: "1",
    totalPaymentAmount: "500",
    totalPaymentCount: "1",
    totalTransDepositAmount: "0",
    totalTransDepositCount: "0",
    totalTransPaymentAmount: "0",
    totalTransPaymentCount: "0",
    ...overrides,
  };
}

function record(did: number): Record<string, unknown> {
  return {
    detailKbn: "入出金",
    did,
    dispAbstract: "fixture transaction",
    payAmount: "1000",
    payDepDate: "2026/09/01",
    payDepKbn: "入金",
  };
}

describe("SBI yen history bundle", () => {
  test("preserves every provider field in a deterministic complete bundle", () => {
    const providerPage = page();
    const bundle = bundleYenHistoryPages([providerPage]);
    expect(bundle).toEqual({
      schemaVersion: "sbi-yen-detail-history-bundle-v1",
      pageCount: 1,
      pageSize: 100,
      totalCount: 2,
      complete: true,
      pageLimitExceeded: false,
      rowLimitExceeded: false,
      pages: [providerPage],
    });
  });

  test("accepts both observed provider conventions for an empty init page", () => {
    for (const metadata of [
      { pageCount: 0, pageNumber: 0 },
      { pageCount: 1, pageNumber: 1 },
    ]) {
      expect(
        bundleYenHistoryPages([page({ ...metadata, depositRecordList: [], totalCount: 0 })]),
      ).toMatchObject({ pageCount: 1, totalCount: 0, complete: true });
    }
  });

  test("rejects incomplete and extra page chains", () => {
    expect(() =>
      bundleYenHistoryPages([
        page({ pageCount: 2, pageSize: 1, totalCount: 2, depositRecordList: [record(101)] }),
      ]),
    ).toThrow(/incomplete/u);
    expect(() => bundleYenHistoryPages([page(), page({ pageNumber: 2 })])).toThrow(/extra pages/u);
  });

  test("rejects metadata drift, duplicate ids, provider limit flags, and unknown fields", () => {
    const first = page({
      pageCount: 2,
      pageSize: 1,
      totalCount: 2,
      depositRecordList: [record(101)],
    });
    expect(() =>
      bundleYenHistoryPages([
        first,
        page({
          pageCount: 2,
          pageNumber: 2,
          pageSize: 2,
          totalCount: 2,
          depositRecordList: [record(102)],
        }),
      ]),
    ).toThrow(/pageCount|pagination metadata/u);
    expect(() =>
      bundleYenHistoryPages([
        first,
        page({
          pageCount: 2,
          pageNumber: 2,
          pageSize: 1,
          totalCount: 2,
          depositRecordList: [record(101)],
        }),
      ]),
    ).toThrow(/duplicate did/u);
    expect(() => bundleYenHistoryPages([page({ isExceededMaxCount: true })])).toThrow(
      /provider row limit/u,
    );
    expect(() => bundleYenHistoryPages([page({ unexpected: true })])).toThrow(/fields changed/u);
  });
});
