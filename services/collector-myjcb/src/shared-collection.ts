// MyJCB → the shared DATA bucket (unified plan 03, U09).
//
// The collector already redacts every statement page it keeps
// (`redactedStatementHtml`): scripts, styles, textareas, link and form targets
// and every `value=` attribute are gone and card numbers in text are replaced
// before anything is written. Those are the bytes the central path stores, so
// shared mode stores exactly them — and re-checks the redaction invariants the
// central path enforces before a byte goes into the shared bucket, because a
// collector regression must fail the run rather than publish a session token
// or a card number (G3-08).
//
// The collector manifest records a stopped connection as a closed stop code, a
// month position and a count of the months it kept (ADR 0005's amendment), so
// the free text of an upstream error never reaches the shared bucket either.
import { assertRedactedHtml } from "./redaction";
import {
  CONNECTION_STOP_CODES,
  SCHEDULE_PAGE_CODES,
  UNREAD_MONTH_CODES,
  type CollectionFailure,
  type CollectionManifest,
  type ConnectionStopCode,
  type ConnectionSummary,
  type ExportOffer,
  type RawArtifact,
  type SchedulePage,
  type StoredArtifact,
  type UnreadMonth,
} from "./types";
import {
  objectKey,
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalReport,
  type TerminalTransformation,
  type TerminalUnit,
} from "../../../packages/collection/src/index";

export const SOURCE = "myjcb";
/** `collector-<collector id>`: the producer the Processor's route for this source names (ADR 0014). */
export const PRODUCER = "collector-myjcb";
/**
 * What derives a ledger or the discovery record from provider pages: this
 * collector, named by its collector id (ADR 0021).
 */
const TRANSFORMER_ID = PRODUCER;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
/**
 * Datasets the central path has never accepted: the importer refuses a run
 * that names one (`manifest_dataset_unobserved`) because no validator for
 * their bytes exists yet. Shared mode refuses them the same way rather than
 * storing centrally what the legacy path never let through.
 */
const UNOBSERVED_DATASETS = new Set([
  "debit-menu",
  "debit-detail",
  "credit-csv",
  "credit-pdf",
  "credit-ofx",
]);

/** One connection's finished collection, as the worker saw it. */
export interface SharedConnectionRun {
  readonly summary: ConnectionSummary;
  readonly artifacts: readonly RawArtifact[];
}

export interface SharedRunInput {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: CollectionManifest["status"];
  readonly trigger: CollectionManifest["trigger"];
  readonly connections: readonly SharedConnectionRun[];
  readonly failures: readonly CollectionFailure[];
  /**
   * Set when an operation requested this run (unified plan 02 §5). U08
   * dispatches collection operations; the cron and the admin trigger leave
   * both undefined.
   */
  readonly operationId?: string;
  readonly attemptId?: string;
  /** Shared by the per-source runs of one multi-source session (03 §3). */
  readonly acquisitionSessionRef?: string;
}

export interface SharedRunOutcome {
  readonly result: PersistRunResult;
  readonly artifactCount: number;
}

/**
 * The Workers `R2Bucket` provides everything `R2BucketLike` names; the two
 * declarations differ only in how the optional `onlyIf` put option is written
 * under `exactOptionalPropertyTypes`, so the binding is narrowed here once
 * rather than at every call site.
 */
export function sharedBucket(binding: R2Bucket): R2BucketLike {
  return binding as unknown as R2BucketLike;
}

/**
 * The artifact role vocabulary the central contract already uses for MyJCB,
 * so a terminal registers the same way the importer registered the same
 * bytes.
 */
export function artifactRole(artifact: RawArtifact): string {
  if (artifact.mediaType.startsWith("text/html")) return "sanitized_provider_capture";
  if (artifact.dataset === "credit-past-months") return "provider_response";
  if (
    artifact.dataset === "credit-csv" ||
    artifact.dataset === "credit-pdf" ||
    artifact.dataset === "credit-ofx"
  ) {
    return "provider_export";
  }
  return "collector_derived";
}

