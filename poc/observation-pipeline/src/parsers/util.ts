// Deterministic value-normalization helpers shared by parsers.

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
 * Parse a provider-displayed amount string into signed minor units.
 * Handles thousands separators, a leading `+`/`-`, the `△` negative marker
 * used by Japanese financial sites, and parenthesized negatives.
 * Returns undefined (never a guess) when the string does not resolve to an
 * exact amount at the currency's minor-unit scale.
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
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("-")) {
    negative = !negative ? true : negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  text = text.replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return undefined;
  const [wholePart = "", fractionPart = ""] = text.split(".");
  if (fractionPart.length > exponent) return undefined; // would lose precision
  const scaled = wholePart + fractionPart.padEnd(exponent, "0");
  const value = Number(scaled);
  if (!Number.isSafeInteger(value)) return undefined;
  return negative ? -value : value;
}

/**
 * Convert an already-validated decimal string (as produced by decimalText)
 * into signed minor units, or undefined if the currency is unknown, precision
 * would be lost, or the result leaves the safe-integer range.
 */
export function decimalToMinorUnits(
  text: string,
  currency: string,
): number | undefined {
  const exponent = minorUnitExponent(currency);
  if (exponent === undefined) return undefined;
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/u, "");
  const [wholePart = "", fractionPart = ""] = unsigned.split(".");
  if (fractionPart.length > exponent) return undefined;
  const value = Number(wholePart + fractionPart.padEnd(exponent, "0"));
  if (!Number.isSafeInteger(value)) return undefined;
  return negative ? -value : value;
}

/**
 * Normalize a JSON number-or-string into a decimal string plus scale, without
 * ever passing through floating point when the input is already a string.
 */
export function decimalText(
  value: unknown,
): { text: string; scale: number } | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value.trim().replaceAll(",", "");
  } else if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isInteger(value)) return undefined; // refuse float-derived decimals
    text = String(value);
  } else {
    return undefined;
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return undefined;
  const fraction = text.split(".")[1] ?? "";
  return { text, scale: fraction.length };
}

/** Minimal RFC 4180 CSV: quoted fields, embedded commas/quotes/newlines. */
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
    if (character === '"') {
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

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
