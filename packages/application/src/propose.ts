// `kogane.reconcile.propose`: the only write this service has, and it writes
// a proposal, never an adoption.
//
// A proposal is one `decision_revisions` row of kind `propose` plus one
// `entity_relations` row with status `proposed` (migration 0029). No reader
// adopts a `proposed` relation, so a proposal cannot change a balance, a
// mapping, a total or any adopted set. Acceptance is a human operator path
// (addendum 10 section 5) and no capability in this package can reach it.
//
// The free text an agent writes is a `reason` stored as data. It is not a
// tool name, a scope, a URL or a query, and it is never executed. Every ref
// the proposal names is resolved server-side: it must exist and be inside the
// grant, and "does not exist" and "outside the grant" are the same answer.
import { RELATION_KINDS, type RelationKind } from "../../domain/src/decisions.ts";
import { canonicalDigest } from "../../domain/src/context.ts";
import type { FinancialError } from "../../domain/src/result.ts";
import { financialError } from "./errors.ts";
import { type Grant, grantAllows, grantAllowsRow } from "./grants.ts";
import type { OpenedContext } from "./context/open.ts";

export const PROPOSAL_METHODS = ["ai", "manual"] as const;
export type ProposalMethod = (typeof PROPOSAL_METHODS)[number];

export interface ProposalRequest {
  kind: RelationKind;
  /** `source_account:<id>` refs the grant covers. */
  from: string;
  to: string;
  /** `observation:<kind>:<id>` or `fetch_artifact:<id>` refs that support it. */
  evidenceRefs: string[];
  reason: string;
  method: ProposalMethod;
}

/** The scope a ref belongs to, or `null` when the store has no such row. */
export interface ResolvedRef {
  sourceId: string;
  account: string | null;
}

export interface StoredProposal {
  decisionRevisionId: string;
  relationId: string;
  kind: RelationKind;
  fromRef: string;
  toRef: string;
  method: ProposalMethod;
  /** Server-verified principal; never a body claim. */
  actorId: string;
  reason: string;
  evidenceRefs: string[];
  recordedAt: string;
}

/**
 * The store behind a proposal. Reads resolve refs to their scope; the write
 * appends the two append-only rows in one batch. Nothing here can update or
 * delete, and nothing here can write an `accepted` relation.
 */
export interface ProposalStore {
  resolveTarget(ref: string): Promise<ResolvedRef | null>;
  resolveEvidence(ref: string): Promise<ResolvedRef | null>;
  appendProposal(proposal: StoredProposal): Promise<void>;
}

export interface ProposalReceipt {
  schemaVersion: "proposal-receipt-v1";
  proposalId: string;
  relationId: string;
  decisionRevisionId: string;
  contextId: string;
  status: "proposed";
  /** A proposal is not an adoption; the receipt says so in the contract. */
  adopted: false;
  recordedAt: string;
}

export type ProposalOutcome =
  | { ok: true; receipt: ProposalReceipt }
  | { ok: false; error: FinancialError };

