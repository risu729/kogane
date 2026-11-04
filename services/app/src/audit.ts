// This Worker's adapter over the common audit record (ADR 0064).
//
// Every operator route (`ui`), every agent route (`agent-http`) and every MCP
// tool call (`mcp`) of this Worker runs through `executeOperation`
// (`packages/application/src/operation-path/`), with the context built here:
// the verified subject, the request's correlation id (the request id the
// Worker already logs), and the sink that writes the answer records under the
// daily caps. This module is the only writer of `read`, `replayed`, `refused`
// and `failed` records for those paths — a refusal the Processor made comes
// back as the Processor's closed code and is recorded here once. Effect
// records are their writers' own (`OperationCall.effect`).
//
// Recording never changes an answer: a record that cannot be written marks the
// request, and the request log line carries `audit_write_failed`.
import {
  type AnswerOutcome,
  appendAnswerRecord,
  AUDIT_RECORDED_HEADER,
  AUDIT_WRITE_FAILED,
  catalogueEntry,
  d1CommandStore,
  type ExecuteContext,
  executeOperation,
  type OperationCall,
  type OperationName,
  type SubjectPath,
} from "../../../packages/application/src/index";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";

interface AuditState {
  correlationId: string;
  failed: boolean;
}

// Per request, keyed by the Request object itself, so no route signature has
// to carry it: the Worker binds it before routing and reads it for the log.
const states = new WeakMap<Request, AuditState>();

/** Binds the request id the Worker logs as the correlation id of every record of this request. */
export function beginAudit(request: Request, requestId: string): void {
  states.set(request, { correlationId: requestId, failed: false });
}

function stateOf(request: Request): AuditState {
  let state = states.get(request);
  if (!state) {
    state = { correlationId: crypto.randomUUID(), failed: false };
    states.set(request, state);
  }
  return state;
}

/** `audit_write_failed` when a record of this request could not be written, else null. */
export function auditLogCode(request: Request): typeof AUDIT_WRITE_FAILED | null {
  return states.get(request)?.failed ? AUDIT_WRITE_FAILED : null;
}

/**
 * The context of one audited call on `path` by the verified `subject`. The
 * principal is the subject unless the boundary already built another one (an
 * MCP client is `mcp-client:<sub>`, ADR 0047); an operator route grades its
 * subject inside the call instead.
 */
export function auditContext(
  request: Request,
  env: Env,
  path: SubjectPath,
  subject: string,
  principal: string = subject,
): ExecuteContext {
  const state = stateOf(request);
  return {
    path,
    subject,
    principal,
    correlationId: state.correlationId,
    sink: { append: (row) => appendAnswerRecord(d1CommandStore(env.DB), row) },
    onWriteFailure: () => {
      state.failed = true;
    },
  };
}

/**
 * The Processor did not answer, or its answer was lost: the App records
 * `failed` with `upstream_unavailable` while the caller gets the answer it
 * always got. If the Processor applied the operation anyway, its own
 * `applied` record under the same correlation id is the authoritative one.
 */
export class UpstreamLost extends HttpError {}

const FIELD = /^(?:body|[a-z][A-Za-z]{0,31}(?:\.(?:[a-z][A-Za-z]{0,31}|[0-9]{1,3})){0,3})$/u;

/**
 * A thrown refusal as a record. Only the schema paths of a validation refusal
 * are kept, as `field:` references; any other ref of an error (an id the
 * caller sent, a plan id) is not copied. A route or tool this deployment
 * does not serve (`404 not_found`) is not an operation and is not recorded.
 */
function errorOutcome(error: unknown): AnswerOutcome {
  if (error instanceof UpstreamLost) return { result: "failed", code: "upstream_unavailable" };
  if (!(error instanceof HttpError)) return { result: "failed", code: "internal_error" };
  if (error.status === 404 && error.code === "not_found") return { result: "skip" };
  return {
    result: error.status >= 500 ? "failed" : "refused",
    code: error.code,
    fields:
      error.code === "invalid_request"
        ? error.refs
            .map((ref) => (ref === "(body)" ? "body" : ref))
            .filter((ref) => FIELD.test(ref))
        : [],
  };
}

