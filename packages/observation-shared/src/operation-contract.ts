// `GET /api/ops/v1/operations/{id}`: one accepted operations request as the
// operator reads it (docs/ops-api.md, ADR 0048). The record is the
// application's `OperationReceipt` (`packages/application/src/operations/
// requests.ts`) with its collector execution and per-run trail
// (`collector-trail.ts`). Every field is a closed code, a bounded identifier,
// a count or a canonical instant: there is no amount, provider text, bucket
// key or URL, and the validator rejects any key it does not name, so a new
// field is a reviewed contract change rather than a silent widening.
//
// The shared package may not import the application layer, so the
// vocabularies are restated here; `packages/application/test/
// operation-record-contract.test.ts` pins them to the application's own.
import { hasExactKeys, isOneOf, isRecord, isSafeInt, type Guard } from "../../domain/src/guards.ts";
import { validInstantText } from "../../domain/src/time.ts";

export const OPERATION_RECORD_PATH_PREFIX = "/api/ops/v1/operations/";
const OPERATION_RECORD_SCHEMA = "kogane-operation-v1";
/** The id the route accepts (`operationIdSchema` in `services/app/src/ops-api.ts`). */
export const OPERATION_ID = /^op_[0-9a-f]{64}$/u;

export const OPERATION_RECORD_KINDS = [
  "collection",
  "import",
  "replay",
  "projection",
  "session-refresh",
] as const;
export const OPERATION_RECORD_STATUSES = [
  "accepted",
  "waiting_for_human",
  "running",
  "completed",
  "failed",
  "blocked",
] as const;
export const OPERATION_RECORD_DISPATCH_STATES = [
  "not_required",
  "dispatch_pending",
  "dispatched",
  "dispatch_failed",
] as const;
/** contracts/stages.json, in order. */
export const OPERATION_RECORD_STAGES = [
  "persisted",
  "registered",
  "parsed",
  "adopted",
  "projected",
] as const;
export const OPERATION_RECORD_STAGE_STATES = [
  "pending",
  "completed",
  "retryable",
  "blocked",
] as const;
/** Which stages a kind reports, in order (`STAGES_BY_KIND`). */
export const OPERATION_RECORD_STAGES_BY_KIND: Readonly<
  Record<OperationRecordKind, readonly OperationRecordStage[]>
> = {
  collection: ["persisted", "registered", "parsed", "adopted", "projected"],
  import: ["registered", "parsed", "adopted", "projected"],
  replay: ["parsed", "adopted", "projected"],
  projection: ["projected"],
  "session-refresh": [],
};
export const OPERATION_RECORD_COLLECTOR_ACTIONS = ["collect", "refresh-session"] as const;
export const OPERATION_RECORD_EXECUTION_STATES = [
  "accepted",
  "waiting_for_human",
  "waiting",
  "started",
  "collected",
  "refreshed",
  "published",
  "unpublished",
  "failed",
  "uncertain",
  "expired",
  "unsupported",
] as const;
export const OPERATION_RECORD_RUN_STATES = [
  "not_registered",
  "registering",
  "blocked",
  "parsing",
  "published",
  "unpublished",
] as const;
/** `collection_runs.provider_outcome` (CORE 0039 CHECK). */
const OPERATION_RECORD_PROVIDER_OUTCOMES = ["success", "partial", "failed"] as const;
/** The trail reads at most this many reported runs (ADR 0048, cost). */
const OPERATION_RECORD_MAX_RUNS = 100;

export type OperationRecordKind = (typeof OPERATION_RECORD_KINDS)[number];
type OperationRecordStatus = (typeof OPERATION_RECORD_STATUSES)[number];
export type OperationRecordStage = (typeof OPERATION_RECORD_STAGES)[number];
type OperationRecordStageState = (typeof OPERATION_RECORD_STAGE_STATES)[number];
type OperationRecordExecutionState = (typeof OPERATION_RECORD_EXECUTION_STATES)[number];
type OperationRecordRunState = (typeof OPERATION_RECORD_RUN_STATES)[number];

