import {
  ECONOMIC_ROW_READINESS_REASONS,
  ECONOMIC_ROW_READINESS_SCHEMA,
  ECONOMIC_ROW_READINESS_VERSION,
  validEconomicRowReadinessRequest,
  type EconomicRowEvaluation,
  type EconomicRowReadinessRequest,
  type EconomicRowRef,
  type ReadinessFamily,
} from "../../domain/src/economic-row-readiness.ts";
import { TRANSACTION_FAMILY_REGISTRY_VERSION } from "../../domain/src/event-families.ts";
import { hasExactKeys, isOneOf, isRecord } from "../../domain/src/guards.ts";

export const ECONOMIC_READINESS_PATH = "/api/v2/economic-readiness";
export const BANK_GENERATION_GATES = [
  "ownership_principal_contract_missing",
  "writer_not_registered",
] as const;
export const SECURITY_GENERATION_GATES = [
  "security_book_unsupported",
  "security_selector_unsupported",
  "security_event_vocabulary_missing",
  "security_class_unknown",
  "wrapper_unknown",
] as const;
export type EconomicGenerationGate =
  | (typeof BANK_GENERATION_GATES)[number]
  | (typeof SECURITY_GENERATION_GATES)[number];
export interface EconomicReadinessRow extends EconomicRowEvaluation {
  ref: EconomicRowRef;
  pinsDigest: string;
  keyDigest: string | null;
  aliasDigest: string | null;
}
export interface EconomicReadinessResult {
  status: "ok";
  contextId: string;
  manifest: {
    schema: typeof ECONOMIC_ROW_READINESS_SCHEMA;
    evaluator: typeof ECONOMIC_ROW_READINESS_VERSION;
    registry: typeof TRANSACTION_FAMILY_REGISTRY_VERSION;
    family: ReadinessFamily;
    knowledge: "current";
    rows: EconomicReadinessRow[];
  };
  counts: { admitted: number; blocked: number; unavailable: number };
  proposalEnabled: false;
  writerEnabled: false;
  historyCoverage: "unknown";
  generationGates: readonly EconomicGenerationGate[];
}
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const nullableDigest = (v: unknown) => v === null || digest(v);
const status = isOneOf(["admitted", "blocked", "unavailable"] as const);
const reason = isOneOf(ECONOMIC_ROW_READINESS_REASONS);

function validRow(v: unknown): v is EconomicReadinessRow {
  return (
    isRecord(v) &&
    hasExactKeys(v, [
      "ref",
      "readiness",
      "identity",
      "reasons",
      "pinsDigest",
      "keyDigest",
      "aliasDigest",
    ]) &&
    status(v.readiness) &&
    status(v.identity) &&
    Array.isArray(v.reasons) &&
    v.reasons.length <= ECONOMIC_ROW_READINESS_REASONS.length &&
    v.reasons.every(reason) &&
    new Set(v.reasons).size === v.reasons.length &&
    (v.readiness === "admitted" ? v.reasons.length === 0 : v.reasons.length > 0) &&
    digest(v.pinsDigest) &&
    nullableDigest(v.keyDigest) &&
    nullableDigest(v.aliasDigest)
  );
}

/** Closed safe wire shape; admission remains the service's decision, never the browser's. */
export function validEconomicReadinessResult(v: unknown): v is EconomicReadinessResult {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, [
      "status",
      "contextId",
      "manifest",
      "counts",
      "proposalEnabled",
      "writerEnabled",
      "historyCoverage",
      "generationGates",
    ]) ||
    v.status !== "ok" ||
    !digest(v.contextId) ||
    v.proposalEnabled !== false ||
    v.writerEnabled !== false ||
    v.historyCoverage !== "unknown" ||
    !isRecord(v.manifest) ||
    !hasExactKeys(v.manifest, ["schema", "evaluator", "registry", "family", "knowledge", "rows"]) ||
    v.manifest.evaluator !== ECONOMIC_ROW_READINESS_VERSION ||
    v.manifest.registry !== TRANSACTION_FAMILY_REGISTRY_VERSION ||
    !Array.isArray(v.manifest.rows) ||
    !v.manifest.rows.every(validRow) ||
    !validEconomicRowReadinessRequest({
      schema: v.manifest.schema,
      family: v.manifest.family,
      knowledge: v.manifest.knowledge,
      rows: v.manifest.rows.map((row) => row.ref),
    }) ||
    !isRecord(v.counts) ||
    !hasExactKeys(v.counts, ["admitted", "blocked", "unavailable"])
  )
    return false;
  const rows = v.manifest.rows;
  if (rows.some((row, i) => i > 0 && row.ref.observationId <= rows[i - 1]!.ref.observationId))
    return false;
  for (const key of ["admitted", "blocked", "unavailable"] as const)
    if (v.counts[key] !== rows.filter((row) => row.readiness === key).length) return false;
  const gates =
    v.manifest.family === "bank-movement" ? BANK_GENERATION_GATES : SECURITY_GENERATION_GATES;
  return (
    Array.isArray(v.generationGates) &&
    v.generationGates.length === gates.length &&
    v.generationGates.every((gate, i) => gate === gates[i])
  );
}

/** A valid answer for another row, parse or family must not label this observation. */
export function economicReadinessMatches(
  value: EconomicReadinessResult,
  request: EconomicRowReadinessRequest,
): boolean {
  return (
    value.manifest.family === request.family &&
    value.manifest.rows.length === request.rows.length &&
    value.manifest.rows.every((row) =>
      request.rows.some(
        (ref) =>
          ref.observationId === row.ref.observationId && ref.parseRunId === row.ref.parseRunId,
      ),
    )
  );
}
