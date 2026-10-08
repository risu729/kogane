// The identity a human-adopted writer may consume one provider row under (ADR
// 0054, "Identity: eight fail-closed rules"): the closed admission of
// `admitIdentity`, decided from the transaction-family registry and what the
// parser recorded on the row, and the row's alias class from the registry's
// declared provider identity function.
//
// Nothing is adopted here: a refusal is a closed code the writer returns, and
// an admitted row only tells the writer what alias class to record with its
// claim. CORE 0070 then refuses a second live holder of that class
// (`alias_conflict`), whatever producer or namespace collected the row.
import {
  admitIdentity,
  validAliasClass,
  type AliasClass,
  type IdentityAdmission,
  type IdentityOriginBasis,
} from "./economic-contract.ts";
import {
  providerIdentityFunction,
  transactionFamilyEntry,
  type ProviderIdentityFunction,
} from "./event-families.ts";
import { isRecord } from "./guards.ts";

/** One stored transaction row, as the cited observation and its parse run state it. */
export interface HumanAdoptedRowInput {
  sourceId: string;
  parserName: string;
  sourceAccount: string;
  externalId: string | null;
  /** `transaction_observations.extra_json`, parsed (anything else is no record). */
  extra: unknown;
  /** The account the row's source account resolves to now. */
  accountId: string;
}

export type HumanAdoptedRowIdentity =
  | { admitted: true; aliasClass: AliasClass }
  | { admitted: false; refusal: Extract<IdentityAdmission, { admitted: false }>["refusal"] };

/** The `_kogane.identityOrigin` text a parser records for a provider-issued id. */
export const PROVIDER_ID_ORIGIN = "provider-id";

/**
 * Where the row's external id comes from. The registry says what the parser
 * makes the id from; a provider id counts as provider-issued only when the
 * row itself records `_kogane.identityOrigin: provider-id` (rule 2: an id
 * without a recorded origin is refused). A parser with no registry entry is
 * an unrecorded origin.
 */
export function rowOriginBasis(input: HumanAdoptedRowInput): IdentityOriginBasis {
  if (input.externalId === null || input.externalId === "") return "absent";
  const entry = transactionFamilyEntry(input.sourceId, input.parserName);
  if (entry === null) return "unrecorded";
  switch (entry.identity.externalId) {
    case "none":
      return "absent";
    case "fingerprint_occurrence":
      return "fingerprint-occurrence";
    case "collector_fingerprint":
      return "collector-fingerprint";
    case "evidence_digest":
      return "evidence-digest";
    case "provider_id":
    case "provider_id_tuple": {
      const kogane = isRecord(input.extra) ? input.extra["_kogane"] : undefined;
      return isRecord(kogane) && kogane["identityOrigin"] === PROVIDER_ID_ORIGIN
        ? "provider-id"
        : "unrecorded";
    }
  }
}

/** The declared function's components, read from the row's provider fields, or null. */
function components(declared: ProviderIdentityFunction, extra: unknown): string[] | null {
  if (!isRecord(extra)) return null;
  const values = declared.componentFields.map((field) => extra[field]);
  return values.every((value): value is string => typeof value === "string" && value !== "")
    ? values
    : null;
}

/**
 * May a human-adopted writer consume this row, and under which alias class?
 * Refusals, in `admitIdentity`'s order: identity_absent,
 * identity_fingerprint_only, identity_digest_not_provider,
 * identity_origin_unrecorded, identity_resolver_missing. A declared function
 * whose provider field is missing or not text on this row computes nothing:
 * identity_absent.
 */
export function humanAdoptedRowIdentity(input: HumanAdoptedRowInput): HumanAdoptedRowIdentity {
  const declared = providerIdentityFunction(input.sourceId, input.parserName, input.sourceAccount);
  const admission = admitIdentity({
    originBasis: rowOriginBasis(input),
    resolverDeclared: declared !== null,
    writerKind: "human",
    retireBeforeRecognise: false,
  });
  if (!admission.admitted) return admission;
  // A human writer's admission always requires an alias class, so a function is declared.
  const parts = declared === null ? null : components(declared, input.extra);
  if (declared === null || parts === null) return { admitted: false, refusal: "identity_absent" };
  const aliasClass: AliasClass = {
    sourceId: input.sourceId,
    components: parts,
    accountId: input.accountId,
    ruleVersion: declared.ruleVersion,
  };
  return validAliasClass(aliasClass)
    ? { admitted: true, aliasClass }
    : { admitted: false, refusal: "identity_absent" };
}