interface OperationRecordStageWire {
  stage: OperationRecordStage;
  state: OperationRecordStageState;
  evidenceRef: string | null;
  failureCode: string | null;
  attempts: number;
  updatedAt: string | null;
}
interface OperationRecordRunArtifacts {
  total: number;
  parseSelected: number;
  published: number;
  pending: number;
  parseFailed: number;
  notPublished: number;
}
export interface OperationRecordRunWire {
  runId: string;
  state: OperationRecordRunState;
  reasonCode: string | null;
  blockedCode: string | null;
  providerOutcome: (typeof OPERATION_RECORD_PROVIDER_OUTCOMES)[number] | null;
  evidenceRunId: string | null;
  registeredAt: string | null;
  artifacts: OperationRecordRunArtifacts | null;
}
export interface OperationRecordExecutionWire {
  action: (typeof OPERATION_RECORD_COLLECTOR_ACTIONS)[number];
  state: OperationRecordExecutionState;
  connectionId: string | null;
  reasonCode: string | null;
  scope: "collector_default" | null;
  waits: number;
  expiresAt: string | null;
  startedAt: string | null;
  collectedAt: string | null;
  publishedAt: string | null;
  finishedAt: string | null;
  runs: OperationRecordRunWire[];
}
export interface OperationRecordWire {
  schemaVersion: typeof OPERATION_RECORD_SCHEMA;
  operationId: string;
  kind: OperationRecordKind;
  status: OperationRecordStatus;
  source: string | null;
  targetRef: string | null;
  dispatch: { state: (typeof OPERATION_RECORD_DISPATCH_STATES)[number]; attempts: number };
  stages: OperationRecordStageWire[];
  failureCode: string | null;
  acceptedAt: string;
  updatedAt: string;
  execution: OperationRecordExecutionWire | null;
}

/** A stored closed code: the 0039 `blocked_code` rule, which every other code here also meets. */
const CODE = /^[a-z0-9_]{1,64}$/u;
const SOURCE_ID = /^[a-z0-9-]{1,100}$/u;
/** A terminal's run id (`RUN_ID` in the ops API). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** A bound target, a connection or a stage's evidence: an identifier, never a URL. */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
/** The evidence browser's fetch-run id. */
export const EVIDENCE_RUN_ID = /^r_[1-9][0-9]{0,15}$/u;

const matches =
  (pattern: RegExp): Guard<string> =>
  (value): value is string =>
    typeof value === "string" && pattern.test(value);
const orNull =
  <T>(guard: Guard<T>): Guard<T | null> =>
  (value): value is T | null =>
    value === null || guard(value);
const code = orNull(matches(CODE));
/** `run:12`, `runs:2`, `plan:…`, `collector:<job>`: never a URL (no `//`). */
const reference = orNull(
  (value): value is string =>
    typeof value === "string" && REFERENCE.test(value) && !value.includes("//"),
);
const instant = orNull(validInstantText);
const count = (value: unknown): value is number => isSafeInt(value, 0);

function validStage(value: unknown, expected: OperationRecordStage): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "stage",
      "state",
      "evidenceRef",
      "failureCode",
      "attempts",
      "updatedAt",
    ]) &&
    value.stage === expected &&
    isOneOf(OPERATION_RECORD_STAGE_STATES)(value.state) &&
    reference(value.evidenceRef) &&
    code(value.failureCode) &&
    count(value.attempts) &&
    instant(value.updatedAt)
  );
}

function validArtifacts(value: unknown): value is OperationRecordRunArtifacts {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "total",
      "parseSelected",
      "published",
      "pending",
      "parseFailed",
      "notPublished",
    ])
  )
    return false;
  const { total, parseSelected, published, pending, parseFailed, notPublished } = value;
  return (
    count(total) &&
    count(parseSelected) &&
    count(published) &&
    count(pending) &&
    count(parseFailed) &&
    count(notPublished) &&
    // The trail's own arithmetic: every selected artifact is published,
    // pending or not published, and a failed parse is one of the last.
    parseSelected <= total &&
    published + pending + notPublished === parseSelected &&
    parseFailed <= notPublished
  );
}

