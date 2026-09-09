// Human and automated judgements are durable records, not caches (INV07,
// INV08). Relations are typed claims rather than a single `same_as`, and
// allocations obey conservation rules so the same economic effect is never
// allocated twice inside one perimeter (INV06).
import {
  hasExactKeys,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import { validInstantText, validTemporalValue, type TemporalValue } from "./time.ts";
import {
  compareDecimals,
  exactQuantity,
  subtractDecimals,
  sumDecimals,
  validQuantity,
  type ExactDecimal,
  type Quantity,
  type ValueError,
} from "./values.ts";

export const RELATION_KINDS = [
  "same_account",
  "connection_contains",
  "account_has_pocket",
  "statement_covers",
  "funded_by",
  "liable_party",
  "beneficial_owner",
  "same_underlying",
  "listed_as",
  "replaces_identifier",
  "provider_same",
  "supersedes",
  "supports",
  "contradicts",
  "pending_to_posted",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * Lifecycle of one typed relation. `accepted` and `released` are the words the
 * stored `entity_relations` CHECK of migration 0029 uses; `adopted` and
 * `superseded` are the older contract wording kept for the v1 fixtures. The
 * domain type is the union of both so a stored row always validates, and
 * `RELATION_STATUS_STORAGE` maps a domain value to the stored one.
 */
export const RELATION_STATUSES = [
  "proposed",
  "adopted",
  "accepted",
  "rejected",
  "superseded",
  "released",
] as const;
export type RelationStatus = (typeof RELATION_STATUSES)[number];
/** The four values `entity_relations.status` accepts. */
export const STORED_RELATION_STATUSES = ["proposed", "accepted", "rejected", "released"] as const;
export type StoredRelationStatus = (typeof STORED_RELATION_STATUSES)[number];
export const RELATION_STATUS_STORAGE: Record<RelationStatus, StoredRelationStatus> = {
  proposed: "proposed",
  adopted: "accepted",
  accepted: "accepted",
  rejected: "rejected",
  superseded: "released",
  released: "released",
};

export interface TypedRelation {
  relationId: string;
  kind: RelationKind;
  left: string;
  right: string;
  /** Period or date the relation applies to; null when unbounded or unknown. */
  validity: TemporalValue | null;
  evidenceRefs: string[];
  status: RelationStatus;
  decisionRevisionRef: string;
}

export const ACTOR_KINDS = ["human", "agent", "system", "legacy-unknown"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
/** Verified by the server, never taken from a request body. Legacy rows keep `legacy-unknown`. */
export interface Actor {
  kind: ActorKind;
  id: string | null;
  verification: "server" | "legacy";
}

export const DECISION_KINDS = [
  "proposal",
  "acceptance",
  "rejection",
  "supersession",
  "release-override",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
export const DECISION_METHODS = [
  "provider",
  "exact",
  "rule",
  "heuristic",
  "ai",
  "manual",
  "legacy-unknown",
] as const;
export type DecisionMethod = (typeof DECISION_METHODS)[number];

export interface DecisionRevision {
  revisionId: string;
  decisionId: string;
  kind: DecisionKind;
  actor: Actor;
  method: DecisionMethod;
  /** Instant the revision became durable. */
  recordedAt: string;
  reason: string;
  targetRefs: string[];
  evidenceRefs: string[];
  /** Revision this one supersedes or overrides; required for supersession and release-override. */
  supersedesRevisionRef: string | null;
  /** Digest of the immutable plan an acceptance was bound to; null for proposals. */
  planDigest: string | null;
}

export const OPERATION_STATUSES = ["accepted", "published", "rejected", "failed"] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Stable receipt for an idempotent command; `accepted` is not `published`. */
export interface OperationReceipt {
  operationId: string;
  idempotencyKey: string;
  principalRef: string;
  payloadDigest: string;
  status: OperationStatus;
  recordedAt: string;
  resultRef: string | null;
  expectedRevisions: Record<string, number>;
}

export const ALLOCATION_ROLES = [
  "principal",
  "fee",
  "refund",
  "settlement",
  "fill",
  "transfer",
  "unresolved-difference",
] as const;
export type AllocationRole = (typeof ALLOCATION_ROLES)[number];

/** How much of one observed amount is attributed to one economic effect. */
export interface Allocation {
  allocationId: string;
  sourceRef: string;
  targetRef: string;
  role: AllocationRole;
  quantity: Quantity;
}

export function validActor(value: unknown): value is Actor {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "id", "verification"])) return false;
  if (!isOneOf(ACTOR_KINDS)(value.kind) || !isTextOrNull(value.id, 256)) return false;
  if (value.kind === "legacy-unknown") return value.id === null && value.verification === "legacy";
  return value.id !== null && value.verification === "server";
}

export function validDecisionRevision(value: unknown): value is DecisionRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "revisionId",
      "decisionId",
      "kind",
      "actor",
      "method",
      "recordedAt",
      "reason",
      "targetRefs",
      "evidenceRefs",
      "supersedesRevisionRef",
      "planDigest",
    ]) ||
    !isText(value.revisionId, 256) ||
    !isText(value.decisionId, 256) ||
    !isOneOf(DECISION_KINDS)(value.kind) ||
    !validActor(value.actor) ||
    !isOneOf(DECISION_METHODS)(value.method) ||
    !validInstantText(value.recordedAt) ||
    !isText(value.reason, 2000) ||
    !isRefList(value.targetRefs, 1_000) ||
    value.targetRefs.length === 0 ||
    !isRefList(value.evidenceRefs) ||
    !isTextOrNull(value.supersedesRevisionRef, 256) ||
    !isTextOrNull(value.planDigest, 128)
  )
    return false;
  if (value.kind === "supersession" || value.kind === "release-override")
    return value.supersedesRevisionRef !== null;
  if (value.kind === "acceptance") return value.planDigest !== null;
  return true;
}

