import { describe, expect, spyOn, test } from "bun:test";
import {
  CsvByteLineageError,
  inspectCsvByteLineage,
  type CsvByteInputs,
} from "../src/local/csv-byte-lineage";
import type { HistoryInspection } from "../src/local/history-observation";

const scope = { accountNo: "111111111111111", fromDate: "20300101", toDate: "20300131" };
const description = "Synthetic private-looking text";
const history: HistoryInspection = {
  outcome: "rows_observed",
  coverageStatus: "unknown",
  reasonCodes: ["history_continuation_unverified"],
  requestContext: scope,
  periodEchoVerified: true,
  rows: [
    {
      txnReferenceNo: "synthetic-reference",
      description,
      debit: "12.50",
      credit: "",
      postingDate: "2030/01/02",
      balance: "80.00",
      tradeTypeCode: "synthetic-code",
    },
  ],
  memos: new Map([["synthetic-reference", ""]]),
};
const header = "取引日,摘要,出金金額,入金金額,残高,メモ\r\n";
const body = "2030/01/02," + description + ",12.50,,80.00,\r\n";
const text = header + body;
const response = {
  status: 200,
  contentType: "text/csv;charset=Shift_JIS",
  decodedText: text,
  requestContext: scope,
};
const utf8 = (value: string) => new TextEncoder().encode(value);
// Synthetic header encoded as CP932/WHATWG Shift_JIS; ASCII body needs no mapping.
const headerHex =
  "8ee688f893fa2c934597762c8f6f8be08be08a7a2c93fc8be08be08a7a2c8e638d822c838183820d0a";
const http = Uint8Array.from([
  ...Array.from(headerHex.matchAll(/../gu), (match) => Number.parseInt(match[0], 16)),
  ...utf8(body),
]);
const browser = utf8("\uFEFF" + text);
const inspect = (bytes: CsvByteInputs) => inspectCsvByteLineage(history, response, bytes);