function validRun(value: unknown): value is OperationRecordRunWire {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "runId",
      "state",
      "reasonCode",
      "blockedCode",
      "providerOutcome",
      "evidenceRunId",
      "registeredAt",
      "artifacts",
    ]) ||
    !matches(RUN_ID)(value.runId) ||
    !isOneOf(OPERATION_RECORD_RUN_STATES)(value.state) ||
    !code(value.reasonCode) ||
    !code(value.blockedCode) ||
    !orNull(isOneOf(OPERATION_RECORD_PROVIDER_OUTCOMES))(value.providerOutcome) ||
    !orNull(matches(EVIDENCE_RUN_ID))(value.evidenceRunId) ||
    !instant(value.registeredAt) ||
    !(value.artifacts === null || validArtifacts(value.artifacts))
  )
    return false;
  // CORE 0039: a run is registered exactly when it has its fetch run.
  if ((value.evidenceRunId === null) !== (value.registeredAt === null)) return false;
  const registered = value.evidenceRunId !== null;
  const artifacts = value.artifacts as OperationRecordRunArtifacts | null;
  const state = value.state as OperationRecordRunState;
  switch (state) {
    case "not_registered":
    case "registering":
      return !registered && artifacts === null && value.blockedCode === null;
    case "blocked":
      return !registered && artifacts === null && value.blockedCode !== null;
    case "parsing":
      return registered && artifacts !== null && value.reasonCode === null;
    case "published":
      return (
        registered && artifacts !== null && artifacts.published > 0 && value.reasonCode === null
      );
    case "unpublished":
      return registered && artifacts !== null && value.reasonCode !== null;
  }
}

function validExecution(value: unknown, kind: OperationRecordKind): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "action",
      "state",
      "connectionId",
      "reasonCode",
      "scope",
      "waits",
      "expiresAt",
      "startedAt",
      "collectedAt",
      "publishedAt",
      "finishedAt",
      "runs",
    ])
  )
    return false;
  const action = kind === "collection" ? "collect" : "refresh-session";
  return (
    value.action === action &&
    // A collection runs its connection's daily scope; a refresh has none.
    value.scope === (action === "collect" ? "collector_default" : null) &&
    isOneOf(OPERATION_RECORD_EXECUTION_STATES)(value.state) &&
    reference(value.connectionId) &&
    code(value.reasonCode) &&
    count(value.waits) &&
    instant(value.expiresAt) &&
    instant(value.startedAt) &&
    instant(value.collectedAt) &&
    instant(value.publishedAt) &&
    instant(value.finishedAt) &&
    Array.isArray(value.runs) &&
    value.runs.length <= OPERATION_RECORD_MAX_RUNS &&
    value.runs.every(validRun)
  );
}

/**
 * Whether `value` is an operation record, and — when the reader asked for one
 * by id — the record of that id.
 */
export function validOperationRecord(
  value: unknown,
  operationId?: string,
): value is OperationRecordWire {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "operationId",
      "kind",
      "status",
      "source",
      "targetRef",
      "dispatch",
      "stages",
      "failureCode",
      "acceptedAt",
      "updatedAt",
      "execution",
    ]) ||
    value.schemaVersion !== OPERATION_RECORD_SCHEMA ||
    !matches(OPERATION_ID)(value.operationId) ||
    (operationId !== undefined && value.operationId !== operationId) ||
    !isOneOf(OPERATION_RECORD_KINDS)(value.kind) ||
    !isOneOf(OPERATION_RECORD_STATUSES)(value.status) ||
    !orNull(matches(SOURCE_ID))(value.source) ||
    !reference(value.targetRef) ||
    !code(value.failureCode) ||
    !validInstantText(value.acceptedAt) ||
    !validInstantText(value.updatedAt)
  )
    return false;
  const dispatch = value.dispatch;
  if (
    !isRecord(dispatch) ||
    !hasExactKeys(dispatch, ["state", "attempts"]) ||
    !isOneOf(OPERATION_RECORD_DISPATCH_STATES)(dispatch.state) ||
    !count(dispatch.attempts)
  )
    return false;
  // Every stage the kind can reach, in order; never one it cannot.
  const expected = OPERATION_RECORD_STAGES_BY_KIND[value.kind];
  if (
    !Array.isArray(value.stages) ||
    value.stages.length !== expected.length ||
    !value.stages.every((stage, index) => validStage(stage, expected[index]!))
  )
    return false;
  // Only a collector executes a collection or a session refresh.
  const executed = value.kind === "collection" || value.kind === "session-refresh";
  return executed ? validExecution(value.execution, value.kind) : value.execution === null;
}

/** The operation id a record path names, or null for any other path. */
export function operationIdOfPath(path: string): string | null {
  if (!path.startsWith(OPERATION_RECORD_PATH_PREFIX)) return null;
  const id = path.slice(OPERATION_RECORD_PATH_PREFIX.length);
  return OPERATION_ID.test(id) ? id : null;
}
