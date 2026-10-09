// The economic-event command vocabulary (ADR 0054, G2; CORE 0071).
//
// Four reviewed command kinds name what a human-adopted economic writer may
// one day ask the change lifecycle to do with an event: adopt a proposal,
// correct an adopted revision, withdraw it, or move one consumed row from one
// event to another in a single commit. CORE 0071 admits the kinds in the
// command tables' CHECKs; no planner exists for any of them, so the change
// lifecycle refuses every command of these kinds (`unsupported_semantics`)
// and nothing here is executable. The payload shapes below are the contract
// a planner (G3) will read; today only validation tests use them.
//
// A payload never states an amount. A restated leg cites the row it is read
// from, and the value is the cited row's (INV03: amounts are added here from
// stored values, never taken from a caller). Every shape names the
// transaction family (`event-families.ts`) whose writer the command is for,
// so a planner can refuse a family it does not cover.
//
// `economic-event.resolve-identity`, the kind CORE 0070 reserves and refuses
// outright, is not in this vocabulary: whether it belongs here is an open
// owner question (ADR 0054, amendment "G2 as implemented").
import {
  bookClaimId,
  validBookClaim,
  validBookClaimSet,
  type BookClaim,
} from "./economic-contract.ts";
import { TRANSACTION_FAMILIES, type TransactionFamily } from "./event-families.ts";
import {
  ECONOMIC_EVENT_KINDS,
  EVENT_STATE_FAMILIES,
  LEG_ROLES,
  RECOGNITION_BASES,
  UNKNOWN_STATE_REASONS,
  validSourceFactRef,
  type EconomicEventKind,
  type EventState,
  type LegRole,
  type RecognitionBasis,
  type SourceFactRef,
  type UnknownStateReason,
} from "./events.ts";
import { hasExactKeys, isArrayOf, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";

/** The closed list CORE 0071 adds to `change_plans.kind` and `operation_receipts.operation_kind`. */
export const ECONOMIC_EVENT_COMMAND_KINDS = [
  "economic-event.adopt",
  "economic-event.correct",
  "economic-event.withdraw",
  "economic-event.move",
] as const;
export type EconomicEventCommandKind = (typeof ECONOMIC_EVENT_COMMAND_KINDS)[number];
export const isEconomicEventCommandKind = isOneOf(ECONOMIC_EVENT_COMMAND_KINDS);

/** Legs and claims a restated revision may carry; the 0070 commit row holds at most 64 claims. */
export const RESTATED_LEGS_MAX = 64;
export const RESTATED_CLAIMS_MAX = 64;
const REASON_MAX = 1000;
const ACCOUNT_SUBJECT = "account:";

/**
 * One leg of a restated revision. `subjectRef` is the canonical
 * `account:<id>` form every new writer uses (ADR 0054); `source` is the
 * transaction row the leg is read from, whose stored value is the leg's.
 */
export interface RestatedLeg {
  legIndex: number;
  subjectRef: string;
  role: LegRole;
  basis: RecognitionBasis;
  source: SourceFactRef;
}

/**
 * A full revision, nothing implicit: every leg and every claim. A revision
 * in state `unknown` (the withdrawal shape) has no legs and no claims; any
 * other has at least one of each.
 */
export interface RestatedRevision {
  kind: EconomicEventKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  legs: RestatedLeg[];
  claims: BookClaim[];
}

/** `economic-event.adopt`: adopt one proposal of a family. */
export interface EconomicEventAdoptPayload {
  family: TransactionFamily;
  proposalId: string;
  reason: string;
}
/**
 * `economic-event.correct`: revision `priorRevision` of `eventId` is
 * superseded by the restated `revision`; `releasedClaims` lists every claim
 * the prior held that the restatement drops.
 */
export interface EconomicEventCorrectPayload {
  family: TransactionFamily;
  eventId: string;
  priorRevision: number;
  revision: RestatedRevision;
  releasedClaims: BookClaim[];
  reason: string;
}
/**
 * `economic-event.withdraw`: revision `revision` of `eventId`, adopted by
 * decision `decisionRevisionId` (the adopting epoch), is withdrawn: the next
 * revision is `unknown` with no legs or claims and releases every claim.
 */
export interface EconomicEventWithdrawPayload {
  family: TransactionFamily;
  eventId: string;
  revision: number;
  decisionRevisionId: string;
  reason: string;
}
/** One member of a move: an event's prior revision and its restatement. */
export interface MovedMember {
  eventId: string;
  priorRevision: number;
  revision: RestatedRevision;
}
/**
 * `economic-event.move`: one commit with two members. `from` is restated
 * without `claim`, `to` with it.
 */
export interface EconomicEventMovePayload {
  family: TransactionFamily;
  claim: BookClaim;
  from: MovedMember;
  to: MovedMember;
  reason: string;
}
export type EconomicEventCommandPayload =
  | EconomicEventAdoptPayload
  | EconomicEventCorrectPayload
  | EconomicEventWithdrawPayload
  | EconomicEventMovePayload;

const isFamily = isOneOf(TRANSACTION_FAMILIES);

function validReason(value: unknown): value is string {
  return isText(value, REASON_MAX) && value.trim() !== "";
}

export function validRestatedLeg(value: unknown): value is RestatedLeg {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["legIndex", "subjectRef", "role", "basis", "source"]) &&
    isSafeInt(value.legIndex, 0, RESTATED_LEGS_MAX - 1) &&
    isText(value.subjectRef, 512) &&
    value.subjectRef.startsWith(ACCOUNT_SUBJECT) &&
    value.subjectRef.length > ACCOUNT_SUBJECT.length &&
    isOneOf(LEG_ROLES)(value.role) &&
    isOneOf(RECOGNITION_BASES)(value.basis) &&
    validSourceFactRef(value.source) &&
    value.source.kind === "transaction"
  );
}