export function validTypedRelation(value: unknown): value is TypedRelation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "relationId",
      "kind",
      "left",
      "right",
      "validity",
      "evidenceRefs",
      "status",
      "decisionRevisionRef",
    ]) &&
    isText(value.relationId, 256) &&
    isOneOf(RELATION_KINDS)(value.kind) &&
    isText(value.left, 512) &&
    isText(value.right, 512) &&
    value.left !== value.right &&
    (value.validity === null || validTemporalValue(value.validity)) &&
    isRefList(value.evidenceRefs) &&
    isOneOf(RELATION_STATUSES)(value.status) &&
    isText(value.decisionRevisionRef, 256)
  );
}

export function validOperationReceipt(value: unknown): value is OperationReceipt {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "operationId",
      "idempotencyKey",
      "principalRef",
      "payloadDigest",
      "status",
      "recordedAt",
      "resultRef",
      "expectedRevisions",
    ]) &&
    isText(value.operationId, 256) &&
    isText(value.idempotencyKey, 256) &&
    isText(value.principalRef, 256) &&
    isText(value.payloadDigest, 128) &&
    isOneOf(OPERATION_STATUSES)(value.status) &&
    validInstantText(value.recordedAt) &&
    isTextOrNull(value.resultRef, 512) &&
    isRecord(value.expectedRevisions) &&
    Object.entries(value.expectedRevisions).every(
      ([key, revision]) => isText(key, 512) && isSafeInt(revision, 0),
    )
  );
}

export function validAllocation(value: unknown): value is Allocation {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["allocationId", "sourceRef", "targetRef", "role", "quantity"]) &&
    isText(value.allocationId, 256) &&
    isText(value.sourceRef, 512) &&
    isText(value.targetRef, 512) &&
    isOneOf(ALLOCATION_ROLES)(value.role) &&
    validQuantity(value.quantity)
  );
}

export type ConservationErrorCode =
  | "conservation_violated"
  | "allocation_exceeds_limit"
  | "negative_allocation";
export interface ConservationError {
  code: ConservationErrorCode;
  message: string;
  refs: string[];
  /** Signed difference in the shared unit, so the caller can show it rather than hide it. */
  difference: Quantity | null;
}
export type ConservationResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: ValueError | ConservationError };

function exactAll(
  unitRef: string,
  quantities: readonly Quantity[],
): { ok: true; values: ExactDecimal[] } | { ok: false; error: ValueError } {
  const foreign = quantities.filter((q) => q.unitRef !== unitRef).map((q) => q.unitRef);
  if (foreign.length > 0)
    return {
      ok: false,
      error: {
        code: "unit_mismatch",
        message: "conservation is checked per unit; cross-unit legs need an FX or fee model",
        refs: [unitRef, ...foreign],
      },
    };
  const absent = quantities
    .filter((q) => q.value.status !== "exact")
    .map((q) => (q.value.status === "exact" ? "" : `${q.value.status}:${q.value.reasonCode}`));
  if (absent.length > 0)
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "non-exact legs cannot be balanced",
        refs: absent,
      },
    };
  return {
    ok: true,
    values: quantities.map((q) => (q.value as { value: ExactDecimal }).value),
  };
}

