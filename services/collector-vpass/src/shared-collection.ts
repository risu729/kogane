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
//   card-identity-binding.json   the card's durable binding token, when the
//                                Worker holds the binding key (ADR 0023)
//
// No raw envelope, cookie, auth blob or card identify key is written: the
// sanitizer replaces them and refuses output that still carries one. The card
// binding is derived from the raw selection and discovery responses before
// they are sanitized (`./card-binding`); only its keyed token is stored.
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
  type TerminalUnit,
} from "../../../packages/collection/src/index";
import {
  deriveVpassCardBinding,
  VPASS_BINDING_ARTIFACT_KEY,
  VPASS_BINDING_CONTRACT,
  VPASS_BINDING_KEY_VERSION,
  VPASS_BINDING_TRANSFORMER_ID,
  VPASS_BINDING_TRANSFORMER_VERSION,
  type VpassBindingUnavailable,
  type VpassCardBinding,
} from "./card-binding";

export const SOURCE = "vpass";
/** `collector-<collector id>`: the producer the Processor's route for this source names (ADR 0014). */
export const PRODUCER = "collector-vpass";
/** The schema version central storage records for a card-scoped Vpass run. */
const VPASS_CARD_SCHEMA_VERSION = "vpass-worker-card-v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MONTH = /^\d{6}$/u;

interface VpassPageCapture {
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
  /** A card run only: `bound`, or the closed code of why no binding was stored. */
  readonly binding?: "bound" | VpassBindingUnavailable;
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

/** One planned artifact; the run's own manifest passes no unit (ADR 0021). */
async function artifactOf(
  artifactKey: string,
  bytes: Uint8Array,
  role: string,
  unitKey?: string,
): Promise<PersistArtifact> {
  return {
    artifactKey,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role,
    ...(unitKey === undefined ? {} : { unitKey }),
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

/**
 * The binding artifact (ADR 0023): the token and what it was derived under,
 * never the tuple. The format is the importer's
 * `vpass-card-identity-binding-json` version 1 without the fields that named
 * the importer's private source objects (snapshot and manifest digests, the
 * storage-key fingerprint): this collector keeps no raw object to name.
 */
function bindingBytes(run: VpassCardRun, token: string): Uint8Array {
  return encodeCanonical({
    schemaVersion: VPASS_BINDING_CONTRACT,
    accountIdentity: token,
    fingerprintKeyVersion: VPASS_BINDING_KEY_VERSION,
    sourceSession: run.sessionRunId,
    sourceNamespace: VPASS_CARD_SCHEMA_VERSION,
    sourceCardOrdinal: run.cardLabel,
    checks: { selectedCardDescriptor: true, selectionDiscoveryCardCode: true },
  });
}

/** The binding was read out of the selection and discovery responses, which
 * are stored only redacted, so the step names no input artifact and the
 * Processor records `source_bytes_not_available` (ADR 0021). */
function bindingExtraction(): TerminalTransformation {
  return {
    transformationId: `extracted:${VPASS_BINDING_ARTIFACT_KEY}`,
    stepKind: "extracted",
    transformerId: VPASS_BINDING_TRANSFORMER_ID,
    transformerVersion: VPASS_BINDING_TRANSFORMER_VERSION,
    inputArtifactKeys: [],
    outputArtifactKey: VPASS_BINDING_ARTIFACT_KEY,
  };
}

/**
 * Build the persist plan for one finished card. Pure apart from hashing.
 *
 * `bindingKey` is the Worker secret `VPASS_CARD_BINDING_KEY`. With it, and
 * with a selection and discovery that carry a consistent card tuple, the run
 * also holds the card's durable binding: a second `card` unit keyed by the
 * token with exactly one `card-identity-binding.json` (ADR 0023). Without it
 * the run is the same card run with no binding.
 */
export async function vpassCardRunPlan(
  run: VpassCardRun,
  bindingKey?: string,
): Promise<PersistRunPlan> {
  return planFor(run, await deriveVpassCardBinding(run, bindingKey));
}

async function planFor(run: VpassCardRun, binding: VpassCardBinding): Promise<PersistRunPlan> {
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
          // A statement page is the sanitizer's output, like the three
          // envelopes above: CORE seals a provider role only with `decrypted`
          // or `extracted` steps, so a `provider_response` carrying this
          // `redacted` step could never be sealed (ADR 0021).
          "sanitized_provider_capture",
          unitKey,
        ),
      );
    }
  }
  const transformations: TerminalTransformation[] = artifacts.map((artifact) =>
    redaction(artifact.artifactKey),
  );
  const summary = manifestBytes(run, months);
  // The card run's manifest belongs to the run and names no unit (ADR 0021).
  const cardArtifactCount = artifacts.length;
  artifacts.push(await artifactOf("manifest.json", summary, "collector_manifest"));
  // The binding lives in its own unit, keyed by the token, so the trusted
  // binding view reads the token as it read the importer's binding unit.
  const bindingUnits: TerminalUnit[] = [];
  if (binding.status === "derived") {
    artifacts.push(
      await artifactOf(
        VPASS_BINDING_ARTIFACT_KEY,
        bindingBytes(run, binding.token),
        "collector_derived",
        binding.token,
      ),
    );
    transformations.push(bindingExtraction());
    bindingUnits.push({
      unitKey: binding.token,
      unitKind: "card",
      artifactCount: 1,
      coverageStatus: "complete",
    });
  }

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
          artifactCount: cardArtifactCount,
          // The card unit collected every statement month the provider listed
          // for it, so its own terminal report is a success, as the retired
          // importer's card units were. Registration turns a `partial` unit
          // into a `partial` unit report, which makes the whole fetch run
          // `partial` downstream: no identity and no trusted binding reads a
          // partial run, so every row would stay unresolved (ADR 0023). The
          // gap that is real, the rolling window, stays on the run's
          // `coverageStatus` and on the `statement-months` range.
          coverageStatus: "complete",
        },
        ...bindingUnits,
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
function vpassFailedRunPlan(run: VpassFailedRun): PersistRunPlan {
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
 * `bindingKey` is the Worker secret `VPASS_CARD_BINDING_KEY`, or undefined.
 */
export async function persistCardRun(
  bucket: R2BucketLike,
  run: VpassCardRun,
  bindingKey?: string,
): Promise<SharedRunOutcome> {
  const binding = await deriveVpassCardBinding(run, bindingKey);
  const outcome = await persist(bucket, await planFor(run, binding));
  return { ...outcome, binding: binding.status === "derived" ? "bound" : binding.code };
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
    ...(outcome.binding === undefined ? {} : { binding: outcome.binding }),
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
