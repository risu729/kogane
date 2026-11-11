import { describe, expect, test } from "bun:test";
import {
  parseMonthlyReports,
  reportList,
  reportPdf,
  selectedReportPeriods,
  storedReportPeriods,
} from "../src/monthly-reports";
import { PDF_TEXT, reportListFixture, reportDownloadFixture } from "./monthly-report-fixtures";

describe("observed monthly report evidence", () => {
  test("uses the offered periods, then requests only missing months and the newest", () => {
    const offered = reportList(reportListFixture(["2099-01", "2099-03", "2099-02"]));
    expect(offered).toEqual(["2099-03", "2099-02", "2099-01"]);
    expect(selectedReportPeriods(offered, [])).toEqual(offered);
    expect(selectedReportPeriods(offered, offered)).toEqual(["2099-03"]);
    expect(selectedReportPeriods(offered, ["2099-03", "2099-01"])).toEqual(["2099-03", "2099-02"]);
    expect(reportList(reportListFixture())).toEqual([]);
    expect(() => reportList(reportListFixture(["2099-01", "2099-01"]))).toThrow();
    const changed = reportListFixture(["2099-01"]);
    changed.responseParam.periodDetails[0]!.month = "1";
    expect(() => reportList(changed)).toThrow();
    expect(() => reportList(reportListFixture(Array(121).fill("2099-01")))).toThrow();
  });
  test("validates canonical base64, size, PDF magic, exact month echo and strict fields", () => {
    expect(new TextDecoder().decode(reportPdf(reportDownloadFixture("2099-01"), "2099-01"))).toBe(
      PDF_TEXT,
    );
    const mutations = [
      (value: ReturnType<typeof reportDownloadFixture>) => {
        value.responseParam.month = "02";
      },
      (value: ReturnType<typeof reportDownloadFixture>) => {
        value.responseParam.fileSize = "1";
      },
      (value: ReturnType<typeof reportDownloadFixture>) => {
        value.responseParam.fileSize = "1048577";
      },
      (value: ReturnType<typeof reportDownloadFixture>) => {
        value.responseParam.fileStream += "\n";
      },
      (value: ReturnType<typeof reportDownloadFixture>) => {
        value.header.adapterResultCode = "unknown";
      },
      (value: ReturnType<typeof reportDownloadFixture>) => {
        Object.assign(value.responseParam, { unknown: "private" });
      },
    ];
    for (const mutate of mutations) {
      const value = reportDownloadFixture("2099-01");
      mutate(value);
      expect(() => reportPdf(value, "2099-01")).toThrow("monthly_report_response_invalid");
    }
    expect(() =>
      reportPdf(reportDownloadFixture("2099-01", "<html>not PDF</html>"), "2099-01"),
    ).toThrow();
  });
  test("keeps valid PDFs after a sibling fails and excludes transient provider metadata", () => {
    const result = parseMonthlyReports(
      {
        list: JSON.stringify(reportListFixture(["2099-01", "2099-02"])),
        downloads: [
          { year: "2099", month: "02", raw: JSON.stringify(reportDownloadFixture("2099-02")) },
          { year: "2099", month: "01", raw: JSON.stringify(reportDownloadFixture("2099-03")) },
        ],
      },
      [],
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.filename).toBe("monthly-report-2099-02.pdf");
    expect(result.artifacts[0]!.mediaType).toBe("application/pdf");
    expect(result.failures).toEqual([
      {
        operation: "read:monthly-reports",
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      },
    ]);
    for (const privateText of ["synthetic-private", "fileName", "mailID", "eStatementStatus"])
      expect(JSON.stringify(result)).not.toContain(privateText);
  });
  test("omitted/duplicate/out-of-order periods never become complete or silently disappear", () => {
    const prefix = parseMonthlyReports(
      {
        list: JSON.stringify(reportListFixture(["2099-01", "2099-02"])),
        downloads: [
          { year: "2099", month: "02", raw: JSON.stringify(reportDownloadFixture("2099-02")) },
        ],
      },
      [],
    );
    expect(prefix.artifacts).toHaveLength(1);
    expect(prefix.failures).toHaveLength(1);
    for (const downloads of [
      [],
      [{ year: "2099", month: "02", errorCode: "report_read_failed" }],
      [{ year: "2099", month: "01", errorCode: "private-provider-text" }],
    ]) {
      expect(
        parseMonthlyReports({ list: JSON.stringify(reportListFixture(["2099-01"])), downloads }, [])
          .failures.length,
      ).toBeGreaterThan(0);
    }
  });
  test("reads only registered document months and refuses unavailable inventory", async () => {
    const db = {
      prepare: (value: string) => {
        void value;
        return { all: async () => ({ success: true, results: [{ period: "2099-01" }] }) };
      },
    } as unknown as D1Database;
    expect(await storedReportPeriods(db)).toEqual(["2099-01"]);
    await expect(
      storedReportPeriods({
        prepare: () => ({ all: async () => ({ success: false, results: [] }) }),
      } as unknown as D1Database),
    ).rejects.toThrow("report_inventory_unavailable");
  });
});