/**
 * Same-asset transfer: `source decrease = destination increase + explicit fees + unresolved difference`.
 * When no unresolved difference is declared, the legs must balance exactly; a
 * remaining gap is reported, never absorbed into a fee.
 */
export function checkTransferConservation(input: {
  sourceDecrease: Quantity;
  destinationIncrease: Quantity;
  explicitFees: readonly Quantity[];
  unresolvedDifference: Quantity | null;
}): ConservationResult<{ unresolvedDifference: Quantity }> {
  const unitRef = input.sourceDecrease.unitRef;
  const legs = exactAll(unitRef, [
    input.sourceDecrease,
    input.destinationIncrease,
    ...input.explicitFees,
    ...(input.unresolvedDifference ? [input.unresolvedDifference] : []),
  ]);
  if (!legs.ok) return legs;
  const [source, destination, ...rest] = legs.values;
  const declared = input.unresolvedDifference ? rest.pop()! : null;
  const gap = subtractDecimals(subtractDecimals(source!, destination!), sumDecimals(rest));
  const expected = declared ?? { coefficient: "0", scale: 0 };
  if (compareDecimals(gap, expected) !== 0)
    return {
      ok: false,
      error: {
        code: "conservation_violated",
        message: "legs do not balance; declare the unresolved difference explicitly",
        refs: [unitRef],
        difference: exactQuantity(unitRef, gap),
      },
    };
  return { ok: true, unresolvedDifference: exactQuantity(unitRef, gap) };
}

function checkAllocationsWithinLimit(
  limit: Quantity,
  allocations: readonly Allocation[],
  what: string,
): ConservationResult<{ allocated: Quantity; remaining: Quantity }> {
  const legs = exactAll(limit.unitRef, [limit, ...allocations.map((a) => a.quantity)]);
  if (!legs.ok) return legs;
  const [cap, ...values] = legs.values;
  const negative = allocations.filter((_, i) => values[i]!.coefficient.startsWith("-"));
  if (negative.length > 0)
    return {
      ok: false,
      error: {
        code: "negative_allocation",
        message: "allocations are non-negative; reversals are separate allocations",
        refs: negative.map((a) => a.allocationId),
        difference: null,
      },
    };
  const allocated = sumDecimals(values);
  const remaining = subtractDecimals(cap!, allocated);
  if (remaining.coefficient.startsWith("-"))
    return {
      ok: false,
      error: {
        code: "allocation_exceeds_limit",
        message: `allocations exceed the ${what}`,
        refs: allocations.map((a) => a.allocationId),
        difference: exactQuantity(limit.unitRef, remaining),
      },
    };
  return {
    ok: true,
    allocated: exactQuantity(limit.unitRef, allocated),
    remaining: exactQuantity(limit.unitRef, remaining),
  };
}

/** `sum(allocations to an obligation) ≤ eligible outstanding`; the remainder is what is still open. */
export function checkObligationAllocations(input: {
  outstanding: Quantity;
  allocations: readonly Allocation[];
}): ConservationResult<{ allocated: Quantity; remaining: Quantity }> {
  return checkAllocationsWithinLimit(
    input.outstanding,
    input.allocations,
    "eligible outstanding amount",
  );
}

/** `sum(fill quantities) ≤ executed quantity` known for the order revision. */
export function checkFillAllocations(input: {
  executedQuantity: Quantity;
  fills: readonly Allocation[];
}): ConservationResult<{ allocated: Quantity; remaining: Quantity }> {
  return checkAllocationsWithinLimit(input.executedQuantity, input.fills, "executed quantity");
}

/** One observed amount is never allocated beyond itself, whatever the targets (INV06). */
export function checkSourceAllocations(input: {
  sourceAmount: Quantity;
  allocations: readonly Allocation[];
}): ConservationResult<{ allocated: Quantity; remaining: Quantity }> {
  return checkAllocationsWithinLimit(input.sourceAmount, input.allocations, "source amount");
}
