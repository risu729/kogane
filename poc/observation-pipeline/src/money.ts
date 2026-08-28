// Money formatting and minor-unit rules, shared by the parsers, the HTTP API,
// and the browser client. Nothing here imports a runtime API, so the same
// module runs on Bun, on Workers, and in the browser — one definition of what
// an amount means, rather than three that can drift apart.

/** Minor-unit exponents for the currencies the PoC sources actually report. */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0,
  USD: 2,
  AUD: 2,
};

export function minorUnitExponent(currency: string): number | undefined {
  return MINOR_UNIT_EXPONENT[currency];
}

function groupDigits(digits: string): string {
  let grouped = "";
  for (let end = digits.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    grouped = digits.slice(start, end) + (grouped === "" ? "" : `,${grouped}`);
  }
  return grouped === "" ? "0" : grouped;
}

/**
 * Format an amount for display. Minor units are formatted by string and BigInt
 * manipulation only: an amount never passes through floating point, not even
 * on its way to a screen. When the instrument has no known minor-unit exponent
 * the integer is shown as-is and labelled, rather than guessing a scale. When
 * amountMinor is null the stored decimal string is shown verbatim.
 *
 * Intl.NumberFormat is deliberately not used: it takes a Number, so every
 * amount would round-trip through a double on its way to the screen.
 */
export function formatAmount(
  amountMinor: number | bigint | string | null | undefined,
  unit: string | null | undefined,
  amountText?: string | null,
): string {
  const suffix = unit ? ` ${unit}` : "";
  if (amountMinor === null || amountMinor === undefined) {
    if (amountText === null || amountText === undefined || amountText === "") return "";
    return `${amountText}${suffix}`;
  }
  if (typeof amountMinor === "number" && !Number.isInteger(amountMinor)) {
    return `${String(amountMinor)}${suffix}`; // not a minor-unit integer; show as stored
  }
  // A JSON body carries an integer amount as a string when it might exceed the
  // safe range, so a malformed one is shown verbatim rather than coerced.
  let value: bigint;
  try {
    value = BigInt(amountMinor);
  } catch {
    return `${String(amountMinor)}${suffix}`;
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const exponent = unit ? minorUnitExponent(unit) : undefined;
  if (exponent === undefined) {
    return `${negative ? "-" : ""}${groupDigits(digits)}${suffix} (minor units)`;
  }
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = exponent > 0 ? padded.slice(padded.length - exponent) : "";
  const body = fraction === "" ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
  return `${negative ? "-" : ""}${body}${suffix}`;
}

/** Sign of an amount, for styling. Never used for arithmetic. */
export function amountSign(
  amountMinor: number | bigint | string | null | undefined,
): "positive" | "negative" | "zero" | "unknown" {
  if (amountMinor === null || amountMinor === undefined) return "unknown";
  try {
    const value = BigInt(amountMinor);
    if (value > 0n) return "positive";
    if (value < 0n) return "negative";
    return "zero";
  } catch {
    return "unknown";
  }
}
