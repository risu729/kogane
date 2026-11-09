// Deterministic value-normalization helpers shared by parsers.
//
// The rule these follow throughout: refuse rather than guess. Every function
// returns undefined when the input does not resolve exactly, so the caller can
// record a warning and keep the row instead of storing a value the source
// never stated.

// The minor-unit table lives in ../money.ts so the parsers, the HTTP API, and
// the browser client all share one definition of a currency's scale.
export { minorUnitExponent } from "../money.ts";
import { minorUnitExponent } from "../money.ts";

import type { ArtifactMeta } from "../types.ts";

/**
 * Design review D13: a parser's "the capture succeeded" precondition is about
 * the range it is parsing, not necessarily about the whole fetch run. This is
 * the one relaxation: the caller (the pipeline Worker, or the local store's
 * artifact listing) sets `unitScopeEligibility` when the artifact's dataset
 * names the `unit` scope in `dataset_snapshot_policies` AND the artifact's own
 * fetch unit reported terminal success, so an independent card that succeeded
 * is parseable even though a sibling card failed and the run is `partial`.
 *
 * A parser never decides the policy itself, and no dataset is seeded on the
 * `unit` scope, so this returns false for every artifact today and every
 * parser precondition is byte-for-byte the pre-PR-14 rule.
 */
export function unitScopeAdmitted(artifact: Pick<ArtifactMeta, "unitScopeEligibility">): boolean {
  return artifact.unitScopeEligibility === "unit-independent-v1";
}

/**
 * Validate digit grouping and remove it. Commas are only accepted as
 * thousands separators in a well-formed group pattern, because a source that
 * writes "1024,53" means 1024.53 and stripping the comma would inflate the
 * value a hundredfold.
 */
function stripGrouping(text: string): string | undefined {
  const parts = text.split(".");
  if (parts.length > 2) return undefined;
  const whole = parts[0] ?? "";
  const fraction = parts[1];
  if (fraction !== undefined && !/^\d+$/u.test(fraction)) return undefined;
  let digits: string;
  if (whole.includes(",")) {
    if (!/^\d{1,3}(?:,\d{3})+$/u.test(whole)) return undefined;
    digits = whole.replaceAll(",", "");
  } else {
    if (!/^\d+$/u.test(whole)) return undefined;
    digits = whole;
  }
  return fraction === undefined ? digits : `${digits}.${fraction}`;
}

/**
 * Scale a validated unsigned decimal string to minor units. Digits beyond the
 * currency's scale are accepted only when they are all zero — "1.230" USD is
 * exactly 123 cents, while "1.234" USD is not representable and is refused.
 */
function scaleDecimal(text: string, exponent: number, negative: boolean): number | undefined {
  const parts = text.split(".");
  const whole = parts[0] ?? "";
  let fraction = parts[1] ?? "";
  if (fraction.length > exponent) {
    if (!/^0*$/u.test(fraction.slice(exponent))) return undefined;
    fraction = fraction.slice(0, exponent);
  }
  const value = Number(whole + fraction.padEnd(exponent, "0"));
  if (!Number.isSafeInteger(value)) return undefined;
  if (value === 0) return 0; // never produce negative zero
  return negative ? -value : value;
}

/**
 * Parse a provider-displayed amount string into signed minor units.
 * Handles thousands separators, a leading `+`/`-`, the `△`/`▲` negative
 * markers used by Japanese financial sites, and parenthesized negatives.
 * Two negative markers on one value are ambiguous and are refused rather
 * than silently resolved.
 */
