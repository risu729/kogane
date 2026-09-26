// The vocabulary of reviewing a recognised card purchase (ADR 0017, plan
// 2026-09 §1.1–§1.4): excluding a row that is not a purchase, allocating a
// refund to its purchase, and linking later installment portions to their
// obligation. Each is a human decision made through the change lifecycle; a
// heuristic may only propose one (INV07).
//
// This module holds the closed codes and reference shapes only. No review is
// executable yet: the change kinds exist (CORE 0051) but no planner is
// registered, so planning any of them is refused with `unsupported_semantics`
// and writes nothing. Later changes add the planners, never another kind.
import type { CardPurchaseKind } from "./card-purchase.ts";

/**
 * Why a reviewer says a card usage row is not a purchase. Closed: a new
 * reason is a reviewed change.
 */
export const CARD_PURCHASE_EXCLUSION_REASONS = [
  /** An annual fee or a charge (年会費・手数料), not spending at a merchant. */
  "card_fee",
  /** A cash advance, which is borrowing, not a purchase. */
  "cash_advance",
  /** Charging the owner's own stored value: an internal movement, not spending. */
  "own_account_transfer",
  /** A provider-side correction row. */
  "provider_adjustment",
  /** None of the above; the written reason says what it is. */
  "other",
] as const;
export type CardPurchaseExclusionReason = (typeof CARD_PURCHASE_EXCLUSION_REASONS)[number];

/** Decisions that exclude (and later restore) one event: `card-usage-exclusion:<event id>`. */
export const CARD_USAGE_EXCLUSION_SUBJECT_PREFIX = "card-usage-exclusion:";
/** The allocation state of one refund event: `card-refund:<refund event id>`. */
export const CARD_REFUND_SUBJECT_PREFIX = "card-refund:";
/** The refunds allocated to one purchase event: `card-refund-target:<purchase event id>`. */
export const CARD_REFUND_TARGET_SUBJECT_PREFIX = "card-refund-target:";
/** The reviewed portion links of one obligation: `card-installment:<obligation id>`. */
export const CARD_INSTALLMENT_SUBJECT_PREFIX = "card-installment:";

/** The invalidation each review's plan carries, so a confirmation screen can tell it apart. */
export const CARD_PURCHASE_EXCLUSION_INVALIDATION = "review:card-purchase-exclusion";
export const CARD_REFUND_ALLOCATION_INVALIDATION = "review:card-refund-allocation";
export const CARD_INSTALLMENT_LINK_INVALIDATION = "review:card-installment-link";

/** A purchase plan has at most 36 portions, so one link or unlink names at most 36. */
export const CARD_INSTALLMENT_PORTIONS_MAX = 36;

const EVENT_ID = /^(purchase|refund)_[0-9a-f]{64}$/u;
const ALLOCATION_ID = /^ra_[0-9a-f]{64}$/u;
const OBLIGATION_ID = /^obl_cp_[0-9a-f]{64}$/u;
/** A usage row pinned to the parse run it was read in (`pinnedRef`). */
const PORTION_REF = /^transaction:[1-9][0-9]{0,15}@parse_run:[1-9][0-9]{0,15}$/u;
const PORTION_KEY_MAX = 1024;

/** `purchase_<sha256>` or `refund_<sha256>`, as `cardPurchaseEventId` names them. */
export function isCardPurchaseEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID.test(value);
}
/** An event id of one kind: a refund allocation runs from a refund to a purchase. */
export function isCardEventIdOfKind(value: unknown, kind: CardPurchaseKind): value is string {
  return isCardPurchaseEventId(value) && value.startsWith(`${kind}_`);
}
/** `ra_<sha256>`, the id a refund allocation will be written under. */
export function isCardRefundAllocationId(value: unknown): value is string {
  return typeof value === "string" && ALLOCATION_ID.test(value);
}
/** `obl_cp_<sha256>`, the id of the obligation an installment purchase keeps. */
export function isCardInstallmentObligationId(value: unknown): value is string {
  return typeof value === "string" && OBLIGATION_ID.test(value);
}
/** `transaction:<observation id>@parse_run:<parse run id>`: one later portion's row. */
export function isCardInstallmentPortionRef(value: unknown): value is string {
  return typeof value === "string" && PORTION_REF.test(value);
}
/**
 * The JSON text of one recognition key (`[source, producer, namespace,
 * account, external id]`, namespace possibly null): the key a linked portion
 * is held under.
 */
export function isCardInstallmentPortionKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > PORTION_KEY_MAX)
    return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5 || JSON.stringify(parsed) !== value)
    return false;
  return parsed.every(
    (part, index) =>
      (typeof part === "string" && part.length > 0) || (index === 2 && part === null),
  );
}

/** One to `CARD_INSTALLMENT_PORTIONS_MAX` distinct entries, each accepted by `valid`. */
export function isPortionList(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CARD_INSTALLMENT_PORTIONS_MAX &&
    value.every(valid) &&
    new Set(value).size === value.length
  );
}

export function cardUsageExclusionSubjectRef(eventId: string): string {
  return `${CARD_USAGE_EXCLUSION_SUBJECT_PREFIX}${eventId}`;
}
export function cardRefundSubjectRef(refundEventId: string): string {
  return `${CARD_REFUND_SUBJECT_PREFIX}${refundEventId}`;
}
export function cardRefundTargetSubjectRef(purchaseEventId: string): string {
  return `${CARD_REFUND_TARGET_SUBJECT_PREFIX}${purchaseEventId}`;
}
export function cardInstallmentSubjectRef(obligationId: string): string {
  return `${CARD_INSTALLMENT_SUBJECT_PREFIX}${obligationId}`;
}
