// The shared DATA-bucket write path for the SMBC Direct backfill collector (U09).
//
// This source is human-triggered: a person approves a QR challenge, and the
// backfill then runs across many Durable Object alarms, one month chunk at a
// time. Each stopped session publishes an immutable terminal. Resumes publish
// new partial evidence or a complete parseable snapshot in continuation
// terminals (ADR 0044).
//
// Because the chunks are written across alarms, the bytes are re-read from the
// collector's own staging bucket at that point and verified against the
// manifest before anything is planned. That is the same staging bucket the
// importer reads today; it is the collector's outbox, not a second central
// copy, and it goes away with the legacy route in U15.
//
// What is planned is exactly what the importer forwards centrally today: the
// provider's own response bytes and the collector's normalized counterparts,
// verbatim, plus the collector manifest. The SMBC credential, the encrypted
// session envelope, the challenge state and the page cookies are Durable
// Object state and never enter a plan; only the opaque session *generation*
// reference reaches the terminal (12 §4).
import {
  persistRun,
  readTerminal,
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
import { sha256Hex } from "./storage";
import { lastFinishedJapanDay, monthRanges } from "./dates";
import {
  FOREIGN_BALANCE_UNIT,
  FOREIGN_HISTORY_UNIT,
  foreignFailureCodes,
} from "./foreign-ordinary";
import type { BackfillManifest, BackfillProgress, StoredArtifact } from "./types";

/** `runs/<source>/…` in DATA. The Processor maps it to the CORE source `smbc-bank`. */
export const SHARED_SOURCE = "smbc-direct";
export const PRODUCER = "collector-smbc-direct";
const MANIFEST_ARTIFACT_KEY = "manifest.json";
const JSON_MEDIA_TYPE = "application/json";
/** The legacy yen unit retained by the central descriptors. */
const UNIT_KEY = "account";
const UNIT_KIND = "collection";

const PROVIDER_RESPONSE_ROLE = "provider_response";
const COLLECTOR_DERIVED_ROLE = "collector_derived";
const COLLECTOR_MANIFEST_ROLE = "collector_manifest";

/**
 * A run's bytes are held in memory while the terminal is planned. The cap stops
 * a very long backfill from failing on memory in a way that would look like a
 * storage error; exceeding it leaves no terminal and the run stays unfinished,
 * which is the honest outcome.
 */
export const MAX_SHARED_RUN_BYTES = 48 * 1024 * 1024;

/** Resuming this source always needs a fresh human approval, never a retry. */
const HUMAN_REQUIRED_CODE = "human_required_approval";

class SharedCollectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SharedCollectionError";
  }
}

const encoder = new TextEncoder();

/** Where the ops API's operation and this attempt enter the terminal (03 §3). */
interface SharedRunIdentity {
  readonly operationId?: string;
  readonly attemptId: string;
  /**
   * The generation of the authenticated session that opened this backfill. A
   * initial terminal keeps the generation it started with; continuations name
   * the current approved generation. Only opaque ids travel (12 §4).
   */
  readonly acquisitionSessionRef?: string;
  readonly continuationSessionRef?: string;
}

/**
 * An incomplete backfill can only continue after a person approves a new
 * challenge: this source has no unattended re-authentication at all, and none
 * was added (12 §3, G3-10, G3-11).
 */
export function waitingForHuman(manifest: BackfillManifest): boolean {
  return manifest.status !== "success" || sharedOutcome(manifest).coverageStatus !== "complete";
}

/** True while the person who started the backfill still has to act. */
export function progressWaitingForHuman(progress: BackfillProgress): boolean {
  return (
    progress.phase === "waiting_for_approval" ||
    progress.phase === "failed" ||
    progress.phase === "partial" ||
    progress.coverageErrorCode === "coverage_day_not_finished" ||
    progress.lastErrorCode === "approval_not_completed_generate_new_qr"
  );
}