/** The closed code of an error body (`{error}` or a financial error's `{code}`), or null. */
function bodyCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const value =
    (body as { error?: unknown }).error ?? (body as { code?: unknown }).code ?? undefined;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : null;
}

/** A refusal or failure answered with a status rather than thrown. */
function statusOutcome(status: number, body: unknown): AnswerOutcome {
  const failed = status >= 500;
  return {
    result: failed ? "failed" : "refused",
    code: bodyCode(body) ?? (failed ? "internal_error" : "request_refused"),
  };
}

/**
 * How the Processor answered a forwarded write: its own `applied` record when
 * it set the recorded header, otherwise the quiet result (a read, a replay)
 * or its closed refusal code, which this Worker then records once.
 */
export function upstreamOutcome(
  status: number,
  headers: Headers,
  text: string,
  quiet: AnswerOutcome,
): AnswerOutcome {
  if (status >= 200 && status < 300)
    return headers.get(AUDIT_RECORDED_HEADER) === "1" ? { result: "effect" } : quiet;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* A body that is not JSON carries no code. */
  }
  return statusOutcome(status, body);
}

// Errors a chokepoint already recorded on their way out, so an outer
// transport wrapper does not record the same refusal twice.
const recordedErrors = new WeakSet<object>();
function recordedError(error: unknown): AnswerOutcome {
  if (error !== null && typeof error === "object") recordedErrors.add(error);
  return errorOutcome(error);
}
/** Whether a chokepoint already recorded this thrown error. */
function alreadyRecorded(error: unknown): boolean {
  return error !== null && typeof error === "object" && recordedErrors.has(error);
}

/** One answered route: the response, and what the record of it is. */
export interface Answer {
  response: Response;
  outcome: AnswerOutcome;
}

/** Runs one route through the chokepoint and answers its response unchanged. */
export async function auditedRoute(
  context: ExecuteContext,
  operation: OperationName,
  run: (call: OperationCall) => Promise<Answer>,
): Promise<Response> {
  const answer = await executeOperation(context, operation, run, {
    value: (value) => value.outcome,
    error: recordedError,
  });
  return answer.response;
}

/** How many rows an agent tool's answer carried, and whether more exist: a count, never data. */
function toolRows(operation: OperationName, body: unknown): { rows: number; truncated: boolean } {
  const value = (body ?? {}) as Record<string, unknown>;
  if (operation === "instruments.history")
    return {
      rows: Array.isArray(value["entries"]) ? value["entries"].length : 0,
      truncated: false,
    };
  if (operation === "audit.search")
    return {
      rows: Array.isArray(value["records"]) ? value["records"].length : 0,
      truncated: typeof value["cursor"] === "string",
    };
  if (operation === "audit.get") return { rows: value["record"] ? 1 : 0, truncated: false };
  if (operation === "financial.query") {
    const result = (value["result"] ?? {}) as Record<string, unknown>;
    const coverage = (result["coverage"] ?? {}) as Record<string, unknown>;
    return {
      rows: countOf(result["data"]),
      truncated:
        (typeof result["nextCursor"] === "string" && result["nextCursor"] !== "") ||
        coverage["truncated"] === true,
    };
  }
  if (operation === "explain")
    return {
      rows: Array.isArray(value["nodes"]) ? value["nodes"].length : 0,
      truncated: value["truncated"] === true,
    };
  if (operation === "purchases.explain") return { rows: countOf(value["data"]), truncated: false };
  // One account's reconstructed state, when there is one to show.
  if (operation === "reconstructed-state.read")
    return { rows: value["reconstruction"] ? 1 : 0, truncated: false };
  if (operation === "instruments.candidates") {
    const items = Array.isArray(value["items"]) ? value["items"].length : 0;
    return {
      rows: items,
      truncated: typeof value["total"] === "number" && value["total"] > items,
    };
  }
  return { rows: 1, truncated: false };
}

