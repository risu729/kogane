// The operations application services (unified plan 02 §4-5, U06).
//
// Six operator intents — collect, re-register, replay, rebuild, refresh a
// session, read an operation — as one service each. The HTTP routes of
// `/api/ops/v1` and the MCP tools of the same names are adapters over these
// functions, so neither transport can hold a rule the other does not (G3-05).
//
// Four rules hold in every function below.
//
// 1. The actor is the caller's verified principal. Nothing here reads an actor
//    from a payload, and every read is filtered by the principal that accepted
//    the request.
// 2. A request names a *declared* source, a registered parser release or a
//    bounded run identifier — never a table, a bucket key, a URL or SQL
//    (G3-13). The registry is asked; free text is not trusted.
// 3. Acceptance is durable before the caller is told anything: the operation
//    row, and any plan it creates, are one guarded batch. Re-sending the same
//    idempotency key addresses the same row and returns the same record rather
//    than starting a second run (G3-06, G3-14).
// 4. `accepted` is never `done`. Stage progress lives in `ops_request_stages`
//    in the vocabulary of contracts/stages.json, and a queued, building or
//    undispatched request never reports a completed stage.
//
// Pure: no Cloudflare `Env`, no database driver, no HTTP, no clock. The store
// is the same structural port the change lifecycle uses.
import {
  COLLECTION_STAGES,
  type CollectionStage,
  JOB_OUTCOMES,
  type JobOutcome,
  stageRecord,
} from "../../../collection/src/stages.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import type { CommandStore, PreparedWrite, Principal } from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";

export const OPERATION_KINDS = [
  "collection",
  "import",
  "replay",
  "projection",
  "session-refresh",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * contracts/stages.json, in order. A stage is evidence, not a progress bar.
 * One vocabulary, defined once in `packages/collection` (03 §5) and used here
 * so an operation and the run behind it cannot name the same stage
 * differently. Only that module is imported: it has no dependencies of its
 * own, so nothing of the R2 contract reaches this package.
 */
export const OPERATION_STAGES = COLLECTION_STAGES;
export type OperationStage = CollectionStage;

/**
 * Which stages a kind can reach. A re-registration starts from evidence that
 * is already persisted, a replay from evidence that is already registered, and
 * a rebuild only republishes READ, so reporting the earlier stages for them
 * would claim progress nobody made.
 */
export const STAGES_BY_KIND: Record<OperationKind, readonly OperationStage[]> = {
  collection: ["persisted", "registered", "parsed", "adopted", "projected"],
  import: ["registered", "parsed", "adopted", "projected"],
  replay: ["parsed", "adopted", "projected"],
  projection: ["projected"],
  // A session refresh produces no evidence of its own; its progress *is* its
  // status, which is why it has no stage row to complete.
  "session-refresh": [],
};

export const OPERATION_STATUSES = [
  "accepted",
  "waiting_for_human",
  "running",
  "completed",
  "failed",
  "blocked",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const DISPATCH_STATES = [
  "not_required",
  "dispatch_pending",
  "dispatched",
  "dispatch_failed",
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** contracts/stages.json `jobOutcome`, per stage. The same list. */
export const STAGE_STATES = JOB_OUTCOMES;
export type StageState = JobOutcome;

// ── request shapes ──────────────────────────────────────────────────────
//
// These are the *validated* inputs the adapters hand over. The wire schema
// that produces them is Zod in the App (`services/*/src/ops-api.ts`); both
// transports use that one schema, and this package stays dependency-free.

/** An optional caller-chosen key. Absent means "this exact payload, once". */
interface Keyed {
  idempotencyKey?: string | undefined;
}
export interface CollectionRequest extends Keyed {
  source: string;
  requestedScope: { from: string; to: string };
}
export interface ImportRequest extends Keyed {
  source: string;
  runId: string;
}
export interface ReplayRequest extends Keyed {
  scope: { source: string; from: string | null; to: string | null };
  parserRelease: string;
}
export interface ProjectionRequest extends Keyed {
  reason: string;
}
export interface SessionRefreshRequest extends Keyed {
  source: string;
}

export type OperationRequest =
  | CollectionRequest
  | ImportRequest
  | ReplayRequest
  | ProjectionRequest
  | SessionRefreshRequest;

// ── receipts ────────────────────────────────────────────────────────────

export interface OperationStageReport {
  stage: OperationStage;
  state: StageState;
  evidenceRef: string | null;
  failureCode: string | null;
  attempts: number;
  updatedAt: string | null;
}

/**
 * What both transports return. Identifiers, safe codes and timestamps only:
 * no amount, no credential, no provider text, no bucket key (G3-08).
 */
export interface OperationReceipt {
  schemaVersion: "kogane-operation-v1";
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  source: string | null;
  /** The work this request is bound to, once an executor has bound it. */
  targetRef: string | null;
  dispatch: { state: DispatchState; attempts: number };
  stages: OperationStageReport[];
  /** A safe code naming why the operation stopped, or null. */
  failureCode: string | null;
  acceptedAt: string;
  updatedAt: string;
}

export interface AcceptedOperation {
  receipt: OperationReceipt;
  /**
   * True when this key had already been accepted. The record is the same
   * either way; only the caller's own retry bookkeeping differs (G3-06).
   */
  replayed: boolean;
}

// ── policy ──────────────────────────────────────────────────────────────

export const SESSION_REFRESH_MODES = ["unattended", "human"] as const;
export type SessionRefreshMode = (typeof SESSION_REFRESH_MODES)[number];

/**
 * Per-source session policy (12 §3). A source is `human` unless the
 * deployment states otherwise, so an absent, empty or malformed configuration
 * asks a person rather than assuming a login can be repeated unattended. No
 * policy ever authorises retrying a password or working around MFA (G3-11).
 */
export function sessionRefreshPolicy(
  configured: string | undefined,
): (source: string) => SessionRefreshMode {
  const unattended = new Set<string>();
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        for (const [source, mode] of Object.entries(parsed as Record<string, unknown>))
          if (mode === "unattended") unattended.add(source);
    } catch {
      /* A malformed policy grants nothing; the safe direction is "ask a human". */
    }
  }
  return (source) => (unattended.has(source) ? "unattended" : "human");
}

// ── identity of a request ───────────────────────────────────────────────

/** What is stored and digested: the request without its idempotency key. */
function storedPayload(request: OperationRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...request };
  delete payload["idempotencyKey"];
  return payload;
}

