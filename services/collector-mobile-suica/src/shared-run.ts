// Shared DATA-bucket persistence for the Mobile Suica collector (unified plan
// U09, chapter 03, decisions D7/D12).
//
// With `COLLECTION_TARGET=shared` the run is written through
// `packages/collection` — every artifact content-addressed under `objects/`,
// the `terminal-v1` manifest last — instead of per-artifact writes into the
// per-source bucket followed by the central importer call.
//
// The bytes are the ones the importer forwards centrally today. In particular
// the history page is the **sanitized** CP932 HTML: `sanitizeHistoryHtml`
// replaces the hidden `baseVariable` session field before anything is stored,
// and the importer verifies that redaction on the way to the central store. No
// unsanitized page, cookie or session envelope is ever an artifact.
import {
  persistRun,
  sha256Hex,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRunFields,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";
import type { RawArtifact } from "./types";

export const MOBILE_SUICA_SOURCE = "mobile-suica";
export const SHARED_PRODUCER = "collector-mobile-suica";
const UNIT_KEY = "account";
const UNIT_KIND = "collection";
const HTML_ARTIFACT = "sf-history-page-0001.html";
const NORMALIZED_ARTIFACT = "sf-history.json";
const SANITIZER_ID = "mobile-suica-history-sanitizer";
const NORMALIZER_ID = "mobile-suica-history-normalizer";
const TRANSFORMER_VERSION = "v1";
const FALLBACK_ERROR_CODE = "collector_failed";
/** The manifest's own machine-code charset; a code that fails it is replaced. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;

export interface MobileSuicaSharedRun {
  readonly runId: string;
  readonly producerVersion: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly acquisitionSessionRef?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "partial" | "failed";
  /** The JST date the run asked the site for. */
  readonly asOfDateJst: string;
  /** The collector's own proof that it reached the end of the history. */
  readonly complete: boolean;
  readonly artifacts: readonly RawArtifact[];
  /** Safe failure codes of the run, most significant first; never provider text. */
  readonly failureCodes: readonly string[];
}

/** Builds the plan without writing anything, so a test can read the manifest. */
export async function mobileSuicaRunPlan(run: MobileSuicaSharedRun): Promise<PersistRunPlan> {
  const artifacts = await Promise.all(run.artifacts.map((artifact) => plannedArtifact(artifact)));
  const stored = new Set(artifacts.map((artifact) => artifact.artifactKey));
  const providerOutcome: ProviderOutcome = run.status;
  const coverageStatus = coverageFor(providerOutcome, run.complete);
  const safeErrorCode = providerOutcome === "success" ? undefined : failureCode(run.failureCodes);
  const transformations: TerminalTransformation[] = [];
  if (stored.has(HTML_ARTIFACT)) {
    transformations.push({
      transformationId: "sf-history-html-redacted",
      stepKind: "redacted",
      transformerId: SANITIZER_ID,
      transformerVersion: TRANSFORMER_VERSION,
      // The unredacted page carried the session's `baseVariable` and is
      // deliberately not retained, so this step has no stored input.
      inputArtifactKeys: [],
      outputArtifactKey: HTML_ARTIFACT,
    });
  }
  if (stored.has(NORMALIZED_ARTIFACT)) {
    transformations.push({
      transformationId: "sf-history-extracted",
      stepKind: "extracted",
      transformerId: NORMALIZER_ID,
      transformerVersion: TRANSFORMER_VERSION,
      inputArtifactKeys: stored.has(HTML_ARTIFACT) ? [HTML_ARTIFACT] : [],
      outputArtifactKey: NORMALIZED_ARTIFACT,
    });
  }
  const fields: TerminalRunFields = {
    source: MOBILE_SUICA_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion: run.producerVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    ...(run.operationId === undefined ? {} : { operationId: run.operationId }),
    ...(run.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: run.acquisitionSessionRef }),
    // The site returns the whole visible SF history for one as-of date; the
    // date is a selector, not the extent of what came back.
    requestedScope: {
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [UNIT_KEY],
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    units: [
      {
        unitKey: UNIT_KEY,
        unitKind: UNIT_KIND,
        artifactCount: artifacts.length,
        coverageStatus,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      },
    ],
    ranges: [
      {
        rangeKey: "as-of-selector",
        rangeKind: "selector",
        precision: "date",
        basis: "request",
        startValue: run.asOfDateJst,
        endValue: run.asOfDateJst,
        unitKey: UNIT_KEY,
      },
    ],
    reports: [],
    transformations,
  };
  return { run: fields, artifacts };
}

export async function persistMobileSuicaRun(
  bucket: R2BucketLike,
  run: MobileSuicaSharedRun,
): Promise<PersistRunResult> {
  return await persistRun(bucket, await mobileSuicaRunPlan(run));
}

/**
 * The roles the central descriptor gives these bytes today: the redacted CP932
 * page is a sanitized provider capture, the parsed rows are collector-derived,
 * the summary is generated by the collector.
 */
function role(dataset: string): string {
  if (dataset === "sf-history-html") return "sanitized_provider_capture";
  return dataset === "collection-summary" ? "collector_summary" : "collector_derived";
}

/**
 * A run may only claim complete coverage when it both succeeded and proved it
 * reached the end of the history (`complete`); an unproven boundary is a
 * partial observation however clean the transport was.
 */
function coverageFor(outcome: ProviderOutcome, complete: boolean): CoverageStatus {
  if (outcome === "failed") return "unknown";
  return outcome === "success" && complete ? "complete" : "partial";
}

function failureCode(codes: readonly string[]): string {
  return codes.find((candidate) => SAFE_CODE.test(candidate)) ?? FALLBACK_ERROR_CODE;
}

async function plannedArtifact(artifact: RawArtifact): Promise<PersistArtifact> {
  const bytes =
    typeof artifact.body === "string" ? new TextEncoder().encode(artifact.body) : artifact.body;
  return {
    artifactKey: artifact.filename,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    // `terminal-v1` media types carry no parameters; the CP932 charset of the
    // history page is the source's own constant and is what the central
    // descriptor declares for it too (`text/html`).
    mediaType: artifact.mediaType.split(";")[0]!.trim(),
    role: role(artifact.dataset),
    unitKey: UNIT_KEY,
    body: { kind: "bytes", bytes },
  };
}
