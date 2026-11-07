// The owner's decision of 2026-11-07 (ADR 0087): an account with no recorded
// ownership is assumed to be the owner's, sole personal. The default is a
// closed, versioned evidence reference and one fixed party; it is never a
// recorded claim, never provider-name verification, and never applied to an
// account whose ownership was ever recorded or contradicted
// (packages/read-model/src/card-settlement-ownership.ts says exactly when).

/** The evidence reference a defaulted owner cites. A new rule is a new version. */
export const OWNERSHIP_DEFAULT_REF = "ownership-default:owner-v1";
/**
 * The party the default names. It is an ordinary party reference, so an
 * operator claim with the label `owner` names the same party, as the same
 * identifier always does (docs/card-settlements.md, Ownership).
 */
export const OWNERSHIP_DEFAULT_PARTY = "party:owner";

/** True when an ownership evidence list rests on the default rather than a recorded claim. */
export function ownershipDefaulted(refs: readonly string[]): boolean {
  return refs.includes(OWNERSHIP_DEFAULT_REF);
}
