// The audit record builder (ADR 0064). Every record, on every path, is built
// here: the App adapter's answer records, each writer's effect record and the
// Processor's overflow records alike. A field that does not fit its closed
// shape is refused with `AuditRecordError`, which names the field and never
// its value, so nothing outside the vocabulary reaches a statement.
//
// What a record may hold is the envelope (who, through which path, under
// which correlation id), the catalogued operation and its risk class, the
// target and scope as server-resolved identifiers, the result and its closed
// code, and the references and safe diff of `diff.ts`. Credentials, tokens,
// request or response bodies, provider text, amounts, account labels and
// exception text have no column to go to.
import type { SqlWrite } from "../../../storage-d1/src/core/operations.ts";
import { type AuditDiff, auditDiffJson } from "./diff.ts";
import {
  AUDIT_CORRELATION_ID,
  AUDIT_DIGEST,
  AUDIT_ID,
  AUDIT_IDEMPOTENCY_KEY,
  AUDIT_INSTANT,
  AUDIT_MAX_REFS,
  AUDIT_OPERATION,
  AUDIT_PRINCIPAL,
  AUDIT_PRINCIPAL_KINDS,
  AUDIT_REASON_CODE,
  AUDIT_RESULT_CODE,
  AUDIT_RESULTS,
  AUDIT_SCOPE_SOURCE,
  AUDIT_SUBJECT,
  type AuditPath,
  type AuditPrincipalKind,
  type AuditResult,
  type AuditStep,
  AUDIT_PATHS,
  isAuditRef,
  RISK_CLASSES,
  type RiskClass,
  SCOPE_NAMESPACES,
  type ScopeNamespace,
} from "./vocabulary.ts";

/** Who acted and through which path; the same for every record of one call. */
export interface AuditActor {
  path: AuditPath;
  /** The verified Access subject; null exactly on `alarm` and `lane`. */
  subject: string | null;
  /** What the subject was graded as: `<sub>`, `mcp-client:<sub>`, or the Processor's own. */
  principal: string;
  principalKind: AuditPrincipalKind;
  /** The App's request id, forwarded to the Processor, or the Processor's own. */
  correlationId: string;
}

export interface AuditScope {
  namespace: ScopeNamespace;
  /** A server-resolved source id; never a value the caller sent and was refused for. */
  source: string;
}

/** What one record says about the operation. */
export interface AuditFacts {
  operation: string;
  riskClass: RiskClass;
  step?: AuditStep;
  scope?: AuditScope | null;
  targetRef?: string | null;
  result: AuditResult;
  /** Required for `refused` and `failed`, absent otherwise. */
  resultCode?: string | null;
  reasonCode?: string | null;
  idempotencyKey?: string | null;
  payloadDigest?: string | null;
  /**
   * References into the existing logs. A reference outside the closed
   * patterns is dropped rather than stored, so an unexpected identifier shape
   * can never turn a writer's batch into a failure.
   */
  refs?: readonly string[];
  diff: AuditDiff;
}

/** One `audit_records` row, column for column. */
export interface AuditRow {
  audit_id: string;
  recorded_at: string;
  path: AuditPath;
  subject: string | null;
  principal: string;
  principal_kind: AuditPrincipalKind;
  delegation_ref: null;
  operation: string;
  risk_class: RiskClass;
  step: AuditStep;
  scope_namespace: ScopeNamespace | null;
  scope_source: string | null;
  target_ref: string | null;
  result: AuditResult;
  result_code: string | null;
  reason_code: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  payload_digest: string | null;
  confirmation_digest: null;
  confirm_expires_at: null;
  confirms_audit_id: null;
  reverts_audit_id: null;
  refs_json: string;
  diff_json: string;
}

export const AUDIT_COLUMNS = [
  "audit_id",
  "recorded_at",
  "path",
  "subject",
  "principal",
  "principal_kind",
  "delegation_ref",
  "operation",
  "risk_class",
  "step",
  "scope_namespace",
  "scope_source",
  "target_ref",
  "result",
  "result_code",
  "reason_code",
  "correlation_id",
  "idempotency_key",
  "payload_digest",
  "confirmation_digest",
  "confirm_expires_at",
  "confirms_audit_id",
  "reverts_audit_id",
  "refs_json",
  "diff_json",
] as const satisfies readonly (keyof AuditRow)[];

