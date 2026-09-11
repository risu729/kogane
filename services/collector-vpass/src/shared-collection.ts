// Vpass → the shared DATA bucket (unified plan 03, U09).
//
// The legacy path stores the raw response envelopes in the per-source bucket
// and the importer sanitizes them on the way to central storage. A collector
// that writes the shared bucket directly has to sanitize first, so this module
// applies the same `vpass-json-sanitizer` v1 (`./sanitize`) and stores exactly
// the artifact set central storage holds today:
//
//   card-list.json          the card inventory, names and references replaced
//   select-card.json        the card selection response
//   web-meisai-top.json     the statement-month discovery response
//   months/<yyyymm>/<top|answer>-NNN.json   each statement page
//   manifest.json           the run summary, in its central shape
//
// No raw envelope, cookie, auth blob or card identify key is written: the
// sanitizer replaces them and refuses output that still carries one.
//
// One Vpass session visits several cards under one run timestamp. Each card is
// its own run (`<runId>-card-NNN`) and all of them carry the session timestamp
// as `acquisitionSessionRef`, so the cards stay distinguishable instead of
// collapsing into one run whose provenance is lost (G1-16) — the same mapping
// `VPASS_LEGACY_ADAPTER` uses for a legacy re-persist.
import {
  sanitizedEnvelopeBytes,
  encodeCanonical,
  VPASS_SANITIZER_ID,
  VPASS_SANITIZER_VERSION,
  type JsonValue,
} from "./sanitize";
import {
  persistRun,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type R2BucketLike,
  type TerminalRange,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";

const SOURCE = "vpass";
const PRODUCER = "vpass-json";
/** The schema version central storage records for a card-scoped Vpass run. */
export const VPASS_CARD_SCHEMA_VERSION = "vpass-worker-card-v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MONTH = /^\d{6}$/u;

export interface VpassPageCapture {
  readonly kind: "top" | "answer";
  readonly index: number;
  readonly rawJson: string;
}

export interface VpassMonthCapture {
  readonly pages: readonly VpassPageCapture[];
  readonly transactionCount: number;
}

/** What one finished card collection knows, before anything is stored. */
export interface VpassCardRun {
  /** The acquisition session's run id: one timestamp, several cards. */
  readonly sessionRunId: string;
  /** `card-NNN`, this card's unit inside the session. */
  readonly cardLabel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cardListRawJson: string;
  readonly selectCardRawJson: string;
  readonly webMeisaiTopRawJson: string;
  readonly months: Readonly<Record<string, VpassMonthCapture>>;
  /**
   * Set when an operation requested this run (unified plan 02 §5). U08
   * dispatches collection operations; the cron and the admin trigger leave
   * both undefined.
   */
  readonly operationId?: string;
  readonly attemptId?: string;
}

/** A card or session that ended without a stored artifact. */
export interface VpassFailedRun {
  readonly sessionRunId: string;
  /** `card-NNN`, or `run` when the session failed before a card was selected. */
  readonly unitKey: string;
  readonly startedAt: string;
  readonly failedAt: string;
  readonly operationId?: string;
  readonly attemptId?: string;
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function identifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

function pageArtifactKey(month: string, page: VpassPageCapture): string {
  return `months/${month}/${page.kind}-${String(page.index).padStart(3, "0")}.json`;
}

async function artifactOf(
  artifactKey: string,
  bytes: Uint8Array,
  role: string,
  unitKey: string,
): Promise<PersistArtifact> {
  return {
    artifactKey,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role,
    unitKey,
    body: { kind: "bytes", bytes },
  };
}

/** Every stored object is the sanitizer's output; the provider bytes that
 * carried the session were deliberately not retained. */
function redaction(artifactKey: string): TerminalTransformation {
  return {
    transformationId: `redacted:${artifactKey.replaceAll("/", ":")}`,
    stepKind: "redacted",
    transformerId: VPASS_SANITIZER_ID,
    transformerVersion: VPASS_SANITIZER_VERSION,
    inputArtifactKeys: [],
    outputArtifactKey: artifactKey,
  };
}

/** The run summary in the shape central storage records it. */
function manifestBytes(run: VpassCardRun, months: readonly string[]): Uint8Array {
  const summary: Record<string, JsonValue> = {};
  let pageCount = 0;
  let transactionCount = 0;
  for (const month of months) {
    const capture = run.months[month]!;
    summary[month] = { pages: capture.pages.length, transactions: capture.transactionCount };
    pageCount += capture.pages.length;
    transactionCount += capture.transactionCount;
  }
  return encodeCanonical({
    schemaVersion: VPASS_CARD_SCHEMA_VERSION,
    source: SOURCE,
    runId: run.sessionRunId,
    card: run.cardLabel,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status: "success",
    monthCount: months.length,
    pageCount,
    transactionCount,
    months: summary,
  });
}

/** Build the persist plan for one finished card. Pure apart from hashing. */
export async function vpassCardRunPlan(run: VpassCardRun): Promise<PersistRunPlan> {
  const months = Object.keys(run.months).sort();
  for (const month of months) {
    if (!MONTH.test(month)) throw new Error("vpass_month_invalid");
  }
  const unitKey = run.cardLabel;
  const artifacts: PersistArtifact[] = [
    await artifactOf(
      "card-list.json",
      sanitizedEnvelopeBytes(run.cardListRawJson, "card_list_json_invalid", true),
      "sanitized_provider_capture",
      unitKey,
    ),
    await artifactOf(
      "select-card.json",
      sanitizedEnvelopeBytes(run.selectCardRawJson, "card_selection_json_invalid"),
      "sanitized_provider_capture",
      unitKey,
    ),
    await artifactOf(
      "web-meisai-top.json",
      sanitizedEnvelopeBytes(run.webMeisaiTopRawJson, "month_discovery_json_invalid"),
      "sanitized_provider_capture",
      unitKey,
    ),
  ];
  for (const month of months) {
    for (const page of run.months[month]!.pages) {
      artifacts.push(
        await artifactOf(
          pageArtifactKey(month, page),
          sanitizedEnvelopeBytes(page.rawJson, "statement_page_json_invalid"),
          "provider_response",
          unitKey,
        ),
      );
    }
  }
  const transformations: TerminalTransformation[] = artifacts.map((artifact) =>
    redaction(artifact.artifactKey),
  );
  const summary = manifestBytes(run, months);
  artifacts.push(await artifactOf("manifest.json", summary, "collector_manifest", unitKey));

  // A card exposes a rolling window of statement months, so even a fully
  // successful run is not a claim about the card's whole history.
  const ranges: TerminalRange[] =
    months.length === 0
      ? []
      : [
          {
            rangeKey: "statement-months",
            rangeKind: "declared_coverage",
            precision: "month",
            basis: "manifest",
            startValue: `${months[0]!.slice(0, 4)}-${months[0]!.slice(4)}`,
            endValue: `${months.at(-1)!.slice(0, 4)}-${months.at(-1)!.slice(4)}`,
            unitKey,
          },
        ];
  const operationId = identifier(run.operationId, "shared_operation_id_invalid");
  return {
    run: {
      source: SOURCE,
      producer: PRODUCER,
      producerVersion: VPASS_CARD_SCHEMA_VERSION,
      runId: `${run.sessionRunId}-${unitKey}`,
      attemptId: identifier(run.attemptId, "shared_attempt_id_invalid") ?? run.sessionRunId,
      ...(operationId === undefined ? {} : { operationId }),
      acquisitionSessionRef: run.sessionRunId,
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: [unitKey],
      },
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      providerOutcome: "success",
      coverageStatus: "partial",
      persistenceComplete: true,
      units: [
        {
          unitKey,
          unitKind: "card",
          artifactCount: artifacts.length,
          coverageStatus: "partial",
        },
      ],
      ranges,
      reports: [
        { reportRef: "terminal", reportKind: "terminal", scope: "run", outcome: "success" },
      ],
      transformations,
    },
    artifacts,
  };
}

/**
 * The plan for a card or session that ended without an artifact. It persists
 * no object at all, so the failure cannot read downstream like an observation
 * of zero (G1-09), and it carries a machine code rather than the provider's
 * message.
 */
export function vpassFailedRunPlan(run: VpassFailedRun): PersistRunPlan {
  const operationId = identifier(run.operationId, "shared_operation_id_invalid");
  return {
    run: {
      source: SOURCE,
      producer: PRODUCER,
      producerVersion: VPASS_CARD_SCHEMA_VERSION,
      runId: `${run.sessionRunId}-${run.unitKey}`,
      attemptId: identifier(run.attemptId, "shared_attempt_id_invalid") ?? run.sessionRunId,
      ...(operationId === undefined ? {} : { operationId }),
      acquisitionSessionRef: run.sessionRunId,
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: [run.unitKey],
      },
      startedAt: run.startedAt,
      completedAt: run.failedAt,
      providerOutcome: "failed",
      coverageStatus: "unknown",
      persistenceComplete: true,
      safeErrorCode: "collector_failed",
      units: [
        {
          unitKey: run.unitKey,
          unitKind: run.unitKey === "run" ? "session" : "card",
          artifactCount: 0,
          coverageStatus: "unknown",
          safeErrorCode: "collector_failed",
        },
      ],
      ranges: [],
      reports: [
        {
          reportRef: "terminal",
          reportKind: "terminal",
          scope: "run",
          outcome: "failed",
          safeErrorCode: "collector_failed",
        },
      ],
      transformations: [],
    },
    artifacts: [],
  };
}

