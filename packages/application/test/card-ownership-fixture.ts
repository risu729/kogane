import type { CardOwnershipReview } from "../../domain/src/card-ownership-review.ts";
import { ownershipReviewEvidenceRefs } from "../../domain/src/ownership-review.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
export function ownershipReview(): CardOwnershipReview {
  const facts = settlementFacts(true);
  facts.bankDebit.sourceId = "smbc-bank";
  return {
    proposalId: "card-settlement-synthetic",
    revision: 0,
    status: "proposed",
    sides: [
      ["liable_party", facts.statement, "sa-card", "mapping-card"],
      ["beneficial_owner", facts.bankDebit, "sa-bank", "mapping-bank"],
    ].map(([role, fact, sourceAccountId, mappingId]) => {
      const item = fact as typeof facts.statement;
      return {
        role: role as "liable_party" | "beneficial_owner",
        sourceId: item.sourceId,
        sourceAccount: item.sourceAccount,
        fact: item.ref,
        accountId: item.accountId,
        sourceAccountId: sourceAccountId as string,
        mappingId: mappingId as string,
        mappingRevision: 1,
        ownershipRevision: 0,
        evidenceRefs: ownershipReviewEvidenceRefs(
          "card-settlement-synthetic",
          item.ref,
          mappingId as string,
        ),
        blockers: [],
        claims: [],
        claimsTruncated: false,
      };
    }),
  };
}
