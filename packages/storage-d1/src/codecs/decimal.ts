// decimal-v1 columns ⇄ the exact quantity the domain works with.
//
// Every stored amount in CORE is the pair `(coefficient, scale)` plus a status
// (migration 0024, `packages/domain/src/values.ts`): an arbitrary-precision
// integer as TEXT and a non-negative integer exponent, never a JS number and
// never a float column. The status carries `missing | unparsed | conflict`
// without inventing a value, and the two columns are NULL in exactly those
// cases. Turning any of them into 0 is the mistake this codec exists to make
// impossible (INV05).
import {
  validExactDecimal,
  VALUE_STATUSES,
  type ValueState,
  type ValueStatus,
} from "../../../domain/src/values.ts";

/** The three columns a decimal-v1 value occupies in any CORE table. */
export interface DecimalColumns {
  coefficient: string | null;
  scale: number | null;
  status: ValueStatus;
}

/** The reason recorded beside a non-exact value; never provider content. */
export const UNKNOWN_REASON = "value_not_exact";

/**
 * The columns a value writes. An exact value writes both parts; anything else
 * writes NULL twice, so a reader cannot mistake an absent amount for zero.
 */
export function encodeDecimal(value: ValueState): DecimalColumns {
  return value.status === "exact"
    ? { coefficient: value.value.coefficient, scale: value.value.scale, status: "exact" }
    : { coefficient: null, scale: null, status: value.status };
}

/**
 * The value a row holds. A row whose status is `exact` but whose columns are
 * not a valid decimal-v1 pair is a schema violation, not a zero: it decodes as
 * `conflict`, so the caller reports "the stored value cannot be read" instead
 * of a number nobody wrote.
 */
export function decodeDecimal(
  columns: DecimalColumns,
  normalizationVersion = "decimal-v1",
): ValueState {
  if (columns.status !== "exact")
    return { status: columns.status, reasonCode: UNKNOWN_REASON };
  const candidate = { coefficient: columns.coefficient, scale: columns.scale };
  if (!validExactDecimal(candidate)) return { status: "conflict", reasonCode: "invalid_decimal" };
  return { status: "exact", value: candidate, normalizationVersion };
}

/** Whether a column value is one of the four statuses decimal-v1 defines. */
export function isValueStatus(value: unknown): value is ValueStatus {
  return typeof value === "string" && (VALUE_STATUSES as readonly string[]).includes(value);
}

/**
 * The status a row column holds, or `conflict` when the column is not one of
 * the four. An unreadable status is never silently treated as `exact`.
 */
export function readValueStatus(value: unknown): ValueStatus {
  return isValueStatus(value) ? value : "conflict";
}
