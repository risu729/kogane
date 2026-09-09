// The change lifecycle contract: what a plan is, who may act on one, and the
// ports the application layer needs from a store and from the domain writers.
//
// Nothing here reaches for Cloudflare types, a database driver or HTTP. The
// store is structural (`{ sql, binds }` in, row objects out) so the same code
// runs against D1 in a Worker and against a test double.
import { isOneOf, isRecord, isText } from "../../../domain/src/guards.ts";
import { RELATION_KINDS, type RelationKind } from "../../../domain/src/decisions.ts";

/**
 * The closed list of change kinds. There is no external money action here and
 * none is added by configuration: a new kind is a reviewed code change.
 */
export const CHANGE_KINDS = [
  "identity.assign",
  "identity.release-override",
  "relation.accept",
  "relation.reject",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const IDENTITY_SUBJECTS = ["account", "instrument"] as const;
export type IdentitySubject = (typeof IDENTITY_SUBJECTS)[number];

export interface IdentityAssignPayload {
  subject: IdentitySubject;
  referenceId: string;
  targetId: string;
  reason: string;
}
export interface IdentityReleasePayload {
  subject: IdentitySubject;
  referenceId: string;
  reason: string;
}
export interface RelationPayload {
  relationKind: RelationKind;
  fromRef: string;
  toRef: string;
  validFrom: string | null;
  validTo: string | null;
  evidenceRefs: string[];
  reason: string;
}
export type ChangePayload = IdentityAssignPayload | IdentityReleasePayload | RelationPayload;

const REASON_MAX = 1000;

/**
 * Payload validators reject unknown keys, so a caller cannot smuggle a field
 * the server would later read — in particular no caller-supplied "impact",
 * "approved" or "expectedRevisions": those are server facts (addendum 10 §5).
 */
export function validPayload(kind: ChangeKind, value: unknown): value is ChangePayload {
  if (!isRecord(value)) return false;
  const reason = isText(value.reason, REASON_MAX) && value.reason.trim() !== "";
  if (kind === "identity.assign" || kind === "identity.release-override") {
    const assign = kind === "identity.assign";
    const keys = assign
      ? ["subject", "referenceId", "targetId", "reason"]
      : ["subject", "referenceId", "reason"];
    return (
      exactKeys(value, keys) &&
      isOneOf(IDENTITY_SUBJECTS)(value.subject) &&
      isText(value.referenceId, 512) &&
      (!assign || isText(value.targetId, 512)) &&
      reason
    );
  }
  return (
    exactKeys(value, [
      "relationKind",
      "fromRef",
      "toRef",
      "validFrom",
      "validTo",
      "evidenceRefs",
      "reason",
    ]) &&
    isOneOf(RELATION_KINDS)(value.relationKind) &&
    isText(value.fromRef, 512) &&
    isText(value.toRef, 512) &&
    value.fromRef !== value.toRef &&
    optionalDate(value.validFrom) &&
    optionalDate(value.validTo) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length <= 100 &&
    value.evidenceRefs.every((ref) => isText(ref, 512)) &&
    new Set(value.evidenceRefs).size === value.evidenceRefs.length &&
    reason
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function optionalDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value));
}

export function isChangeKind(value: unknown): value is ChangeKind {
  return isOneOf(CHANGE_KINDS)(value);
}

// ── principals and grants ───────────────────────────────────────────────

/**
 * The minimum-privilege set of addendum 10 §2 that this change lifecycle
 * needs. `interpretation.accept` is what an approval requires; agents get
 * `interpretation.propose` only, so they can plan and simulate but never
 * approve or commit.
 */
export const COMMAND_CAPABILITIES = ["interpretation.propose", "interpretation.accept"] as const;
export type CommandCapability = (typeof COMMAND_CAPABILITIES)[number];

