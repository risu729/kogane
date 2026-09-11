// Column codecs: the four conversions that decide whether a stored fact keeps
// its meaning when it is read back (unified plan 09 §4). Each one has a value
// it must never produce: zero for a missing amount, a shifted calendar day,
// `true` for an unreadable flag, row 0 for a missing reference.
export {
  decodeDecimal,
  encodeDecimal,
  isValueStatus,
  readValueStatus,
  UNKNOWN_REASON,
  type DecimalColumns,
} from "./decimal.ts";
export { decodeDateOnly, encodeDateOnly, isDateOnly } from "./date-only.ts";
export { decodeBoolean, decodeBooleanOr, encodeBoolean, isTrue } from "./boolean.ts";
export { decodeNullableId, encodeNullableId, isRowId, requireRowId } from "./nullable-id.ts";
