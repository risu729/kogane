// One operation call as the audit sees it (ADR 0064, "One chokepoint").
//
// `executeOperation` creates one `OperationCall` per call on the App; the
// Processor rebuilds the same object from the envelope headers the App
// forwarded over the private `PIPELINE` binding. A writer asks the call for
// its effect statement (`effect`), appends it as the last statement of its own
// batch and reports what that statement changed (`settle`); whether the call
// is then recorded is the call's answer, not the writer's.
import {
  guardDelegatedEffect,
  validDelegatedExecution,
  type DelegatedExecution,
} from "../delegation/execution.ts";
import type { DelegatedPrincipal } from "../delegation/contract.ts";
import type { SqlWrite } from "../../../storage-d1/src/core/operations.ts";
import {
  type AuditActor,
  type AuditFacts,
  auditEffectWrite,
  auditInstant,
  buildAuditRecord,
  type EffectOnce,
  newAuditId,
} from "./record.ts";
import {
  AUDIT_CORRELATION_ID,
  type RiskClass,
  SUBJECT_PATHS,
  type SubjectPath,
  type SubjectPrincipalKind,
} from "./vocabulary.ts";
import { catalogueEntry, type OperationName } from "../operation-path/catalogue.ts";

/** The envelope headers the App forwards to the Processor, and nothing else. */
export const AUDIT_HEADERS = {
  correlationId: "x-kogane-correlation-id",
  path: "x-kogane-audit-path",
  /** ADR 0063's reference, admitted only with the closed private execution envelope. */
  delegationRef: "x-kogane-delegation-ref",
  delegatedExecution: "x-kogane-delegated-execution",
} as const;
/** Set by the Processor on its answer when its batch wrote the effect record. */
export const AUDIT_RECORDED_HEADER = "x-kogane-audit-recorded";

/** What the effect record says beyond the envelope; the result comes from the catalogue. */
export type EffectFacts = Pick<
  AuditFacts,
  "targetRef" | "refs" | "diff" | "scope" | "reasonCode" | "idempotencyKey" | "payloadDigest"
>;

export class OperationCall {
  #actor: AuditActor;
  #risk: RiskClass;
  #pending: { auditId: string } | null = null;
  #recorded: string | null = null;
  #execution: DelegatedExecution | null = null;
  #step: "call" | "prepare" | "confirm" = "call";

  constructor(
    readonly operation: OperationName,
    actor: AuditActor,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#actor = { ...actor };
    this.#risk = catalogueEntry(operation).risk[0];
  }

