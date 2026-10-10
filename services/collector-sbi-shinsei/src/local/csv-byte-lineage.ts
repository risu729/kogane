// Offline comparisons only. Caller-supplied bytes do not prove their origin,
// a completed download, persistence, or completeness of the requested period.
import { inspectObservedHistoryCsv, type HistoryInspection } from "./history-observation";

const MAX_CSV_BYTES = 2 * 1024 * 1024; // Local budget, not a provider limit.
const UTF8_BOM_BYTES = 3;

type DecodedCsvResponse = Parameters<typeof inspectObservedHistoryCsv>[1];

export type CsvByteLineageCode =
  | "history_csv_byte_input_invalid"
  | "history_csv_byte_budget_exceeded"
  | "history_csv_unicode_invalid"
  | "history_csv_http_decode_failed"
  | "history_csv_http_text_mismatch"
  | "history_csv_browser_bytes_mismatch";

/** No input byte, provider text, token, or decoder message enters an error. */
export class CsvByteLineageError extends Error {
  constructor(readonly code: CsvByteLineageCode) {
    super(code);
    this.name = "CsvByteLineageError";
  }
}

export interface CsvByteInputs {
  /** Caller-supplied candidate HTTP response bytes; origin is not verified. */
  readonly httpResponseBytes?: Uint8Array;
  /** Caller-supplied candidate browser download; completion is not verified. */
  readonly browserArtifactBytes?: Uint8Array;
}

type ByteComparison =
  | { readonly supplied: false }
  | { readonly supplied: true; readonly byteLength: number; readonly matched: true };

export interface CsvByteLineageInspection {
  readonly rowCount: number;
  readonly coverageStatus: "unknown";
  readonly decodedText: {
    readonly representation: "decoded_text";
    readonly utf8ByteLength: number;
  };
  readonly httpResponse: {
    readonly representation: "candidate_http_response_bytes";
    readonly declaredEncoding: "shift_jis";
    readonly comparison: ByteComparison;
  };
  readonly browserArtifact: {
    readonly representation: "browser_derived_utf8_bom";
    readonly transformation: "decoded_text_prefixed_bom_then_utf8";
    readonly comparison: ByteComparison;
  };
  readonly comparisonOnly: true;
  readonly captureVerified: false;
  readonly providerOriginVerified: false;
  readonly persisted: false;
  readonly registrationReady: false;
}

function fail(code: CsvByteLineageCode): never {
  throw new CsvByteLineageError(code);
}

function byteInput(value: Uint8Array | undefined, limit: number): Uint8Array | undefined {
  if (value === undefined) return undefined;
  // Shared memory can change during comparison; no racing source is admitted.
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer))
    fail("history_csv_byte_input_invalid");
  if (value.byteLength > limit) fail("history_csv_byte_budget_exceeded");
  return value;
}

function scalarText(text: string): void {
  if (typeof text !== "string") fail("history_csv_unicode_invalid");
  // Check before allocating an encoded copy. UTF-8 cannot use fewer bytes than
  // UTF-16 code units, so this is a safe early rejection, not the final budget.
  if (text.length > MAX_CSV_BYTES) fail("history_csv_byte_budget_exceeded");
  for (const point of text) {
    const unit = point.charCodeAt(0);
    if (point.length === 1 && unit >= 0xd800 && unit <= 0xdfff) fail("history_csv_unicode_invalid");
  }
}

/**
 * Compare the three representations without manufacturing provenance.
 * The existing CSV inspector still validates context, schema and JSON rows.
 * A missing byte input remains absent; it is never reconstructed as an original.
 */
export function inspectCsvByteLineage(
  history: HistoryInspection,
  response: DecodedCsvResponse,
  bytes: CsvByteInputs,
): CsvByteLineageInspection {
  const http = byteInput(bytes.httpResponseBytes, MAX_CSV_BYTES);
  const browser = byteInput(bytes.browserArtifactBytes, MAX_CSV_BYTES + UTF8_BOM_BYTES);
  scalarText(response.decodedText);
  const decodedBytes = new TextEncoder().encode(response.decodedText);
  if (decodedBytes.byteLength > MAX_CSV_BYTES) fail("history_csv_byte_budget_exceeded");
  const csv = inspectObservedHistoryCsv(history, response);

  if (http !== undefined) {
    let decoded: string;
    try {
      decoded = new TextDecoder("shift_jis", { fatal: true }).decode(http);
    } catch {
      return fail("history_csv_http_decode_failed");
    }
    if (decoded !== response.decodedText) fail("history_csv_http_text_mismatch");
  }
  if (browser !== undefined) {
    // File API Blob string parts are UTF-8 encoded. The observed controller
    // prefixes U+FEFF; no newline, Unicode, quote or numeric normalization occurs.
    const expected = new TextEncoder().encode("\uFEFF" + response.decodedText);
    if (
      browser.byteLength !== expected.byteLength ||
      expected.some((value, index) => value !== browser[index])
    )
      fail("history_csv_browser_bytes_mismatch");
  }
  return {
    rowCount: csv.rowCount,
    coverageStatus: "unknown",
    decodedText: {
      representation: "decoded_text",
      utf8ByteLength: decodedBytes.byteLength,
    },
    httpResponse: {
      representation: "candidate_http_response_bytes",
      declaredEncoding: "shift_jis",
      comparison:
        http === undefined
          ? { supplied: false }
          : { supplied: true, byteLength: http.byteLength, matched: true },
    },
    browserArtifact: {
      representation: "browser_derived_utf8_bom",
      transformation: "decoded_text_prefixed_bom_then_utf8",
      comparison:
        browser === undefined
          ? { supplied: false }
          : { supplied: true, byteLength: browser.byteLength, matched: true },
    },
    comparisonOnly: true,
    captureVerified: false,
    providerOriginVerified: false,
    persisted: false,
    registrationReady: false,
  };
}
