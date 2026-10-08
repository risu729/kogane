// The operations API's half of the named collector RPC (issue #544, ADR 0048).
//
// An accepted `collection` or unattended `session-refresh` request reaches a
// collector over the same private Service Binding the alarm uses
// (`SCHEDULE_<WORKSPACE>` → the collector's `ScheduledCollection`
// entrypoint). There is no URL, no generic executor and no second transport:
// the Processor names one *connection* — the alarm job that already binds a
// source to a collector Worker — and one closed action, and the collector runs
// that job's own scheduled path once, under the same execution lease.
//
// The request carries identifiers only: the operation id, the connection, the
// collector's source id, the action and a time. No credential, no window, no
// provider value. A collector refuses a request that names another collector's
// connection, a source that is not the connection's, or an action the
// connection does not have, with a closed code and without contacting anyone.
//
// Dependency-free like the rest of this package: collectors bundle it, so the
// validation below is the same closed-key style as `manifest.ts` rather than a
// schema library (the App's request schemas stay Zod).
import type { ScheduledResult } from "./schedule-result";

export const COLLECTOR_OPERATION_VERSION = "kogane-collector-operation-v1";

/** The two things an operation may ask a collector to do. */
export const COLLECTOR_OPERATION_ACTIONS = ["collect", "refresh-session"] as const;
export type CollectorOperationAction = (typeof COLLECTOR_OPERATION_ACTIONS)[number];

export interface CollectorOperationRequest {
  readonly version: typeof COLLECTOR_OPERATION_VERSION;
  /** The accepted operation, `op_<64 hex>`; it names the request, not a run. */
  readonly operationId: string;
  /** The alarm job id that binds this source to this collector. */
  readonly connectionId: string;
  /** The collector's own source id: the execution lease key. */
  readonly source: string;
  readonly action: CollectorOperationAction;
  /** When the Processor started the request, in epoch ms; the run's nominal time. */
  readonly requestedAtMs: number;
}

/**
 * One named connection: an alarm job of `config/alarm-jobs.json` that a
 * collector Worker serves. This is a closed mirror of that file — the
 * collectors do not import JSON — and
 * `tests/collector-operation-rpc.test.ts` fails when the two differ.
 *
 * `source` is the job's source, which is also the key every collector passes
 * to `withCollectionLease`; `terminalSource` is the `runs/<source>/…` id its
 * terminals carry, which is how a reported run is found in `collection_runs`.
 */
export interface OperationConnection {
  readonly connectionId: string;
  readonly workspace: string;
  readonly source: string;
  readonly terminalSource: string;
  readonly action: CollectorOperationAction;
  /** The job's historical trigger shape, which the collector's `runScheduled` validates. */
  readonly cron: string;
}

export const OPERATION_CONNECTIONS: readonly OperationConnection[] = [
  {
    connectionId: "prestia-globalpass",
    workspace: "collector-globalpass",
    source: "prestia-globalpass",
    terminalSource: "prestia-globalpass",
    action: "collect",
    cron: "17 18 * * *",
  },
  {
    connectionId: "vpass",
    workspace: "collector-vpass",
    source: "vpass",
    terminalSource: "vpass",
    action: "collect",
    cron: "0 21 * * *",
  },
  {
    connectionId: "myjcb",
    workspace: "collector-myjcb",
    source: "myjcb",
    terminalSource: "myjcb",
    action: "collect",
    cron: "0 21 * * *",
  },
  {
    connectionId: "sbi-securities",
    workspace: "collector-sbi-securities",
    source: "sbi-securities",
    terminalSource: "sbi-securities",
    action: "collect",
    cron: "0 21 * * *",
  },
  {
    connectionId: "sbi-shinsei",
    workspace: "collector-sbi-shinsei",
    source: "sbi-shinsei",
    terminalSource: "sbi-shinsei",
    action: "collect",
    cron: "0 21 * * *",
  },
  {
    connectionId: "sony-bank",
    workspace: "collector-sony-bank",
    source: "sony-bank",
    terminalSource: "sony-bank",
    action: "collect",
    cron: "0 21 * * *",
  },
  {
    connectionId: "sbi-vc-trade",
    workspace: "collector-sbi-vc-trade",
    source: "sbi-vc-trade",
    terminalSource: "sbi-vc-trade",
    action: "collect",
    cron: "5 21 * * *",
  },
  {
    connectionId: "mobile-suica",
    workspace: "collector-mobile-suica",
    source: "mobile-suica",
    terminalSource: "mobile-suica",
    action: "collect",
    cron: "10 21 * * *",
  },
  {
    connectionId: "moneyforward-me",
    workspace: "collector-moneyforward",
    source: "moneyforward-me",
    terminalSource: "moneyforward-me",
    action: "collect",
    cron: "15 21 * * *",
  },
  {
    connectionId: "vpoint",
    workspace: "collector-vpoint",
    source: "vpoint",
    terminalSource: "v-point",
    action: "collect",
    cron: "15 21 * * *",
  },
  {
    connectionId: "mizuho-bank",
    workspace: "collector-mizuho",
    source: "mizuho-bank",
    terminalSource: "mizuho-bank",
    action: "collect",
    cron: "25 21 * * *",
  },
  {
    connectionId: "prestia-bank",
    workspace: "collector-prestia-bank",
    source: "prestia-bank",
    terminalSource: "prestia-bank",
    action: "collect",
    cron: "30 21 * * *",
  },
  {
    connectionId: "st-george",
    workspace: "collector-st-george",
    source: "st-george",
    terminalSource: "st-george",
    action: "collect",
    cron: "35 21 * * *",
  },
  // The only session a collector renews by itself today: SBI VC's keepalive.
  // Every other source has no refresh connection, so a refresh request for it
  // ends `unsupported` instead of being guessed onto a login.
  {
    connectionId: "sbi-vc-keepalive",
    workspace: "collector-sbi-vc-trade",
    source: "sbi-vc-trade",
    terminalSource: "sbi-vc-trade",
    action: "refresh-session",
    cron: "*/15 * * * *",
  },
];

