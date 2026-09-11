// Vpass: policy 2 applies only with exactly one trusted importer sidecar
// binding for the financial artifact (migrations 0020/0021). The trusted
// lookup and the fallback rule moved here unchanged from the store; provider
// extra_json never supplies evidence, and card names or ordinals never merge.
import type {
  AvailableIdentityEvidence,
  IdentityParseMeta,
  IdentityPolicyModule,
  IdentityPolicySelection,
} from "./index.ts";

export const VPASS_POLICY_FAMILY = "vpass-card-binding";
export const VPASS_POLICY_VERSION = 2;

export interface VpassBinding {
  financial_unit_id: number;
  financial_unit_key: string;
  binding_artifact_id: number;
  card_token: string;
}

/** The single trusted binding, or undefined when none or more than one exists. */
export function trustedVpassBinding(
  evidence: Pick<AvailableIdentityEvidence, "vpassBindings">,
): VpassBinding | undefined {
  return evidence.vpassBindings.length === 1 ? evidence.vpassBindings[0] : undefined;
}

export const vpassPolicy: IdentityPolicyModule = {
  family: VPASS_POLICY_FAMILY,
  sourceId: "vpass",
  version: VPASS_POLICY_VERSION,
  evidenceSql: (alias) =>
    `${alias}.source_id='vpass' AND EXISTS(
    SELECT 1 FROM trusted_vpass_card_bindings binding WHERE binding.financial_artifact_id=${alias}.id)`,
  async loadEvidence(db, parse) {
    if (parse.source_id !== "vpass") return {};
    const result = await db
      .prepare(`SELECT financial_unit_id,financial_unit_key,binding_artifact_id,card_token
    FROM trusted_vpass_card_bindings WHERE financial_artifact_id=? LIMIT 2`)
      .bind(parse.artifact_id)
      .all<VpassBinding>();
    return { vpassBindings: result.results };
  },
  select(
    parse: IdentityParseMeta,
    evidence,
    requestedVersion,
  ): IdentityPolicySelection | { fallback: string } {
    if (parse.source_id !== "vpass") return { fallback: "source-mismatch" };
    if (evidence.vpassBindings.length > 1) return { fallback: "binding-ambiguous" };
    const binding = trustedVpassBinding(evidence);
    if (!binding) return { fallback: "binding-missing" };
    return {
      policyFamily: VPASS_POLICY_FAMILY,
      release: `${VPASS_POLICY_FAMILY}-v${requestedVersion}`,
      policyVersion: requestedVersion,
      dependencySet: [
        {
          kind: "trusted-vpass-card-binding",
          financialUnitId: binding.financial_unit_id,
          bindingArtifactId: binding.binding_artifact_id,
          cardToken: binding.card_token,
        },
      ],
      eligibility: { status: "eligible" },
    };
  },
};
