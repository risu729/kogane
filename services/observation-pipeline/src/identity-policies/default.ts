// The family every source is eligible for: the shared resolver rules with no
// auxiliary evidence. Its dependency set is empty, so every run of one release
// over one parse has the same digest.
import type { IdentityPolicyEligibility, IdentityPolicySelection } from "./index.ts";

export const DEFAULT_POLICY_FAMILY = "identity-default";

export function defaultSelection(
  policyVersion: number,
  eligibility: IdentityPolicyEligibility,
): IdentityPolicySelection {
  return {
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: `${DEFAULT_POLICY_FAMILY}-v${policyVersion}`,
    policyVersion,
    dependencySet: [],
    eligibility,
  };
}
