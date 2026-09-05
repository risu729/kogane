import { decode, encode } from "iconv-lite";
import { REDACTED_BASE_VARIABLE, sanitizeHistoryHtmlText } from "./sanitize-contract";

export { REDACTED_BASE_VARIABLE } from "./sanitize-contract";

export function sanitizeHistoryHtml(html: string): Uint8Array {
  const { sanitized, originalValue } = sanitizeHistoryHtmlText(html);
  const bytes = encode(sanitized, "shift_jis");
  const roundTrip = decode(bytes, "shift_jis");
  if (roundTrip !== sanitized || !roundTrip.includes(REDACTED_BASE_VARIABLE) || roundTrip.includes(originalValue)) {
    throw new Error("history_base_variable_redaction_round_trip_invalid");
  }
  return bytes;
}
