import type { ArtifactMeta, BalanceObservation } from "../types.ts";
import {
  decimalText,
  decimalToMinorUnits,
  decodeUtf8,
  isObject,
  minorUnitExponent,
} from "./util.ts";

export const SBI_VC_SOURCE_ID = "sbi-vc-trade";
export const SBI_VC_SOURCE_ACCOUNT = "sbi-vc-trade:main";
export const SBI_VC_PAGE_SIZE = 30;
export const SBI_VC_MAX_PAGES = 100;

export interface SbiVcEnvelope {
  meta: Record<string, unknown>;
  body: Record<string, unknown>;
}

export interface SbiVcPage extends SbiVcEnvelope {
  list: unknown[];
  pageNumber: number;
  pageSize: number;
  totalNumOfPages: number;
  totalSize: number;
}

export function acceptsSbiVcDataset(artifact: ArtifactMeta, dataset: string | RegExp): boolean {
  if (artifact.sourceId !== SBI_VC_SOURCE_ID || artifact.dataset === null) return false;
  return typeof dataset === "string"
    ? artifact.dataset === dataset
    : dataset.test(artifact.dataset);
}

export function parseSbiVcEnvelope(bytes: Uint8Array, dataset: string): SbiVcEnvelope {
  const parsed: unknown = JSON.parse(decodeUtf8(bytes));
  if (!isObject(parsed)) throw new Error(`${dataset}: expected a gateway envelope object`);
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "body" || keys[1] !== "meta") {
    throw new Error(`${dataset}: gateway envelope must contain exactly body and meta`);
  }
  if (!isObject(parsed["meta"]) || !isObject(parsed["body"])) {
    throw new Error(`${dataset}: gateway envelope body and meta must be objects`);
  }
  const meta = parsed["meta"];
  const metaKeys = Object.keys(meta).sort();
  const expectedMeta = ["sessUpdTime", "status", "timestamp"];
  if (
    metaKeys.length !== expectedMeta.length ||
    metaKeys.some((key, index) => key !== expectedMeta[index])
  ) {
    throw new Error(`${dataset}: gateway meta fields do not match the sanitized contract`);
  }
  if (
    meta["status"] !== "OK" ||
    typeof meta["sessUpdTime"] !== "string" ||
    typeof meta["timestamp"] !== "string"
  ) {
    throw new Error(`${dataset}: gateway meta values do not match the sanitized contract`);
  }
  return { meta, body: parsed["body"] };
}