async function persist(bucket: R2BucketLike, plan: PersistRunPlan): Promise<SharedRunOutcome> {
  const result = await persistRun(bucket, plan);
  return { result, artifactCount: plan.artifacts.length };
}

/**
 * Persist one finished card into the shared bucket. The terminal is written
 * last by the helper; a failed put returns `incomplete` with a checkpoint and
 * no terminal, which the caller must not report as a completed run (G1-01).
 */
export async function persistCardRun(
  bucket: R2BucketLike,
  run: VpassCardRun,
): Promise<SharedRunOutcome> {
  return persist(bucket, await vpassCardRunPlan(run));
}

/** Persist the terminal of a card or session that collected nothing. */
export async function persistFailedRun(
  bucket: R2BucketLike,
  run: VpassFailedRun,
): Promise<SharedRunOutcome> {
  return persist(bucket, vpassFailedRunPlan(run));
}

export function sharedRunPersisted(outcome: SharedRunOutcome): boolean {
  return outcome.result.outcome === "persisted" || outcome.result.outcome === "already_persisted";
}

/** Safe, code-only diagnostics for a persist attempt: no provider text, no
 * amounts, no bodies. */
export function sharedRunDiagnostic(
  runId: string,
  unitKey: string,
  outcome: SharedRunOutcome,
): Record<string, unknown> {
  const result = outcome.result;
  return {
    event: "vpass-shared-collection",
    runId,
    unitKey,
    persistence: result.outcome,
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
