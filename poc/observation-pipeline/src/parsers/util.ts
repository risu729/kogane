// Deterministic value-normalization helpers shared by parsers.
//
// The rule these follow throughout: refuse rather than guess. Every function
// returns undefined when the input does not resolve exactly, so the caller can
// record a warning and keep the row instead of storing a value the source
// never stated.

/** Minor-unit exponents for the currencies the PoC sources actually report. */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0,
  USD: 2,
  AUD: 2,
};

export function minorUnitExponent(currency: string): number | undefined {
  return MINOR_UNIT_EXPONENT[currency];
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
function scaleDecimal(
  text: string,
  exponent: number,
  negative: boolean,
): number | undefined {
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
export function amountToMinorUnits(
  raw: string,
  currency: string,
): number | undefined {
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
export function decimalToMinorUnits(
  text: string,
  currency: string,
): number | undefined {
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
export function decimalText(
  value: unknown,
): { text: string; scale: number } | undefined {
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

/**
 * Minimal RFC 4180 CSV: quoted fields, embedded commas/quotes/newlines.
 * A quote only opens a quoted field at the start of a field; elsewhere it is
 * a literal character, so a description containing an inch mark does not
 * swallow the following delimiter.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
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
