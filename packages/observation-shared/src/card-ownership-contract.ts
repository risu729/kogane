import type { CardOwnershipReview } from "../../domain/src/card-ownership-review.ts";
import { validSourceFactRef } from "../../domain/src/events.ts";
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown) => v === null || text(v);
const revision = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const texts = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(text);
/** Shape only; the browser does not establish ownership from matching names. */
export function validCardOwnershipReview(v: unknown): v is CardOwnershipReview {
  return (
    record(v) &&
    text(v.proposalId) &&
    revision(v.revision) &&
    ["proposed", "accepted", "rejected", "withdrawn"].includes(String(v.status)) &&
    Array.isArray(v.sides) &&
    v.sides.length === 2 &&
    v.sides.every(
      (s: unknown, index: number) =>
        record(s) &&
        s.role === (index === 0 ? "liable_party" : "beneficial_owner") &&
        text(s.sourceId) &&
        text(s.sourceAccount) &&
        validSourceFactRef(s.fact) &&
        [s.accountId, s.sourceAccountId, s.mappingId].every(nullable) &&
        revision(s.mappingRevision) &&
        revision(s.ownershipRevision) &&
        texts(s.evidenceRefs) &&
        texts(s.blockers) &&
        typeof s.claimsTruncated === "boolean" &&
        Array.isArray(s.claims) &&
        s.claims.length <= 50 &&
        s.claims.every(
          (c: unknown) =>
            record(c) &&
            text(c.id) &&
            text(c.partyRef) &&
            ["proposed", "accepted", "rejected", "released"].includes(String(c.status)) &&
            nullable(c.validFrom) &&
            nullable(c.validTo) &&
            texts(c.evidenceRefs) &&
            text(c.decisionRevisionId),
        ),
    )
  );
}