export const PRINCIPAL_KINDS = ["human", "agent"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Always built from a server-verified identity, never from a request body. */
export interface Principal {
  id: string;
  kind: PrincipalKind;
  verification: "server";
  capabilities: readonly CommandCapability[];
}

export function principalCan(principal: Principal, capability: CommandCapability): boolean {
  return principal.capabilities.includes(capability);
}

/**
 * Where grants come from. A08 replaces the placeholder loader with its grant
 * registry; the contract it must satisfy is this one function.
 */
export interface GrantLoader {
  principalFor(subject: string): Principal;
}

// ── store port ──────────────────────────────────────────────────────────

/** One statement of a batch. The application layer never runs raw caller text. */
export interface PreparedWrite {
  sql: string;
  binds: readonly unknown[];
}

export interface BatchOutcome {
  changes: number;
}

export interface CommandStore {
  first<T>(sql: string, binds?: readonly unknown[]): Promise<T | null>;
  all<T>(sql: string, binds?: readonly unknown[]): Promise<T[]>;
  /** One transaction. Every statement after the first is guarded on its effect. */
  batch(writes: readonly PreparedWrite[]): Promise<readonly BatchOutcome[]>;
}

// ── plans, simulations, approvals, receipts ─────────────────────────────

/** `{ subjectRef: revision }`; the revision every commit re-verifies in-batch. */
export type ExpectedRevisions = Record<string, number>;

export interface PlanTarget {
  /** `account_mapping:<ref>`, `instrument_mapping:<ref>` or `relation:<kind>|<from>|<to>`. */
  subjectRef: string;
  currentRevision: number;
  /** What the subject resolves to today; null when it resolves to nothing yet. */
  currentTargetRef: string | null;
  /** What the plan would make it resolve to. */
  proposedTargetRef: string | null;
}

/**
 * Server-computed impact. Counts, identifiers and reason codes only: no
 * amounts, no provider text (addendum 10 §4, addendum 12 §5).
 */
export interface Simulation {
  kind: ChangeKind;
  targets: PlanTarget[];
  before: { attributedObservations: number; relations: number };
  after: { attributedObservations: number; relations: number };
  /** Read models and snapshots this change makes stale. */
  invalidations: string[];
  /** Source ids whose scope the change touches; never a hidden scope. */
  affectedScopes: string[];
  /** Sealed identity runs whose attribution the change moves. */
  affectedParseRuns: number;
  /** Outbox targets a commit of this plan would enqueue. */
  outboxTargets: OutboxTarget[];
}

export const OUTBOX_TARGETS = [
  "identity-projection",
  "balance-projection",
  "agent-notify",
] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

export const PLAN_STATUSES = ["planned", "approved", "committed", "stale", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface ChangePlan {
  planId: string;
  planDigest: string;
  kind: ChangeKind;
  payload: ChangePayload;
  baseContextId: string;
  expectedRevisions: ExpectedRevisions;
  simulation: Simulation;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: PlanStatus;
}

export interface ApprovalReceipt {
  approvalId: string;
  planId: string;
  planDigest: string;
  approverActor: string;
  approverVerification: "server";
  scope: string[];
  expiresAt: string;
  usesRemaining: number;
  createdAt: string;
}

export const OPERATION_RECEIPT_STATUSES = ["accepted", "published", "failed"] as const;
export type OperationReceiptStatus = (typeof OPERATION_RECEIPT_STATUSES)[number];

/**
 * The stable receipt. `accepted` says the judgement is durable; `published`
 * says every outbox target of that judgement has been processed. A UI or an
 * agent must not read `accepted` as "every screen is up to date".
 */
export interface CommandReceipt {
  operationId: string;
  principal: string;
  operationKind: ChangeKind;
  planId: string;
  planDigest: string;
  payloadDigest: string;
  status: OperationReceiptStatus;
  acceptedAt: string;
  publishedAt: string | null;
  decisionRevisionId: string;
  expectedRevisions: ExpectedRevisions;
  outboxTargets: OutboxTarget[];
  /** Identifiers of what the mutation wrote; never amounts. */
  result: Record<string, unknown>;
}

// ── mutation planner port ───────────────────────────────────────────────

/** A SQL fragment every write of the commit batch is joined to. */
export interface CommitGuard {
  sql: string;
  binds: readonly unknown[];
}

export interface MutationInput {
  store: CommandStore;
  plan: ChangePlan;
  principal: Principal;
  operationId: string;
  now: string;
  guard: CommitGuard;
}

export interface MutationWrites {
  /** Appended to the commit batch in order; each is guarded. */
  writes: PreparedWrite[];
  decisionRevisionId: string;
  result: Record<string, unknown>;
}

/**
 * How one change kind is written. The identity kinds are supplied by the
 * observation pipeline so the commit reuses `executeIdentityCommand`'s
 * statements rather than a second copy of them.
 */
export type MutationPlanner = (input: MutationInput) => Promise<MutationWrites | null>;
export type MutationPlanners = Partial<Record<ChangeKind, MutationPlanner>>;

/** Deterministic row key: a prefix and a SHA-256 over the JSON of the parts. */
export async function commandKey(prefix: string, parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return `${prefix}_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