/** A record could not be built. `field` names which part; the value is never kept. */
export class AuditRecordError extends Error {
  readonly code = "audit_record_invalid";
  constructor(readonly field: string) {
    super(`audit_record_invalid:${field}`);
  }
}

function check(condition: boolean, field: string): void {
  if (!condition) throw new AuditRecordError(field);
}

/** `aud_` + a random UUID. */
export function newAuditId(): string {
  return `aud_${crypto.randomUUID()}`;
}

/** Canonical UTC milliseconds, as the table stores time. */
export function auditInstant(date: Date): string {
  return date.toISOString();
}

/**
 * Builds and validates one record. The builder never fills a field it was
 * not given: a refusal before the target was resolved has no target, and a
 * scope is only what the caller passed as server-resolved.
 */
export function buildAuditRecord(
  actor: AuditActor,
  facts: AuditFacts,
  recordedAt: string,
  auditId: string = newAuditId(),
): AuditRow {
  check(AUDIT_ID.test(auditId), "audit_id");
  check(AUDIT_INSTANT.test(recordedAt) && !Number.isNaN(Date.parse(recordedAt)), "recorded_at");
  check((AUDIT_PATHS as readonly string[]).includes(actor.path), "path");
  const automatic = actor.path === "alarm" || actor.path === "lane";
  check(
    automatic
      ? actor.subject === null
      : typeof actor.subject === "string" && AUDIT_SUBJECT.test(actor.subject),
    "subject",
  );
  check(AUDIT_PRINCIPAL.test(actor.principal), "principal");
  check(
    (AUDIT_PRINCIPAL_KINDS as readonly string[]).includes(actor.principalKind) &&
      (actor.principalKind === "automatic") === automatic,
    "principal_kind",
  );
  check(AUDIT_CORRELATION_ID.test(actor.correlationId), "correlation_id");
  check(AUDIT_OPERATION.test(facts.operation), "operation");
  check((RISK_CLASSES as readonly string[]).includes(facts.riskClass), "risk_class");
  const step = facts.step ?? "call";
  // Two-step confirmation (ADR 0063) is not built yet: no record of this
  // slice is a prepare or a confirm, so none carries their digests. When it
  // is, an applied confirm cites its prepare (`confirms_audit_id`); a refused
  // confirm may have none to cite, which the table admits.
  check(step === "call", "step");
  check((AUDIT_RESULTS as readonly string[]).includes(facts.result), "result");
  check(facts.result !== "prepared", "result");
  const scope = facts.scope ?? null;
  check(
    scope === null ||
      ((SCOPE_NAMESPACES as readonly string[]).includes(scope.namespace) &&
        AUDIT_SCOPE_SOURCE.test(scope.source)),
    "scope",
  );
  const target = facts.targetRef ?? null;
  check(target === null || isAuditRef(target), "target_ref");
  const refused = facts.result === "refused" || facts.result === "failed";
  const resultCode = facts.resultCode ?? null;
  check(
    refused ? resultCode !== null && AUDIT_RESULT_CODE.test(resultCode) : resultCode === null,
    "result_code",
  );
  const reasonCode = facts.reasonCode ?? null;
  check(reasonCode === null || AUDIT_REASON_CODE.test(reasonCode), "reason_code");
  const idempotencyKey = facts.idempotencyKey ?? null;
  check(idempotencyKey === null || AUDIT_IDEMPOTENCY_KEY.test(idempotencyKey), "idempotency_key");
  const payloadDigest = facts.payloadDigest ?? null;
  check(payloadDigest === null || AUDIT_DIGEST.test(payloadDigest), "payload_digest");
  check((facts.result === "overflow") === (facts.diff.kind === "overflow"), "diff_json");
  let diff: string;
  try {
    diff = auditDiffJson(facts.diff);
  } catch {
    throw new AuditRecordError("diff_json");
  }
  const refs = [...new Set((facts.refs ?? []).filter(isAuditRef))].slice(0, AUDIT_MAX_REFS);
  return {
    audit_id: auditId,
    recorded_at: recordedAt,
    path: actor.path,
    subject: actor.subject,
    principal: actor.principal,
    principal_kind: actor.principalKind,
    delegation_ref: null,
    operation: facts.operation,
    risk_class: facts.riskClass,
    step,
    scope_namespace: scope?.namespace ?? null,
    scope_source: scope?.source ?? null,
    target_ref: target,
    result: facts.result,
    result_code: resultCode,
    reason_code: reasonCode,
    correlation_id: actor.correlationId,
    idempotency_key: idempotencyKey,
    payload_digest: payloadDigest,
    confirmation_digest: null,
    confirm_expires_at: null,
    confirms_audit_id: null,
    reverts_audit_id: null,
    refs_json: JSON.stringify(refs),
    diff_json: diff,
  };
}