  get actor(): Readonly<AuditActor> {
    return this.#actor;
  }
  get delegatedExecution(): Readonly<DelegatedExecution> | null {
    return this.#execution;
  }
  get step() {
    return this.#step;
  }
  setStep(step: "call" | "prepare" | "confirm"): void {
    this.#step = step;
  }
  markRecorded(auditId: string): void {
    this.#recorded = auditId;
  }
  delegate(
    principal: Pick<DelegatedPrincipal, "id" | "delegator" | "delegationRef">,
    execution: DelegatedExecution,
  ): void {
    if (
      this.#actor.path !== "mcp" ||
      this.#actor.principal !== principal.id ||
      this.#actor.subject !== principal.delegator ||
      principal.id !== `mcp-client:${principal.delegator}` ||
      !validDelegatedExecution(execution) ||
      execution.delegationRef !== principal.delegationRef
    )
      throw new Error("invalid delegated call");
    this.#actor = {
      ...this.#actor,
      principalKind: "delegated",
      delegationRef: principal.delegationRef,
    };
    this.#execution = { ...execution, commandFamilies: [...execution.commandFamilies] };
  }
  get riskClass(): RiskClass {
    return this.#risk;
  }
  /** The id of the effect record this call's writer wrote, or null. */
  get recordedAuditId(): string | null {
    return this.#recorded;
  }
  get recorded(): boolean {
    return this.#recorded !== null;
  }

  /**
   * The principal the adapter graded the subject as. Until it is called the
   * principal is the subject itself, under the path's default kind — which is
   * what a refusal before grading (an ungranted subject) is recorded as.
   */
  grade(principal: string, kind: SubjectPrincipalKind): void {
    if (kind === "delegated" || this.#execution !== null)
      throw new Error("delegation must be resolved");
    this.#actor = { ...this.#actor, principal, principalKind: kind };
  }

  /** Narrows the risk class to one the catalogue lists for this operation. */
  setRisk(risk: RiskClass): void {
    if (!(catalogueEntry(this.operation).risk as readonly string[]).includes(risk))
      throw new Error(`risk class not catalogued for ${this.operation}`);
    this.#risk = risk;
  }

  /**
   * The effect record as the last statement of the writer's batch. The
   * result is the catalogue's (`applied` or `accepted`); a read has none.
   */
  effect(facts: EffectFacts, guard: SqlWrite, once: EffectOnce): SqlWrite {
    const result = catalogueEntry(this.operation).effect;
    if (result === null) throw new Error(`${this.operation} has no effect record`);
    const auditId = newAuditId();
    const row = buildAuditRecord(
      this.#actor,
      {
        operation: this.operation,
        riskClass: this.#risk,
        result,
        ...facts,
        ...(this.#execution
          ? {
              step: this.#step,
              idempotencyKey: this.#execution.idempotencyKey,
              payloadDigest: this.#execution.payloadDigest,
              confirmsAuditId: this.#execution.confirmsAuditId,
              ...(this.#execution.revertsAuditId
                ? { revertsAuditId: this.#execution.revertsAuditId }
                : {}),
            }
          : {}),
      },
      auditInstant(this.clock()),
      auditId,
    );
    this.#pending = { auditId };
    const write = auditEffectWrite(row, guard, once);
    return this.#execution ? guardDelegatedEffect(write, row, this.#execution) : write;
  }

  /** The writer reports the changes of the effect statement after its batch. */
  settle(changes: number | undefined): boolean {
    if (this.#pending !== null && changes === 1) this.#recorded = this.#pending.auditId;
    this.#pending = null;
    return this.recorded;
  }

  /** The envelope headers for the Processor. */
  envelopeHeaders(): Record<string, string> {
    return {
      [AUDIT_HEADERS.correlationId]: this.#actor.correlationId,
      [AUDIT_HEADERS.path]: this.#actor.path,
      ...(this.#execution
        ? {
            [AUDIT_HEADERS.delegationRef]: this.#execution.delegationRef,
            [AUDIT_HEADERS.delegatedExecution]: JSON.stringify(this.#execution),
          }
        : {}),
    };
  }
}

/** The envelope the Processor accepts: a closed path and a correlation id. */
export interface AuditEnvelope {
  path: SubjectPath;
  correlationId: string;
  delegatedExecution?: DelegatedExecution;
}

/**
 * Reads the envelope headers, validated by the same patterns the builder
 * uses. Missing or malformed headers, or an incomplete delegation envelope,
 * answer null: the route refuses the request as it
 * refuses a missing actor header.
 */
export function parseAuditEnvelope(headers: Headers): AuditEnvelope | null {
  const path = headers.get(AUDIT_HEADERS.path);
  const correlationId = headers.get(AUDIT_HEADERS.correlationId);
  const delegationRef = headers.get(AUDIT_HEADERS.delegationRef);
  const serialized = headers.get(AUDIT_HEADERS.delegatedExecution);
  let delegatedExecution: DelegatedExecution | undefined;
  if (delegationRef !== null || serialized !== null) {
    if (path !== "mcp" || delegationRef === null || serialized === null || serialized.length > 2048)
      return null;
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!validDelegatedExecution(parsed) || parsed.delegationRef !== delegationRef) return null;
      delegatedExecution = parsed;
    } catch {
      return null;
    }
  }
  if (path === null || !(SUBJECT_PATHS as readonly string[]).includes(path)) return null;
  if (correlationId === null || !AUDIT_CORRELATION_ID.test(correlationId)) return null;
  return {
    path: path as SubjectPath,
    correlationId,
    ...(delegatedExecution ? { delegatedExecution } : {}),
  };
}

/** `mcp-client:<sub>` stands for `<sub>` (ADR 0047); every other principal is its own subject. */
export function subjectOfPrincipal(principal: string): string {
  return principal.startsWith("mcp-client:") ? principal.slice("mcp-client:".length) : principal;
}

/** The Processor's call: the App's envelope plus the actor headers the route already trusts. */
export function processorCall(
  envelope: AuditEnvelope,
  operation: OperationName,
  principal: string,
  kind: SubjectPrincipalKind,
  clock?: () => Date,
): OperationCall {
  const call = new OperationCall(
    operation,
    {
      path: envelope.path,
      subject: subjectOfPrincipal(principal),
      principal,
      principalKind: kind === "delegated" ? "agent" : kind,
      correlationId: envelope.correlationId,
    },
    clock,
  );
  if (kind === "delegated") {
    if (!envelope.delegatedExecution) throw new Error("delegation envelope required");
    call.delegate(
      {
        id: principal,
        delegator: subjectOfPrincipal(principal),
        delegationRef: envelope.delegatedExecution.delegationRef,
      },
      envelope.delegatedExecution,
    );
    if (envelope.delegatedExecution.confirmsAuditId) call.setStep("confirm");
  } else if (envelope.delegatedExecution) throw new Error("unexpected delegation envelope");
  return call;
}
