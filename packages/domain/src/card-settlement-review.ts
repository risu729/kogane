import type {
  CardSettlementImpact,
  CardSettlementReview as StoredReview,
  CardSettlementStatus,
} from "./card-settlement.ts";
import { CARD_DEBIT_ACCOUNT_REASONS, type CardDebitAccountReason } from "./card-debit-account.ts";
import {
  CARD_INFORMATION_REFUSALS,
  type CardInformationRefusal,
} from "./myjcb-card-information.ts";

/**
 * Why a MyJCB page's 「カード情報」 table was not read: the reader's own codes
 * and the lane's two page-level codes (migration 0060's `refusal_code` CHECK).
 */
export const CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS = [
  ...CARD_INFORMATION_REFUSALS,
  "page_not_utf8",
  "raw_object_unreadable",
] as const satisfies readonly string[];
export type CardDebitAccountStatementRefusal =
  | CardInformationRefusal
  | "page_not_utf8"
  | "raw_object_unreadable";

/**
 * The closed reason of a statement whose source states no debit account at
 * all: no Vpass statement API carries a bank, branch or debit-account field
 * (observed absent for every card in round 4, ADR 0032 amendment).
 */
export const SOURCE_STATES_NO_DEBIT_ACCOUNT = "source_states_no_debit_account";

/**
 * What the card provider's own statement says about the bank account it
 * debits, for one settlement candidate (ADR 0032; docs/card-settlements.md,
 * Provider-stated debit accounts). Evidence for the reviewer only: it never
 * changes the candidate's facts, blockers or eligibility.
 *
 * - `supports` / `names_other_account`: the newest row the settlement sweep
 *   appended for the candidate under the current rule policy
 *   (`card_settlement_debit_account_evidence`), with the bank account the
 *   rule's proposal names and how many leading digits it compared;
 * - `not_proposed`: that row, where the rule made no proposal, with its
 *   closed reason;
 * - `statement_refused`: no such row, and the page's table was refused under
 *   the current reader version, with the reader's closed code;
 * - `not_recorded`: neither a row nor a refusal yet (the lanes have not
 *   reached the candidate, or the bank has more known accounts than the rule
 *   is given). A reason, never a guess;
 * - `not_stated_by_source`: the statement's source states no debit account
 *   (`source_states_no_debit_account`, Vpass).
 */
export type CardSettlementDebitAccount =
  | {
      outcome: "supports" | "names_other_account";
      reason: null;
      policy: string;
      bankSourceId: string;
      bankSourceAccount: string;
      visibleDigitCount: number;
      recordedAt: string;
    }
  | {
      outcome: "not_proposed";
      reason: CardDebitAccountReason;
      policy: string;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: string;
    }
  | {
      outcome: "statement_refused";
      reason: CardDebitAccountStatementRefusal;
      policy: null;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: null;
    }
  | {
      outcome: "not_recorded";
      reason: null;
      policy: null;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: null;
    }
  | {
      outcome: "not_stated_by_source";
      reason: typeof SOURCE_STATES_NO_DEBIT_ACCOUNT;
      policy: null;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: null;
    };

/** One stored `card_settlement_debit_account_evidence` row, as read. */
export interface DebitAccountEvidenceRow {
  outcome: string;
  reason: string | null;
  policy: string;
  proposal_json: string | null;
  created_at: string;
}

const UNSTATED = {
  policy: null,
  bankSourceId: null,
  bankSourceAccount: null,
  visibleDigitCount: null,
  recordedAt: null,
} as const;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * The reviewer's view of a candidate's provider-stated debit account, from
 * the newest evidence row under the current policy (or none) and the
 * refusal code of the page's reading under the current reader version (or
 * none). A Vpass statement is `not_stated_by_source` whatever is passed. A
 * stored row that breaks the evidence contract throws: an unavailable answer,
 * never a plausible one.
 */
export function cardSettlementDebitAccount(
  sourceId: "vpass" | "myjcb",
  evidence: DebitAccountEvidenceRow | null,
  refusalCode: string | null,
): CardSettlementDebitAccount {
  if (sourceId === "vpass")
    return { outcome: "not_stated_by_source", reason: SOURCE_STATES_NO_DEBIT_ACCOUNT, ...UNSTATED };
  if (evidence === null) {
    if (refusalCode === null) return { outcome: "not_recorded", reason: null, ...UNSTATED };
    if (!isOneOf(CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS, refusalCode))
      throw new Error("card_settlement_debit_account_invalid");
    return { outcome: "statement_refused", reason: refusalCode, ...UNSTATED };
  }
  if (evidence.outcome === "not_proposed") {
    if (evidence.proposal_json !== null || !isOneOf(CARD_DEBIT_ACCOUNT_REASONS, evidence.reason))
      throw new Error("card_settlement_debit_account_invalid");
    return {
      outcome: "not_proposed",
      reason: evidence.reason,
      policy: evidence.policy,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: evidence.created_at,
    };
  }
  if (
    (evidence.outcome !== "supports" && evidence.outcome !== "names_other_account") ||
    evidence.reason !== null ||
    evidence.proposal_json === null
  )
    throw new Error("card_settlement_debit_account_invalid");
  const proposal: unknown = JSON.parse(evidence.proposal_json);
  if (
    proposal === null ||
    typeof proposal !== "object" ||
    Array.isArray(proposal) ||
    !("bankSourceId" in proposal) ||
    !("bankSourceAccount" in proposal) ||
    !("visibleDigitCount" in proposal) ||
    typeof proposal.bankSourceId !== "string" ||
    typeof proposal.bankSourceAccount !== "string" ||
    proposal.bankSourceId.length === 0 ||
    proposal.bankSourceAccount.length === 0 ||
    typeof proposal.visibleDigitCount !== "number" ||
    !Number.isSafeInteger(proposal.visibleDigitCount) ||
    proposal.visibleDigitCount < 1
  )
    throw new Error("card_settlement_debit_account_invalid");
  return {
    outcome: evidence.outcome,
    reason: null,
    policy: evidence.policy,
    bankSourceId: proposal.bankSourceId,
    bankSourceAccount: proposal.bankSourceAccount,
    visibleDigitCount: proposal.visibleDigitCount,
    recordedAt: evidence.created_at,
  };
}

/** Read-side review metadata; stored financial facts and impact stay in the domain contract. */
export interface CardSettlementReview extends StoredReview {
  acceptanceBlockers: string[];
  impact: CardSettlementImpact;
  /** The card provider's own statement of its debit account (evidence only). */
  debitAccount: CardSettlementDebitAccount;
  history: {
    revision: number;
    status: Exclude<CardSettlementStatus, "proposed">;
    decisionRevisionId: string;
    createdAt: string;
  }[];
  historyTruncated: boolean;
}

export interface CardSettlementReviewPage {
  items: CardSettlementReview[];
  nextOffset: number | null;
  coverage: {
    scope: "card-statement-bank-debit-candidates";
    completeTransactionHistory: false;
    netAssets: "unknown";
    limit: number;
  };
}