export function validRestatedRevision(value: unknown): value is RestatedRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "state", "unknownReason", "legs", "claims"]) ||
    !isOneOf(ECONOMIC_EVENT_KINDS)(value.kind)
  )
    return false;
  const family: readonly string[] = EVENT_STATE_FAMILIES[value.kind];
  if (typeof value.state !== "string" || !family.includes(value.state)) return false;
  const unknown = value.state === "unknown";
  if (unknown ? !isOneOf(UNKNOWN_STATE_REASONS)(value.unknownReason) : value.unknownReason !== null)
    return false;
  const legs = value.legs;
  const claims = value.claims;
  if (
    !isArrayOf(validRestatedLeg, RESTATED_LEGS_MAX)(legs) ||
    !validBookClaimSet(claims, RESTATED_CLAIMS_MAX)
  )
    return false;
  // Leg indexes are 0..n-1, each once: nothing is left to a default.
  const indexes = new Set(legs.map((leg) => leg.legIndex));
  if (indexes.size !== legs.length || legs.some((leg) => leg.legIndex >= legs.length)) return false;
  return unknown ? legs.length === 0 && claims.length === 0 : legs.length > 0 && claims.length > 0;
}

function validMovedMember(value: unknown): value is MovedMember {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["eventId", "priorRevision", "revision"]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.priorRevision, 1) &&
    validRestatedRevision(value.revision)
  );
}

/**
 * Exact keys and closed values per kind, the reason included (non-blank, at
 * most 1000 characters). Shape only: whether a proposal, event, revision or
 * decision exists, and what a prior revision held, are a planner's to read.
 */
export function validEconomicEventCommandPayload(
  kind: EconomicEventCommandKind,
  value: unknown,
): value is EconomicEventCommandPayload {
  if (!isRecord(value) || !isFamily(value.family) || !validReason(value.reason)) return false;
  switch (kind) {
    case "economic-event.adopt":
      return (
        hasExactKeys(value, ["family", "proposalId", "reason"]) && isText(value.proposalId, 512)
      );
    case "economic-event.correct": {
      if (
        !hasExactKeys(value, [
          "family",
          "eventId",
          "priorRevision",
          "revision",
          "releasedClaims",
          "reason",
        ]) ||
        !isText(value.eventId, 256) ||
        !isSafeInt(value.priorRevision, 1) ||
        !validRestatedRevision(value.revision) ||
        // A correction to `unknown` with nothing held is a withdrawal.
        value.revision.state === "unknown" ||
        !validBookClaimSet(value.releasedClaims, RESTATED_CLAIMS_MAX)
      )
        return false;
      // A released claim is not restated.
      const kept = new Set(value.revision.claims.map(bookClaimId));
      return value.releasedClaims.every((claim) => !kept.has(bookClaimId(claim)));
    }
    case "economic-event.withdraw":
      return (
        hasExactKeys(value, ["family", "eventId", "revision", "decisionRevisionId", "reason"]) &&
        isText(value.eventId, 256) &&
        isSafeInt(value.revision, 1) &&
        isText(value.decisionRevisionId, 256)
      );
    case "economic-event.move": {
      if (
        !hasExactKeys(value, ["family", "claim", "from", "to", "reason"]) ||
        !validBookClaim(value.claim) ||
        !validMovedMember(value.from) ||
        !validMovedMember(value.to) ||
        value.from.eventId === value.to.eventId ||
        // The member that receives the claim holds something.
        value.to.revision.state === "unknown"
      )
        return false;
      const moved = bookClaimId(value.claim);
      return (
        !value.from.revision.claims.some((claim) => bookClaimId(claim) === moved) &&
        value.to.revision.claims.some((claim) => bookClaimId(claim) === moved)
      );
    }
  }
}
