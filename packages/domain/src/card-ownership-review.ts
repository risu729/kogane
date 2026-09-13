import type { SourceFactRef } from "./events.ts";
import type { CardSettlementStatus } from "./card-settlement.ts";

export type CardOwnershipRole = "liable_party" | "beneficial_owner";
export interface CardOwnershipClaim {
  id: string;
  partyRef: string;
  status: "proposed" | "accepted" | "rejected" | "released";
  validFrom: string | null;
  validTo: string | null;
  evidenceRefs: string[];
  decisionRevisionId: string;
}
export interface CardOwnershipSide {
  role: CardOwnershipRole;
  sourceId: string;
  sourceAccount: string;
  fact: SourceFactRef;
  accountId: string | null;
  sourceAccountId: string | null;
  mappingId: string | null;
  mappingRevision: number;
  ownershipRevision: number;
  evidenceRefs: string[];
  blockers: string[];
  claims: CardOwnershipClaim[];
  claimsTruncated: boolean;
}
export interface CardOwnershipReview {
  proposalId: string;
  revision: number;
  status: CardSettlementStatus;
  sides: CardOwnershipSide[];
}
