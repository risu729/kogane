// Accepting a reconciliation proposal (architecture addendum A10; addendum 07
// sections 3 and 7). Acceptance is a decision, never a side effect of a
// matcher: the rule writes candidates, and only this command turns one into an
// adopted `entity_relations` row (INV07).
//
// Guarded exactly like `identity-commands.ts`: a caller-chosen operation id
// makes a resend idempotent, the actor is the principal the server verified
// (never a request body claim), and `expectedStatus` is the state of the
// proposal the caller saw. All writes of one command form one D1 batch whose
// statements are guarded on the ledger row, so a failed guard writes nothing.
//
// Undoing an acceptance is not a DELETE: a later `supersede` decision appends
// a new revision and the reports that cite the old one keep resolving.
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  RECONCILIATION_KINDS,
  type ReconciliationKind,
} from "../../../packages/domain/src/reconcile.ts";
import { identityKey } from "./identity-keys.ts";

export const PROPOSAL_DECISION_ACTIONS = ["accept", "reject"] as const;
export type ProposalDecisionAction = (typeof PROPOSAL_DECISION_ACTIONS)[number];
export type ActorVerification = "server" | "legacy-unknown";
export const PROPOSAL_DECISION_METHODS = ["manual", "rule", "ai"] as const;
export type ProposalDecisionMethod = (typeof PROPOSAL_DECISION_METHODS)[number];

export interface ProposalCommand {
  /** Caller-chosen idempotency key; a resend with the same payload replays the receipt. */
  operationId: string;
  actorId: string;
  actorVerification: ActorVerification;
  action: ProposalDecisionAction;
  proposalId: string;
  /** The status the caller saw; anything else is a conflict. */
  expectedStatus: "proposed";
  method: ProposalDecisionMethod;
  reason: string;
}

export interface ProposalCommandReceipt {
  operationId: string;
  action: ProposalDecisionAction;
  proposalId: string;
  status: "accepted" | "rejected";
  /** Written only by `accept`; a rejection creates no relation. */
  relationId: string | null;
  proposalDecisionId: string;
  relationDecisionId: string | null;
  payloadDigest: string;
}

export type ProposalCommandError =
  | "invalid_command"
  | "idempotency_conflict"
  | "proposal_missing"
  | "status_conflict"
  | "proposal_shape_unsupported";

export type ProposalCommandResult =
  | { ok: true; replayed: boolean; receipt: ProposalCommandReceipt }
  | { ok: false; error: ProposalCommandError };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const PROPOSAL_ID_PATTERN = /^[^\u0000-\u001f]{1,512}$/u;

export function validProposalCommand(value: unknown): value is ProposalCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.operationId === "string" &&
    ID_PATTERN.test(c.operationId) &&
    typeof c.actorId === "string" &&
    ID_PATTERN.test(c.actorId) &&
    (c.actorVerification === "server" || c.actorVerification === "legacy-unknown") &&
    (c.action === "accept" || c.action === "reject") &&
    typeof c.proposalId === "string" &&
    PROPOSAL_ID_PATTERN.test(c.proposalId) &&
    c.expectedStatus === "proposed" &&
    (PROPOSAL_DECISION_METHODS as readonly unknown[]).includes(c.method) &&
    typeof c.reason === "string" &&
    c.reason.trim() !== "" &&
    c.reason.length <= 1000
  );
}

/** The digest that makes a resend comparable; the actor and operation id are outside it. */
export async function proposalCommandDigest(command: ProposalCommand): Promise<string> {
  return canonicalDigest({
    action: command.action,
    proposalId: command.proposalId,
    expectedStatus: command.expectedStatus,
    method: command.method,
    reason: command.reason,
  });
}

interface OperationRow {
  actor_id: string;
  payload_digest: string;
  result_json: string;
}
interface ProposalRow {
  id: string;
  kind: string;
  status: string;
  target_refs_json: string;
  evidence_refs_json: string;
}

function replayOrConflict(
  command: ProposalCommand,
  digest: string,
  stored: OperationRow,
): ProposalCommandResult {
  if (stored.payload_digest !== digest || stored.actor_id !== command.actorId)
    return { ok: false, error: "idempotency_conflict" };
  return { ok: true, replayed: true, receipt: JSON.parse(stored.result_json) };
}

/**
 * The two claims an accepted relation connects. Only a two-ended proposal can
 * become an `entity_relations` row; a wider candidate set is refused here
 * rather than silently reduced to its first two members.
 */
function relationEnds(row: ProposalRow): { from: string; to: string } | null {
  let refs: unknown;
  try {
    refs = JSON.parse(row.target_refs_json);
  } catch {
    return null;
  }
  if (!Array.isArray(refs) || refs.length !== 2) return null;
  const ends = refs.map((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
    const entry = ref as Record<string, unknown>;
    return typeof entry.kind === "string" && typeof entry.id === "string"
      ? `${entry.kind}:${entry.id}`
      : null;
  });
  const [from, to] = ends;
  if (!from || !to || from === to) return null;
  return { from, to };
}

/**
 * Accept or reject one proposal. Never touches Layer B, never writes amounts,
 * and never creates a relation kind outside the closed reconciliation subset.
 */
