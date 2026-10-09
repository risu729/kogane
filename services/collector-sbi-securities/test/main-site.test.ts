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

function chainPage(
  pageNumber: number,
  records: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return page({
    depositRecordList: records,
    pageCount: 3,
    pageNumber,
    pageSize: 2,
    totalCount: 5,
    ...overrides,
  });
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

  test("preserves every provider field in a three-page bundle with a shorter final page", () => {
    const first = chainPage(1, [record(101), record(102)]);
    const middle = chainPage(2, [record(103), record(104)], {
      detailsConditions: ["fixture-middle"],
      nextBusinessDate: "20260909",
    });
    const last = chainPage(3, [record(105)], {
      detailsConditions: ["fixture-final"],
      nextBusinessDate: "20260910",
    });
    const pages = [first, middle, last];
    const bundle = bundleYenHistoryPages(pages);
    expect(bundle).toEqual({
      schemaVersion: "sbi-yen-detail-history-bundle-v1",
      pageCount: 3,
      pageSize: 2,
      totalCount: 5,
      complete: true,
      pageLimitExceeded: false,
      rowLimitExceeded: false,
      pages,
    });
    expect(bundle.pages).toBe(pages);
    expect(bundle.pages[0]).toBe(first);
    expect(bundle.pages[1]).toBe(middle);
    expect(bundle.pages[2]).toBe(last);
    expect(last.depositRecordList).toEqual([record(105)]);
    expect((last.depositRecordList as unknown[]).length).toBeLessThan(bundle.pageSize);
  });

  test("rejects reordered middle and final pages and an underfilled final total", () => {
    const first = chainPage(1, [record(101), record(102)]);
    const middle = chainPage(2, [record(103), record(104)]);
    const last = chainPage(3, [record(105)]);
    expect(() => bundleYenHistoryPages([first, last, middle])).toThrow(
      /expected pageNumber 2 but received 3/u,
    );
    expect(() =>
      bundleYenHistoryPages([
        chainPage(1, [record(201), record(202)]),
        chainPage(2, [record(203), record(204)]),
        chainPage(2, [record(205)]),
      ]),
    ).toThrow(/expected pageNumber 3 but received 2/u);
    expect(() =>
      bundleYenHistoryPages([
        chainPage(1, [record(301), record(302)]),
        chainPage(2, [record(303), record(304)]),
        chainPage(3, []),
      ]),
    ).toThrow(/collected 4 of 5 rows/u);
  });
});
