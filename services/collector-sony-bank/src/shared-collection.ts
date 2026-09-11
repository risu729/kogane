// Sony Bank → the shared DATA bucket (unified plan 03, U09).
//
// The bytes are the ones the legacy path already sends central: the collector
// sanitizes the wallet statements itself (`sanitizeWalletHtml`) and the
// importer forwards every stored object verbatim, so shared mode stores the
// same artifact bodies under content-addressed keys and states the run in a
// `terminal-v1` manifest instead of a per-source manifest object.
//
// Nothing here touches a provider or a credential: it maps an already
// finished run onto a persist plan and lets `persistRun` write the terminal
// last. Before a byte is planned it is re-checked against the invariants the
// importer enforces on the way to central storage (a wallet page that still
// carries a `jsessionid` or a hidden-input value, a JSON payload with a
// credential field), so a sanitizer regression fails the run rather than
// publishing the value (G3-08). A failed run persists no artifact at all, so a run that collected
// nothing stays a failure downstream instead of reading like an observation
// of zero (G1-09).
import { manifestFailure } from "./diagnostics";
import type { CollectionFailure, CollectionManifest, RawArtifact, StoredArtifact } from "./types";
import {
  objectKey,
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRange,
  type TerminalReport,
  type TerminalTransformation,
  type TerminalUnit,
} from "../../../packages/collection/src/index";

const SOURCE = "sony-bank";
const PRODUCER = "sony-bank-worker";
/** One credential, one account: the run's only addressable unit. */
const UNIT_KEY = "account";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export interface SharedRunInput {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: CollectionManifest["status"];
  readonly window: { readonly from: string; readonly to: string };
  readonly transactionCount: number;
  readonly artifacts: readonly RawArtifact[];
  readonly failures: readonly CollectionFailure[];
  /**
   * Set when an operation requested this run (unified plan 02 §5). U08
   * dispatches collection operations; until then the collector's own cron and
   * admin trigger leave both undefined and the run is self-initiated.
   */
  readonly operationId?: string;
  readonly attemptId?: string;
  /** Shared by the per-source runs of one multi-source session (03 §3). */
  readonly acquisitionSessionRef?: string;
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

export interface SharedRunOutcome {
  readonly result: PersistRunResult;
  readonly artifactCount: number;
}

/**
 * The artifact role vocabulary the central contract already uses for Sony
 * Bank, so a terminal registers the same way the importer registered the
 * same bytes.
 */
export function artifactRole(dataset: string): string {
  if (dataset === "collection-summary") return "collector_summary";
  if (dataset.startsWith("wallet-history-")) return "sanitized_provider_capture";
  if (dataset.endsWith("-csv")) return "provider_export";
  return "provider_response";
}

function bodyBytes(body: string | ArrayBuffer): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
}

function attribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

/** A hidden input (or the `cc` field) that kept a value is the session or the
 * CSRF material `sanitizeWalletHtml` exists to strip. */
function unsafeHiddenInput(html: string): boolean {
  for (const match of html.matchAll(/<input\b[^>]*>/giu)) {
    const tag = match[0];
    const type = attribute(tag, "type").toLowerCase();
    const name = attribute(tag, "name").toLowerCase();
    if ((type === "hidden" || name === "cc") && attribute(tag, "value") !== "") return true;
  }
  return false;
}

function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      /^(loginpwd|password|csrf|debitssobindat|messagecheck)$/iu.test(key) ||
      containsSecretField(child),
  );
}

/**
 * The invariants the central path enforces before it accepts a Sony Bank
 * object (`wallet_html_not_sanitized`, `artifact_secret_field_present` in
 * the importer), checked again on the bytes about to leave the Worker
 * (unified plan 12 §6). `sanitizeWalletHtml` and the collector's own response
 * handling are what make them hold; this is the assertion that a regression
 * fails the run instead of publishing a session id. Throws a stable code,
 * never the offending text.
 */
export function assertCentralSafe(artifact: RawArtifact, bytes: Uint8Array): void {
  if (artifact.dataset.startsWith("wallet-history-")) {
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("artifact_html_encoding_invalid");
    }
    if (/;jsessionid=/iu.test(html) || unsafeHiddenInput(html)) {
      throw new Error("artifact_html_redaction_invalid");
    }
    return;
  }
  if (artifact.dataset.endsWith("-csv")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("artifact_json_invalid");
  }
  if (containsSecretField(parsed)) throw new Error("artifact_secret_field_present");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function providerOutcome(status: CollectionManifest["status"]): ProviderOutcome {
  return status;
}

/**
 * A finished window is a claim about the window that was requested, never
 * about the account's whole history — which is why `requestedScope` carries
 * the window and a partial run may not claim complete coverage.
 */
function coverage(status: CollectionManifest["status"]): CoverageStatus {
  if (status === "success") return "complete";
  return status === "partial" ? "partial" : "unknown";
}