/** The connection with this id, or null. */
export function operationConnection(connectionId: string): OperationConnection | null {
  return OPERATION_CONNECTIONS.find((entry) => entry.connectionId === connectionId) ?? null;
}

const REQUEST_KEYS = [
  "version",
  "operationId",
  "connectionId",
  "source",
  "action",
  "requestedAtMs",
] as const;
const OPERATION_ID = /^op_[0-9a-f]{64}$/u;
const IDENT = /^[a-z0-9][a-z0-9-]{0,99}$/u;

export type ParsedOperationRequest =
  | { ok: true; request: CollectorOperationRequest }
  | { ok: false; code: "operation_invalid" };

/** Closed keys, closed values, nothing coerced. */
export function parseCollectorOperationRequest(value: unknown): ParsedOperationRequest {
  const refused = { ok: false, code: "operation_invalid" } as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refused;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== REQUEST_KEYS.length ||
    keys.some((key) => !(REQUEST_KEYS as readonly string[]).includes(key))
  )
    return refused;
  const { version, operationId, connectionId, source, action, requestedAtMs } = record;
  if (
    version !== COLLECTOR_OPERATION_VERSION ||
    typeof operationId !== "string" ||
    !OPERATION_ID.test(operationId) ||
    typeof connectionId !== "string" ||
    !IDENT.test(connectionId) ||
    typeof source !== "string" ||
    !IDENT.test(source) ||
    typeof action !== "string" ||
    !(COLLECTOR_OPERATION_ACTIONS as readonly string[]).includes(action) ||
    typeof requestedAtMs !== "number" ||
    !Number.isSafeInteger(requestedAtMs) ||
    requestedAtMs < 0
  )
    return refused;
  return {
    ok: true,
    request: {
      version: COLLECTOR_OPERATION_VERSION,
      operationId,
      connectionId,
      source,
      action: action as CollectorOperationAction,
      requestedAtMs,
    },
  };
}

function refusal(failureCode: string): ScheduledResult {
  return { status: "failed", runIds: [], failureCode };
}

/**
 * The collector side, called from each collector's `ScheduledCollection`
 * entrypoint with its own workspace name and its own `runScheduled`. The
 * request is checked against the connection table *before* anything runs; a
 * valid request runs the connection's job exactly as its alarm would, through
 * the same lease, so an operation and the alarm can never run one source twice
 * at once. A refusal contacts nobody.
 */
export async function runCollectorOperation(
  value: unknown,
  workspace: string,
  runScheduled: (cron: string, scheduledTime: number) => Promise<ScheduledResult>,
): Promise<ScheduledResult> {
  const parsed = parseCollectorOperationRequest(value);
  if (!parsed.ok) return refusal(parsed.code);
  const { request } = parsed;
  const connection = operationConnection(request.connectionId);
  if (
    connection === null ||
    connection.workspace !== workspace ||
    connection.source !== request.source
  )
    return refusal("connection_mismatch");
  if (connection.action !== request.action) return refusal("action_unsupported");
  return runScheduled(connection.cron, request.requestedAtMs);
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/u;

/**
 * What the Processor accepts back over the binding: the closed result shape,
 * or null when the value is not one. A malformed answer arrived *after* the
 * collector was called, so the caller treats null as an uncertain outcome —
 * never as "nothing happened".
 */
export function collectorOperationResult(value: unknown): ScheduledResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { status, runIds, failureCode } = record;
  if (status !== "completed" && status !== "failed") return null;
  if (!Array.isArray(runIds) || runIds.length > 100) return null;
  if (!runIds.every((id): id is string => typeof id === "string" && RUN_ID.test(id))) return null;
  if (failureCode !== null && (typeof failureCode !== "string" || !SAFE_CODE.test(failureCode)))
    return null;
  if ((status === "failed") !== (failureCode !== null)) return null;
  return { status, runIds: [...new Set(runIds)], failureCode };
}