export async function decideProposal(
  db: D1Database,
  command: ProposalCommand,
): Promise<ProposalCommandResult> {
  if (!validProposalCommand(command)) return { ok: false, error: "invalid_command" };
  const digest = await proposalCommandDigest(command);
  const readOperation = () =>
    db
      .prepare(
        "SELECT actor_id,payload_digest,result_json FROM decision_operations WHERE operation_id=?",
      )
      .bind(command.operationId)
      .first<OperationRow>();
  const stored = await readOperation();
  if (stored) return replayOrConflict(command, digest, stored);
  const proposal = await db
    .prepare(
      "SELECT id,kind,status,target_refs_json,evidence_refs_json FROM reconciliation_proposals WHERE id=?",
    )
    .bind(command.proposalId)
    .first<ProposalRow>();
  if (!proposal) return { ok: false, error: "proposal_missing" };
  if (proposal.status !== command.expectedStatus) return { ok: false, error: "status_conflict" };
  if (!(RECONCILIATION_KINDS as readonly string[]).includes(proposal.kind))
    return { ok: false, error: "proposal_shape_unsupported" };
  const accept = command.action === "accept";
  const ends = accept ? relationEnds(proposal) : null;
  if (accept && !ends) return { ok: false, error: "proposal_shape_unsupported" };
  const proposalDecisionId = await identityKey("dr", ["proposal", command.operationId]);
  const relationDecisionId = accept
    ? await identityKey("dr", ["relation", command.operationId])
    : null;
  const relationId = accept ? await identityKey("rel", ["proposal", proposal.id]) : null;
  const receipt: ProposalCommandReceipt = {
    operationId: command.operationId,
    action: command.action,
    proposalId: proposal.id,
    status: accept ? "accepted" : "rejected",
    relationId,
    proposalDecisionId,
    relationDecisionId,
    payloadDigest: digest,
  };
  const now = new Date().toISOString();
  const decisionRow = `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
    SELECT ?,'relation',?,1,?,?,?,?,?,?,NULL,NULL,? FROM decision_operations op
    WHERE op.operation_id=? AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`;
  const statements: D1PreparedStatement[] = [
    // The ledger row carries every precondition; later statements exist only if it was written.
    db
      .prepare(`INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM decision_operations WHERE operation_id=?)
      AND EXISTS(SELECT 1 FROM reconciliation_proposals WHERE id=? AND status='proposed')`)
      .bind(
        command.operationId,
        command.actorId,
        command.actorVerification,
        `proposal-${command.action}`,
        digest,
        JSON.stringify(receipt),
        now,
        command.operationId,
        proposal.id,
      ),
    db
      .prepare(decisionRow)
      .bind(
        proposalDecisionId,
        `proposal:${proposal.id}`,
        accept ? "accept" : "reject",
        command.method,
        command.actorId,
        command.operationId,
        command.reason,
        proposal.evidence_refs_json,
        now,
        command.operationId,
        proposalDecisionId,
      ),
  ];
  if (accept && ends && relationDecisionId && relationId) {
    statements.push(
      db
        .prepare(decisionRow)
        .bind(
          relationDecisionId,
          relationId,
          "accept",
          command.method,
          command.actorId,
          command.operationId,
          command.reason,
          proposal.evidence_refs_json,
          now,
          command.operationId,
          relationDecisionId,
        ),
      db
        .prepare(`INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
        SELECT ?,?,?,?,NULL,NULL,'accepted',?,?,? FROM decision_revisions d
        WHERE d.id=? AND NOT EXISTS(SELECT 1 FROM entity_relations WHERE id=?)`)
        .bind(
          relationId,
          proposal.kind as ReconciliationKind,
          ends.from,
          ends.to,
          relationDecisionId,
          proposal.evidence_refs_json,
          now,
          relationDecisionId,
          relationId,
        ),
    );
  }
  // The one permitted update on a proposal: name the decision that resolved it.
  statements.push(
    db
      .prepare(`UPDATE reconciliation_proposals SET status=?,decision_revision_id=?
      WHERE id=? AND status='proposed'
      AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`)
      .bind(accept ? "accepted" : "rejected", proposalDecisionId, proposal.id, proposalDecisionId),
  );
  const results = await db.batch(statements);
  if (results[0]!.meta.changes === 1) return { ok: true, replayed: false, receipt };
  // Nothing was written. Name the precondition that failed without guessing.
  const concurrent = await readOperation();
  if (concurrent) return replayOrConflict(command, digest, concurrent);
  const current = await db
    .prepare("SELECT status FROM reconciliation_proposals WHERE id=?")
    .bind(proposal.id)
    .first<{ status: string }>();
  if (!current) return { ok: false, error: "proposal_missing" };
  return { ok: false, error: "status_conflict" };
}

/** Named for the command A09 will expose; acceptance always goes through the decision log. */
export function acceptProposal(
  db: D1Database,
  command: Omit<ProposalCommand, "action">,
): Promise<ProposalCommandResult> {
  return decideProposal(db, { ...command, action: "accept" });
}