/** A `partial` run stays partial and a `failed` run never claims coverage. */
export function sharedOutcome(manifest: BackfillManifest): {
  providerOutcome: ProviderOutcome;
  coverageStatus: CoverageStatus;
  safeErrorCode?: string;
} {
  if (manifest.status === "success") {
    // Old saved successes may have read their last day while it was still
    // open. Publication retries must not turn that snapshot complete later.
    // Legacy artifacts lack request timestamps; the run start is a safe lower
    // bound. Earlier closed months remain usable in an approved continuation.
    const closed =
      manifest.requestedRange.end <=
        lastFinishedJapanDay(new Date(manifest.completedAt ?? manifest.startedAt)) &&
      manifest.artifacts.every(
        (artifact) =>
          !artifact.range ||
          artifact.range.end <=
            lastFinishedJapanDay(new Date(artifact.collectedAt ?? manifest.startedAt)),
      );
    if (!closed) {
      return {
        providerOutcome: "success",
        coverageStatus: "partial",
        safeErrorCode: "coverage_day_not_finished",
      };
    }
    // Every requested month chunk was collected and stored.
    return { providerOutcome: "success", coverageStatus: "complete" };
  }
  const first = manifest.failureCodes[0];
  return {
    providerOutcome: manifest.status === "partial" ? "partial" : "failed",
    coverageStatus: manifest.status === "partial" ? "partial" : "unknown",
    safeErrorCode: first === undefined || first === "session_missing" ? HUMAN_REQUIRED_CODE : first,
  };
}

/** The base media type, without parameters: a terminal names no charset. */
export function baseMediaType(value: string): string {
  const base = (value.split(";")[0] ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(base)) {
    throw new SharedCollectionError("shared_artifact_media_type_invalid");
  }
  return base;
}

/** The artifact's key inside the run, the same relative key central records. */
export function relativeArtifactKey(key: string, prefix: string): string {
  if (!key.startsWith(`${prefix}/`)) {
    throw new SharedCollectionError("shared_artifact_key_outside_run");
  }
  return key.slice(prefix.length + 1);
}

function role(artifact: StoredArtifact): string {
  if (foreignArtifact(artifact)) return "sanitized_provider_capture";
  return artifact.dataset.endsWith("-normalized") ? COLLECTOR_DERIVED_ROLE : PROVIDER_RESPONSE_ROLE;
}

function foreignArtifact(artifact: StoredArtifact): boolean {
  return (
    artifact.dataset === "foreign-ordinary-aud-balance" ||
    artifact.dataset === "foreign-ordinary-aud-history"
  );
}

function artifactUnit(artifact: StoredArtifact): string {
  return artifact.dataset === "foreign-ordinary-aud-balance"
    ? FOREIGN_BALANCE_UNIT
    : artifact.dataset === "foreign-ordinary-aud-history"
      ? FOREIGN_HISTORY_UNIT
      : UNIT_KEY;
}

/** Rescue only complete yen acquisition when its sole failure belongs to
 * the newly independent AUD unit. A failed yen chunk remains ineligible. */
function yenUnitComplete(manifest: BackfillManifest): boolean {
  const foreign = manifest.foreignOrdinary;
  const foreignFailures = foreignFailureCodes(foreign);
  if (
    manifest.status !== "partial" ||
    foreignFailures.length === 0 ||
    !foreignFailures.every((code) => code.startsWith("foreign_")) ||
    manifest.failureCodes.length === 0 ||
    !manifest.failureCodes.every((code) => foreignFailures.includes(code))
  )
    return false;
  const expected = monthRanges(manifest.requestedRange.start, manifest.requestedRange.end);
  const yen = manifest.artifacts.filter((artifact) => !foreignArtifact(artifact));
  const chunks = yen.filter((artifact) => artifact.dataset === "transactions-normalized");
  return (
    manifest.completedChunks === expected.length &&
    manifest.totalChunks === expected.length &&
    yen.filter((artifact) => artifact.dataset === "balance-normalized").length === 1 &&
    chunks.length === expected.length &&
    expected.every((range) =>
      chunks.some(
        (artifact) => artifact.range?.start === range.start && artifact.range.end === range.end,
      ),
    ) &&
    manifest.requestedRange.end <=
      lastFinishedJapanDay(new Date(manifest.completedAt ?? manifest.startedAt)) &&
    yen.every(
      (artifact) =>
        !artifact.range ||
        artifact.range.end <=
          lastFinishedJapanDay(new Date(artifact.collectedAt ?? manifest.startedAt)),
    )
  );
}

function rangeKey(range: { start: string; end: string }): string {
  return `chunk-${range.start}-${range.end}`;
}

