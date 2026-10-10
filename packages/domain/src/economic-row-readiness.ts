// Internal current evidence diagnostic; never an adoption or writer permission.
import { parseConsumptionKey, type IdentityAdmission } from "./economic-contract.ts";
import { transactionFamilyEntry } from "./event-families.ts";
import { hasExactKeys, isRecord } from "./guards.ts";
import { humanAdoptedRowIdentity } from "./row-identity.ts";

export const ECONOMIC_ROW_READINESS_SCHEMA = "economic-row-readiness-v1";
export const ECONOMIC_ROW_READINESS_VERSION = "economic-row-readiness-evaluator-v1";
export interface EconomicRowRef {
  observationId: number;
  parseRunId: number;
}
export type ReadinessFamily = "bank-movement" | "securities-execution";
export interface EconomicRowReadinessRequest {
  schema: typeof ECONOMIC_ROW_READINESS_SCHEMA;
  family: ReadinessFamily;
  rows: EconomicRowRef[];
  knowledge: "current";
}
export function validEconomicRowReadinessRequest(
  value: unknown,
): value is EconomicRowReadinessRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema", "family", "rows", "knowledge"]) ||
    value.schema !== ECONOMIC_ROW_READINESS_SCHEMA ||
    value.knowledge !== "current" ||
    (value.family !== "bank-movement" && value.family !== "securities-execution") ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > 64
  )
    return false;
  const seen = new Set<number>();
  return value.rows.every((row: unknown) => {
    if (
      !isRecord(row) ||
      !hasExactKeys(row, ["observationId", "parseRunId"]) ||
      typeof row.observationId !== "number" ||
      !Number.isSafeInteger(row.observationId) ||
      row.observationId < 1 ||
      typeof row.parseRunId !== "number" ||
      !Number.isSafeInteger(row.parseRunId) ||
      row.parseRunId < 1 ||
      seen.has(row.observationId)
    )
      return false;
    seen.add(row.observationId);
    return true;
  });
}

export type ReadinessReason =
  | Extract<IdentityAdmission, { admitted: false }>["refusal"]
  | "observation_missing"
  | "evidence_not_current"
  | "evidence_restricted"
  | "evidence_unavailable"
  | "family_mismatch"
  | "account_mapping_unresolved"
  | "account_mapping_ambiguous"
  | "ownership_unresolved"
  | "economic_claim_held"
  | "alias_conflict"
  | "identity_key_invalid";

/** Trusted loader output. Internal strings must never escape the application digest boundary. */
export interface EconomicRowEvidence {
  observation_id: number;
  parse_run_id: number;
  found: number;
  restricted: number;
  visible: number;
  current_parse: number | null;
  source_id: string | null;
  parser_name: string | null;
  source_account: string | null;
  external_id: string | null;
  extra_json: string | null;
  key_text: string | null;
  alias_text: string | null;
  mapping_count: number;
  mapping_status: string | null;
  account_id: string | null;
  owner_ref: string | null;
  key_holders: string;
  alias_holders: string;
  pins: string;
}
export interface EconomicRowEvaluation {
  readiness: "admitted" | "blocked" | "unavailable";
  identity: "admitted" | "blocked" | "unavailable";
  reasons: ReadinessReason[];
}

export function evaluateEconomicRowReadiness(
  family: ReadinessFamily,
  row: EconomicRowEvidence,
): EconomicRowEvaluation {
  const reasons: ReadinessReason[] = [];
  const stop = (
    reason: ReadinessReason,
    readiness: "blocked" | "unavailable",
  ): EconomicRowEvaluation => ({ readiness, identity: "unavailable", reasons: [reason] });
  if (!row.found) return stop("observation_missing", "unavailable");
  if (row.restricted) return stop("evidence_restricted", "blocked");
  if (!row.visible) return stop("evidence_unavailable", "unavailable");
  if (row.current_parse !== row.parse_run_id) reasons.push("evidence_not_current");
  const entry = transactionFamilyEntry(row.source_id ?? "", row.parser_name ?? "");
  if (!entry?.families.some((item) => item.family === family)) reasons.push("family_mismatch");
  if (row.mapping_count > 1) reasons.push("account_mapping_ambiguous");
  else if (
    row.mapping_count !== 1 ||
    row.mapping_status !== "identified" ||
    row.account_id === null
  )
    reasons.push("account_mapping_unresolved");
  // A beneficial_owner relation identifies a party, not the authenticated owner.
  // No principal-to-party contract exists yet. Never infer "self" from a mapping.
  reasons.push("ownership_unresolved");
  let extra: unknown = null;
  try {
    extra = JSON.parse(row.extra_json ?? "null") as unknown;
  } catch {
    /* refused by the identity helper */
  }
  const identity = humanAdoptedRowIdentity({
    sourceId: row.source_id ?? "",
    parserName: row.parser_name ?? "",
    sourceAccount: row.source_account ?? "",
    externalId: row.external_id,
    extra,
    accountId: row.account_id ?? "",
  });
  if (!identity.admitted) reasons.push(identity.refusal);
  if (row.key_text === null || parseConsumptionKey(row.key_text) === null)
    reasons.push("identity_key_invalid");
  if (row.key_holders !== "[]") reasons.push("economic_claim_held");
  if (row.alias_holders !== "[]") reasons.push("alias_conflict");
  return {
    readiness: reasons.length ? "blocked" : "admitted",
    identity: identity.admitted ? "admitted" : "blocked",
    reasons,
  };
}