function rowValues(row: AuditRow): unknown[] {
  return AUDIT_COLUMNS.map((column) => row[column]);
}

const COLUMN_LIST = AUDIT_COLUMNS.join(",");
const PLACEHOLDERS = AUDIT_COLUMNS.map(() => "?").join(",");

/** A plain insert of one record; the App's answer records go through `store.ts`. */
export function auditInsertWrite(row: AuditRow): SqlWrite {
  return {
    sql: `INSERT INTO audit_records(${COLUMN_LIST}) VALUES(${PLACEHOLDERS})`,
    binds: rowValues(row),
  };
}

/**
 * How an effect record keeps "one record per effect" when two batches race
 * for the same effect and only one of them applies it: the losing batch's
 * guard may still see the winner's row, so the record statement also refuses
 * to add a second effect record for the same effect.
 *
 *   * `target`: one effect record per (target, operation) — a plan, a
 *     proposal, a survey decision, an operations request;
 *   * `target-ref`: one per (target, operation, reference) — a revision
 *     (`schedule:<id>@<rev>`), an approval, a commit's operation id;
 *   * `each`: every effect is its own (a lease release, which may be repeated
 *     while the source is unlocked and each time releases).
 */
export type EffectOnce =
  | { kind: "target" }
  | { kind: "target-ref"; ref: string }
  | { kind: "each" };

/**
 * The `applied` or `accepted` record as the last statement of its writer's
 * batch: a plain `INSERT … SELECT … WHERE`, joined to `guard` (the writer's
 * own guard or the row its effect wrote) and never `OR IGNORE`. A guard that
 * matches no row writes no record; a statement error rolls the batch back
 * with the effect. `guard.sql` is a boolean SQL expression that uses plain
 * `?` placeholders only, bound in order after the record's own values.
 */
export function auditEffectWrite(row: AuditRow, guard: SqlWrite, once: EffectOnce): SqlWrite {
  if (row.result !== "applied" && row.result !== "accepted") throw new AuditRecordError("result");
  if (once.kind !== "each" && row.target_ref === null) throw new AuditRecordError("target_ref");
  if (
    once.kind === "target-ref" &&
    !(isAuditRef(once.ref) && (JSON.parse(row.refs_json) as string[]).includes(once.ref))
  )
    throw new AuditRecordError("refs_json");
  const dedupe =
    once.kind === "each"
      ? ""
      : ` AND NOT EXISTS(SELECT 1 FROM audit_records a WHERE a.target_ref=? AND a.operation=?
          AND a.result IN ('applied','accepted')${
            once.kind === "target-ref"
              ? " AND EXISTS(SELECT 1 FROM json_each(a.refs_json) r WHERE r.atom=?)"
              : ""
          })`;
  return {
    sql: `INSERT INTO audit_records(${COLUMN_LIST}) SELECT ${PLACEHOLDERS} WHERE (${guard.sql})${dedupe}`,
    binds: [
      ...rowValues(row),
      ...guard.binds,
      ...(once.kind === "each" ? [] : [row.target_ref, row.operation]),
      ...(once.kind === "target-ref" ? [once.ref] : []),
    ],
  };
}
