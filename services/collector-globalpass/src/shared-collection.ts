// The shared DATA-bucket write path for the GLOBAL PASS collector (U09).
//
// In `shared` mode the Worker — never the container — persists the run: each
// month's activity page and the collector manifest are written
// content-addressed into DATA and the `terminal-v1` manifest is written last,
// by `packages/collection`. The upload to `kogane-collector-r2-importer` is
// then skipped, so the Processor reads the collector's own bytes rather than a
// copy (plan 03 §1, G1-15).
//
// The bytes are the ones `sanitizeGlobalPassActivityHtml` already produced
// before anything reached the staging bucket: the encrypted Nablarch state is
// redacted, interactive attributes are canonicalized, and an unreviewed page
// shape fails the run instead of being stored. Those are exactly the bytes the
// importer re-derives and sends centrally today. The GLOBAL PASS id, password
// and relay token are never part of a plan.
//
// Coverage is `partial` even on a `success` run. The provider exposes a
// rolling window of statement months and the collector's pagination status is
// `unproven` (`GLOBALPASS_PAGINATION_STATUS`), so a finished run is a claim
// about persistence, never about the account's whole history.
import {
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRange,
  type TerminalRunFields,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";
import {
  artifactFilename,
  GLOBALPASS_MEDIA_TYPE,
  safeMonth,
  type CollectionManifest,
} from "./model";

/** `runs/<source>/…` in DATA. The Processor maps it to the CORE source `global-pass`. */
export const SHARED_SOURCE = "prestia-globalpass";
const PRODUCER = "collector-globalpass";
const MANIFEST_ARTIFACT_KEY = "manifest.json";
const JSON_MEDIA_TYPE = "application/json";
/** The single unit the central descriptors already use for this source. */
const UNIT_KEY = "account";
const UNIT_KIND = "collection";

export const PROVIDER_CAPTURE_ROLE = "sanitized_provider_capture";
export const COLLECTOR_MANIFEST_ROLE = "collector_manifest";

const encoder = new TextEncoder();

/** One month's already-sanitized activity page, as it was stored. */
export interface SharedCapture {
  readonly month: string;
  readonly sanitizedHtml: string;
}

/** Where the ops API's operation and this attempt enter the terminal (03 §3). */
export interface SharedRunIdentity {
  readonly operationId?: string;
  readonly attemptId: string;
}

export interface SharedRunInput {
  readonly manifest: CollectionManifest;
  /** The exact manifest bytes written to the staging bucket. */
  readonly manifestJson: string;
  readonly captures: readonly SharedCapture[];
  readonly identity: SharedRunIdentity;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function artifactOf(options: {
  artifactKey: string;
  bytes: Uint8Array;
  mediaType: string;
  role: string;
  unitKey?: string;
}): Promise<PersistArtifact> {
  return {
    artifactKey: options.artifactKey,
    sha256: await sha256Hex(options.bytes),
    byteSize: options.bytes.byteLength,
    mediaType: options.mediaType,
    role: options.role,
    ...(options.unitKey === undefined ? {} : { unitKey: options.unitKey }),
    body: { kind: "bytes", bytes: options.bytes },
  };
}

/**
 * GLOBAL PASS has no re-authentication and no stored session: the collector
 * makes exactly one login attempt per run and the cron is the only retry. The
 * container reports a failed login as the generic `browser_collection_failed`,
 * so nothing here can honestly single out "a person must act" without a
 * container change, which U09 does not make. The hook exists so a later,
 * better-classified failure can set it without changing the terminal contract.
 */
export function waitingForHuman(_manifest: CollectionManifest): boolean {
  return false;
}

/** A `partial` run stays partial and a `failed` run never claims coverage. */
export function sharedOutcome(manifest: CollectionManifest): {
  providerOutcome: ProviderOutcome;
  coverageStatus: CoverageStatus;
  safeErrorCode?: string;
} {
  if (manifest.status === "success") {
    // Never `complete`: a rolling window with unproven pagination.
    return { providerOutcome: "success", coverageStatus: "partial" };
  }
  return {
    providerOutcome: manifest.status === "partial" ? "partial" : "failed",
    coverageStatus: manifest.status === "partial" ? "partial" : "unknown",
    safeErrorCode: manifest.failures[0]?.errorCode ?? "collector_run_incomplete",
  };
}

/** The months the run asked the provider for, oldest to newest. */
function requestedScope(manifest: CollectionManifest): TerminalRunFields["requestedScope"] {
  const months = [...manifest.selectedMonths].map(safeMonth).sort();
  const oldest = months[0];
  const newest = months.at(-1);
  if (oldest === undefined || newest === undefined) {
    // The container never reported its month list: the run states that it does
    // not know what it asked for rather than inventing a range.
    return { scopeKind: "unspecified", startValue: null, endValue: null, unitKeys: [UNIT_KEY] };
  }
  return {
    scopeKind: "month_range",
    startValue: oldest,
    endValue: newest,
    unitKeys: [UNIT_KEY],
  };
}

function ranges(manifest: CollectionManifest): TerminalRange[] {
  const entries: TerminalRange[] = [];
  const months = [...manifest.selectedMonths].map(safeMonth).sort();
  const oldest = months[0];
  const newest = months.at(-1);
  if (oldest !== undefined && newest !== undefined) {
    entries.push({
      rangeKey: "requested",
      rangeKind: "requested",
      precision: "month",
      basis: "request",
      startValue: oldest,
      endValue: newest,
      unitKey: UNIT_KEY,
    });
  }
  // One declared-coverage range per month whose page was actually stored.
  for (const artifact of manifest.artifacts) {
    const month = safeMonth(artifact.month);
    entries.push({
      rangeKey: `month-${month}`,
      rangeKind: "declared_coverage",
      precision: "month",
      basis: "source",
      startValue: month,
      endValue: month,
      unitKey: UNIT_KEY,
    });
  }
  return entries;
}

/**
 * The `terminal-v1` plan for one run: the manifest plus one artifact per stored
 * month. A `failed` run plans the manifest alone, so the failure stays a
 * failure instead of reading like a complete month with nothing in it (G1-09).
 */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const stored = new Map(input.captures.map((capture) => [safeMonth(capture.month), capture]));
  const artifacts: PersistArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  for (const entry of input.manifest.artifacts) {
    const month = safeMonth(entry.month);
    const capture = stored.get(month);
    if (!capture) throw new Error("shared_capture_missing");
    const artifactKey = artifactFilename(month);
    artifacts.push(
      await artifactOf({
        artifactKey,
        bytes: encoder.encode(capture.sanitizedHtml),
        mediaType: GLOBALPASS_MEDIA_TYPE,
        role: PROVIDER_CAPTURE_ROLE,
        unitKey: UNIT_KEY,
      }),
    );
    transformations.push({
      transformationId: `${artifactKey}:redacted`,
      stepKind: "redacted",
      transformerId: "globalpass-activity-sanitizer",
      transformerVersion: input.manifest.schemaVersion,
      // The unredacted page is never retained, so it has no artifact key.
      inputArtifactKeys: [],
      outputArtifactKey: artifactKey,
    });
  }
  artifacts.push(
    await artifactOf({
      artifactKey: MANIFEST_ARTIFACT_KEY,
      bytes: encoder.encode(input.manifestJson),
      mediaType: JSON_MEDIA_TYPE,
      role: COLLECTOR_MANIFEST_ROLE,
      unitKey: UNIT_KEY,
    }),
  );

  const outcome = sharedOutcome(input.manifest);
  const run: TerminalRunFields = {
    source: SHARED_SOURCE,
    producer: PRODUCER,
    producerVersion: input.manifest.schemaVersion,
    runId: input.manifest.runId,
    attemptId: input.identity.attemptId,
    ...(input.identity.operationId === undefined
      ? {}
      : { operationId: input.identity.operationId }),
    // No acquisition session ref: the container logs in once per run and keeps
    // no session across runs, so there is no generation to reference (12 §4).
    requestedScope: requestedScope(input.manifest),
    startedAt: input.manifest.startedAt,
    completedAt: input.manifest.completedAt,
    providerOutcome: outcome.providerOutcome,
    coverageStatus: outcome.coverageStatus,
    persistenceComplete: true,
    ...(outcome.safeErrorCode === undefined ? {} : { safeErrorCode: outcome.safeErrorCode }),
    units: [
      {
        unitKey: UNIT_KEY,
        unitKind: UNIT_KIND,
        artifactCount: input.manifest.artifacts.length,
        coverageStatus: outcome.coverageStatus,
        ...(outcome.safeErrorCode === undefined ? {} : { safeErrorCode: outcome.safeErrorCode }),
      },
    ],
    ranges: ranges(input.manifest),
    reports: [],
    transformations,
  };
  return { run, artifacts };
}

export interface SharedRunSummary {
  readonly target: "shared";
  readonly outcome: PersistRunResult["outcome"];
  readonly terminalKey: string;
  readonly terminalDigest: string;
  readonly objectCount: number;
  /**
   * Where the collector manifest is in DATA (`objects/<2 hex>/<sha256>`). It
   * takes the place of the staging manifest key in shared mode, where nothing
   * is staged. Empty until a terminal exists.
   */
  readonly manifestObjectKey: string;
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}

/**
 * Persists one run into DATA. Objects first, terminal last: an `incomplete`
 * result means no terminal exists and the run is not reported persisted
 * (G1-01). Nothing here retries a login or re-reads the provider.
 */
export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<SharedRunSummary> {
  const plan = await buildSharedRunPlan(input);
  const result = await persistRun(bucket, plan);
  return {
    target: "shared",
    outcome: result.outcome,
    terminalKey: result.terminalKey,
    terminalDigest: result.terminalDigest,
    objectCount: result.outcome === "conflict" ? 0 : result.objects.length,
    manifestObjectKey:
      result.outcome === "persisted" || result.outcome === "already_persisted"
        ? (result.objects.find((object) => object.artifactKey === MANIFEST_ARTIFACT_KEY)?.key ?? "")
        : "",
    waitingForHuman: waitingForHuman(input.manifest),
    ...(result.outcome === "conflict" || result.outcome === "incomplete"
      ? { reasonCode: result.reasonCode }
      : {}),
  };
}

/** `persisted` and `already_persisted` are the only completion outcomes. */
export function sharedRunPersisted(summary: SharedRunSummary): boolean {
  return summary.outcome === "persisted" || summary.outcome === "already_persisted";
}

/**
 * The Workers `R2Bucket` binding seen through the contract's minimal surface.
 * They are the same object: `R2BucketLike` names exactly the five methods
 * `persistRun` calls.
 */
export function dataBucket(bucket: R2Bucket): R2BucketLike {
  return bucket as unknown as R2BucketLike;
}
