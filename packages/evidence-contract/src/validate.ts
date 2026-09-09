// Runtime validation primitives for the ingest request schemas. Error codes are
// part of the HTTP contract (raw-evidence maps ContractError to 400 with the
// same code), so keep the code strings stable.
import type { JsonObject } from "./json";

export class ContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ContractError";
  }
}

export const ID = /^[a-z0-9-]{1,100}$/;
export const OPAQUE = /^[A-Za-z0-9._:/-]{1,500}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

export function object(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ContractError("invalid_json_shape");
  }
  return value as JsonObject;
}

export function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) {
    throw new ContractError("unknown_field");
  }
}

export function stringValue(
  value: unknown,
  field: string,
  options: { optional?: boolean; max?: number; pattern?: RegExp } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.optional) return null;
    throw new ContractError(`invalid_${field}`);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (options.max ?? 500) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new ContractError(`invalid_${field}`);
  }
  return value;
}

export function requiredString(
  value: unknown,
  field: string,
  options: { max?: number; pattern?: RegExp } = {},
): string {
  return stringValue(value, field, options) as string;
}

export function enumValue<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
  optional = false,
): T | null {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new ContractError(`invalid_${field}`);
  }
  return value as T;
}

export function requiredEnum<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
): T {
  return enumValue(value, field, choices) as T;
}

export function integerValue(value: unknown, field: string, optional = false): number | null {
  if ((value === undefined || value === null) && optional) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractError(`invalid_${field}`);
  }
  return value as number;
}

export function requiredInteger(value: unknown, field: string): number {
  return integerValue(value, field) as number;
}

export function arrayValue(value: unknown, field: string, max = 1_000): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new ContractError(`invalid_${field}`);
  }
  return value;
}

/** Wire booleans are accepted as true/false/1/0 and stored as 1/0. */
export function boolInteger(value: unknown, field: string, defaultValue: 0 | 1): 0 | 1 {
  if (value === undefined) return defaultValue;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ContractError(`invalid_${field}`);
}

export function rejectDuplicate<T>(values: T[], key: (value: T) => string, code: string): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) throw new ContractError(code);
}