/** The rows of a result's data: an array's length, a page's items, or one object. */
function countOf(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data === null || data === undefined) return 0;
  if (typeof data !== "object") return 1;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record["items"])) return record["items"].length;
  const first = Object.values(record).find((entry) => Array.isArray(entry));
  return Array.isArray(first) ? first.length : 1;
}

/**
 * One agent tool call (`agent-http` or `mcp`) through the chokepoint: a read
 * is recorded as `read` with its row count, a proposal by its own batch, a
 * refusal with the tool's closed code. A tool this deployment does not serve
 * (`null`) is not recorded.
 */
export async function auditedTool(
  context: ExecuteContext,
  operation: OperationName,
  run: (call: OperationCall) => Promise<ToolResult | null>,
): Promise<ToolResult | null> {
  return executeOperation(context, operation, run, {
    value: (result) => {
      if (result === null) return { result: "skip" };
      if (result.auditOutcome) return result.auditOutcome;
      if (result.status >= 200 && result.status < 300) {
        // A write tool whose writer recorded nothing answered an earlier
        // effect: an operations request re-sent under its key, named by the
        // operation id the service answered with.
        if (catalogueEntry(operation).quiet === "replayed") {
          const operationId = (result.body as { operationId?: unknown } | null)?.operationId;
          return {
            result: "replayed",
            targetRef:
              typeof operationId === "string" && /^op_[0-9a-f]{64}$/u.test(operationId)
                ? operationId
                : null,
          };
        }
        return { result: "read", ...toolRows(operation, result.body) };
      }
      const outcome = statusOutcome(result.status, result.body);
      const refs = (result.body as { refs?: unknown } | null)?.refs;
      // Only the operations tools' validation refusals carry schema paths
      // (`parseRequest`); every other tool's refs are not copied.
      return outcome.result === "refused" &&
        outcome.code === "invalid_request" &&
        operation.startsWith("ops.") &&
        Array.isArray(refs)
        ? {
            ...outcome,
            fields: refs
              .filter((ref): ref is string => typeof ref === "string")
              .map((ref) => (ref === "(body)" ? "body" : ref))
              .filter((ref) => FIELD.test(ref)),
          }
        : outcome;
    },
    error: recordedError,
  });
}

/**
 * Records a refusal that was thrown before any audited call ran (a transport
 * check), once, and never throws: the caller rethrows the error unchanged.
 */
export async function recordThrown(
  context: ExecuteContext,
  operation: OperationName,
  error: unknown,
): Promise<void> {
  if (alreadyRecorded(error)) return;
  await executeOperation(context, operation, () => Promise.reject(error), {
    value: () => ({ result: "skip" }),
    error: recordedError,
  }).catch(() => undefined);
}

/**
 * The closed code of an HTTP refusal the MCP transport answers itself, before
 * any message reaches a tool: a body that is not JSON or a bad protocol
 * header (400), a method it does not serve (405), a client that does not
 * accept JSON (406), a body over the bound (413), a body that is not JSON by
 * its media type (415).
 */
const MCP_TRANSPORT_CODES: Readonly<Record<number, string>> = {
  400: "invalid_body",
  405: "method_not_allowed",
  406: "not_acceptable",
  413: "request_too_large",
  415: "unsupported_media_type",
};

/**
 * Records a refusal the MCP transport answered with an HTTP status rather
 * than a JSON-RPC message, once, as `mcp.request`; never throws. JSON-RPC
 * answers (`200`, an unknown method or tool inside the envelope) and an
 * accepted notification (`202`) are the protocol's own and not recorded.
 */
export async function recordTransportStatus(
  context: ExecuteContext,
  status: number,
): Promise<void> {
  if (status < 400) return;
  const failed = status >= 500;
  const code = MCP_TRANSPORT_CODES[status] ?? (failed ? "internal_error" : "request_refused");
  await executeOperation(context, "mcp.request", () => Promise.resolve(null), {
    value: () => ({ result: failed ? "failed" : "refused", code }),
    error: recordedError,
  }).catch(() => undefined);
}
