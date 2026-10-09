// Delegation guards shared by every adapter and writer. Authority comes from
// the resolver; no request value can construct a delegated principal.
import { canonicalDigest } from "../../../domain/src/context.ts";
import type { SqlWrite } from "../../../storage-d1/src/core/operations.ts";
import type { CommandStore } from "../command/contract.ts";
import type { OperationCall } from "../audit/call.ts";
import { type AuditRow, type AuditScope, buildAuditRecord, auditInstant } from "../audit/record.ts";
import { appendAnswerRecord } from "../audit/store.ts";
import {
  AUDIT_IDEMPOTENCY_KEY,
  AUDIT_DIGEST,
  AUDIT_DELEGATION_REF,
  AUDIT_ID,
  AUDIT_CONFIRMATION_DIGEST,
  AUDIT_INSTANT,
} from "../audit/vocabulary.ts";
import { type OperationName } from "../operation-path/catalogue.ts";
import type { DelegatedPrincipal, DelegationCapability } from "./contract.ts";

export type DelegatedErrorCode =
  | "capability_not_delegated"
  | "delegation_expired"
  | "delegation_budget_exceeded"
  | "idempotency_required"
  | "idempotency_conflict"
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_expired"
  | "confirmation_used"
  | "revision_conflict"
  | "audit_cap_reached"
  | "operation_not_delegable"
  | "revert_invalid";
export class DelegatedOperationError extends Error {
  constructor(readonly code: DelegatedErrorCode) {
    super(code);
    this.name = "DelegatedOperationError";
  }
}

/** The closed, private-binding authority attached to an OperationCall. */
export interface DelegatedExecution {
  delegationRef: string;
  writesPerDay: number;
  notAfter: string;
  idempotencyKey?: string;
  payloadDigest?: string;
  confirmsAuditId?: string;
  revertsAuditId?: string;
  confirmationDigest?: string;
  commandFamilies: readonly ("plan" | "card-settlement" | "relation" | "identity")[];
}

export function validDelegatedExecution(value: unknown): value is DelegatedExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "delegationRef",
          "writesPerDay",
          "notAfter",
          "idempotencyKey",
          "payloadDigest",
          "confirmsAuditId",
          "revertsAuditId",
          "confirmationDigest",
          "commandFamilies",
        ].includes(k),
    )
  )
    return false;
  return (
    typeof v.delegationRef === "string" &&
    AUDIT_DELEGATION_REF.test(v.delegationRef) &&
    Number.isSafeInteger(v.writesPerDay) &&
    Number(v.writesPerDay) >= 1 &&
    Number(v.writesPerDay) <= 200 &&
    typeof v.notAfter === "string" &&
    AUDIT_INSTANT.test(v.notAfter) &&
    !Number.isNaN(Date.parse(v.notAfter)) &&
    new Date(v.notAfter).toISOString() === v.notAfter &&
    (v.idempotencyKey === undefined ||
      (typeof v.idempotencyKey === "string" && AUDIT_IDEMPOTENCY_KEY.test(v.idempotencyKey))) &&
    (v.payloadDigest === undefined ||
      (typeof v.payloadDigest === "string" && AUDIT_DIGEST.test(v.payloadDigest))) &&
    (v.idempotencyKey === undefined) === (v.payloadDigest === undefined) &&
    (v.revertsAuditId === undefined ||
      (typeof v.revertsAuditId === "string" && AUDIT_ID.test(v.revertsAuditId))) &&
    (v.confirmsAuditId === undefined ||
      (typeof v.confirmsAuditId === "string" && AUDIT_ID.test(v.confirmsAuditId))) &&
    (v.confirmationDigest === undefined ||
      (typeof v.confirmationDigest === "string" &&
        AUDIT_CONFIRMATION_DIGEST.test(v.confirmationDigest))) &&
    (v.confirmsAuditId === undefined) === (v.confirmationDigest === undefined) &&
    Array.isArray(v.commandFamilies) &&
    v.commandFamilies.length <= 4 &&
    new Set(v.commandFamilies).size === v.commandFamilies.length &&
    v.commandFamilies.every((f) =>
      ["plan", "card-settlement", "relation", "identity"].includes(String(f)),
    )
  );
}