/** `payload_digest`: the canonical digest of what was asked, without the key. */
export async function operationPayloadDigest(
  kind: OperationKind,
  request: OperationRequest,
): Promise<string> {
  return canonicalDigest({ kind, payload: storedPayload(request) });
}

/** `operation_id`: stable in (kind, principal, key), so a re-send lands here. */
export async function operationIdFor(
  kind: OperationKind,
  principal: string,
  idempotencyKey: string,
): Promise<string> {
  return `op_${await canonicalDigest({ kind, principal, idempotencyKey })}`;
}

// ── the stored row ──────────────────────────────────────────────────────

interface OpsRow {
  operation_id: string;
  kind: string;
  principal: string;
  idempotency_key: string;
  payload_digest: string;
  source_id: string | null;
  status: string;
  dispatch_state: string;
  dispatch_attempts: number;
  target_ref: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}
interface StageRow {
  stage: string;
  state: string;
  evidence_ref: string | null;
  failure_code: string | null;
  attempts: number;
  updated_at: string;
}

const ROW_COLUMNS = `operation_id,kind,principal,idempotency_key,payload_digest,source_id,status,
 dispatch_state,dispatch_attempts,target_ref,failure_code,created_at,updated_at`;
const SELECT_ROW = `SELECT ${ROW_COLUMNS} FROM ops_requests WHERE operation_id=?1 AND principal=?2`;
const SELECT_STAGES = `SELECT stage,state,evidence_ref,failure_code,attempts,updated_at
 FROM ops_request_stages WHERE operation_id=?1`;
const INSERT_REQUEST = `INSERT INTO ops_requests
 (operation_id,kind,principal,idempotency_key,payload_digest,source_id,request_json,status,
  dispatch_state,dispatch_attempts,available_at_ms,target_ref,failure_code,created_at,updated_at)
 SELECT ?1,?2,?3,?4,?5,?6,json(?7),?8,?9,0,0,NULL,NULL,?10,?10
 WHERE NOT EXISTS(SELECT 1 FROM ops_requests WHERE operation_id=?1)`;

