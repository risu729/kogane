// Shared DATA-bucket persistence for this Worker's two sources (unified plan
// U09, chapter 03, decisions D7/D12): the V Point ledger run and the V Point
// Pay notification mail the Email route receives.
//
// With `COLLECTION_TARGET=shared` the legacy path is skipped entirely — no
// per-source bucket write, no importer call — and the run is written through
// `packages/collection`: every artifact content-addressed under `objects/`,
// the terminal manifest last. The bytes are the same bytes the importer
// forwards to the central store today, so the switch changes where a run is
// kept and nothing about what is kept.
//
// Nothing here logs: the caller emits the safe summary. No credential, cookie,
// session state, amount or provider body reaches this module except as the
// artifact bytes the collector already decided to keep.
import {
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRunFields,
  sha256Hex,
} from "../../../packages/collection/src/index";
import type { RawArtifact } from "./types";
import type { PreparedVPointPayEmail } from "./vpoint-pay-email";

export const VPOINT_SOURCE = "v-point";
export const VPOINT_PAY_EMAIL_SOURCE = "v-point-pay-email";
/** Same producer for both sources: one Worker acquires them. */
export const SHARED_PRODUCER = "collector-vpoint";
const VPOINT_UNIT_KEY = "account";
const VPOINT_UNIT_KIND = "collection";
const EMAIL_UNIT_KEY = "notification";
const EMAIL_UNIT_KIND = "message";
const EMAIL_PARSER_ID = "vpoint-pay-email-parser";
const FALLBACK_ERROR_CODE = "collector_failed";
/** The manifest's own machine-code charset; a code that fails it is replaced. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;

export type CollectionStatus = "success" | "partial" | "failed";

export interface SharedRunIdentity {
  /** Distinguishes retries of the same run; carried into the terminal. */
  readonly attemptId: string;
  /** The App operation this run answers, when it was requested rather than scheduled. */
  readonly operationId?: string;
  /**
   * One acquisition session that touches several sources keeps one ref on
   * every per-source run (03 §3): one delivered mail can both archive a V
   * Point Pay notification and finish a V Point login, and those stay two
   * runs of two sources that name the same session (G1-16).
   */
  readonly acquisitionSessionRef?: string;
}

export interface VPointSharedRun extends SharedRunIdentity {
  readonly runId: string;
  readonly producerVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: CollectionStatus;
  /** The sanitized artifacts `collectVPoint` produced, in collection order. */
  readonly artifacts: readonly RawArtifact[];
  /** Safe failure codes of the run, most significant first; never provider text. */
  readonly failureCodes: readonly string[];
}

/** Builds the plan without writing anything, so a test can read the manifest. */
export async function vPointRunPlan(run: VPointSharedRun): Promise<PersistRunPlan> {
  const artifacts = await Promise.all(
    run.artifacts.map((artifact) =>
      plannedArtifact(artifact, vPointRole(artifact.dataset), VPOINT_UNIT_KEY),
    ),
  );
  const providerOutcome: ProviderOutcome = run.status;
  const coverageStatus = coverageFor(providerOutcome);
  const safeErrorCode = providerOutcome === "success" ? undefined : failureCode(run.failureCodes);
  const fields: TerminalRunFields = {
    source: VPOINT_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion: run.producerVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    ...(run.operationId === undefined ? {} : { operationId: run.operationId }),
    ...(run.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: run.acquisitionSessionRef }),
    // The collector always asks for the whole visible ledger; the page count
    // it actually read is stated by the collection-summary artifact.
    requestedScope: {
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [VPOINT_UNIT_KEY],
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    units: [
      {
        unitKey: VPOINT_UNIT_KEY,
        unitKind: VPOINT_UNIT_KIND,
        artifactCount: artifacts.length,
        coverageStatus,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      },
    ],
    ranges: [],
    reports: [],
    transformations: [],
  };
  return { run: fields, artifacts };
}

export async function persistVPointRun(
  bucket: R2BucketLike,
  run: VPointSharedRun,
): Promise<PersistRunResult> {
  return await persistRun(bucket, await vPointRunPlan(run));
}

/**
 * One delivered notification is one run of `v-point-pay-email`.
 *
 * Every field is derived from the message, so a redelivery of the same mail
 * produces the same terminal digest and `persistRun` answers
 * `already_persisted` instead of conflicting — the shared-target equivalent of
 * the legacy duplicate check. The run window is the message's own date for the
 * same reason; the importer already treats that instant as the fetch time.
 */