export function amountToMinorUnits(raw: string, currency: string): number | undefined {
  const exponent = minorUnitExponent(currency);
  if (exponent === undefined) return undefined;
  let text = raw.trim();
  if (text === "") return undefined;
  let negative = false;
  if (/^\(.*\)$/u.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("△") || text.startsWith("▲")) {
    if (negative) return undefined;
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("-")) {
    if (negative) return undefined;
    negative = true;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  const normalized = stripGrouping(text);
  if (normalized === undefined) return undefined;
  return scaleDecimal(normalized, exponent, negative);
}

/**
 * Convert a decimal string into signed minor units. Input is validated here
 * rather than trusted, because this is exported and an empty string must never
 * become zero yen.
 */
export function decimalToMinorUnits(text: string, currency: string): number | undefined {
  const exponent = minorUnitExponent(currency);
  if (exponent === undefined) return undefined;
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return undefined;
  return scaleDecimal(text.replace(/^[+-]/u, ""), exponent, text.startsWith("-"));
}

/**
 * Normalize a JSON number-or-string into a decimal string plus scale, without
 * ever passing through floating point when the input is already a string.
 *
 * A JSON number is only accepted when it is an integer within the safe range:
 * `JSON.parse` has already rounded anything larger, so the value on hand is no
 * longer what the provider sent and must not be recorded as if it were.
 */
export function decimalText(value: unknown): { text: string; scale: number } | undefined {
  let text: string;
  if (typeof value === "string") {
    let unsigned = value.trim();
    let sign = "";
    if (unsigned.startsWith("-") || unsigned.startsWith("+")) {
      sign = unsigned.startsWith("-") ? "-" : "";
      unsigned = unsigned.slice(1);
    }
    const normalized = stripGrouping(unsigned);
    if (normalized === undefined) return undefined;
    text = sign + normalized;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) return undefined;
    text = String(value);
  } else {
    return undefined;
  }
  const fraction = text.split(".")[1] ?? "";
  return { text, scale: fraction.length };
}

export interface CsvWarning {
  /** One-based logical row, excluding empty lines, as in csv:row locators. */
  row: number;
  column: number;
  code: "unclosed_quote" | "text_after_quote";
}

export function csvWarningText(warning: CsvWarning): string {
  const reason =
    warning.code === "unclosed_quote"
      ? "unclosed CSV quote read literally"
      : "text after closing CSV quote joined to field";
  return `row ${warning.row}: column ${warning.column}: ${reason}`;
}

/**
 * RFC 4180 fields, with bounded recovery for malformed quotes. An opener
 * without a closing quote is literal, so its physical line ends the row.
 * Valid quoted multiline fields retain their CSV meaning. If the first
 * undoubled closing quote has trailing text on a later physical line, it
 * cannot close the field: recover at the opening line instead. Same-line
 * trailing text keeps the historical concatenation, with a warning.
 */
export function parseCsv(text: string, warnings: CsvWarning[] = []): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  const finishRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    field = "";
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"' && field === "") {
      let close = index + 1;
      let multiline = false;
      for (; close < text.length; close += 1) {
        const next = text[close];
        if (next === "\n" || next === "\r") multiline = true;
        if (next !== '"') continue;
        if (text[close + 1] === '"') {
          close += 1;
          continue;
        }
        break;
      }
      const after = text[close + 1];
      const trailingText = after !== undefined && after !== "," && after !== "\n" && after !== "\r";
      if (close === text.length || (multiline && trailingText)) {
        warnings.push({ row: rows.length + 1, column: row.length + 1, code: "unclosed_quote" });
        field += character;
      } else {
        field = text.slice(index + 1, close).replaceAll('""', '"');
        if (trailingText)
          warnings.push({ row: rows.length + 1, column: row.length + 1, code: "text_after_quote" });
        index = close;
      }
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    finishRow();
  }
  return rows;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode artifact bytes as UTF-8, refusing malformed input rather than
 * producing replacement characters. Several Japanese sources emit Shift-JIS
 * (CP932); those artifacts fail here and become an error parse run, which is
 * recoverable — see RESULTS.md, "encoding is not yet carried on the artifact".
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "artifact bytes are not valid UTF-8; the artifact's encoding is not recorded, so no decoder can be selected",
    );
  }
}