export function executionFor(principal: DelegatedPrincipal): DelegatedExecution {
  return {
    delegationRef: principal.delegationRef,
    writesPerDay: principal.budget.writesPerDay,
    // Floor submillisecond expiry conservatively at the SQLite clock's precision.
    notAfter: new Date(principal.notAfter).toISOString(),
    commandFamilies: [
      ...(principal.capabilities.includes("commands.plan") ? ["plan" as const] : []),
      ...(principal.capabilities.includes("commands.decide.card-settlement")
        ? ["card-settlement" as const]
        : []),
      ...(principal.capabilities.includes("commands.decide.relation") ? ["relation" as const] : []),
      ...(principal.capabilities.includes("commands.decide.identity") ? ["identity" as const] : []),
    ],
  };
}

export function delegatedCan(
  principal: DelegatedPrincipal,
  capability: DelegationCapability,
): void {
  if (!principal.capabilities.includes(capability))
    throw new DelegatedOperationError("capability_not_delegated");
}

/** A constraint failure in the audit's last statement rolls back the entire effect batch. */
export function guardDelegatedEffect(
  write: SqlWrite,
  row: AuditRow,
  auth: DelegatedExecution,
): SqlWrite {
  if (!validDelegatedExecution(auth) || !auth.idempotencyKey || !auth.payloadDigest)
    throw new DelegatedOperationError("idempotency_required");
  if (row.principal_kind !== "delegated" || row.delegation_ref !== auth.delegationRef)
    throw new DelegatedOperationError("operation_not_delegable");
  if (
    row.risk_class === "R1"
      ? row.step !== "call" || auth.confirmsAuditId !== undefined
      : row.risk_class !== "R2" || row.step !== "confirm" || !auth.confirmsAuditId
  )
    throw new DelegatedOperationError("confirmation_required");
  const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const conditions = [
    `? > ${clock}`,
    `(SELECT count(*) FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted') AND recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')) < ?`,
  ];
  const binds: unknown[] = [auth.notAfter, row.principal, auth.writesPerDay];
  if (auth.confirmsAuditId) {
    conditions.push(
      `EXISTS(SELECT 1 FROM audit_records p WHERE p.audit_id=? AND p.result='prepared' AND p.principal=? AND p.delegation_ref=? AND p.operation=? AND p.idempotency_key=? AND p.payload_digest=? AND p.confirmation_digest=? AND p.target_ref IS ? AND p.scope_namespace IS ? AND p.scope_source IS ? AND p.reverts_audit_id IS ? AND p.confirm_expires_at>${clock})`,
    );
    binds.push(
      auth.confirmsAuditId,
      row.principal,
      auth.delegationRef,
      row.operation,
      auth.idempotencyKey,
      auth.payloadDigest,
      auth.confirmationDigest,
      row.target_ref,
      row.scope_namespace,
      row.scope_source,
      auth.revertsAuditId ?? null,
    );
  }
  // auditEffectWrite always starts its SELECT with the audit_id placeholder.
  // Fail a CHECK instead of filtering the audit out: filtering would leave an unaudited effect.
  if (!write.sql.includes("SELECT ?,")) throw new Error("audit effect statement shape");
  return {
    sql: write.sql.replace(
      "SELECT ?,",
      `SELECT CASE WHEN (${conditions.join(" AND ")}) THEN ? ELSE '' END,`,
    ),
    binds: [...binds, ...write.binds],
  };
}