export async function vPointPayEmailRunPlan(
  prepared: PreparedVPointPayEmail,
  producerVersion: string,
  identity?: { readonly operationId?: string },
): Promise<PersistRunPlan> {
  const eml: PersistArtifact = {
    artifactKey: "notification.eml",
    sha256: prepared.rawSha256,
    byteSize: prepared.raw.byteLength,
    mediaType: "message/rfc822",
    // The message is evidence produced outside this collector and its sender
    // is not cryptographically verified here, exactly as the central
    // descriptor records it today.
    role: "user_capture",
    unitKey: EMAIL_UNIT_KEY,
    body: { kind: "bytes", bytes: prepared.raw },
  };
  const normalized: PersistArtifact = {
    artifactKey: "normalized-event.json",
    sha256: prepared.normalizedSha256,
    byteSize: prepared.normalized.byteLength,
    mediaType: "application/json",
    role: "collector_derived",
    unitKey: EMAIL_UNIT_KEY,
    body: { kind: "bytes", bytes: prepared.normalized },
  };
  const fields: TerminalRunFields = {
    source: VPOINT_PAY_EMAIL_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion,
    runId: prepared.event.id,
    attemptId: `message-${prepared.event.id}`,
    ...(identity?.operationId === undefined ? {} : { operationId: identity.operationId }),
    acquisitionSessionRef: emailSessionRef(prepared.outerMessageSha256),
    requestedScope: {
      scopeKind: "unspecified",
      startValue: null,
      endValue: null,
      unitKeys: [EMAIL_UNIT_KEY],
    },
    startedAt: prepared.event.occurredAt,
    completedAt: prepared.event.occurredAt,
    providerOutcome: "success",
    coverageStatus: "complete",
    persistenceComplete: true,
    units: [
      {
        unitKey: EMAIL_UNIT_KEY,
        unitKind: EMAIL_UNIT_KIND,
        artifactCount: 2,
        coverageStatus: "complete",
      },
    ],
    ranges: [],
    reports: [],
    transformations: [
      {
        transformationId: "normalized-event",
        stepKind: "extracted",
        transformerId: EMAIL_PARSER_ID,
        transformerVersion: prepared.event.schemaVersion,
        inputArtifactKeys: [eml.artifactKey],
        outputArtifactKey: normalized.artifactKey,
      },
    ],
  };
  return { run: fields, artifacts: [eml, normalized] };
}

export async function persistVPointPayEmailRun(
  bucket: R2BucketLike,
  prepared: PreparedVPointPayEmail,
  producerVersion: string,
  identity?: { readonly operationId?: string },
): Promise<PersistRunResult> {
  return await persistRun(bucket, await vPointPayEmailRunPlan(prepared, producerVersion, identity));
}

/**
 * The acquisition session of one delivered mail, named by the digest of the
 * message as it arrived. The V Point run a login mail triggers derives the
 * same ref from the same bytes, so both terminals point at one session while
 * staying two runs of two sources.
 */
export function emailSessionRef(outerMessageSha256: string): string {
  return `email-${outerMessageSha256}`;
}

export function emailSessionRefFor(raw: Uint8Array): Promise<string> {
  return sha256Hex(raw).then(emailSessionRef);
}

/** `collection-summary` is generated by the collector; the rest is ledger data. */
function vPointRole(dataset: string): string {
  return dataset === "collection-summary" ? "collector_summary" : "collector_derived";
}

function coverageFor(outcome: ProviderOutcome): CoverageStatus {
  return outcome === "success" ? "complete" : outcome === "partial" ? "partial" : "unknown";
}

function failureCode(codes: readonly string[]): string {
  const code = codes.find((candidate) => SAFE_CODE.test(candidate));
  return code ?? FALLBACK_ERROR_CODE;
}

async function plannedArtifact(
  artifact: RawArtifact,
  role: string,
  unitKey: string,
): Promise<PersistArtifact> {
  const bytes = new TextEncoder().encode(artifact.body);
  return {
    artifactKey: artifact.filename,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: artifact.mediaType,
    role,
    unitKey,
    body: { kind: "bytes", bytes },
  };
}