function safeErrorCode(status: CollectionManifest["status"]): string | undefined {
  if (status === "success") return undefined;
  return status === "partial" ? "collector_partial" : "collector_failed";
}

function walletMonths(artifacts: readonly RawArtifact[]): string[] {
  return artifacts
    .flatMap((artifact) =>
      /^wallet-history-(\d{4})(\d{2})$/u.exec(artifact.dataset) === null
        ? []
        : [`${artifact.dataset.slice(-6, -2)}-${artifact.dataset.slice(-2)}`],
    )
    .sort();
}

function identifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

/** The manifest the run would have written, with central-safe failures and the
 * content-addressed keys the artifacts actually got. */
function manifestBytes(input: SharedRunInput, stored: readonly StoredArtifact[]): Uint8Array {
  const manifest: CollectionManifest = {
    schemaVersion: input.schemaVersion,
    source: "sony-bank",
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    window: { from: input.window.from, to: input.window.to },
    transactionCount: input.transactionCount,
    artifacts: [...stored],
    failures: input.failures.map(manifestFailure),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** Build the persist plan for a finished run. Pure apart from hashing. */
export async function sonyBankRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const outcome = providerOutcome(input.status);
  const coverageStatus = coverage(input.status);
  const errorCode = safeErrorCode(input.status);
  // A failed run keeps no artifact: there is nothing whose persistence could
  // be claimed, and the terminal states the failure on its own.
  const sources = outcome === "failed" ? [] : input.artifacts;

  const artifacts: PersistArtifact[] = [];
  const stored: StoredArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  for (const artifact of sources) {
    const bytes = bodyBytes(artifact.body);
    // Re-checked here, against the same invariants the central path
    // enforces, before the bytes leave the Worker (G3-08).
    assertCentralSafe(artifact, bytes);
    const sha256 = await sha256Hex(bytes);
    const role = artifactRole(artifact.dataset);
    artifacts.push({
      artifactKey: artifact.filename,
      sha256,
      byteSize: bytes.byteLength,
      mediaType: artifact.mediaType.split(";", 1)[0]!.trim(),
      role,
      unitKey: UNIT_KEY,
      body: { kind: "bytes", bytes },
    });
    stored.push({
      dataset: artifact.dataset,
      key: objectKey(sha256),
      mediaType: artifact.mediaType,
      sha256,
      bytes: bytes.byteLength,
    });
    if (role === "sanitized_provider_capture") {
      // Provenance for the wallet statements: the collector redacted them and
      // the provider bytes were deliberately not retained.
      transformations.push({
        transformationId: `redacted:${artifact.filename}`,
        stepKind: "redacted",
        transformerId: PRODUCER,
        transformerVersion: input.schemaVersion,
        inputArtifactKeys: [],
        outputArtifactKey: artifact.filename,
      });
    }
  }
  if (artifacts.length > 0) {
    const bytes = manifestBytes(input, stored);
    artifacts.push({
      artifactKey: "manifest.json",
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: "application/json",
      role: "collector_manifest",
      unitKey: UNIT_KEY,
      body: { kind: "bytes", bytes },
    });
  }

  const units: TerminalUnit[] = [
    {
      unitKey: UNIT_KEY,
      unitKind: "account",
      artifactCount: artifacts.length,
      coverageStatus,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
    },
  ];
  const months = walletMonths(sources);
  const ranges: TerminalRange[] = [
    {
      rangeKey: "request-window",
      rangeKind: "requested",
      precision: "date",
      basis: "manifest",
      startValue: input.window.from,
      endValue: input.window.to,
      unitKey: UNIT_KEY,
    },
    ...(months.length === 0
      ? []
      : [
          {
            rangeKey: "wallet-months",
            rangeKind: "declared_coverage",
            precision: "month",
            basis: "source",
            startValue: months[0]!,
            endValue: months.at(-1)!,
            unitKey: UNIT_KEY,
          } satisfies TerminalRange,
        ]),
  ];
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
      requestedScope: {
        scopeKind: "date_range",
        startValue: input.window.from,
        endValue: input.window.to,
        unitKeys: [UNIT_KEY],
      },
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      providerOutcome: outcome,
      coverageStatus,
      persistenceComplete: true,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
      units,
      ranges,
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
  const plan = await sonyBankRunPlan(input);
  const result = await persistRun(bucket, plan);
  return { result, artifactCount: plan.artifacts.length };
}

/** Safe, code-only diagnostics for a persist attempt: no keys of provider
 * origin, no amounts, no bodies. */
export function sharedRunDiagnostic(
  input: SharedRunInput,
  outcome: SharedRunOutcome,
): Record<string, unknown> {
  const result = outcome.result;
  return {
    event: "sony-bank-shared-collection",
    runId: input.runId,
    status: input.status,
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