const EFFECT = `SELECT * FROM audit_records WHERE principal=? AND operation=? AND idempotency_key=? AND result IN ('applied','accepted','replayed') ORDER BY recorded_at,audit_id LIMIT 1`;
export async function delegatedReplay(
  store: CommandStore,
  call: OperationCall,
  key: string,
  digest: string,
): Promise<AuditRow | null> {
  const row = await store.first<AuditRow>(EFFECT, [call.actor.principal, call.operation, key]);
  if (row && row.payload_digest !== digest)
    throw new DelegatedOperationError("idempotency_conflict");
  return row;
}

export async function bindDelegatedWrite(
  store: CommandStore,
  call: OperationCall,
  principal: DelegatedPrincipal,
  input: {
    capability: DelegationCapability;
    idempotencyKey: unknown;
    payload: unknown;
  },
): Promise<AuditRow | null> {
  delegatedCan(principal, input.capability);
  if (call.riskClass !== "R1") throw new DelegatedOperationError("confirmation_required");
  if (typeof input.idempotencyKey !== "string" || !AUDIT_IDEMPOTENCY_KEY.test(input.idempotencyKey))
    throw new DelegatedOperationError("idempotency_required");
  const digest = await canonicalDigest({
    v: "kogane-delegated-payload-v1",
    operation: call.operation,
    payload: input.payload,
  });
  call.delegate(principal, {
    ...executionFor(principal),
    idempotencyKey: input.idempotencyKey,
    payloadDigest: digest,
  });
  return delegatedReplay(store, call, input.idempotencyKey, digest);
}

export interface ConfirmationInput {
  idempotencyKey: string;
  payload: unknown;
  targetRef: string;
  scope: AuditScope | null;
  expectedRevision?: number;
  revertsAuditId?: string;
}
function confirmationBody(
  operation: OperationName,
  principal: string,
  delegationRef: string,
  input: ConfirmationInput,
  payloadDigest: string,
  expiresAt: string,
) {
  return {
    v: "kogane-confirm-v1",
    operation,
    principal,
    delegationRef,
    targetRef: input.targetRef,
    scope: input.scope,
    ...(input.revertsAuditId ? { revertsAuditId: input.revertsAuditId } : {}),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    payloadDigest,
    idempotencyKey: input.idempotencyKey,
    expiresAt,
  };
}