const TARGET_REF = /^source_account:[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const EVIDENCE_REF =
  /^(?:observation:(?:transaction|balance|position|valuation):[1-9][0-9]{0,15}|fetch_artifact:[1-9][0-9]{0,15})$/u;
const REQUEST_KEYS = ["kind", "from", "to", "evidenceRefs", "reason", "method"] as const;

export function parseProposalRequest(
  value: unknown,
  maxTargets: number,
):
  | { ok: true; value: ProposalRequest }
  | {
      ok: false;
      code: "unsupported_semantics" | "invalid_query" | "budget_exceeded";
      refs: string[];
    } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, code: "invalid_query", refs: [] };
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter(
    (key) => !(REQUEST_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    return { ok: false, code: "unsupported_semantics", refs: unknown.slice(0, 10) };
  const kind = body["kind"];
  if (typeof kind !== "string" || !(RELATION_KINDS as readonly string[]).includes(kind))
    return { ok: false, code: "unsupported_semantics", refs: ["kind"] };
  const from = body["from"];
  const to = body["to"];
  if (typeof from !== "string" || !TARGET_REF.test(from))
    return { ok: false, code: "invalid_query", refs: ["from"] };
  if (typeof to !== "string" || !TARGET_REF.test(to) || to === from)
    return { ok: false, code: "invalid_query", refs: ["to"] };
  const evidenceRefs = body["evidenceRefs"];
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length === 0 ||
    new Set(evidenceRefs).size !== evidenceRefs.length ||
    !evidenceRefs.every((ref) => typeof ref === "string" && EVIDENCE_REF.test(ref))
  )
    return { ok: false, code: "invalid_query", refs: ["evidenceRefs"] };
  if (evidenceRefs.length + 2 > maxTargets)
    return { ok: false, code: "budget_exceeded", refs: ["budget:maxProposalTargets"] };
  const reason = body["reason"];
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 2000)
    return { ok: false, code: "invalid_query", refs: ["reason"] };
  const method = body["method"];
  if (typeof method !== "string" || !(PROPOSAL_METHODS as readonly string[]).includes(method))
    return { ok: false, code: "unsupported_semantics", refs: ["method"] };
  return {
    ok: true,
    value: {
      kind: kind as RelationKind,
      from,
      to,
      evidenceRefs: evidenceRefs as string[],
      reason,
      method: method as ProposalMethod,
    },
  };
}

export async function proposeReconciliation(input: {
  grant: Grant;
  opened: OpenedContext;
  store: ProposalStore;
  request: ProposalRequest;
  now: string;
}): Promise<ProposalOutcome> {
  const { grant, opened, store, request, now } = input;
  const requestId = opened.context.contextId;
  const fail = (
    code: Parameters<typeof financialError>[0],
    refs: string[] = [],
  ): ProposalOutcome => ({ ok: false, error: financialError(code, requestId, refs) });

  if (!grantAllows(grant, "interpretation.propose"))
    return fail("unauthorized", ["capability:interpretation.propose"]);
  if (request.evidenceRefs.length + 2 > grant.budget.maxProposalTargets)
    return fail("budget_exceeded", ["budget:maxProposalTargets"]);

  const missing: string[] = [];
  for (const ref of [request.from, request.to]) {
    const resolved = await store.resolveTarget(ref);
    if (resolved === null || !grantAllowsRow(grant, resolved.sourceId, resolved.account))
      missing.push(ref);
  }
  if (missing.length > 0) return fail("incomplete_evidence", missing);
  for (const ref of request.evidenceRefs) {
    const resolved = await store.resolveEvidence(ref);
    if (resolved === null || !grantAllowsRow(grant, resolved.sourceId, resolved.account))
      missing.push(ref);
  }
  if (missing.length > 0) return fail("incomplete_evidence", missing);

  const digest = await canonicalDigest({
    principal: grant.principal,
    contextId: opened.context.contextId,
    kind: request.kind,
    from: request.from,
    to: request.to,
    evidenceRefs: [...request.evidenceRefs].sort(),
    reason: request.reason,
    recordedAt: now,
  });
  const suffix = digest.slice(0, 32);
  const proposal: StoredProposal = {
    decisionRevisionId: `dr_prop_${suffix}`,
    relationId: `rel_prop_${suffix}`,
    kind: request.kind,
    fromRef: request.from,
    toRef: request.to,
    method: request.method,
    actorId: grant.principal,
    reason: request.reason,
    evidenceRefs: request.evidenceRefs,
    recordedAt: now,
  };
  try {
    await store.appendProposal(proposal);
  } catch {
    // The append-only triggers refuse a replacement; the same proposal body in
    // the same instant is the only way to collide. Nothing else is reported.
    return fail("idempotency_conflict", [`proposal:${suffix}`]);
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: "proposal-receipt-v1",
      proposalId: `proposal:${suffix}`,
      relationId: proposal.relationId,
      decisionRevisionId: proposal.decisionRevisionId,
      contextId: opened.context.contextId,
      status: "proposed",
      adopted: false,
      recordedAt: now,
    },
  };
}
