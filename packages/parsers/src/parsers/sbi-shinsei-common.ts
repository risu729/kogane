import type { ArtifactMeta, BalanceObservation } from "../types.ts";
import {
  decimalText,
  decimalToMinorUnits,
  decodeUtf8,
  isObject,
  minorUnitExponent,
  unitScopeAdmitted,
} from "./util.ts";

export const SBI_SHINSEI_SOURCE_ID = "sbi-shinsei-bank";

export function acceptsSbiShinseiDataset(artifact: ArtifactMeta, dataset: string): boolean {
  return (
    artifact.sourceId === SBI_SHINSEI_SOURCE_ID &&
    artifact.dataset === dataset &&
    artifact.mime === "application/json"
  );
}

export function assertSuccessfulRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  ) {
    throw new Error("SBI Shinsei observations require a successful failure-free parent run");
  }
}

export function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label}: invalid JSON`, { cause: error });
    }
    throw error;
  }
  return exactObject(value, label, ["responseParam", "header"], ["responseParam", "header"]);
}

export function responseParam(
  root: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const header = exactObject(
    root["header"],
    `${label}.header`,
    ["adapterResultCode"],
    ["adapterResultCode"],
  );
  if (header["adapterResultCode"] !== "0") throw new Error(`${label}: response was not successful`);
  return object(root["responseParam"], `${label}.responseParam`);
}

export function wrapper(value: unknown, label: string): Record<string, unknown> {
  const result = exactObject(
    value,
    label,
    ["requestParam", "responseParam", "header", "errorInfo"],
    ["responseParam"],
  );
  if (result["requestParam"] !== undefined) object(result["requestParam"], `${label}.requestParam`);
  if (result["header"] !== undefined) {
    const header = exactObject(
      result["header"],
      `${label}.header`,
      ["referenceNo", "systemCode", "langCode"],
      [],
    );
    scalarFields(header, Object.keys(header), `${label}.header`);
  }
  if (result["errorInfo"] !== undefined) {
    const error = exactObject(
      result["errorInfo"],
      `${label}.errorInfo`,
      ["statusID", "statusMessage"],
      [],
    );
    scalarFields(error, Object.keys(error), `${label}.errorInfo`);
    const explicitSuccess =
      error["statusID"] === "00000" &&
      typeof error["statusMessage"] === "string" &&
      error["statusMessage"].toLowerCase() === "success";
    for (const field of ["statusID", "statusMessage"] as const) {
      const value = error[field];
      if (!explicitSuccess && value !== undefined && value !== null && value !== "") {
        throw new Error(`${label}.errorInfo.${field}: successful wrapper contains an error`);
      }
    }
  }
  return object(result["responseParam"], `${label}.responseParam`);
}

export function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const result = object(value, label);
  for (const key of Object.keys(result))
    if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
  for (const key of required)
    if (!(key in result)) throw new Error(`${label}: missing field ${key}`);
  return result;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label}: expected an object`);
  return value;
}

export function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  if (value.length > maximum) throw new Error(`${label}: cardinality exceeds audited bound`);
  return value;
}

export function scalarFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    const value = record[field];
    if (
      value !== undefined &&
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`${label}.${field}: expected a scalar`);
    }
  }
}

export function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label}: expected a non-empty string`);
  return value;
}

export function currency(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[A-Z]{3}$/u.test(result)) throw new Error(`${label}: invalid provider currency`);
  return result;
}

export function decimal(value: unknown, label: string) {
  const result = decimalText(value);
  if (!result) throw new Error(`${label}: expected an exact decimal`);
  return result;
}

export function balanceObservation(options: {
  value: unknown;
  currency: string;
  accountNo: string;
  metric: string;
  asOf: string;
  observedAt?: string;
  locator: string;
  extra: Record<string, unknown>;
}): BalanceObservation {
  const amount = decimal(options.value, options.locator);
  const amountMinor = decimalToMinorUnits(amount.text, options.currency);
  if (minorUnitExponent(options.currency) !== undefined && amountMinor === undefined)
    throw new Error(`${options.locator}: not exactly representable in ${options.currency}`);
  return {
    kind: "balance",
    sourceAccount: `sbi-shinsei:${options.accountNo}`,
    metric: options.metric,
    ...(amountMinor === undefined ? {} : { amountMinor }),
    amountText: amount.text,
    amountScale: amount.scale,
    instrument: options.currency,
    asOf: options.asOf,
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    rawLocator: options.locator,
    extra: options.extra,
  };
}

export function compactDate(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  const match = /^(\d{4})[/-]?(\d{2})[/-]?(\d{2})$/u.exec(text);
  if (!match) throw new Error(`${label}: invalid date`);
  const result = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== result)
    throw new Error(`${label}: invalid date`);
  return result;
}

export function providerTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("provider timestamp must be a string");
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u.exec(value) ??
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("provider timestamp format is not recognized");
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const roundTrip = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    throw new Error("provider timestamp is invalid");
  }
  const result = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00`;
  return result;
}

export function providerExtra(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
  kogane: Record<string, unknown>,
): Record<string, unknown> {
  return { ...row, _kogane: { providerContext: context, ...kogane } };
}
