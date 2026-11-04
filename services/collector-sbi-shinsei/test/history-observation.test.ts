import { describe, expect, test } from "bun:test";
import {
  buildObservedYenPeriodRequest,
  HistoryInspectionError,
  inspectObservedHistoryCsv,
  inspectObservedHistoryResponse,
} from "../src/local/history-observation";
import { assertReadAllowed, getReadRoute } from "../src/read-allowlist";
import { UnverifiedReadRouteError } from "../src/errors";

const scope = { accountNo: "111111111111111", fromDate: "20300101", toDate: "20300131" };
const syntheticRows = [
  {
    txnReferenceNo: "synthetic-a",
    description: "Synthetic debit",
    credit: "",
    debit: "12.50",
    postingDate: "2030/01/02",
    balance: "80.00",
    tradeTypeCode: "synthetic-code",
  },
  {
    txnReferenceNo: "synthetic-b",
    description: "Synthetic credit",
    credit: "7.00",
    debit: "",
    postingDate: "2030/01/03",
    balance: "87.00",
    tradeTypeCode: "synthetic-code",
  },
];
const syntheticWrapper = (responseParam: unknown, statusID = "00000") => ({
  requestParam: { nationalid: "synthetic-owner" },
  responseParam,
  header: {
    referenceNo: "synthetic-reference",
    systemCode: "synthetic-system",
    langCode: "synthetic-language",
  },
  errorInfo: { statusID, statusMessage: "synthetic-status-message" },
});
function success() {
  return {
    requestParam: { accountActivityDetails: [] },
    header: { adapterResultCode: "0" },
    responseParam: {
      activity: syntheticWrapper({
        type: "1",
        fromDate: "2030/01/01",
        toDate: "2030/01/31",
        purgeflag: "Y",
        currentBalance: "87.00",
        accountNo: scope.accountNo,
        currency: "JPY",
        activityDetails: structuredClone(syntheticRows),
      }),
      memoInquiry: syntheticWrapper({
        memoInquiryDetails: syntheticRows.map((row) => ({
          txnReferenceNo: row.txnReferenceNo,
          memo: "",
        })),
      }),
      summaryColumnTransformation: syntheticWrapper({
        descriptionTransformDetails: syntheticRows.map((row) => ({
          txnReferenceNo: row.txnReferenceNo,
          descriptionTransform: row.description,
        })),
      }),
      sysTimeForCsvDownload: "synthetic-time",
    },
  };
}
function empty() {
  return {
    requestParam: { accountActivityDetails: [] },
    header: { adapterResultCode: "0" },
    responseParam: {
      activity: syntheticWrapper(
        {
          type: "",
          fromDate: "",
          toDate: "",
          purgeflag: "",
          currentBalance: "",
          accountNo: "",
          currency: "",
          activityDetails: [],
        },
        "30224",
      ),
      sysTimeForCsvDownload: "synthetic-time",
    },
  };
}
const inspect = (value: unknown) =>
  inspectObservedHistoryResponse(scope, {
    status: 200,
    mediaType: "application/json",
    body: JSON.stringify(value),
  });
const csv =
  "取引日,摘要,出金金額,入金金額,残高,メモ\r\n2030/01/02,Synthetic debit,12.50,,80.00,\r\n2030/01/03,Synthetic credit,,7.00,87.00,\r\n";
const csvResponse = (decodedText = csv) => ({
  status: 200,
  contentType: "text/csv;charset=Shift_JIS",
  decodedText,
  requestContext: scope,
});

