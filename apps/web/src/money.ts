// The single point of contact between the client and the pipeline's money
// rules. `formatAmount` and `amountSign` are imported from src/money.ts rather
// than reimplemented here: an amount is stored as integer minor units plus the
// provider's verbatim text, and the one formatter that knows how to widen
// minor units without floating point lives there.
//
// An exact decimal (`{ coefficient, scale }`, or its plain text as a compact
// wire quantity carries it) is formatted by `formatDecimal` below and nowhere
// else. It groups the integer digits in threes, the way `formatAmount` does,
// and keeps every fraction digit, the sign and the scale. It lives here
// rather than beside `formatAmount` because packages/parsers/src/money.ts and
// packages/domain/src/values.ts are inside the parser code digests
// (packages/parsers/scripts/parser-digests.ts): a display helper added there
// would change every parser's digest. test/money.test.ts holds the two
// formatters to the same text for every currency `formatAmount` knows.
//
// Nothing in this client may use Intl.NumberFormat, toLocaleString, parseFloat,
// or arithmetic on an amount. Keeping every amount format in this module keeps
// that rule enforceable by grep.

import { decimalToString, type ExactDecimal } from "../../../packages/domain/src/values.ts";

export {
  amountSign,
  formatAmount,
  minorUnitExponent,
} from "../../../packages/parsers/src/money.ts";

/** A plain decimal: an optional minus, integer digits, optional fraction digits. */
const PLAIN_DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/u;

function groupThousands(digits: string): string {
  const head = digits.length % 3 === 0 ? 3 : digits.length % 3;
  let grouped = digits.slice(0, head);
  for (let start = head; start < digits.length; start += 3)
    grouped += `,${digits.slice(start, start + 3)}`;
  return grouped;
}

/**
 * Plain decimal text such as `-1234.5` for display, as `-1,234.5`: the integer
 * digits grouped in threes, every fraction digit kept, never through a Number.
 * Text that is not a plain decimal is returned as it is rather than read.
 */
export function formatDecimalText(text: string): string {
  const match = PLAIN_DECIMAL.exec(text);
  if (match === null) return text;
  const [, sign, integer, fraction] = match;
  return `${sign}${groupThousands(integer!)}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** An exact decimal for display: `{ coefficient: "-123450", scale: 2 }` is `-1,234.50`. */
export function formatDecimal(value: ExactDecimal): string {
  return formatDecimalText(decimalToString(value));
}
