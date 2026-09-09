// A context fixes the set of versions a result was computed from. It is not
// the largest id or the latest date; every manifest reference names a
// concrete, immutable set. Changing any input yields a new context (INV09).
import { hasExactKeys, isOneOf, isRecord, isStringRecord, isText, isTextOrNull } from "./guards.ts";
import { validInstantText, validTemporalValue, type TemporalValue } from "./time.ts";

export const FINANCIAL_CONTEXT_SCHEMA_VERSION = "financial-context-v1";
export interface FinancialContext {
  contextId: string;
  schemaVersion: typeof FINANCIAL_CONTEXT_SCHEMA_VERSION;
  querySemanticsVersion: string;
  perimeterRef: string;
  effectiveTime: TemporalValue;
  /** Instant: evidence recorded after it is not part of this context. */
  knowledgeCutoff: string;
  publicationRef: string;
  sourceSelectionManifestRef: string;
  parserBuildManifestRef: string;
  metadataBuildManifestRef: string;
  identityDecisionManifestRef: string;
  eventDecisionManifestRef: string;
  referenceManifestRef: string;
  calculationPolicyRef: string;
  /** Instant at which the evaluation ran; part of the inputs, not an audit timestamp. */
  evaluationClock: string;
}

export interface TransformManifest {
  transformerId: string;
  semanticVersion: string;
  codeDigest: string;
  inputContractVersion: string;
  outputContractVersion: string;
  metadataExtractorRelease: string;
  dependencyDigests: Record<string, string>;
}

export const REPLAYABILITY = [
  "replayable",
  "artifact-preserved",
  "restricted",
  "unavailable",
] as const;
export type Replayability = (typeof REPLAYABILITY)[number];

export const INTERPRETATION_MODES = ["latest", "as-recorded", "snapshot"] as const;
export type InterpretationMode = (typeof INTERPRETATION_MODES)[number];
export interface InterpretationContext {
  mode: InterpretationMode;
  snapshotId: string | null;
  identityRelease: string;
  productCatalogueRelease: string;
  productResolverRelease: string;
  measurePolicyRelease: string;
  decimalPolicyRelease: string;
}

const CONTEXT_KEYS = [
  "contextId",
  "schemaVersion",
  "querySemanticsVersion",
  "perimeterRef",
  "effectiveTime",
  "knowledgeCutoff",
  "publicationRef",
  "sourceSelectionManifestRef",
  "parserBuildManifestRef",
  "metadataBuildManifestRef",
  "identityDecisionManifestRef",
  "eventDecisionManifestRef",
  "referenceManifestRef",
  "calculationPolicyRef",
  "evaluationClock",
] as const;
const CONTEXT_REF_KEYS = [
  "querySemanticsVersion",
  "perimeterRef",
  "publicationRef",
  "sourceSelectionManifestRef",
  "parserBuildManifestRef",
  "metadataBuildManifestRef",
  "identityDecisionManifestRef",
  "eventDecisionManifestRef",
  "referenceManifestRef",
  "calculationPolicyRef",
] as const;

export function validFinancialContext(value: unknown): value is FinancialContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONTEXT_KEYS) &&
    isText(value.contextId, 256) &&
    value.schemaVersion === FINANCIAL_CONTEXT_SCHEMA_VERSION &&
    CONTEXT_REF_KEYS.every((key) => isText(value[key], 512)) &&
    validTemporalValue(value.effectiveTime) &&
    validInstantText(value.knowledgeCutoff) &&
    validInstantText(value.evaluationClock)
  );
}

export function validTransformManifest(value: unknown): value is TransformManifest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "transformerId",
      "semanticVersion",
      "codeDigest",
      "inputContractVersion",
      "outputContractVersion",
      "metadataExtractorRelease",
      "dependencyDigests",
    ]) &&
    isText(value.transformerId, 256) &&
    isText(value.semanticVersion, 64) &&
    isText(value.codeDigest, 128) &&
    isText(value.inputContractVersion, 64) &&
    isText(value.outputContractVersion, 64) &&
    isText(value.metadataExtractorRelease, 128) &&
    isStringRecord(value.dependencyDigests)
  );
}

export function validInterpretationContext(value: unknown): value is InterpretationContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "mode",
      "snapshotId",
      "identityRelease",
      "productCatalogueRelease",
      "productResolverRelease",
      "measurePolicyRelease",
      "decimalPolicyRelease",
    ]) &&
    isOneOf(INTERPRETATION_MODES)(value.mode) &&
    isTextOrNull(value.snapshotId, 256) &&
    (value.mode === "snapshot") === (value.snapshotId !== null) &&
    isText(value.identityRelease, 128) &&
    isText(value.productCatalogueRelease, 128) &&
    isText(value.productResolverRelease, 128) &&
    isText(value.measurePolicyRelease, 128) &&
    isText(value.decimalPolicyRelease, 128)
  );
}

/**
 * Canonical form `canonical-json-v1`, the only input to digests in this
 * package: object keys sorted by UTF-16 code units, arrays in their given
 * order (array order is meaningful; sets must be sorted by the producer),
 * strings as JSON, booleans, null, and safe integers only. Non-integer
 * numbers, NaN, Infinity, bigint, undefined, functions and symbols are
 * rejected; decimals are represented as `ExactDecimal` objects, never as JS
 * numbers. `-0` is emitted as `0`.
 */
export const CANONICAL_FORM_VERSION = "canonical-json-v1";

export class CanonicalFormError extends Error {
  readonly code: "unsafe_number" | "unsupported_type" | "undefined_value" | "depth_exceeded";
  constructor(code: CanonicalFormError["code"], path: string) {
    super(`${code} at ${path || "$"}`);
    this.name = "CanonicalFormError";
    this.code = code;
  }
}

const CANONICAL_MAX_DEPTH = 64;

function canonicalize(value: unknown, path: string, depth: number): string {
  if (depth > CANONICAL_MAX_DEPTH) throw new CanonicalFormError("depth_exceeded", path);
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalFormError("unsafe_number", path);
      return value === 0 ? "0" : String(value);
    case "undefined":
      throw new CanonicalFormError("undefined_value", path);
    case "object":
      break;
    default:
      throw new CanonicalFormError("unsupported_type", path);
  }
  if (Array.isArray(value))
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, depth + 1)).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new CanonicalFormError("unsupported_type", path);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`, depth + 1)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "", 0);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `sha256(canonicalJson(value))` as lowercase hex. */
export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** Digest over every context input except the assigned `contextId`. */
export async function contextInputsDigest(context: FinancialContext): Promise<string> {
  const { contextId: _contextId, ...inputs } = context;
  return canonicalDigest(inputs);
}

/** Input fields that differ between two contexts; any difference requires a new contextId (INV09). */
export function changedContextInputs(a: FinancialContext, b: FinancialContext): string[] {
  return CONTEXT_KEYS.filter(
    (key) => key !== "contextId" && canonicalJson(a[key]) !== canonicalJson(b[key]),
  );
}