describe("offline observed yen period contracts", () => {
  test("builds only the observed explicit-period request and does not enable its route", () => {
    expect(buildObservedYenPeriodRequest(scope)).toEqual({
      operation: "account.casa-activity-specific-period",
      body: { requestParam: { ...scope, type: "1", eventType: "3" } },
    });
    const route = getReadRoute("account.casa-activity-specific-period");
    expect(() =>
      assertReadAllowed({
        operation: route.operation,
        method: route.method,
        url: `${route.origin}${route.path}`,
      }),
    ).toThrow(UnverifiedReadRouteError);
  });

  test.each([
    { ...scope, accountNo: "synthetic-not-an-account" },
    { ...scope, fromDate: "2030/01/01" },
    { ...scope, fromDate: "20300230" },
    { ...scope, fromDate: "20300132" },
    { ...scope, fromDate: "20301301" },
    { ...scope, fromDate: "00000101" },
    { ...scope, fromDate: "20300201" },
    { ...scope, toDate: "20300201" },
  ])("rejects unsupported requests with a closed code", (request) => {
    expect(() => buildObservedYenPeriodRequest(request)).toThrow("history_request_invalid");
  });

  test("handles leap dates without accepting overflow dates", () => {
    expect(
      buildObservedYenPeriodRequest({ ...scope, fromDate: "20320229", toDate: "20320229" })
        .operation,
    ).toBe("account.casa-activity-specific-period");
    expect(() =>
      buildObservedYenPeriodRequest({ ...scope, fromDate: "20310229", toDate: "20310301" }),
    ).toThrow("history_request_invalid");
  });

  test("validates a stated period and context but never claims complete coverage", () => {
    const result = inspect(success());
    expect(result.outcome).toBe("rows_observed");
    expect(result.periodEchoVerified).toBeTrue();
    expect(result.rows).toEqual(syntheticRows);
    expect(result.coverageStatus).toBe("unknown");
    expect(result.reasonCodes).toEqual([
      "history_continuation_unverified",
      "history_purge_semantics_unverified",
    ]);
    expect(result.memos.size).toBe(2);
  });

  test("recognizes the observed empty status without inventing a period echo", () => {
    const result = inspect(empty());
    expect(result.outcome).toBe("provider_reported_empty");
    expect(result.rows).toEqual([]);
    expect(result.periodEchoVerified).toBeFalse();
    expect(result.coverageStatus).toBe("unknown");
    expect(result.reasonCodes).toContain("history_empty_period_unconfirmed");
    expect(() => inspectObservedHistoryCsv(result, csvResponse())).toThrow(
      "history_context_mismatch",
    );
  });

  test("other application failures never become a normal empty response", () => {
    const value = empty();
    value.responseParam.activity.errorInfo.statusID = "99999";
    expect(() => inspect(value)).toThrow("history_provider_status_unverified");
    value.header.adapterResultCode = "1";
    expect(() => inspect(value)).toThrow("history_provider_status_unverified");
  });

  test("does not accept the empty code with successful or partially filled content", () => {
    const populated = success();
    populated.responseParam.activity.errorInfo.statusID = "30224";
    expect(() => inspect(populated)).toThrow(HistoryInspectionError);
    const partial = empty();
    partial.responseParam.activity.responseParam = { accountNo: scope.accountNo };
    expect(() => inspect(partial)).toThrow("history_shape_unverified");
    const noRowsSuccess = empty();
    noRowsSuccess.responseParam.activity.errorInfo.statusID = "00000";
    expect(() => inspect(noRowsSuccess)).toThrow("history_shape_unverified");
  });

  test.each(["accountNo", "currency", "fromDate", "toDate", "type"])(
    "refuses mismatched %s",
    (field) => {
      const value = success();
      const activity = value.responseParam.activity.responseParam as Record<string, unknown>;
      activity[field] = field.endsWith("Date") ? "2030/02/01" : "synthetic-other";
      expect(() => inspect(value)).toThrow("history_context_mismatch");
    },
  );

  test("rejects unknown shapes at every layer without quoting a value", () => {
    const locations = [
      [],
      ["header"],
      ["requestParam"],
      ["responseParam"],
      ["responseParam", "activity"],
      ["responseParam", "activity", "requestParam"],
      ["responseParam", "activity", "header"],
      ["responseParam", "activity", "errorInfo"],
      ["responseParam", "activity", "responseParam"],
    ];
    for (const path of locations) {
      const value = success();
      let target: Record<string, unknown> = value;
      for (const key of path) target = target[key] as Record<string, unknown>;
      target["synthetic-provider-private-key"] = "synthetic-provider-private-value";
      expect(() => inspect(value)).toThrow("history_shape_unverified");
    }
  });

  test("rejects row duplicates, context drift, invalid money and out-of-period postings", () => {
    for (const patch of [
      { txnReferenceNo: syntheticRows[0]!.txnReferenceNo },
      { postingDate: "2030/02/01" },
      { debit: "1e2" },
      { balance: "NaN" },
      { debit: "1.00", credit: "2.00" },
      { debit: "", credit: "" },
    ]) {
      const value = success();
      const activity = value.responseParam.activity.responseParam as {
        activityDetails: Record<string, unknown>[];
      };
      Object.assign(activity.activityDetails[1]!, patch);
      expect(() => inspect(value)).toThrow(HistoryInspectionError);
    }
    const value = success();
    value.responseParam.memoInquiry.requestParam.nationalid = "synthetic-other-owner";
    expect(() => inspect(value)).toThrow("history_context_mismatch");
  });

  test("requires complete matching auxiliary rows without interpreting them", () => {
    for (const kind of ["missing", "duplicate", "other", "failed"] as const) {
      const value = success();
      const memo = value.responseParam.memoInquiry.responseParam as {
        memoInquiryDetails: { txnReferenceNo: string; memo: string }[];
      };
      if (kind === "missing") memo.memoInquiryDetails.pop();
      if (kind === "duplicate") memo.memoInquiryDetails[1] = { ...memo.memoInquiryDetails[0]! };
      if (kind === "other") memo.memoInquiryDetails[1]!.txnReferenceNo = "synthetic-unknown";
      if (kind === "failed") value.responseParam.memoInquiry.errorInfo.statusID = "99999";
      expect(() => inspect(value)).toThrow(HistoryInspectionError);
    }
  });

  test("refuses HTTP/auth/content-type, malformed JSON and oversized decoded bodies", () => {
    for (const status of [302, 401, 403, 429, 500]) {
      expect(() =>
        inspectObservedHistoryResponse(scope, {
          status,
          mediaType: "application/json",
          body: "{}",
        }),
      ).toThrow("history_response_unavailable");
    }
    expect(() =>
      inspectObservedHistoryResponse(scope, {
        status: 200,
        mediaType: "text/html",
        body: "synthetic-challenge",
      }),
    ).toThrow("history_response_unavailable");
    for (const body of ["not-json", " ".repeat(2 * 1024 * 1024 + 1)]) {
      expect(() =>
        inspectObservedHistoryResponse(scope, { status: 200, mediaType: "application/json", body }),
      ).toThrow("history_body_invalid");
    }
    for (const value of [
      null,
      [],
      {},
      { ...success(), requestParam: { accountActivityDetails: [{}] } },
    ]) {
      expect(() => inspect(value)).toThrow("history_shape_unverified");
    }
  });
});

