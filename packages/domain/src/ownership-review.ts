import type { SourceFactRef } from "./events.ts";
/** Explicit operator identity, never derived from the authenticated principal. */
export function ownershipReviewPartyRef(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("party:")) return false;
  const label = value.slice(6);
  return (
    label.length > 0 &&
    label.length <= 128 &&
    label.trim() === label &&
    !/[|/\u0000-\u001f\u007f]/u.test(label)
  );
}
export function ownershipReviewEvidenceRefs(
  proposalId: string,
  fact: SourceFactRef,
  mappingId: string,
): string[] {
  return ["card-settlement:" + proposalId, fact.id, fact.revision, "account_mapping:" + mappingId];
}
export function ownershipReviewRequested(evidenceRefs: readonly string[]): boolean {
  return evidenceRefs.some((ref) => ref.startsWith("card-settlement:"));
}
export function ownershipRevisionRef(
  role: "liable_party" | "beneficial_owner",
  accountId: string,
): string {
  return "ownership:" + role + "|" + accountId;
}
