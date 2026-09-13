import {
  cardSettlementImpact,
  type CardSettlementFacts,
} from "../../domain/src/card-settlement.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import type { CardSettlementReview } from "../../domain/src/card-settlement-review.ts";

export function settlementFacts(unknownOwner = false): CardSettlementFacts {
  const amount = exactQuantity("JPY", integerDecimal(3000));
  return {
    statement: {
      ref: { kind: "balance", id: "balance:11", revision: "parse_run:1" },
      sourceId: "myjcb",
      sourceAccount: "synthetic-card",
      accountId: "acct-card",
      ownerRef: unknownOwner ? null : "party:synthetic-self",
      amount,
      paymentDate: {
        kind: "local-date",
        value: "2026-09-10",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      period: "2026-09",
    },
    bankDebit: {
      ref: { kind: "transaction", id: "transaction:12", revision: "parse_run:2" },
      sourceId: "sony-bank",
      sourceAccount: "synthetic-bank",
      accountId: "acct-bank",
      ownerRef: "party:synthetic-self",
      amount,
      occurred: { kind: "local-date", value: "2026-09-10", zone: "Asia/Tokyo", basis: "provider" },
    },
    rationaleCodes: [
      "authoritative_statement_total",
      "observed_bank_debit",
      "amount_equal",
      "date_within_window",
    ],
    rejectionConditions: ["statement_changed", "allocation_already_used"],
    ownership: unknownOwner ? "unknown" : "established-same",
    ownershipEvidenceRefs: unknownOwner ? [] : ["decision:synthetic-owner"],
    feeBreakdown: "unknown",
  };
}
export function settlementReview(unknownOwner = false): CardSettlementReview {
  const facts = settlementFacts(unknownOwner);
  return {
    proposalId: "card-settlement-synthetic",
    revision: 0,
    status: "proposed",
    facts,
    decisionRevisionId: null,
    eventId: null,
    obligationId: null,
    settlementId: null,
    createdAt: "2026-09-11T00:00:00Z",
    acceptanceBlockers: unknownOwner ? ["owner_not_established"] : [],
    impact: cardSettlementImpact(facts, "proposed"),
    history: [],
    historyTruncated: false,
  };
}
