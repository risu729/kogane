// Identity commands (review 04 section 3, addendum A06). A manual decision is
// a durable, corrigible record: every command carries an operation id for
// idempotent resend, a server-verified actor, and the revision it expects.
// `assign` appends a manual mapping revision and its decision; `release-override`
// appends a decision that lets automatic policy apply again from the current
// revision on. Neither deletes or updates a mapping row. All writes of one
// command form one D1 batch (one transaction) whose statements are guarded on
// the ledger row, so a failed guard writes nothing and a trigger failure
// aborts everything.
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import { identityKey } from "./identity-keys.ts";

export const IDENTITY_COMMAND_ACTIONS = ["assign", "release-override"] as const;
export type IdentityCommandAction = (typeof IDENTITY_COMMAND_ACTIONS)[number];
export type IdentityCommandKind = "account" | "instrument";
export type ActorVerification = "server" | "legacy-unknown";

export interface IdentityCommand {
  /** Caller-chosen idempotency key. A resend with the same payload replays the stored result. */
  operationId: string;
  /** The principal the server verified; never copied from a request body. */
  actorId: string;
  actorVerification: ActorVerification;
  action: IdentityCommandAction;
  kind: IdentityCommandKind;
  referenceId: string;
  /** Current mapping revision the caller saw; anything else is a conflict. */
  expectedRevision: number;
  /** Required for `assign`; must be null for `release-override`. */
  targetId: string | null;
  reason: string;
}

export interface IdentityCommandReceipt {
  operationId: string;
  action: IdentityCommandAction;
  kind: IdentityCommandKind;
  referenceId: string;
  /** Mapping revision after the command: `expectedRevision + 1` for assign, unchanged for release. */
  revision: number;
  mappingId: string | null;
  decisionRevisionId: string;
  payloadDigest: string;
}

export type IdentityCommandError =
  | "invalid_command"
  | "idempotency_conflict"
  | "revision_conflict"
  | "target_missing"
  | "target_metadata_ambiguous"
  | "no_active_override";

export type IdentityCommandResult =
  | { ok: true; replayed: boolean; receipt: IdentityCommandReceipt }
  | { ok: false; error: IdentityCommandError };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const REF_PATTERN = /^[^\u0000-\u001f]{1,512}$/u;

export function validIdentityCommand(value: unknown): value is IdentityCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.operationId === "string" &&
    ID_PATTERN.test(c.operationId) &&
    typeof c.actorId === "string" &&
    ID_PATTERN.test(c.actorId) &&
    (c.actorVerification === "server" || c.actorVerification === "legacy-unknown") &&
    (c.action === "assign" || c.action === "release-override") &&
    (c.kind === "account" || c.kind === "instrument") &&
    typeof c.referenceId === "string" &&
    REF_PATTERN.test(c.referenceId) &&
    typeof c.expectedRevision === "number" &&
    Number.isSafeInteger(c.expectedRevision) &&
    c.expectedRevision >= 1 &&
    (c.action === "assign"
      ? typeof c.targetId === "string" && REF_PATTERN.test(c.targetId)
      : c.targetId === null) &&
    typeof c.reason === "string" &&
    c.reason.trim() !== "" &&
    c.reason.length <= 1000
  );
}

/** The digest that makes a resend comparable; the actor and operation id are outside it. */
export async function identityCommandDigest(command: IdentityCommand): Promise<string> {
  return canonicalDigest({
    action: command.action,
    kind: command.kind,
    referenceId: command.referenceId,
    expectedRevision: command.expectedRevision,
    targetId: command.targetId,
    reason: command.reason,
  });
}

interface OperationRow {
  actor_id: string;
  payload_digest: string;
  result_json: string;
}

function tables(kind: IdentityCommandKind) {
  const account = kind === "account";
  return {
    table: account ? "account_mappings" : "instrument_mappings",
    reference: account ? "source_account_id" : "identifier_id",
    target: account ? "account_id" : "instrument_id",
    entities: account ? "accounts" : "instruments",
    currentView: account ? "current_account_mappings" : "current_instrument_mappings",
    subjectKind: account ? "account_mapping" : "instrument_mapping",
  };
}

/** Target label/status come from its current claims, or the entity when it has none. */
async function targetMetadata(
  db: D1Database,
  command: IdentityCommand,
): Promise<{ label: string; status: string } | IdentityCommandError> {
  const { currentView, reference, target, entities } = tables(command.kind);
  const same = await db
    .prepare(`SELECT label,status FROM ${currentView} WHERE ${reference}=? AND ${target}=?`)
    .bind(command.referenceId, command.targetId)
    .first<{ label: string; status: string }>();
  const claims = same
    ? [same]
    : (
        await db
          .prepare(`SELECT DISTINCT label,status FROM ${currentView} WHERE ${target}=? LIMIT 2`)
          .bind(command.targetId)
          .all<{ label: string; status: string }>()
      ).results;
  if (claims.length > 1) return "target_metadata_ambiguous";
  const metadata =
    claims[0] ??
    (await db
      .prepare(`SELECT label,status FROM ${entities} WHERE id=?`)
      .bind(command.targetId)
      .first<{ label: string; status: string }>());
  return metadata ?? "target_missing";
}

function replayOrConflict(
  command: IdentityCommand,
  digest: string,
  stored: OperationRow,
): IdentityCommandResult {
  if (stored.payload_digest !== digest || stored.actor_id !== command.actorId)
    return { ok: false, error: "idempotency_conflict" };
  return { ok: true, replayed: true, receipt: JSON.parse(stored.result_json) };
}