describe("offline CSV byte lineage comparisons", () => {
  test("keeps decoded-only observation distinct from absent bytes", () => {
    const result = inspect({});
    expect(result.rowCount).toBe(1);
    expect(result.httpResponse.comparison).toEqual({ supplied: false });
    expect(result.browserArtifact.comparison).toEqual({ supplied: false });
    expect(result.decodedText).toEqual({
      representation: "decoded_text",
      utf8ByteLength: utf8(text).byteLength,
    });
    expect(result.coverageStatus).toBe("unknown");
    expect(result.comparisonOnly).toBe(true);
    expect(result.captureVerified).toBe(false);
    expect(result.providerOriginVerified).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.registrationReady).toBe(false);
  });

  test("strictly compares both byte representations without declaring provider provenance", () => {
    const result = inspect({ httpResponseBytes: http, browserArtifactBytes: browser });
    expect(result.httpResponse).toEqual({
      representation: "candidate_http_response_bytes",
      declaredEncoding: "shift_jis",
      comparison: { supplied: true, byteLength: http.byteLength, matched: true },
    });
    expect(result.browserArtifact).toEqual({
      representation: "browser_derived_utf8_bom",
      transformation: "decoded_text_prefixed_bom_then_utf8",
      comparison: { supplied: true, byteLength: browser.byteLength, matched: true },
    });
    expect(result.providerOriginVerified).toBe(false);
    expect(result.captureVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain(description);
    expect(JSON.stringify(result)).not.toContain(scope.accountNo);
    expect(JSON.stringify(result)).not.toContain("12.50");
    expect(JSON.stringify(result)).not.toContain("2030/01/02");
  });

  test("checks each supplied representation independently", () => {
    expect(inspect({ httpResponseBytes: http }).browserArtifact.comparison).toEqual({
      supplied: false,
    });
    expect(inspect({ browserArtifactBytes: browser }).httpResponse.comparison).toEqual({
      supplied: false,
    });
  });

  test("accepts exact subarray bytes without consuming surrounding data or mutating input", () => {
    const surrounded = Uint8Array.from([0xff, ...browser, 0xff]);
    const before = surrounded.slice();
    expect(
      inspect({ browserArtifactBytes: surrounded.subarray(1, surrounded.length - 1) })
        .browserArtifact.comparison,
    ).toEqual({ supplied: true, byteLength: browser.byteLength, matched: true });
    expect(surrounded).toEqual(before);
  });

  test("matches actual synthetic Blob construction", async () => {
    const bytes = new Uint8Array(
      await new Blob(["\uFEFF", text], { type: "text/csv" }).arrayBuffer(),
    );
    expect(inspect({ browserArtifactBytes: bytes }).browserArtifact.comparison).toEqual({
      supplied: true,
      byteLength: bytes.byteLength,
      matched: true,
    });
  });

  test.each([
    utf8(text),
    utf8("\uFEFF\uFEFF" + text),
    utf8("\uFEFF" + text.replaceAll("\r\n", "\n")),
    utf8("\uFEFF" + text.replace("12.50", "12.5")),
    Uint8Array.from([0xef, 0xbb, 0xbf, 0xff]),
    new Uint8Array(),
    http,
  ])(
    "rejects missing/double BOM, normalization, invalid bytes and swapped representations",
    (bytes) => {
      expect(() => inspect({ browserArtifactBytes: bytes })).toThrow(
        "history_csv_browser_bytes_mismatch",
      );
    },
  );

  test("rejects invalid and incomplete Shift_JIS without returning decoder details", () => {
    for (const invalid of [new Uint8Array([0x82]), new Uint8Array([0x82, 0x22])]) {
      try {
        inspect({ httpResponseBytes: invalid });
        throw new Error("unexpected_success");
      } catch (error) {
        expect(error).toBeInstanceOf(CsvByteLineageError);
        expect((error as Error).message).toBe("history_csv_http_decode_failed");
      }
    }
  });

  test("rejects valid Shift_JIS that does not match the decoded observation", () => {
    expect(() => inspect({ httpResponseBytes: utf8("synthetic different response") })).toThrow(
      "history_csv_http_text_mismatch",
    );
    expect(() => inspect({ httpResponseBytes: new Uint8Array() })).toThrow(
      "history_csv_http_text_mismatch",
    );
    expect(() => inspect({ httpResponseBytes: browser })).toThrow(CsvByteLineageError);
  });

  test.each(["\uD800", "\uDC00"])("rejects lossy isolated UTF-16 surrogates", (surrogate) => {
    expect(() =>
      inspectCsvByteLineage(history, { ...response, decodedText: text + surrogate }, {}),
    ).toThrow("history_csv_unicode_invalid");
  });

  test("rejects replacement characters through the existing CSV inspection boundary", () => {
    expect(() =>
      inspectCsvByteLineage(history, { ...response, decodedText: text + "\uFFFD" }, {}),
    ).toThrow("history_body_invalid");
  });

  test("accepts valid scalar pairs without silently normalizing Unicode", () => {
    const unicodeDescription = "Synthetic \u{1F642} e\u0301";
    const unicodeText = text.replace(description, unicodeDescription);
    const unicodeHistory = {
      ...history,
      rows: history.rows.map((row) => ({ ...row, description: unicodeDescription })),
    };
    const unicodeResponse = { ...response, decodedText: unicodeText };
    const exactBytes = utf8("\uFEFF" + unicodeText);
    expect(
      inspectCsvByteLineage(unicodeHistory, unicodeResponse, { browserArtifactBytes: exactBytes })
        .browserArtifact.comparison,
    ).toEqual({ supplied: true, byteLength: exactBytes.byteLength, matched: true });
    expect(() =>
      inspectCsvByteLineage(unicodeHistory, unicodeResponse, {
        browserArtifactBytes: utf8(("\uFEFF" + unicodeText).normalize("NFC")),
      }),
    ).toThrow("history_csv_browser_bytes_mismatch");
    expect(() =>
      inspectCsvByteLineage(history, { ...response, decodedText: null as unknown as string }, {}),
    ).toThrow("history_csv_unicode_invalid");
  });

  test("does not skip existing CSV content-type, context, status or row checks", () => {
    expect(() =>
      inspectCsvByteLineage(history, { ...response, contentType: "text/csv;charset=UTF-8" }, {}),
    ).toThrow("history_csv_charset_unverified");
    expect(() => inspectCsvByteLineage(history, { ...response, status: 403 }, {})).toThrow(
      "history_response_unavailable",
    );
    expect(() =>
      inspectCsvByteLineage(
        history,
        { ...response, requestContext: { ...scope, accountNo: "222222222222222" } },
        {},
      ),
    ).toThrow("history_context_mismatch");
    expect(() =>
      inspectCsvByteLineage(
        history,
        { ...response, decodedText: text.replace("12.50", "99.99") },
        {},
      ),
    ).toThrow("history_csv_rows_mismatch");
  });

  test("applies local byte and pre-encoding text budgets", () => {
    expect(() => inspect({ httpResponseBytes: new Uint8Array(2 * 1024 * 1024 + 1) })).toThrow(
      "history_csv_byte_budget_exceeded",
    );
    expect(() => inspect({ browserArtifactBytes: new Uint8Array(2 * 1024 * 1024 + 4) })).toThrow(
      "history_csv_byte_budget_exceeded",
    );
    expect(() =>
      inspectCsvByteLineage(
        history,
        { ...response, decodedText: "a".repeat(2 * 1024 * 1024 + 1) },
        {},
      ),
    ).toThrow("history_csv_byte_budget_exceeded");
    expect(() =>
      inspectCsvByteLineage(history, { ...response, decodedText: "あ".repeat(700_000) }, {}),
    ).toThrow("history_csv_byte_budget_exceeded");
  });

  test("rejects non-byte and shared-memory inputs", () => {
    expect(() => inspect({ httpResponseBytes: "synthetic" as unknown as Uint8Array })).toThrow(
      "history_csv_byte_input_invalid",
    );
    expect(() =>
      inspect({ browserArtifactBytes: new Uint8Array(new SharedArrayBuffer(4)) }),
    ).toThrow("history_csv_byte_input_invalid");
  });

  test("accepts the inclusive decoded-byte limit plus only the browser BOM", () => {
    const emptyDescriptionText = text.replace(description, "");
    const maxDescription = "a".repeat(2 * 1024 * 1024 - utf8(emptyDescriptionText).byteLength);
    const maxText = text.replace(description, maxDescription);
    const maxHistory = {
      ...history,
      rows: history.rows.map((row) => ({ ...row, description: maxDescription })),
    };
    const maxBrowser = utf8("\uFEFF" + maxText);
    const result = inspectCsvByteLineage(
      maxHistory,
      { ...response, decodedText: maxText },
      { browserArtifactBytes: maxBrowser },
    );
    expect(result.decodedText.utf8ByteLength).toBe(2 * 1024 * 1024);
    expect(result.browserArtifact.comparison).toEqual({
      supplied: true,
      byteLength: 2 * 1024 * 1024 + 3,
      matched: true,
    });
  });

  test("never requests provider data", () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        () => {
          throw new Error("unexpected_fetch");
        },
        {
          preconnect: () => {
            throw new Error("unexpected_preconnect");
          },
        },
      ),
    );
    try {
      inspect({ httpResponseBytes: http, browserArtifactBytes: browser });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