function ranges(manifest: BackfillManifest): TerminalRange[] {
  const entries: TerminalRange[] = [
    {
      rangeKey: "requested",
      rangeKind: "requested",
      precision: "date",
      basis: "request",
      startValue: manifest.requestedRange.start,
      endValue: manifest.requestedRange.end,
      unitKey: UNIT_KEY,
    },
  ];
  if (manifest.foreignOrdinary?.history)
    entries.push({
      rangeKey: "foreign-requested",
      rangeKind: "requested",
      precision: "date",
      basis: "request",
      startValue: manifest.foreignOrdinary.range.start,
      endValue: manifest.foreignOrdinary.range.end,
      unitKey: FOREIGN_HISTORY_UNIT,
    });
  const seen = new Set<string>();
  // The raw and normalized artifacts of one month share one declared range.
  for (const artifact of manifest.artifacts) {
    if (!artifact.range) continue;
    const key = `${foreignArtifact(artifact) ? "foreign-" : ""}${rangeKey(artifact.range)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      rangeKey: key,
      rangeKind: "declared_coverage",
      precision: "date",
      basis: "request",
      startValue: artifact.range.start,
      endValue: artifact.range.end,
      unitKey: artifactUnit(artifact),
    });
  }
  return entries;
}

/** Bytes a caller already read out of the staging bucket, keyed by object key. */
type SharedArtifactBytes = ReadonlyMap<string, Uint8Array>;

export interface SharedRunInput {
  readonly manifest: BackfillManifest;
  /** The exact manifest bytes written to the staging bucket. */
  readonly manifestBytes: Uint8Array;
  readonly prefix: string;
  readonly bytesByKey: SharedArtifactBytes;
  readonly identity: SharedRunIdentity;
  readonly cumulativeManifestBytes?: Uint8Array;
}

/**
 * One planned artifact. A stored response and its normalized counterpart
 * belong to the account unit; the run's own manifest belongs to the run and
 * names no unit, so the unit's `artifactCount` is exactly the artifacts that
 * name it (ADR 0021). Until then the manifest named the unit without being
 * counted, and CORE refused the seal (`run_inventory_incomplete`).
 */
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
 * The `terminal-v1` plan for one backfill run: the collector manifest plus
 * every stored artifact. A failed run with nothing stored plans the manifest
 * alone, so it stays a failure rather than reading like a complete observation
 * of an empty account (G1-09).
 */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const artifacts: PersistArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  const foreign = input.manifest.foreignOrdinary;
  if (
    [foreign?.balance, foreign?.history].some((unit) => unit?.status === "partial") &&
    input.manifest.status === "success"
  )
    throw new SharedCollectionError("foreign_manifest_outcome_inconsistent");
  const foreignArtifacts = input.manifest.artifacts.filter(foreignArtifact);
  const balances = foreignArtifacts.filter(
    (artifact) => artifact.dataset === "foreign-ordinary-aud-balance",
  );
  const histories = foreignArtifacts.filter(
    (artifact) => artifact.dataset === "foreign-ordinary-aud-history",
  );
  if ((!foreign?.balance && balances.length > 0) || (!foreign?.history && histories.length > 0))
    throw new SharedCollectionError("foreign_manifest_scope_missing");
  if (foreign?.balance?.status === "success" && balances.length !== 1)
    throw new SharedCollectionError("foreign_manifest_inventory_incomplete");
  if (foreign?.history?.status === "success") {
    const expected = monthRanges(foreign.range.start, foreign.range.end);
    if (
      histories.length !== expected.length ||
      expected.some(
        (range) =>
          !histories.some(
            (artifact) => artifact.range?.start === range.start && artifact.range.end === range.end,
          ),
      )
    ) {
      throw new SharedCollectionError("foreign_manifest_inventory_incomplete");
    }
    if (
      foreign.range.end >
        lastFinishedJapanDay(new Date(input.manifest.completedAt ?? input.manifest.startedAt)) ||
      histories.some(
        (artifact) =>
          artifact.range!.end >
          lastFinishedJapanDay(new Date(artifact.collectedAt ?? input.manifest.startedAt)),
      )
    )
      throw new SharedCollectionError("foreign_history_window_not_closed");
  }
  for (const [index, entry] of input.manifest.artifacts.entries()) {
    const bytes = input.bytesByKey.get(entry.key);
    if (!bytes) throw new SharedCollectionError("shared_artifact_bytes_missing");
    if (bytes.byteLength !== entry.bytes || (await sha256Hex(bytes)) !== entry.sha256) {
      throw new SharedCollectionError("shared_artifact_changed");
    }
    const artifactKey = relativeArtifactKey(entry.key, input.prefix);
    artifacts.push(
      await artifactOf({
        artifactKey,
        bytes,
        mediaType: baseMediaType(entry.mediaType),
        role: role(entry),
        unitKey: artifactUnit(entry),
      }),
    );
    if (foreignArtifact(entry))
      transformations.push({
        transformationId: `sanitized-foreign-${String(index).padStart(4, "0")}`,
        stepKind: "redacted",
        transformerId: "smbc-foreign-ordinary-sanitizer",
        transformerVersion: "0.1.0",
        inputArtifactKeys: [],
        outputArtifactKey: artifactKey,
      });
    if (entry.dataset.endsWith("-normalized")) {
      const parent = artifactKey
        .replace(".normalized.json", ".raw.json.sjis")
        .replace("balance.normalized.json", "balance.raw.json.sjis");
      transformations.push({
        // Positional, not derived from the key: an artifact key may contain a
        // path separator, which a transformation id may not.
        transformationId: `extracted-${String(index).padStart(4, "0")}`,
        // v2 retains authenticated request context as well as response extraction.
        stepKind:
          input.manifest.schemaVersion === "smbc-direct-backfill-worker-poc-v1"
            ? "extracted"
            : "generated",
        transformerId: "smbc-direct-normalizer",
        transformerVersion: input.manifest.schemaVersion,
        inputArtifactKeys: input.manifest.artifacts.some(
          (candidate) => relativeArtifactKey(candidate.key, input.prefix) === parent,
        )
          ? [parent]
          : [],
        outputArtifactKey: artifactKey,
      });
    }
  }
  artifacts.push(
    await artifactOf({
      artifactKey: MANIFEST_ARTIFACT_KEY,
      bytes: input.manifestBytes,
      mediaType: JSON_MEDIA_TYPE,
      role: COLLECTOR_MANIFEST_ROLE,
    }),
  );

  if (input.cumulativeManifestBytes) {
    artifacts.push(
      await artifactOf({
        artifactKey: "backfill-manifest.json",
        bytes: input.cumulativeManifestBytes,
        mediaType: JSON_MEDIA_TYPE,
        role: COLLECTOR_MANIFEST_ROLE,
      }),
    );
  }
  const outcome = sharedOutcome(input.manifest);
  const yenComplete = yenUnitComplete(input.manifest);
  const ownYenFailure = input.manifest.failureCodes.find((code) => !code.startsWith("foreign_"));
  const yenErrorCode = !foreign
    ? outcome.safeErrorCode
    : ownYenFailure === "session_missing"
      ? HUMAN_REQUIRED_CODE
      : (ownYenFailure ??
        (outcome.safeErrorCode === "coverage_day_not_finished"
          ? outcome.safeErrorCode
          : "yen_unit_incomplete"));
  const run: TerminalRunFields = {
    source: SHARED_SOURCE,
    producer: PRODUCER,
    producerVersion: input.manifest.schemaVersion,
    runId: input.manifest.runId,
    attemptId: input.identity.attemptId,
    ...(input.identity.operationId === undefined
      ? {}
      : { operationId: input.identity.operationId }),
    ...(input.identity.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: input.identity.acquisitionSessionRef }),
    requestedScope: {
      scopeKind: "date_range",
      startValue:
        foreign && foreign.range.start < input.manifest.requestedRange.start
          ? foreign.range.start
          : input.manifest.requestedRange.start,
      endValue:
        foreign && foreign.range.end > input.manifest.requestedRange.end
          ? foreign.range.end
          : input.manifest.requestedRange.end,
      unitKeys: [
        UNIT_KEY,
        ...(foreign?.balance ? [FOREIGN_BALANCE_UNIT] : []),
        ...(foreign?.history ? [FOREIGN_HISTORY_UNIT] : []),
      ],
    },
    startedAt: input.manifest.startedAt,
    completedAt: input.manifest.completedAt ?? input.manifest.startedAt,
    providerOutcome: outcome.providerOutcome,
    coverageStatus: outcome.coverageStatus,
    persistenceComplete: true,
    // A successful provider acquisition cannot carry a run-level failure code.
    // Its partial coverage reason belongs to the account unit below.
    ...(outcome.safeErrorCode === undefined || outcome.providerOutcome === "success"
      ? {}
      : { safeErrorCode: outcome.safeErrorCode }),
    units: [
      {
        unitKey: UNIT_KEY,
        unitKind: UNIT_KIND,
        artifactCount: input.manifest.artifacts.length - foreignArtifacts.length,
        coverageStatus: yenComplete ? "complete" : outcome.coverageStatus,
        ...(yenComplete || outcome.coverageStatus === "complete" || yenErrorCode === undefined
          ? {}
          : { safeErrorCode: yenErrorCode }),
      },
      ...(
        [
          [foreign?.balance, FOREIGN_BALANCE_UNIT, balances.length],
          [foreign?.history, FOREIGN_HISTORY_UNIT, histories.length],
        ] as const
      ).flatMap(([unit, unitKey, artifactCount]) =>
        unit
          ? [
              {
                unitKey,
                unitKind: UNIT_KIND,
                artifactCount,
                coverageStatus:
                  unit.status === "success" ? ("complete" as const) : ("partial" as const),
                ...(unit.failureCode ? { safeErrorCode: unit.failureCode } : {}),
              },
            ]
          : [],
      ),
    ],
    ranges: ranges(input.manifest),
    reports:
      input.manifest.logoutSucceeded === false
        ? [
            {
              reportRef: "logout",
              reportKind: "logout",
              scope: "run",
              outcome: "failed",
              safeErrorCode: "logout_failed",
            },
          ]
        : [],
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
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}

/**
 * Reads a finished run's artifacts back out of the staging bucket. Every object
 * is verified against the manifest before it is planned, so a run whose bytes
 * changed or vanished stops without a terminal.
 */
export async function readStagedArtifacts(
  bucket: R2BucketLike,
  manifest: BackfillManifest,
): Promise<Map<string, Uint8Array>> {
  const total = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (total > MAX_SHARED_RUN_BYTES) throw new SharedCollectionError("shared_run_too_large");
  const bytesByKey = new Map<string, Uint8Array>();
  for (const artifact of manifest.artifacts) {
    const object = await bucket.get(artifact.key);
    if (!object) throw new SharedCollectionError("shared_artifact_bytes_missing");
    bytesByKey.set(artifact.key, new Uint8Array(await object.arrayBuffer()));
  }
  return bytesByKey;
}

/**
 * Persists one backfill run into DATA. Objects first, terminal last: an
 * `incomplete` result means no terminal exists and the run is not reported
 * persisted (G1-01). Nothing here re-authenticates or re-reads the provider.
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
    waitingForHuman: waitingForHuman(input.manifest),
    ...(result.outcome === "conflict" || result.outcome === "incomplete"
      ? { reasonCode: result.reasonCode }
      : {}),
  };
}

/**
 * Publish a resumed backfill without changing an earlier immutable terminal.
 * Partial continuations contain new evidence. A completed unit includes its
 * earlier ineligible chunks and excludes already eligible success rows.
 */
export async function persistBackfillRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<SharedRunSummary> {
  const root = await readTerminal(bucket, SHARED_SOURCE, input.manifest.runId);
  if (root.outcome === "blocked") throw new SharedCollectionError("shared_prior_terminal_invalid");
  const digest = await sha256Hex(input.manifestBytes);
  if (root.outcome === "missing") {
    return persistSharedRun(bucket, {
      ...input,
      identity: { ...input.identity, attemptId: "attempt-" + digest },
    });
  }
  const prefix = "runs/" + SHARED_SOURCE + "/" + input.manifest.runId + "-continuation-";
  const listed = await bucket.list({ prefix, limit: 128 });
  if (listed.truncated) throw new SharedCollectionError("shared_continuation_limit");
  const prior = [root];
  for (const object of listed.objects) {
    if (!object.key.endsWith("/terminal.json")) {
      throw new SharedCollectionError("shared_prior_terminal_invalid");
    }
    const runId = object.key.slice(
      ("runs/" + SHARED_SOURCE + "/").length,
      -"/terminal.json".length,
    );
    const read = await readTerminal(bucket, SHARED_SOURCE, runId);
    if (read.outcome !== "found") throw new SharedCollectionError("shared_prior_terminal_invalid");
    prior.push(read);
  }
  const published = new Map<string, Set<string>>();
  const parseablePublished = new Map<string, Set<string>>();
  const independentlyCompletePublished = new Map<string, Set<string>>();
  for (const read of prior) {
    if (read.manifest.producer !== PRODUCER) {
      throw new SharedCollectionError("shared_prior_terminal_invalid");
    }
    for (const artifact of read.manifest.artifacts) {
      if (artifact.role === COLLECTOR_MANIFEST_ROLE) continue;
      const hashes = published.get(artifact.artifactKey) ?? new Set<string>();
      hashes.add(artifact.sha256);
      published.set(artifact.artifactKey, hashes);
      // Partial account units are not parseable under either run or unit
      // eligibility. A complete snapshot must include their earlier evidence.
      const successfulRun =
        read.manifest.providerOutcome === "success" &&
        read.manifest.coverageStatus === "complete" &&
        read.manifest.units.every(
          (unit) => unit.coverageStatus === "complete" && unit.safeErrorCode === undefined,
        );
      const independentlyComplete =
        read.manifest.providerOutcome === "partial" &&
        [UNIT_KEY, FOREIGN_BALANCE_UNIT, FOREIGN_HISTORY_UNIT].includes(artifact.unitKey ?? "") &&
        read.manifest.units.some(
          (unit) =>
            unit.unitKey === artifact.unitKey &&
            unit.coverageStatus === "complete" &&
            unit.safeErrorCode === undefined,
        ) &&
        !read.manifest.artifacts.some(
          (candidate) =>
            candidate.role === "collector_error" &&
            (candidate.unitKey === undefined || candidate.unitKey === artifact.unitKey),
        );
      if (independentlyComplete) {
        const hashes =
          independentlyCompletePublished.get(artifact.artifactKey) ?? new Set<string>();
        hashes.add(artifact.sha256);
        independentlyCompletePublished.set(artifact.artifactKey, hashes);
      }
      if (
        successfulRun &&
        !read.manifest.artifacts.some((candidate) => candidate.role === "collector_error")
      ) {
        const eligibleHashes = parseablePublished.get(artifact.artifactKey) ?? new Set<string>();
        eligibleHashes.add(artifact.sha256);
        parseablePublished.set(artifact.artifactKey, eligibleHashes);
      }
    }
  }
  // Completed normalized chunks are not recollected by a resume. Missing or
  // changed ones refuse publication rather than silently duplicating rows.
  for (const [key, hashes] of published) {
    if (!key.endsWith(".normalized.json")) continue;
    const current = input.manifest.artifacts.find(
      (artifact) => relativeArtifactKey(artifact.key, input.prefix) === key,
    );
    if (!current || !hashes.has(current.sha256)) {
      throw new SharedCollectionError("shared_published_normalized_changed");
    }
  }
  // A later whole-run success still includes partial-run evidence: an
  // operator may have deliberately kept its eligibility run-scoped. Within
  // a partial continuation, include earlier ineligible chunks of a newly
  // completed unit, but do not republish a unit already declared complete.
  const completedPublished = new Map([...parseablePublished, ...independentlyCompletePublished]);
  const added = input.manifest.artifacts.filter((artifact) => {
    const complete =
      artifactUnit(artifact) === UNIT_KEY
        ? yenUnitComplete(input.manifest)
        : artifactUnit(artifact) === FOREIGN_BALANCE_UNIT
          ? input.manifest.foreignOrdinary?.balance?.status === "success"
          : input.manifest.foreignOrdinary?.history?.status === "success";
    const inventory =
      input.manifest.status === "success"
        ? parseablePublished
        : complete
          ? completedPublished
          : published;
    return !inventory.get(relativeArtifactKey(artifact.key, input.prefix))?.has(artifact.sha256);
  });
  const identical = prior.find((read) =>
    read.manifest.artifacts.some(
      (artifact) => artifact.role === COLLECTOR_MANIFEST_ROLE && artifact.sha256 === digest,
    ),
  );
  if (identical) {
    return {
      target: "shared",
      outcome: "already_persisted",
      terminalKey: identical.key,
      terminalDigest: identical.terminalDigest,
      objectCount: identical.manifest.artifacts.length,
      waitingForHuman: waitingForHuman(input.manifest),
    };
  }
  if (added.length === 0 && input.manifest.status === "success") {
    throw new SharedCollectionError("shared_success_without_new_evidence");
  }
  // A failed chunk may have published raw bytes only. Include those bytes as
  // input of its later normalization, without re-publishing normalized rows.
  const selected = new Set(added.map((artifact) => artifact.key));
  for (const artifact of added) {
    if (!artifact.dataset.endsWith("-normalized")) continue;
    const parent = artifact.key.replace(".normalized.json", ".raw.json.sjis");
    const raw = input.manifest.artifacts.find((candidate) => candidate.key === parent);
    if (!raw) throw new SharedCollectionError("shared_normalized_parent_missing");
    selected.add(raw.key);
  }
  const artifacts = input.manifest.artifacts.filter((artifact) => selected.has(artifact.key));
  const starts = artifacts.flatMap((artifact) =>
    !foreignArtifact(artifact) && artifact.range ? [artifact.range.start] : [],
  );
  const remaining = monthRanges(
    input.manifest.requestedRange.start,
    input.manifest.requestedRange.end,
  )[input.manifest.completedChunks];
  const start = starts.sort()[0] ?? remaining?.start ?? input.manifest.requestedRange.start;
  const { foreignOrdinary: foreignProgress, ...priorManifest } = input.manifest;
  const balanceProgress =
    foreignProgress?.balance &&
    (foreignProgress.balance.status === "partial" ||
      artifacts.some((artifact) => artifact.dataset === "foreign-ordinary-aud-balance"))
      ? foreignProgress.balance
      : undefined;
  const historyProgress =
    foreignProgress?.history &&
    (foreignProgress.history.status === "partial" ||
      artifacts.some((artifact) => artifact.dataset === "foreign-ordinary-aud-history"))
      ? foreignProgress.history
      : undefined;
  const manifest: BackfillManifest = {
    ...priorManifest,
    ...(foreignProgress && (balanceProgress || historyProgress)
      ? {
          foreignOrdinary: {
            range: foreignProgress.range,
            ...(balanceProgress ? { balance: balanceProgress } : {}),
            ...(historyProgress ? { history: historyProgress } : {}),
          },
        }
      : {}),
    runId: input.manifest.runId + "-continuation-" + digest,
    status: added.length === 0 ? "failed" : input.manifest.status,
    requestedRange: { start, end: input.manifest.requestedRange.end },
    completedChunks: artifacts.filter((artifact) => artifact.dataset === "transactions-normalized")
      .length,
    totalChunks: monthRanges(start, input.manifest.requestedRange.end).length,
    transactionCount: artifacts.reduce(
      (count, artifact) =>
        count +
        (artifact.dataset === "transactions-normalized" ? (artifact.transactionCount ?? 0) : 0),
      0,
    ),
    artifacts,
  };
  if (manifest.status === "success") {
    const expected = monthRanges(start, manifest.requestedRange.end);
    const collected = artifacts.filter(
      (artifact) => artifact.dataset === "transactions-normalized",
    );
    if (
      collected.length !== expected.length ||
      expected.some(
        (range) =>
          !collected.some(
            (artifact) => artifact.range?.start === range.start && artifact.range.end === range.end,
          ),
      )
    )
      throw new SharedCollectionError("shared_continuation_coverage_incomplete");
  }
  const segmentBytes = encoder.encode(
    JSON.stringify({
      ...manifest,
      backfillRunId: input.manifest.runId,
      priorTerminalKeys: prior.map((read) => read.key).sort(),
    }) + "\n",
  );
  return persistSharedRun(bucket, {
    ...input,
    manifest,
    manifestBytes: segmentBytes,
    cumulativeManifestBytes: input.manifestBytes,
    identity: {
      ...input.identity,
      attemptId: "attempt-" + digest,
      ...(input.manifest.status === "success" || input.identity.continuationSessionRef === undefined
        ? {}
        : {
            acquisitionSessionRef: input.identity.continuationSessionRef,
          }),
    },
  });
}

/** `persisted` and `already_persisted` are the only completion outcomes. */
export function sharedRunPersisted(summary: SharedRunSummary): boolean {
  return summary.outcome === "persisted" || summary.outcome === "already_persisted";
}

/** The exact staging bytes of a manifest, so the terminal names what was stored. */
export function manifestBytes(manifest: BackfillManifest): Uint8Array {
  return encoder.encode(`${JSON.stringify(manifest)}\n`);
}

/**
 * The Workers `R2Bucket` binding seen through the contract's minimal surface.
 * They are the same object: `R2BucketLike` names exactly the five methods
 * `persistRun` and the staged read call.
 */
export function dataBucket(bucket: R2Bucket): R2BucketLike {
  return bucket as unknown as R2BucketLike;
}
