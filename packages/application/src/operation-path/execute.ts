// executeOperation: the one entry every adapter of an existing operation path
// calls (ADR 0063 item 9, ADR 0064 "One chokepoint"; plan section 6.3).
//
// It wraps the adapter's existing authorization and its existing service or
// writer — nothing is re-implemented here — and makes the record of the call
// certain:
//
//   * the writer appends the `applied` / `accepted` record to its own batch
//     through the `OperationCall` it is handed (or, for a writer in the
//     Processor, through the envelope headers the call produces), so that
//     record exists exactly when the effect does;
//   * everything else — a read, a replay, a refusal, a failure — is recorded
//     here, once, after the answer, by this adapter only. A refusal the
//     Processor made reaches this function as the Processor's closed code and
//     is recorded here and nowhere else;
//   * recording never changes the answer. A record that cannot be built or
//     written is reported through `onWriteFailure` (the request log's
//     `audit_write_failed`), and the value or error the adapter produced is
//     returned or rethrown unchanged.
//
// There is no delegation, prepare or confirm yet (ADR 0063, plan S3): the
// authorization is the adapter's own, as it was before this function existed.
import { OperationCall } from "../audit/call.ts";
import { type AuditRow, type AuditScope, auditInstant, buildAuditRecord } from "../audit/record.ts";
import type { AnswerAppend } from "../audit/store.ts";
import type { SubjectPath, SubjectPrincipalKind } from "../audit/vocabulary.ts";
import { catalogueEntry, type OperationName } from "./catalogue.ts";

/** Where answer records go: the App's capped append (`appendAnswerRecord`). */
export interface AnswerSink {
  append(row: AuditRow): Promise<AnswerAppend>;
}

export interface ExecuteContext {
  path: SubjectPath;
  /** The subject Cloudflare Access verified; never a body or header claim. */
  subject: string;
  /** The principal, when the adapter knows it before the call; else the subject. */
  principal?: string;
  /** The kind a refusal before grading is recorded under: `human` on `ui`, `agent` elsewhere. */
  principalKind?: SubjectPrincipalKind;
  /** The App's request id. */
  correlationId: string;
  sink: AnswerSink;
  clock?: () => Date;
  /** Called with `audit_write_failed` when a record could not be built or written. */
  onWriteFailure?: () => void;
}

/** What a call that the writer did not record was. */
export type AnswerOutcome =
  /** The writer recorded the effect (in this Worker or in the Processor). */
  | { result: "effect" }
  /** Not an operation after all: a route or tool this deployment does not serve. */
  | { result: "skip" }
  | { result: "read"; rows: number; truncated: boolean }
  | {
      result: "replayed";
      /** Server-resolved identifiers of the earlier effect; never the caller's refused value. */
      targetRef?: string | null;
      refs?: readonly string[];
      scope?: AuditScope | null;
    }
  | {
      result: "refused" | "failed";
      code: string;
      /** Schema paths of the refused fields (`field:<path>`), never their values. */
      fields?: readonly string[];
    };

export interface Classifier<T> {
  /** A returned value: an effect, a read, a replay, or a refusal carried in the value. */
  value(value: T, call: OperationCall): AnswerOutcome;
  /** A thrown error: the refusal or failure it stands for, or `skip`. */
  error(error: unknown, call: OperationCall): AnswerOutcome;
}

/** A closed result code, or the generic one of its kind when the code is not one. */
function closedCode(code: string, result: "refused" | "failed"): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code)
    ? code
    : result === "refused"
      ? "request_refused"
      : "internal_error";
}

async function recordAnswer(
  context: ExecuteContext,
  call: OperationCall,
  outcome: AnswerOutcome,
  clock: () => Date,
): Promise<void> {
  if (outcome.result === "effect" || outcome.result === "skip") return;
  try {
    const refused = outcome.result === "refused" || outcome.result === "failed";
    const row = buildAuditRecord(
      call.actor,
      {
        operation: call.operation,
        riskClass: call.riskClass,
        result: outcome.result,
        ...(refused
          ? {
              resultCode: closedCode(outcome.code, outcome.result),
              refs: (outcome.fields ?? []).map((field) => `field:${field}`),
            }
          : {}),
        ...(outcome.result === "replayed"
          ? {
              targetRef: outcome.targetRef ?? null,
              refs: outcome.refs ?? [],
              scope: outcome.scope ?? null,
            }
          : {}),
        diff:
          outcome.result === "read"
            ? { kind: "read", rows: outcome.rows, truncated: outcome.truncated }
            : { kind: "none" },
      },
      auditInstant(clock()),
    );
    await context.sink.append(row);
  } catch {
    context.onWriteFailure?.();
  }
}

/**
 * Runs one operation through the chokepoint. `run` is the adapter's existing
 * authorization and service call; it receives the call, hands
 * `call.effect(...)` to its writer, and grades the principal with
 * `call.grade(...)` once it has. `classify` maps what `run` answered or threw
 * to the outcome recorded here.
 */
export async function executeOperation<T>(
  context: ExecuteContext,
  operation: OperationName,
  run: (call: OperationCall) => Promise<T>,
  classify: Classifier<T>,
): Promise<T> {
  const clock = context.clock ?? (() => new Date());
  const call = new OperationCall(
    operation,
    {
      path: context.path,
      subject: context.subject,
      principal: context.principal ?? context.subject,
      principalKind: context.principalKind ?? (context.path === "ui" ? "human" : "agent"),
      correlationId: context.correlationId,
    },
    clock,
  );
  let value: T;
  try {
    value = await run(call);
  } catch (error) {
    let outcome: AnswerOutcome;
    try {
      outcome = classify.error(error, call);
    } catch {
      outcome = { result: "failed", code: "internal_error" };
    }
    if (!call.recorded) await recordAnswer(context, call, outcome, clock);
    throw error;
  }
  if (!call.recorded) {
    let outcome: AnswerOutcome;
    try {
      outcome = classify.value(value, call);
    } catch {
      outcome = { result: "failed", code: "internal_error" };
    }
    // A successful call whose writer wrote nothing is the catalogue's quiet
    // result; a classifier never upgrades it to an effect it did not see.
    if (outcome.result === "read" && catalogueEntry(operation).quiet !== "read")
      outcome = { result: "replayed" };
    await recordAnswer(context, call, outcome, clock);
  }
  return value;
}