describe("offline decoded Shift_JIS CSV observation", () => {
  test("compares all six fields without claiming byte-exact persistence or complete history", () => {
    expect(inspectObservedHistoryCsv(inspect(success()), csvResponse())).toEqual({
      rowCount: 2,
      coverageStatus: "unknown",
      byteExact: false,
      persisted: false,
    });
  });

  test("requires declared Shift_JIS, safe status and matching request provenance", () => {
    const history = inspect(success());
    for (const contentType of [
      "text/csv",
      "text/csv;charset=UTF-8",
      "text/html;charset=Shift_JIS",
    ]) {
      expect(() => inspectObservedHistoryCsv(history, { ...csvResponse(), contentType })).toThrow(
        "history_csv_charset_unverified",
      );
    }
    expect(() => inspectObservedHistoryCsv(history, { ...csvResponse(), status: 403 })).toThrow(
      "history_response_unavailable",
    );
    for (const requestContext of [
      { ...scope, accountNo: "222222222222222" },
      { ...scope, fromDate: "20300102" },
      { ...scope, toDate: "20300130" },
    ]) {
      expect(() =>
        inspectObservedHistoryCsv(history, { ...csvResponse(), requestContext }),
      ).toThrow("history_context_mismatch");
    }
  });

  test("refuses missing, extra, reordered, altered or malformed CSV rows", () => {
    const history = inspect(success());
    const lines = csv.split("\r\n");
    for (const text of [
      "",
      csv.replace("取引日", "synthetic-unknown-header"),
      [lines[0], lines[1], ""].join("\r\n"),
      [lines[0], lines[2], lines[1], ""].join("\r\n"),
      csv.replace("12.50", "12.51"),
      csv.replace("Synthetic debit", "Synthetic other"),
      csv.replaceAll("\r\n", "\n"),
      csv.replace("Synthetic debit", '"unterminated'),
      csv.replace("Synthetic debit", '"closed"junk'),
      csv.replace("Synthetic debit", 'not"quoted'),
      csv.replace("Synthetic debit", "\uFFFD"),
      csv.replace("Synthetic debit", "extra,column"),
    ])
      expect(() => inspectObservedHistoryCsv(history, csvResponse(text))).toThrow(
        HistoryInspectionError,
      );
    expect(() =>
      inspectObservedHistoryCsv(history, csvResponse("x".repeat(2 * 1024 * 1024 + 1))),
    ).toThrow("history_body_invalid");
  });

  test("handles quoted commas, escaped quotes and final row without a terminator", () => {
    const value = success();
    const activity = value.responseParam.activity.responseParam as {
      activityDetails: { description: string }[];
    };
    activity.activityDetails[0]!.description = 'Synthetic, "quoted" debit';
    const text = csv.replace("Synthetic debit", '"Synthetic, ""quoted"" debit"').trimEnd();
    expect(inspectObservedHistoryCsv(inspect(value), csvResponse(text)).rowCount).toBe(2);
  });
});