function receiptOf(row: OpsRow, stages: readonly StageRow[]): OperationReceipt {
  const kind = row.kind as OperationKind;
  const recorded = new Map(stages.map((stage) => [stage.stage, stage]));
  return {
    schemaVersion: "kogane-operation-v1",
    operationId: row.operation_id,
    kind,
    status: row.status as OperationStatus,
    source: row.source_id,
    targetRef: row.target_ref,
    dispatch: {
      state: row.dispatch_state as DispatchState,
      attempts: row.dispatch_attempts,
    },
    // Every stage the kind can reach, in order. A stage nobody has reported is
    // `pending`: silence is never progress.
    stages: STAGES_BY_KIND[kind].map((stage) => {
      const recordedStage = recorded.get(stage);
      return {
        stage,
        state: (recordedStage?.state ?? "pending") as StageState,
        evidenceRef: recordedStage?.evidence_ref ?? null,
        failureCode: recordedStage?.failure_code ?? null,
        attempts: recordedStage?.attempts ?? 0,
        updatedAt: recordedStage?.updated_at ?? null,
      };
    }),
    failureCode: row.failure_code,
    acceptedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadReceipt(
  store: CommandStore,
  operationId: string,
  principal: string,
): Promise<OperationReceipt | null> {
  const row = await store.first<OpsRow>(SELECT_ROW, [operationId, principal]);
  if (!row) return null;
  return receiptOf(row, await store.all<StageRow>(SELECT_STAGES, [operationId]));
}

export interface OperationContext {
  store: CommandStore;
  /** The verified caller; `principal.id` is the only actor that is stored. */
  principal: Principal;
  /** ISO-8601 second precision, supplied by the adapter. */
  now: string;
}

interface AcceptInput extends OperationContext {
  kind: OperationKind;
  request: OperationRequest;
  sourceId: string | null;
  status: OperationStatus;
  dispatchState: DispatchState;
  /**
   * Statements appended to the acceptance batch, built from the operation id
   * this function derived. Each one is guarded on the request row existing, so
   * the whole acceptance is one all-or-nothing batch.
   */
  extraWrites?: (operationId: string) => readonly PreparedWrite[];
}

/**
 * The one write path. It stores the request, then reads the stored row back
 * and answers from *that*, so a first request and a re-send under the same key
 * return the same record even when the second request raced the first — and a
 * raced request whose payload differs from what the winner stored is refused
 * exactly as it would have been without the race.
 */
async function accept(input: AcceptInput): Promise<CommandResult<AcceptedOperation>> {
  const { store, principal, now, kind, request } = input;
  const payloadDigest = await operationPayloadDigest(kind, request);
  const idempotencyKey = request.idempotencyKey ?? payloadDigest;
  const operationId = await operationIdFor(kind, principal.id, idempotencyKey);
  const existing = await store.first<OpsRow>(SELECT_ROW, [operationId, principal.id]);
  // The same key with a different payload is a different request. Answering
  // with the first receipt would silently drop the second; running it would
  // break the key's promise. Both are refused, with the id and nothing else.
  if (existing && existing.payload_digest !== payloadDigest)
    return commandError("idempotency_conflict", [operationId]);
  let replayed = existing !== null;
  if (!existing) {
    const outcomes = await store.batch([
      {
        sql: INSERT_REQUEST,
        binds: [
          operationId,
          kind,
          principal.id,
          idempotencyKey,
          payloadDigest,
          input.sourceId,
          JSON.stringify(storedPayload(request)),
          input.status,
          input.dispatchState,
          now,
        ],
      },
      ...(input.extraWrites?.(operationId) ?? []),
    ]);
    // The insert is guarded on the row not existing, so a request that lost a
    // race to another sender of the same key inserts nothing — and *that*, not
    // the earlier read, is what says whether this call created the record.
    replayed = (outcomes[0]?.changes ?? 0) === 0;
  }
  const row = await store.first<OpsRow>(SELECT_ROW, [operationId, principal.id]);
  // The row is written and read in the same request; its absence is a store
  // failure, never a silent success.
  if (!row) return commandError("commit_failed", [operationId]);
  // What the winner of a race stored is checked the same way an earlier row
  // was: a different payload under this key is a conflict, never a quiet
  // answer with someone else's request.
  if (row.payload_digest !== payloadDigest)
    return commandError("idempotency_conflict", [operationId]);
  const receipt = receiptOf(row, await store.all<StageRow>(SELECT_STAGES, [operationId]));
  return { ok: true, receipt, replayed };
}

// ── source and release registries ───────────────────────────────────────

const DECLARED_SOURCE = `SELECT id FROM sources WHERE id=?1 AND active=1`;
const PARSER_RELEASE = `SELECT release_id FROM parser_releases WHERE release_id=?1`;

/**
 * A source exists for this API only if the registry declares it active. A
 * refusal names the *field* that held the unknown id, never the id itself:
 * the caller already has its own value, and a value never travels back in an
 * error, a log or a queue (G3-08).
 */
async function declaredSource(store: CommandStore, source: string): Promise<boolean> {
  return (await store.first<{ id: string }>(DECLARED_SOURCE, [source])) !== null;
}

// ── the six services ────────────────────────────────────────────────────

/**
 * `POST /api/ops/v1/collections`. 202 means the request is stored, never that
 * a provider was contacted: the collector runs later, through the dispatch the
 * Processor cron drains.
 */
export async function requestCollection(
  input: OperationContext & { request: CollectionRequest },
): Promise<CommandResult<AcceptedOperation>> {
  const { request } = input;
  if (!(await declaredSource(input.store, request.source)))
    return commandError("target_missing", ["source"]);
  return accept({
    ...input,
    kind: "collection",
    sourceId: request.source,
    status: "accepted",
    // Recorded, not sent. The Service Binding call to the collector is U09's;
    // until it exists (and after it fails) this row is what the Processor cron
    // re-dispatches, so a lost notification never loses the request (02 §5).
    dispatchState: "dispatch_pending",
  });
}

/**
 * `POST /api/ops/v1/imports`: re-register a terminal that is already
 * persisted. The Processor executes it (U08); this path validates, stores and
 * answers 202. `runId` is a bounded run identifier, never a bucket key.
 */
export async function requestImport(
  input: OperationContext & { request: ImportRequest },
): Promise<CommandResult<AcceptedOperation>> {
  const { request } = input;
  if (!(await declaredSource(input.store, request.source)))
    return commandError("target_missing", ["source"]);
  return accept({
    ...input,
    kind: "import",
    sourceId: request.source,
    status: "accepted",
    dispatchState: "dispatch_pending",
  });
}

const INSERT_REPLAY_PLAN = `INSERT INTO observation_replay_plans
 (created_at_ms,updated_at_ms,source_id,dataset,parser_name,parser_version,target_release,
  artifact_id_from,artifact_id_high_water,fetched_from,fetched_to,status,estimated_artifacts,
  already_parsed,creation_cursor,creation_complete,reason,operation_id)
 SELECT ?2,?2,?3,NULL,r.parser_name,r.semantic_version,?4,0,
  (SELECT coalesce(max(id),0) FROM fetch_artifacts),?5,?6,'planned',0,0,0,0,?7,?1
 FROM parser_releases r WHERE r.release_id=?4
  AND EXISTS(SELECT 1 FROM ops_requests o WHERE o.operation_id=?1)
  AND NOT EXISTS(SELECT 1 FROM observation_replay_plans p WHERE p.operation_id=?1)`;

/** The reason stored on a plan. Server-authored: no caller text reaches it. */
const REPLAY_REASON = "requested through the operations API";

/**
 * `POST /api/ops/v1/replays`: pin a scope and a registered parser release and
 * store a `planned` replay plan in the 0035 tables — the same tables the
 * Processor already drains, not a second copy of them. The plan's artifact
 * high-water is fixed by the insert, so evidence collected afterwards is not
 * silently pulled into this replay.
 */
export async function requestReplay(
  input: OperationContext & { request: ReplayRequest; nowMs: number },
): Promise<CommandResult<AcceptedOperation>> {
  const { request, store } = input;
  if (!(await declaredSource(store, request.scope.source)))
    return commandError("target_missing", ["scope.source"]);
  // A release is a registered transformation identity (0028), never free text:
  // an unknown release would leave jobs that no deployed parser can execute.
  const release = await store.first<{ release_id: string }>(PARSER_RELEASE, [
    request.parserRelease,
  ]);
  if (!release) return commandError("target_missing", ["parserRelease"]);
  return accept({
    ...input,
    kind: "replay",
    sourceId: request.scope.source,
    status: "accepted",
    dispatchState: "dispatch_pending",
    extraWrites: (operationId) => [
      {
        sql: INSERT_REPLAY_PLAN,
        binds: [
          operationId,
          input.nowMs,
          request.scope.source,
          request.parserRelease,
          request.scope.from,
          request.scope.to,
          REPLAY_REASON,
        ],
      },
    ],
  });
}

/**
 * `POST /api/ops/v1/projections`: ask for a READ rebuild. "Rebuild" means a
 * new snapshot from valid inputs; it is not an API that deletes a database
 * (02 §6). The reason is stored with the request so an operator can see why a
 * rebuild was asked for.
 */
export async function requestProjectionRebuild(
  input: OperationContext & { request: ProjectionRequest },
): Promise<CommandResult<AcceptedOperation>> {
  return accept({
    ...input,
    kind: "projection",
    sourceId: null,
    status: "accepted",
    dispatchState: "dispatch_pending",
  });
}

/**
 * `POST /api/ops/v1/sessions/{source}/refresh`: ask the party that owns the
 * source's credentials to renew its session. This path never holds, returns or
 * logs a credential, and it never retries a login: when the source policy says
 * a person is needed the operation is stored as `waiting_for_human` and the UI
 * shows that state (12 §3, G3-11).
 */
export async function requestSessionRefresh(
  input: OperationContext & {
    request: SessionRefreshRequest;
    policy: (source: string) => SessionRefreshMode;
  },
): Promise<CommandResult<AcceptedOperation>> {
  const { request } = input;
  if (!(await declaredSource(input.store, request.source)))
    return commandError("target_missing", ["source"]);
  const human = input.policy(request.source) === "human";
  return accept({
    ...input,
    kind: "session-refresh",
    sourceId: request.source,
    status: human ? "waiting_for_human" : "accepted",
    // Nothing to notify while a person is the next step.
    dispatchState: human ? "not_required" : "dispatch_pending",
  });
}

/**
 * `GET /api/ops/v1/operations/{id}`: the stored record of one accepted
 * request, scoped to the principal that accepted it. An operation belonging to
 * someone else answers exactly like one that does not exist.
 */
export async function readOperation(
  input: OperationContext & { operationId: string },
): Promise<CommandResult<{ receipt: OperationReceipt }>> {
  const receipt = await loadReceipt(input.store, input.operationId, input.principal.id);
  if (!receipt) return commandError("receipt_not_found", [input.operationId]);
  return { ok: true, receipt };
}

// ── executor hooks (U08, U09) ───────────────────────────────────────────
//
// The Processor and the collectors are the other side of this contract. They
// are named here so the executors call one service instead of writing their
// own SQL against these tables.

const PENDING_DISPATCH = `SELECT ${ROW_COLUMNS} FROM ops_requests
 WHERE dispatch_state='dispatch_pending' AND available_at_ms<=?1
 ORDER BY available_at_ms,operation_id LIMIT ?2`;

/**
 * The Processor cron's queue: accepted requests whose executor has not been
 * notified yet, oldest first. A request stays here until a dispatch succeeds,
 * which is why a lost notification is recoverable (02 §5).
 */
export async function pendingDispatches(input: {
  store: CommandStore;
  nowMs: number;
  limit: number;
}): Promise<OperationReceipt[]> {
  const rows = await input.store.all<OpsRow>(PENDING_DISPATCH, [input.nowMs, input.limit]);
  return rows.map((row) => receiptOf(row, []));
}

export interface DispatchResult {
  store: CommandStore;
  operationId: string;
  outcome: "dispatched" | "retry" | "failed";
  now: string;
  /** For a retry: when this row becomes available again. */
  retryAtMs?: number;
  /** A safe code; never a message, a value or an exception string. */
  failureCode?: string;
  /** The run, plan or registration the executor bound this request to. */
  targetRef?: string;
}

/** What one dispatch left behind. */
export interface DispatchRecord {
  /** The target the operation is bound to after this call, or null. */
  targetRef: string | null;
  /**
   * True when the target this call named is the one the row holds. False with
   * a non-null `targetRef` means another dispatch bound the operation first:
   * the executor must continue *that* run and never open a second provider
   * session for the same acceptance (G3-14).
   */
  boundHere: boolean;
}

/**
 * Records what happened to one dispatch. `dispatched` does not complete the
 * operation: completion is stage evidence, recorded by `recordOperationStage`.
 * `target_ref` is write-once — the update keeps the first value and the 0040
 * trigger refuses any re-pointing — so a second dispatch of the same operation
 * is told which run the first executor bound and must reuse it (G3-14).
 */
export async function recordDispatch(input: DispatchResult): Promise<DispatchRecord> {
  const state =
    input.outcome === "dispatched"
      ? "dispatched"
      : input.outcome === "retry"
        ? "dispatch_pending"
        : "dispatch_failed";
  await input.store.batch([
    {
      sql: `UPDATE ops_requests SET dispatch_state=?2,dispatch_attempts=dispatch_attempts+1,
        available_at_ms=?3,target_ref=coalesce(target_ref,?4),
        failure_code=CASE WHEN ?5 IS NULL THEN failure_code ELSE ?5 END,
        status=CASE WHEN ?2='dispatch_failed' THEN 'blocked' ELSE status END,updated_at=?6
        WHERE operation_id=?1 AND status NOT IN ('completed','failed','blocked')`,
      binds: [
        input.operationId,
        state,
        input.retryAtMs ?? 0,
        input.targetRef ?? null,
        input.failureCode ?? null,
        input.now,
      ],
    },
  ]);
  const row = await input.store.first<{ target_ref: string | null }>(
    "SELECT target_ref FROM ops_requests WHERE operation_id=?1",
    [input.operationId],
  );
  const targetRef = row?.target_ref ?? null;
  return { targetRef, boundHere: targetRef !== null && targetRef === input.targetRef };
}

export interface StageReport {
  store: CommandStore;
  operationId: string;
  stage: OperationStage;
  state: StageState;
  now: string;
  evidenceRef?: string;
  failureCode?: string;
}

/**
 * Records one stage of one operation. `completed` is only ever written by the
 * executor that holds the evidence of that stage; enqueuing work, a flag being
 * off or a missing processor are not completion (contracts/stages.json), and a
 * completed stage is never reopened (the 0040 trigger enforces it).
 */
export async function recordOperationStage(input: StageReport): Promise<void> {
  // The shared stage contract refuses `completed` for the four reasons that
  // are never completion (queued, building, flag_off, no_processor), so an
  // executor cannot record one of them as done through this path either.
  stageRecord(input.stage, input.state, input.failureCode);
  const row = await input.store.first<{ kind: string }>(
    "SELECT kind FROM ops_requests WHERE operation_id=?1",
    [input.operationId],
  );
  if (!row) return;
  const required = STAGES_BY_KIND[row.kind as OperationKind];
  await input.store.batch([
    {
      sql: `INSERT INTO ops_request_stages
        (operation_id,stage,state,evidence_ref,failure_code,attempts,updated_at)
        SELECT ?1,?2,?3,?4,?5,1,?6 FROM ops_requests o WHERE o.operation_id=?1
        ON CONFLICT(operation_id,stage) DO UPDATE SET state=excluded.state,
         evidence_ref=coalesce(excluded.evidence_ref,ops_request_stages.evidence_ref),
         failure_code=excluded.failure_code,attempts=ops_request_stages.attempts+1,
         updated_at=excluded.updated_at`,
      binds: [
        input.operationId,
        input.stage,
        input.state,
        input.evidenceRef ?? null,
        input.failureCode ?? null,
        input.now,
      ],
    },
    // An operation is complete when every stage its kind can reach is
    // complete — the request's own status never runs ahead of the evidence.
    // A kind with no stages of its own is never completed from here.
    ...(required.length === 0
      ? []
      : [
          {
            sql: `UPDATE ops_requests SET status='completed',updated_at=?2 WHERE operation_id=?1
        AND status NOT IN ('completed','failed','blocked')
        AND NOT EXISTS(SELECT 1 FROM json_each(?3) required
          WHERE NOT EXISTS(SELECT 1 FROM ops_request_stages s
            WHERE s.operation_id=?1 AND s.stage=required.value AND s.state='completed'))`,
            binds: [input.operationId, input.now, JSON.stringify(required)],
          },
        ]),
  ]);
}