/** Never accepts amounts or edits Layer B. Entity creation is not part of this command. */
export async function executeIdentityCommand(
  db: D1Database,
  command: IdentityCommand,
  policyVersion: number,
): Promise<IdentityCommandResult> {
  if (!validIdentityCommand(command) || !Number.isSafeInteger(policyVersion) || policyVersion < 1)
    return { ok: false, error: "invalid_command" };
  const digest = await identityCommandDigest(command);
  const readOperation = () =>
    db
      .prepare(
        "SELECT actor_id,payload_digest,result_json FROM decision_operations WHERE operation_id=?",
      )
      .bind(command.operationId)
      .first<OperationRow>();
  const stored = await readOperation();
  if (stored) return replayOrConflict(command, digest, stored);
  const { table, reference, target, entities, subjectKind } = tables(command.kind);
  const assign = command.action === "assign";
  const metadata = assign ? await targetMetadata(db, command) : null;
  if (typeof metadata === "string") return { ok: false, error: metadata };
  const decisionId = await identityKey("dr", ["command", command.operationId]);
  const mappingId = assign
    ? await identityKey(command.kind === "account" ? "am" : "im", ["command", command.operationId])
    : null;
  const receipt: IdentityCommandReceipt = {
    operationId: command.operationId,
    action: command.action,
    kind: command.kind,
    referenceId: command.referenceId,
    revision: assign ? command.expectedRevision + 1 : command.expectedRevision,
    mappingId,
    decisionRevisionId: decisionId,
    payloadDigest: digest,
  };
  const now = new Date().toISOString();
  const revisionGuard = `(SELECT max(revision) FROM ${table} WHERE ${reference}=?)=?`;
  const statements: D1PreparedStatement[] = [
    // The ledger row carries every precondition; later statements exist only if it was written.
    db
      .prepare(`INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM decision_operations WHERE operation_id=?)
      AND ${revisionGuard} AND ${
        assign
          ? `EXISTS(SELECT 1 FROM ${entities} WHERE id=?)`
          : "EXISTS(SELECT 1 FROM protected_mapping_subjects WHERE subject_kind=? AND subject_ref=?)"
      }`)
      .bind(
        command.operationId,
        command.actorId,
        command.actorVerification,
        command.action,
        digest,
        JSON.stringify(receipt),
        now,
        command.operationId,
        command.referenceId,
        command.expectedRevision,
        ...(assign ? [command.targetId] : [subjectKind, command.referenceId]),
      ),
  ];
  if (assign && metadata)
    statements.push(
      db
        .prepare(`INSERT INTO ${table}(id,${reference},revision,${target},method,reason,policy_version,created_at,label,status)
        SELECT ?,?,?,?,'manual',?,?,?,?,? FROM decision_operations op WHERE op.operation_id=?
        AND NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?) AND ${revisionGuard}`)
        .bind(
          mappingId,
          command.referenceId,
          command.expectedRevision + 1,
          command.targetId,
          command.reason,
          policyVersion,
          now,
          metadata.label,
          metadata.status,
          command.operationId,
          mappingId,
          command.referenceId,
          command.expectedRevision,
        ),
    );
  statements.push(
    assign
      ? db
          .prepare(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
          SELECT ?,?,?,?,'assign','manual',?,?,?,json_array(?),?,NULL,? FROM decision_operations op
          WHERE op.operation_id=? AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)
          AND EXISTS(SELECT 1 FROM ${table} WHERE id=?)`)
          .bind(
            decisionId,
            subjectKind,
            command.referenceId,
            command.expectedRevision + 1,
            command.actorId,
            command.operationId,
            command.reason,
            `${subjectKind}:${mappingId}`,
            command.expectedRevision,
            now,
            command.operationId,
            decisionId,
            mappingId,
          )
      : db
          .prepare(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
          SELECT ?,?,?,?,'release-override','manual',?,?,?,
          (SELECT json_group_array('decision_revision:'||o.id) FROM active_manual_overrides o WHERE o.subject_kind=? AND o.subject_ref=?),
          (SELECT max(o.revision) FROM active_manual_overrides o WHERE o.subject_kind=? AND o.subject_ref=?),NULL,?
          FROM decision_operations op WHERE op.operation_id=? AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`)
          .bind(
            decisionId,
            subjectKind,
            command.referenceId,
            command.expectedRevision,
            command.actorId,
            command.operationId,
            command.reason,
            subjectKind,
            command.referenceId,
            subjectKind,
            command.referenceId,
            now,
            command.operationId,
            decisionId,
          ),
  );
  if (!assign)
    // The one permitted update: each active override is superseded exactly once, by this release.
    statements.push(
      db
        .prepare(`UPDATE decision_revisions SET superseded_by=? WHERE subject_kind=? AND subject_ref=?
        AND decision_kind='assign' AND method IN ('manual','legacy-migration') AND superseded_by IS NULL
        AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`)
        .bind(decisionId, subjectKind, command.referenceId, decisionId),
    );
  const results = await db.batch(statements);
  if (results[0]!.meta.changes === 1) return { ok: true, replayed: false, receipt };
  // Nothing was written. Name the precondition that failed without guessing.
  const concurrent = await readOperation();
  if (concurrent) return replayOrConflict(command, digest, concurrent);
  const current = await db
    .prepare(`SELECT max(revision) revision FROM ${table} WHERE ${reference}=?`)
    .bind(command.referenceId)
    .first<{ revision: number | null }>();
  if (current?.revision !== command.expectedRevision)
    return { ok: false, error: "revision_conflict" };
  if (assign) return { ok: false, error: "target_missing" };
  return { ok: false, error: "no_active_override" };
}
