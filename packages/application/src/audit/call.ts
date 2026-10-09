// One operation call as the audit sees it (ADR 0064, "One chokepoint").
//
// `executeOperation` creates one `OperationCall` per call on the App; the
// Processor rebuilds the same object from the envelope headers the App
// forwarded over the private `PIPELINE` binding. A writer asks the call for
// its effect statement (`effect`), appends it as the last statement of its own
// batch and reports what that statement changed (`settle`); whether the call
// is then recorded is the call's answer, not the writer's.
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
  /** ADR 0063's delegation reference. No delegation exists yet, so its presence is refused. */
  delegationRef: "x-kogane-delegation-ref",
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
      { operation: this.operation, riskClass: this.#risk, result, ...facts },
      auditInstant(this.clock()),
      auditId,
    );
    this.#pending = { auditId };
    return auditEffectWrite(row, guard, once);
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
    };
  }
}

/** The envelope the Processor accepts: a closed path and a correlation id. */
export interface AuditEnvelope {
  path: SubjectPath;
  correlationId: string;
}

/**
 * Reads the envelope headers, validated by the same patterns the builder
 * uses. Missing or malformed headers, and any delegation reference (no
 * delegation exists yet), answer null: the route refuses the request as it
 * refuses a missing actor header.
 */
export function parseAuditEnvelope(headers: Headers): AuditEnvelope | null {
  const path = headers.get(AUDIT_HEADERS.path);
  const correlationId = headers.get(AUDIT_HEADERS.correlationId);
  if (headers.has(AUDIT_HEADERS.delegationRef)) return null;
  if (path === null || !(SUBJECT_PATHS as readonly string[]).includes(path)) return null;
  if (correlationId === null || !AUDIT_CORRELATION_ID.test(correlationId)) return null;
  return { path: path as SubjectPath, correlationId };
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
  return new OperationCall(
    operation,
    {
      path: envelope.path,
      subject: subjectOfPrincipal(principal),
      principal,
      principalKind: kind,
      correlationId: envelope.correlationId,
    },
    clock,
  );
}
