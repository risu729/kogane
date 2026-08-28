// The single point of contact between the client and the pipeline's money
// rules. `formatAmount` and `amountSign` are imported from src/money.ts rather
// than reimplemented here: an amount is stored as integer minor units plus the
// provider's verbatim text, and the one formatter that knows how to widen
// minor units without floating point lives there.
//
// Nothing in this client may use Intl.NumberFormat, parseFloat, or arithmetic
// on an amount. Re-exporting keeps that rule enforceable by grep.

export { amountSign, formatAmount, minorUnitExponent } from "../../src/money.ts";