/** The adapter validates payload and resolves scope/current revision before calling this. */
export async function prepareDelegatedOperation(
  store: CommandStore,
  call: OperationCall,
  principal: DelegatedPrincipal,
  capability: DelegationCapability,
  input: ConfirmationInput,
  currentRevision: number | undefined,
  now = new Date(),
): Promise<{
  confirmation: { digest: string; expiresAt: string };
  preview: { targetRef: string; expectedRevision?: number };
}> {
  delegatedCan(principal, capability);
  if (!AUDIT_IDEMPOTENCY_KEY.test(input.idempotencyKey))
    throw new DelegatedOperationError("idempotency_required");
  if (call.riskClass !== "R2") throw new DelegatedOperationError("operation_not_delegable");
  if (
    (call.operation.startsWith("schedules.") &&
      (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) ||
    input.expectedRevision !== currentRevision
  )
    throw new DelegatedOperationError("revision_conflict");
  const expiresAt = new Date(
    Math.min(now.getTime() + 600_000, Date.parse(principal.notAfter)),
  ).toISOString();
  if (expiresAt <= now.toISOString()) throw new DelegatedOperationError("delegation_expired");
  const payloadDigest = await canonicalDigest({
    v: "kogane-delegated-payload-v1",
    operation: call.operation,
    payload: input.payload,
  });
  call.delegate(principal, executionFor(principal));
  call.setStep("prepare");
  const digest = `cfm_${await canonicalDigest(confirmationBody(call.operation, principal.id, principal.delegationRef, input, payloadDigest, expiresAt))}`;
  const row = buildAuditRecord(
    call.actor,
    {
      operation: call.operation,
      riskClass: "R2",
      step: "prepare",
      result: "prepared",
      scope: input.scope,
      targetRef: input.targetRef,
      idempotencyKey: input.idempotencyKey,
      payloadDigest,
      confirmationDigest: digest,
      confirmExpiresAt: expiresAt,
      ...(input.revertsAuditId ? { revertsAuditId: input.revertsAuditId } : {}),
      diff: { kind: "none" },
    },
    auditInstant(now),
  );
  const outcome = await appendAnswerRecord(store, row);
  if (outcome !== "recorded") throw new DelegatedOperationError("audit_cap_reached");
  call.markRecorded(row.audit_id);
  return {
    confirmation: { digest, expiresAt },
    preview: {
      targetRef: input.targetRef,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    },
  };
}

export async function confirmDelegatedOperation(
  store: CommandStore,
  call: OperationCall,
  principal: DelegatedPrincipal,
  capability: DelegationCapability,
  input: ConfirmationInput,
  confirmationDigest: string,
  now = new Date(),
): Promise<void> {
  delegatedCan(principal, capability);
  call.delegate(principal, executionFor(principal));
  call.setStep("confirm");
  if (call.riskClass !== "R2" || !AUDIT_CONFIRMATION_DIGEST.test(confirmationDigest))
    throw new DelegatedOperationError("confirmation_invalid");
  const prepared = await store.first<AuditRow>(
    `SELECT * FROM audit_records WHERE principal=? AND delegation_ref=? AND operation=? AND confirmation_digest=? AND result='prepared' ORDER BY recorded_at DESC LIMIT 1`,
    [principal.id, principal.delegationRef, call.operation, confirmationDigest],
  );
  if (!prepared) throw new DelegatedOperationError("confirmation_invalid");
  const used = await store.first(
    "SELECT audit_id FROM audit_records WHERE confirms_audit_id=? AND result IN ('applied','accepted')",
    [prepared.audit_id],
  );
  if (used) throw new DelegatedOperationError("confirmation_used");
  const payloadDigest = await canonicalDigest({
    v: "kogane-delegated-payload-v1",
    operation: call.operation,
    payload: input.payload,
  });
  if (
    prepared.idempotency_key !== input.idempotencyKey ||
    prepared.payload_digest !== payloadDigest ||
    prepared.target_ref !== input.targetRef ||
    prepared.scope_namespace !== (input.scope?.namespace ?? null) ||
    prepared.scope_source !== (input.scope?.source ?? null) ||
    prepared.reverts_audit_id !== (input.revertsAuditId ?? null) ||
    confirmationDigest !==
      `cfm_${await canonicalDigest(confirmationBody(call.operation, principal.id, principal.delegationRef, input, payloadDigest, prepared.confirm_expires_at!))}`
  )
    throw new DelegatedOperationError("confirmation_invalid");
  if (prepared.confirm_expires_at! <= now.toISOString())
    throw new DelegatedOperationError("confirmation_expired");
  call.delegate(principal, {
    ...executionFor(principal),
    idempotencyKey: input.idempotencyKey,
    payloadDigest,
    confirmsAuditId: prepared.audit_id,
    ...(input.revertsAuditId ? { revertsAuditId: input.revertsAuditId } : {}),
    confirmationDigest,
  });
}

/** Map a raced batch refusal by re-reading closed authority facts; never inspect exception text. */
export async function delegatedBatchFailure(
  store: CommandStore,
  call: OperationCall,
  now = new Date(),
): Promise<DelegatedOperationError | null> {
  const auth = call.delegatedExecution;
  if (!auth) return null;
  if (auth.notAfter <= now.toISOString()) return new DelegatedOperationError("delegation_expired");
  if (auth.confirmsAuditId) {
    const used = await store.first(
      "SELECT audit_id FROM audit_records WHERE confirms_audit_id=? AND result IN ('applied','accepted')",
      [auth.confirmsAuditId],
    );
    if (used) return new DelegatedOperationError("confirmation_used");
    const prepared = await store.first<AuditRow>(
      "SELECT * FROM audit_records WHERE audit_id=? AND principal=? AND delegation_ref=? AND operation=? AND confirmation_digest=?",
      [
        auth.confirmsAuditId,
        call.actor.principal,
        auth.delegationRef,
        call.operation,
        auth.confirmationDigest,
      ],
    );
    if (!prepared) return new DelegatedOperationError("confirmation_invalid");
    if (prepared.confirm_expires_at! <= now.toISOString())
      return new DelegatedOperationError("confirmation_expired");
  }
  const count = await store.first<{ n: number }>(
    `SELECT count(*) n FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted') AND recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`,
    [call.actor.principal],
  );
  if (count && count.n >= auth.writesPerDay)
    return new DelegatedOperationError("delegation_budget_exceeded");
  if (auth.idempotencyKey && auth.payloadDigest) {
    const row = await store.first<AuditRow>(EFFECT, [
      call.actor.principal,
      call.operation,
      auth.idempotencyKey,
    ]);
    if (row && row.payload_digest !== auth.payloadDigest)
      return new DelegatedOperationError("idempotency_conflict");
  }
  return null;
}

/** Family attenuation survives the private binding; a confirmed call is still not a blanket command grant. */
export function delegatedCommandFamilyAllowed(
  call: OperationCall | undefined,
  kind: string,
): boolean {
  const family = kind.split(".")[0];
  return (
    call?.actor.principalKind === "delegated" &&
    call.step === "confirm" &&
    !!call.delegatedExecution?.confirmsAuditId &&
    (family === "identity" || family === "relation" || family === "card-settlement") &&
    call.delegatedExecution.commandFamilies.includes(family)
  );
}

/** Completed confirmations are read-only retries, but still require the exact prior binding. */
export async function replayDelegatedConfirmation(
  store: CommandStore,
  call: OperationCall,
  principal: DelegatedPrincipal,
  capability: DelegationCapability,
  input: ConfirmationInput,
  confirmationDigest: string,
): Promise<AuditRow | null> {
  delegatedCan(principal, capability);
  const payloadDigest = await canonicalDigest({
    v: "kogane-delegated-payload-v1",
    operation: call.operation,
    payload: input.payload,
  });
  call.delegate(principal, executionFor(principal));
  const row = await delegatedReplay(store, call, input.idempotencyKey, payloadDigest);
  if (!row) return null;
  if (!row.confirms_audit_id) throw new DelegatedOperationError("confirmation_invalid");
  const prepared = await store.first<AuditRow>(
    "SELECT * FROM audit_records WHERE audit_id=? AND principal=? AND delegation_ref=? AND operation=? AND confirmation_digest=? AND result='prepared'",
    [
      row.confirms_audit_id,
      principal.id,
      principal.delegationRef,
      call.operation,
      confirmationDigest,
    ],
  );
  if (
    !prepared ||
    prepared.payload_digest !== payloadDigest ||
    prepared.idempotency_key !== input.idempotencyKey ||
    prepared.target_ref !== input.targetRef ||
    prepared.scope_namespace !== (input.scope?.namespace ?? null) ||
    prepared.scope_source !== (input.scope?.source ?? null) ||
    prepared.reverts_audit_id !== (input.revertsAuditId ?? null) ||
    confirmationDigest !==
      `cfm_${await canonicalDigest(confirmationBody(call.operation, principal.id, principal.delegationRef, input, payloadDigest, prepared.confirm_expires_at!))}`
  )
    throw new DelegatedOperationError("confirmation_invalid");
  call.delegate(principal, {
    ...executionFor(principal),
    idempotencyKey: input.idempotencyKey,
    payloadDigest,
    confirmsAuditId: prepared.audit_id,
    ...(input.revertsAuditId ? { revertsAuditId: input.revertsAuditId } : {}),
    confirmationDigest,
  });
  call.setStep("confirm");
  return row;
}
