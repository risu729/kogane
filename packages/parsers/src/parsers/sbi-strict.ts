import { decimalText, decimalToMinorUnits, isObject } from "./util.ts";

export function strictObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} schema drift` +
        (missing.length > 0 ? `; missing ${missing.join(",")}` : "") +
        (unknown.length > 0 ? `; unknown ${unknown.join(",")}` : ""),
    );
  }
}

export function strictString(
  value: unknown,
  label: string,
  options: { empty?: boolean; max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (options.empty !== true && value.length === 0) throw new Error(`${label} is empty`);
  if (value.length > (options.max ?? 512)) throw new Error(`${label} is too long`);
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
  return value;
}

export function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function strictSafeInteger(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  const integer = value as number;
  if (options.minimum !== undefined && integer < options.minimum) {
    throw new Error(`${label} is below its supported range`);
  }
  if (options.maximum !== undefined && integer > options.maximum) {
    throw new Error(`${label} is above its supported range`);
  }
  return integer;
}

export function exactDecimal(value: unknown, label: string): { text: string; scale: number } {
  const decimal = decimalText(value);
  if (!decimal) throw new Error(`${label} must be an exact decimal`);
  return decimal;
}

export function exactMoney(
  value: unknown,
  currency: string,
  label: string,
): { text: string; scale: number; minor: number } {
  const decimal = exactDecimal(value, label);
  const minor = decimalToMinorUnits(decimal.text, currency);
  if (minor === undefined) {
    throw new Error(`${label} is not exactly representable in ${currency} minor units`);
  }
  return { ...decimal, minor };
}

export function normalizedDate(value: unknown, label: string): string {
  const text = strictString(value, label, {
    max: 10,
    pattern: /^\d{4}[/-]\d{2}[/-]\d{2}$/u,
  });
  const normalized = text.replaceAll("/", "-");
  const [year, month, day] = normalized.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a calendar date`);
  }
  return normalized;
}

/** Stable, non-cryptographic identity for provider rows that carry no id. */
export function stableFingerprint(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (isObject(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, canonical(entry[key])]),
      );
    }
    return entry;
  };
  const text = JSON.stringify(canonical(value));
  if (text === undefined) throw new Error("cannot fingerprint an undefined value");
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
}