function bodyBytes(body: string | ArrayBuffer): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * A connection's coverage of what the run set out to collect (ADR 0026). A
 * `success` connection enumerated its credit months from the menu and the
 * past-months response and kept every one of them: the page and the ledger
 * the collector derives from a page that states its state. Export links are
 * recorded as offers and not fetched (ADR 0005's second amendment).
 * `collectConnection` reports `partial` when a month is kept unread: its page
 * shows rows but no stated state, or rows under the observed third ledger
 * header (the rows were kept as HTML only), and when
 * a month's fetch, state, period, ledger or export failed: the connection
 * stopped there and kept the months before it (ADR 0005's amendment). Either
 * unit stays `partial`. A connection that stopped before its first credit
 * month keeps nothing and is `unknown`.
 *
 * The months are the menu positions under 「最新のご利用明細」 and 「過去の明細」
 * and the past-months response's; the positions under
 * 「ボーナス#回払い・ショッピングスキップ払い」 are payment schedule pages, stored
 * as `credit-schedule-NN.html` and never part of the coverage, whether they
 * show rows or failed to fetch (ADR 0005's amendment (c)).
 */
function coverage(status: ConnectionSummary["status"]): CoverageStatus {
  if (status === "success") return "complete";
  return status === "partial" ? "partial" : "unknown";
}

/**
 * The run's coverage is a claim about the cards' history, not about the
 * snapshot the run requested: a card exposes a rolling set of statement
 * periods, so even a fully successful run is `partial` here. Registration
 * records it on the run and derives no outcome from it (ADR 0026).
 */
function runCoverage(status: CollectionManifest["status"]): CoverageStatus {
  return status === "failed" ? "unknown" : "partial";
}

/** A blocked connection is a state to report, never a reason to retry a login
 * (source policy, G3-10/G3-11). A stopped connection's unit carries the stage
 * it stopped at. One that ran to the end but kept months unread carries
 * `scheduled_payments_page` when every unread month is under the observed third
 * ledger header (ADR 0005's second amendment), and `collector_partial`
 * otherwise, as before. */
export function connectionErrorCode(summary: ConnectionSummary): string | undefined {
  if (summary.status === "success") return undefined;
  if (summary.stopCode !== undefined) return stopCode(summary.stopCode);
  if (summary.status === "human-required") return "human_required";
  if (summary.status !== "partial") return "collector_failed";
  const unread = new Set((summary.unreadMonths ?? []).map((month) => month.code));
  return unread.size === 1 && unread.has("scheduled_payments_page")
    ? "scheduled_payments_page"
    : "collector_partial";
}

function runErrorCode(input: SharedRunInput): string | undefined {
  if (input.status === "success") return undefined;
  // When every connection that is not whole says the same thing (all wait for
  // a person, or all stopped at the same stage), the run carries that code;
  // otherwise the coarse one, and each unit keeps its own.
  const codes = new Set(
    input.connections
      .filter((connection) => connection.summary.status !== "success")
      .map((connection) => connectionErrorCode(connection.summary)),
  );
  const [only] = codes;
  if (
    codes.size === 1 &&
    only !== undefined &&
    (STOP_CODES.has(only) || only === "scheduled_payments_page")
  )
    return only;
  return input.status === "partial" ? "collector_partial" : "collector_failed";
}

function identifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

const STOP_CODES: ReadonlySet<string> = new Set(CONNECTION_STOP_CODES);

/** A stop code from the closed list, or a refused plan. */
function stopCode(value: string): ConnectionStopCode {
  if (!STOP_CODES.has(value)) throw new Error("manifest_stop_code_invalid");
  return value as ConnectionStopCode;
}

/** A month position (`detailMonth`), or a refused plan. */
function position(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 17) {
    throw new Error("manifest_stop_position_invalid");
  }
  return value;
}

const UNREAD_CODES: ReadonlySet<string> = new Set(UNREAD_MONTH_CODES);
const SCHEDULE_CODES: ReadonlySet<string> = new Set(SCHEDULE_PAGE_CODES);
const EXPORT_KINDS: ReadonlySet<string> = new Set(["csv", "pdf", "ofx"]);

/** Each unread month as a position and a code from `UNREAD_MONTH_CODES`, or a refused plan. */
function unreadMonths(months: readonly UnreadMonth[]): UnreadMonth[] {
  return months.map((month) => {
    if (!UNREAD_CODES.has(month.code)) throw new Error("manifest_unread_code_invalid");
    return { position: position(month.position), code: month.code };
  });
}

/** Each schedule page as a position and a code from `SCHEDULE_PAGE_CODES`, or a refused plan. */
function schedulePages(pages: readonly SchedulePage[]): SchedulePage[] {
  return pages.map((page) => {
    if (!SCHEDULE_CODES.has(page.code)) throw new Error("manifest_schedule_code_invalid");
    return { position: position(page.position), code: page.code };
  });
}

/**
 * The count of stored schedule pages: it must be the number of entries coded
 * `scheduled_payments_page`, or the plan is refused.
 */
function schedulePageCount(pages: readonly SchedulePage[], count: number | undefined): number {
  const stored = pages.filter((page) => page.code === "scheduled_payments_page").length;
  if (count !== stored) throw new Error("manifest_schedule_count_invalid");
  return stored;
}

/** Each export offer as a position and closed kinds, or a refused plan. */
function exportOffers(offers: readonly ExportOffer[]): ExportOffer[] {
  return offers.map((offer) => {
    if (offer.kinds.length === 0 || offer.kinds.some((kind) => !EXPORT_KINDS.has(kind)))
      throw new Error("manifest_export_kind_invalid");
    return { position: position(offer.position), kinds: [...new Set(offer.kinds)] };
  });
}

/**
 * The collector manifest the shared bucket stores. Each connection and each
 * failure is rebuilt field by field from closed values: a status, counts, a
 * stop code from `CONNECTION_STOP_CODES` and a month position. No error
 * message, provider text or amount has a field to travel in, and a code
 * outside the list refuses the plan. Each artifact names the
 * content-addressed object that was written.
 */
function manifestBytes(
  input: SharedRunInput,
  connections: readonly ConnectionSummary[],
  stored: readonly StoredArtifact[],
): Uint8Array {
  const manifest: CollectionManifest = {
    schemaVersion: input.schemaVersion,
    source: "myjcb",
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    trigger: input.trigger,
    connections: connections.map((connection) => ({
      connectionId: connection.connectionId,
      bootstrapMode: connection.bootstrapMode,
      status: connection.status,
      cardCount: connection.cardCount,
      periodCount: connection.periodCount,
      artifactCount: connection.artifactCount,
      ...(connection.stopCode === undefined
        ? {}
        : {
            stopCode: stopCode(connection.stopCode),
            ...(connection.stopPosition === undefined
              ? {}
              : { stopPosition: position(connection.stopPosition) }),
            capturedMonthCount: connection.capturedMonthCount ?? 0,
          }),
      ...(connection.unreadMonths === undefined || connection.unreadMonths.length === 0
        ? {}
        : { unreadMonths: unreadMonths(connection.unreadMonths) }),
      ...(connection.exportOffers === undefined || connection.exportOffers.length === 0
        ? {}
        : { exportOffers: exportOffers(connection.exportOffers) }),
      ...(connection.schedulePages === undefined || connection.schedulePages.length === 0
        ? {}
        : {
            schedulePages: schedulePages(connection.schedulePages),
            schedulePageCount: schedulePageCount(
              connection.schedulePages,
              connection.schedulePageCount,
            ),
          }),
    })),
    artifacts: stored,
    failures: input.failures.map((failure) => ({
      connectionId: failure.connectionId,
      operation: "collect",
      code: stopCode(failure.code),
      ...(failure.position === undefined ? {} : { position: position(failure.position) }),
    })),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** Build the persist plan for a finished run. Pure apart from hashing. */
export async function myJcbRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const outcome: ProviderOutcome = input.status;
  const errorCode = runErrorCode(input);
  // A failed run keeps no artifact: there is nothing whose persistence could
  // be claimed, and the terminal states the failure on its own (G1-09). Its
  // connections stay units with no artifact, so each one's stop code is in
  // the terminal (ADR 0005's amendment).
  const failed = outcome === "failed";

  const artifacts: PersistArtifact[] = [];
  const stored: StoredArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  const units: TerminalUnit[] = [];
  for (const connection of input.connections) {
    const unitKey = connection.summary.connectionId;
    const kept = failed ? [] : connection.artifacts;
    for (const artifact of kept) {
      if (UNOBSERVED_DATASETS.has(artifact.dataset)) {
        throw new Error("artifact_dataset_unobserved");
      }
      const bytes = bodyBytes(artifact.body);
      const role = artifactRole(artifact);
      if (role === "sanitized_provider_capture") {
        // The redaction the collector applied is re-checked here, against the
        // same invariants the central path enforces, before the bytes leave
        // the Worker.
        assertRedactedHtml(new TextDecoder().decode(bytes));
      }
      const sha256 = await sha256Hex(bytes);
      const artifactKey = `${unitKey}/${artifact.filename}`;
      artifacts.push({
        artifactKey,
        sha256,
        byteSize: bytes.byteLength,
        mediaType: artifact.mediaType.split(";", 1)[0]!.trim(),
        role,
        unitKey,
        body: { kind: "bytes", bytes },
      });
      stored.push({
        dataset: artifact.dataset,
        key: objectKey(sha256),
        mediaType: artifact.mediaType,
        sha256,
        bytes: bytes.byteLength,
        ...(artifact.statementState ? { statementState: artifact.statementState } : {}),
        ...(artifact.period ? { period: artifact.period } : {}),
      });
      if (role === "sanitized_provider_capture") {
        transformations.push({
          transformationId: `redacted:${artifactKey.replaceAll("/", ":")}`,
          stepKind: "redacted",
          transformerId: "myjcb-sanitizer",
          transformerVersion: "v1",
          // The provider HTML was deliberately not retained.
          inputArtifactKeys: [],
          outputArtifactKey: artifactKey,
        });
      }
      if (role === "collector_derived") {
        // What a derived artifact was derived from (ADR 0021). A
        // `credit-ledger-NN.json` is parsed from the statement page before
        // redaction, and `discovery.json` from the login and mypage
        // responses; none of those bytes is kept. The redacted capture of the
        // statement page is not the ledger's input (the sanitizer rewrites
        // text as well as attributes), so naming it would invent a parent:
        // the step names no input and registers as
        // `source_bytes_not_available`.
        transformations.push({
          transformationId: `extracted:${artifactKey.replaceAll("/", ":")}`,
          stepKind: "extracted",
          transformerId: TRANSFORMER_ID,
          transformerVersion: input.schemaVersion,
          inputArtifactKeys: [],
          outputArtifactKey: artifactKey,
        });
      }
    }
    const connectionCode = connectionErrorCode(connection.summary);
    units.push({
      unitKey,
      unitKind: "connection",
      artifactCount: kept.length,
      coverageStatus: failed ? "unknown" : coverage(connection.summary.status),
      ...(connectionCode === undefined ? {} : { safeErrorCode: connectionCode }),
    });
  }

  const summaries = input.connections.map((connection) => connection.summary);
  if (artifacts.length > 0) {
    const bytes = manifestBytes(input, summaries, stored);
    artifacts.push({
      artifactKey: "manifest.json",
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: "application/json",
      role: "collector_manifest",
      body: { kind: "bytes", bytes },
    });
  }

  const reports: TerminalReport[] = [
    {
      reportRef: "terminal",
      reportKind: "terminal",
      scope: "run",
      outcome,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
    },
  ];
  const operationId = identifier(input.operationId, "shared_operation_id_invalid");
  const sessionRef = identifier(input.acquisitionSessionRef, "shared_session_ref_invalid");
  return {
    run: {
      source: SOURCE,
      producer: PRODUCER,
      producerVersion: input.schemaVersion,
      runId: input.runId,
      attemptId: identifier(input.attemptId, "shared_attempt_id_invalid") ?? input.runId,
      ...(operationId === undefined ? {} : { operationId }),
      ...(sessionRef === undefined ? {} : { acquisitionSessionRef: sessionRef }),
      // A run takes whatever statement periods the card currently exposes, so
      // it is a snapshot of the connections, not a requested window.
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: units.map((unit) => unit.unitKey),
      },
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      providerOutcome: outcome,
      coverageStatus: runCoverage(input.status),
      persistenceComplete: true,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
      // Each unit states its own coverage unchanged. A whole connection is
      // `complete`, which registration turns into the unit outcome `success`
      // that the Processor's eligibility rules read (ADR 0026).
      units,
      // The statement periods are provider labels, not machine ranges; they
      // stay in the collector manifest rather than becoming terminal ranges.
      ranges: [],
      reports,
      transformations,
    },
    artifacts,
  };
}

/**
 * Persist a finished run into the shared bucket. The terminal is written last
 * by the helper; a failed put returns `incomplete` with a checkpoint and no
 * terminal, which the caller must not report as a completed run (G1-01).
 */
export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<SharedRunOutcome> {
  const plan = await myJcbRunPlan(input);
  const result = await persistRun(bucket, plan);
  return { result, artifactCount: plan.artifacts.length };
}

/** Safe, code-only diagnostics for a persist attempt: no provider text, no
 * amounts, no bodies. */
export function sharedRunDiagnostic(
  input: SharedRunInput,
  outcome: SharedRunOutcome,
): Record<string, unknown> {
  const result = outcome.result;
  return {
    event: "myjcb-shared-collection",
    runId: input.runId,
    status: input.status,
    persistence: result.outcome,
    connectionCount: input.connections.length,
    artifactCount: outcome.artifactCount,
    ...(result.outcome === "incomplete"
      ? {
          reasonCode: result.reasonCode,
          persistedCount: result.checkpoint.persistedArtifactKeys.length,
          pendingCount: result.checkpoint.pendingArtifactKeys.length,
        }
      : {}),
    ...(result.outcome === "conflict" ? { reasonCode: result.reasonCode } : {}),
  };
}
