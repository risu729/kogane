// Range schema shared by artifact ranges (hashed into the descriptor) and run
// ranges (not hashed).
import type { JsonObject } from "./json";
import { ContractError, boolInteger, requiredEnum, stringValue } from "./validate";

export type RangeKind = "requested" | "declared_coverage" | "selector";
export type RangePrecision = "instant" | "date" | "month";
export type RangeBasis = "source" | "request" | "manifest" | "operator";
export type WireBoolean = boolean | 0 | 1;

export interface RangeFieldsRequest {
  rangeKind: RangeKind;
  precision: RangePrecision;
  startValue?: string | null;
  endValue?: string | null;
  /** Omitted means inclusive. */
  startInclusive?: WireBoolean;
  endInclusive?: WireBoolean;
  basis: RangeBasis;
}

export interface RangeFields {
  rangeKind: RangeKind;
  precision: RangePrecision;
  startValue: string | null;
  endValue: string | null;
  startInclusive: 0 | 1;
  endInclusive: 0 | 1;
  basis: RangeBasis;
}

export const RANGE_FIELD_KEYS = [
  "rangeKind",
  "precision",
  "startValue",
  "endValue",
  "startInclusive",
  "endInclusive",
  "basis",
] as const;

function canonicalRangeValue(value: unknown, precision: string, field: string): string | null {
  const parsed = stringValue(value, field, { optional: true, max: 35 });
  if (parsed === null) return null;
  if (precision === "month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(parsed)) return parsed;
  if (precision === "date" && /^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    const date = new Date(`${parsed}T00:00:00.000Z`);
    if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === parsed) return parsed;
  }
  if (precision === "instant") {
    const date = new Date(parsed);
    if (!Number.isNaN(date.valueOf()) && date.toISOString() === parsed) return parsed;
  }
  throw new ContractError(`invalid_${field}`);
}

export function parseRangeFields(value: JsonObject): RangeFields {
  const precision = requiredEnum(value.precision, "precision", [
    "instant",
    "date",
    "month",
  ] as const);
  const startValue = canonicalRangeValue(value.startValue, precision, "start_value");
  const endValue = canonicalRangeValue(value.endValue, precision, "end_value");
  if (startValue === null && endValue === null) throw new ContractError("empty_range");
  if (startValue !== null && endValue !== null && startValue > endValue) {
    throw new ContractError("reversed_range");
  }
  return {
    rangeKind: requiredEnum(value.rangeKind, "range_kind", [
      "requested",
      "declared_coverage",
      "selector",
    ] as const),
    precision,
    startValue,
    endValue,
    startInclusive: boolInteger(value.startInclusive, "start_inclusive", 1),
    endInclusive: boolInteger(value.endInclusive, "end_inclusive", 1),
    basis: requiredEnum(value.basis, "range_basis", [
      "source",
      "request",
      "manifest",
      "operator",
    ] as const),
  };
}