export function parseSbiVcPage(
  bytes: Uint8Array,
  dataset: string,
  expectedPageNumber: number,
): SbiVcPage {
  const envelope = parseSbiVcEnvelope(bytes, dataset);
  const keys = Object.keys(envelope.body).sort();
  const expected = ["list", "pageNumber", "pageSize", "totalNumOfPages", "totalSize"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${dataset}: page body fields do not match the provider contract`);
  }
  if (!Array.isArray(envelope.body["list"])) {
    throw new Error(`${dataset}: page list must be an array`);
  }
  const pageNumber = nonNegativeInteger(envelope.body["pageNumber"]);
  const pageSize = nonNegativeInteger(envelope.body["pageSize"]);
  const totalNumOfPages = nonNegativeInteger(envelope.body["totalNumOfPages"]);
  const totalSize = nonNegativeInteger(envelope.body["totalSize"]);
  if (
    pageNumber === undefined ||
    pageSize === undefined ||
    totalNumOfPages === undefined ||
    totalSize === undefined
  ) {
    throw new Error(`${dataset}: page metadata must contain non-negative safe integers`);
  }
  if (pageNumber !== expectedPageNumber || pageSize !== SBI_VC_PAGE_SIZE) {
    throw new Error(`${dataset}: page number or size does not match its dataset`);
  }
  if (pageNumber >= SBI_VC_MAX_PAGES || totalNumOfPages > SBI_VC_MAX_PAGES) {
    throw new Error(`${dataset}: page metadata exceeds the collector limit`);
  }
  if (totalNumOfPages !== Math.ceil(totalSize / pageSize)) {
    throw new Error(`${dataset}: totalNumOfPages does not match totalSize`);
  }
  const expectedLength = Math.min(pageSize, Math.max(totalSize - pageNumber * pageSize, 0));
  if (envelope.body["list"].length !== expectedLength) {
    throw new Error(`${dataset}: list cardinality does not match page metadata`);
  }
  return {
    ...envelope,
    list: envelope.body["list"],
    pageNumber,
    pageSize,
    totalNumOfPages,
    totalSize,
  };
}

export function warnUnknownFields(
  value: Record<string, unknown>,
  known: readonly string[],
  locator: string,
  warnings: string[],
): void {
  const unknown = Object.keys(value)
    .filter((key) => !known.includes(key))
    .sort();
  if (unknown.length > 0) {
    warnings.push(`${locator}: unmodelled fields preserved in extra: ${unknown.join(", ")}`);
  }
}

export function requireString(
  value: Record<string, unknown>,
  field: string,
  locator: string,
  warnings: string[],
): string | undefined {
  const candidate = value[field];
  if (typeof candidate === "string") return candidate;
  warnings.push(`${locator}.${field}: expected a string; raw value preserved`);
  return undefined;
}

export function warnNonStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  locator: string,
  warnings: string[],
): void {
  for (const field of fields) {
    if (typeof value[field] !== "string") {
      warnings.push(`${locator}.${field}: expected a string; raw value preserved`);
    }
  }
}

export function warnAttributeValueObject(
  value: unknown,
  locator: string,
  warnings: string[],
): value is Record<string, unknown> {
  if (!isObject(value)) {
    warnings.push(`${locator}: expected an object; raw value preserved`);
    return false;
  }
  warnUnknownFields(value, ["attribute", "value"], locator, warnings);
  warnNonStringFields(value, ["attribute", "value"], locator, warnings);
  return true;
}

export function balanceFromDecimal(options: {
  value: unknown;
  metric: string;
  instrument: string;
  locator: string;
  extra: Record<string, unknown>;
  asOf?: string;
  observedAt?: string;
  warnings: string[];
}): BalanceObservation {
  const decimal = decimalText(options.value);
  if (!decimal) {
    options.warnings.push(`${options.locator}: expected an exact decimal; raw value preserved`);
  }
  const minor = decimal ? decimalToMinorUnits(decimal.text, options.instrument) : undefined;
  if (decimal && minor === undefined && minorUnitExponent(options.instrument) !== undefined) {
    options.warnings.push(
      `${options.locator}: exact minor-unit conversion unavailable; decimal text preserved`,
    );
  }
  return {
    kind: "balance",
    sourceAccount: SBI_VC_SOURCE_ACCOUNT,
    metric: options.metric,
    ...(minor !== undefined ? { amountMinor: minor } : {}),
    ...(decimal !== undefined ? { amountText: decimal.text, amountScale: decimal.scale } : {}),
    instrument: options.instrument,
    ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
    ...(options.observedAt !== undefined ? { observedAt: options.observedAt } : {}),
    rawLocator: options.locator,
    extra: options.extra,
  };
}

export function providerExtra(
  record: Record<string, unknown>,
  envelope: SbiVcEnvelope,
  excludedBodyFields: readonly string[],
  added: Record<string, unknown> = {},
): Record<string, unknown> {
  const providerContext: Record<string, unknown> = { meta: { ...envelope.meta } };
  for (const [field, value] of Object.entries(envelope.body)) {
    if (!excludedBodyFields.includes(field)) providerContext[field] = value;
  }
  const providerKoganeField = record["_kogane"];
  const copy = { ...record };
  delete copy["_kogane"];
  return {
    ...copy,
    _kogane: {
      ...(providerKoganeField !== undefined
        ? { providerFieldNamedKogane: providerKoganeField }
        : {}),
      providerContext,
      ...added,
    },
  };
}

export function jsonPathProperty(name: string): string {
  return `[${JSON.stringify(name)}]`;
}

export function providerTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return value;
  }
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const checked = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() + 1 !== month ||
    checked.getUTCDate() !== day ||
    checked.getUTCHours() !== hour ||
    checked.getUTCMinutes() !== minute ||
    checked.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ?? ""}+09:00`;
}

export function collisionFreeTuple(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
