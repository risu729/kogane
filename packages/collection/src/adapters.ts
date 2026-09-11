// Legacy per-source bucket layout → `terminal-v1`.
//
// Every collector today writes its own bucket in its own shape and the
// importer reads it (`services/collector-r2-importer/src/adapters/`). The
// shared contract does not replace those buckets: plan 03 §7 keeps them as
// read sources until nothing is left only there. What this module adds is one
// named mapping from such a layout to a terminal-v1 persist plan, so a
// migration or a re-persist produces exactly the manifest a new-style run
// would have produced.
//
// This is a pure mapping. It reads no bucket, calls no service, and does not
// modify the importer: the adapter's caller supplies the bytes it already
// read, and `persistRun` does the writing.
//
// It stores nothing verbatim. Legacy responses carry session material the
// importer strips before anything reaches central storage (plan 03 §2:
// responses that contain credentials never flow into the object area as
// they are), and that sanitizer lives in the importer, not here. So every
// byte the adapter puts in a plan is one the caller has already passed
// through a named sanitizer, and the plan records that step as a `redacted`
// transformation from the legacy key. The legacy terminal record itself is
// parsed for identity, timestamps and outcome and is not stored either.
import {
  type CoverageStatus,
  type ProviderOutcome,
  type TerminalRange,
  type TerminalReport,
  type TerminalTransformation,
  type TerminalUnit,
} from "./manifest";
import type { PersistArtifact, PersistRunPlan } from "./writer";

export class LegacyAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyAdapterError";
  }
}

/** Run identity derived from a legacy terminal object key alone. */
export interface LegacyRunIdentity {
  /** The source id the run belongs to; never merged with another source. */
  readonly source: string;
  /** The terminal-v1 run id. Distinct legacy sub-runs get distinct ids. */
  readonly runId: string;
  /** Prefix in the legacy bucket that holds this run's objects. */
  readonly legacyPrefix: string;
  /** Shared by every run of one acquisition session (plan 03 §3). */
  readonly acquisitionSessionRef?: string;
  /** The unit (card, account, container) this legacy sub-run covers. */
  readonly unitKey?: string;
}

/** The sanitizer a caller ran over a legacy object before handing it over. */
export interface LegacySanitizer {
  readonly transformerId: string;
  readonly transformerVersion: string;
}

export interface LegacyObject {
  /** Key of the raw object in the legacy bucket; recorded as the transformation input. */
  readonly legacyKey: string;
  /** The *sanitized* bytes to store, and their digest. Never the raw response. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mediaType?: string;
  readonly role: string;
  readonly sanitizer: LegacySanitizer;
}

export interface LegacyRunInput {
  readonly identity: LegacyRunIdentity;
  /**
   * The legacy terminal record (manifest/error) key and bytes. They are read
   * for identity, timestamps and outcome only; the record is not stored. A
   * caller that wants it kept passes a sanitized copy through `objects`.
   */
  readonly terminalKey: string;
  readonly terminalBytes: Uint8Array;
  /** The run's other objects, already read, sanitized and hashed by the caller. */
  readonly objects: readonly LegacyObject[];
}

/**
 * What a legacy layout must answer to be re-persisted under the shared
 * contract. Implementations stay pure: given keys and bytes, produce a plan.
 */
export interface LegacyCollectionAdapter {
  readonly sourceId: string;
  /** Recorded for provenance; this package never binds to it. */
  readonly legacyBucketName: string;
  /** The object-name suffixes that mark a finished legacy run. */
  readonly terminalSuffixes: readonly string[];
  /** Version of this mapping; part of the resulting `producerVersion`. */
  readonly contractVersion: string;
  /** Null when the key is not a terminal of this source's layout. */
  matchTerminalKey(key: string): LegacyRunIdentity | null;
  /** Keys of the objects the run needs, relative to the legacy bucket. */
  requiredObjectKeys(input: Omit<LegacyRunInput, "objects">): readonly string[];
  toPersistPlan(input: LegacyRunInput): PersistRunPlan;
}

function decodeJson(bytes: Uint8Array, code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LegacyAdapterError(code);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyAdapterError(code);
  }
  return value as Record<string, unknown>;
}

function requiredIso(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new LegacyAdapterError(code);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Vpass: the worked example.
//
// `poc/vpass-json` writes
//   vpass/<yyyy>/<mm>/<dd>/<runId>/<card-NNN>/snapshot.json
//   vpass/<yyyy>/<mm>/<dd>/<runId>/<card-NNN>/manifest.json   (success)
//   vpass/<yyyy>/<mm>/<dd>/<runId>/<card-NNN>/error.json      (failure)
// and the importer recognises the same two terminal suffixes under the same
// prefix (`services/collector-r2-importer/docs/r2-outbox-reconciler.md`). The
// key grammar below is the same one, kept here as data rather than imported,
// because a pure package must not depend on a Worker.
//
// One Vpass acquisition session visits several cards under one run timestamp.
// Each card is its own terminal-v1 run (`<runId>-<card>`) and they all carry
// the session ref, so the cards stay distinguishable instead of collapsing
// into one run whose provenance is lost.
// ---------------------------------------------------------------------------

const VPASS_TERMINAL_KEY =
  /^vpass\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:\/(card-\d{3}))?\/(manifest|error)\.json$/u;
const VPASS_MONTH = /^\d{6}$/u;

export const VPASS_LEGACY_CONTRACT_VERSION = "vpass-legacy-terminal-v1";

function vpassRunIdToIso(runId: string): string {
  const [date, time] = runId.split("T") as [string, string];
  const [hour, minute, second, millisecond] = time.slice(0, -1).split("-") as [
    string,
    string,
    string,
    string,
  ];
  return `${date}T${hour}:${minute}:${second}.${millisecond}Z`;
}

export const VPASS_LEGACY_ADAPTER: LegacyCollectionAdapter = {
  sourceId: "vpass",
  legacyBucketName: "kogane-vpass-collector-poc",
  terminalSuffixes: ["manifest.json", "error.json"],
  contractVersion: VPASS_LEGACY_CONTRACT_VERSION,

  matchTerminalKey(key) {
    const match = VPASS_TERMINAL_KEY.exec(key);
    if (!match) return null;
    const [, year, month, day, legacyRunId, cardLabel, kind] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string,
    ];
    // The path date must agree with the run id, exactly as the importer checks.
    if (vpassRunIdToIso(legacyRunId).slice(0, 10) !== `${year}-${month}-${day}`) return null;
    const unitKey = cardLabel ?? "run";
    return {
      source: "vpass",
      runId: `${legacyRunId}-${unitKey}`,
      legacyPrefix: key.slice(0, -`${kind}.json`.length),
      acquisitionSessionRef: legacyRunId,
      unitKey,
    };
  },

  requiredObjectKeys(input) {
    const kind = input.terminalKey.endsWith("error.json") ? "error" : "manifest";
    return kind === "error" ? [] : [`${input.identity.legacyPrefix}snapshot.json`];
  },

  toPersistPlan(input) {
    const kind = input.terminalKey.endsWith("error.json") ? "error" : "manifest";
    const record = decodeJson(input.terminalBytes, "vpass_terminal_json_invalid");
    const identity = input.identity;
    if (record.runId !== (identity.acquisitionSessionRef ?? identity.runId)) {
      throw new LegacyAdapterError("vpass_run_id_mismatch");
    }
    const startedAt = requiredIso(record.startedAt, "vpass_started_at_invalid");
    const completedAt = requiredIso(
      kind === "error" ? record.failedAt : record.completedAt,
      "vpass_completed_at_invalid",
    );

    const providerOutcome: ProviderOutcome = kind === "error" ? "failed" : "success";
    // A Vpass card exposes a rolling window of statement months, so even a
    // fully successful run is not a claim about the card's whole history.
    const coverageStatus: CoverageStatus = kind === "error" ? "unknown" : "partial";

    const artifacts: PersistArtifact[] = [];
    const transformations: TerminalTransformation[] = [];
    for (const object of input.objects) {
      if (!object.legacyKey.startsWith(identity.legacyPrefix)) {
        throw new LegacyAdapterError("vpass_object_outside_run");
      }
      const artifactKey = object.legacyKey.slice(identity.legacyPrefix.length);
      artifacts.push({
        artifactKey,
        sha256: object.sha256,
        byteSize: object.bytes.byteLength,
        mediaType: object.mediaType ?? "application/json",
        role: object.role,
        unitKey: identity.unitKey ?? "run",
        body: { kind: "bytes", bytes: object.bytes },
      });
      // Provenance: the stored bytes are the sanitizer's output over the
      // legacy object, which is not itself among the artifacts.
      transformations.push({
        transformationId: `redacted:${artifactKey.replaceAll("/", ":")}`,
        stepKind: "redacted",
        transformerId: object.sanitizer.transformerId,
        transformerVersion: object.sanitizer.transformerVersion,
        inputArtifactKeys: [object.legacyKey],
        outputArtifactKey: artifactKey,
      });
    }

    const months = vpassMonths(record);
    const units: TerminalUnit[] = [
      {
        unitKey: identity.unitKey ?? "run",
        unitKind: "card",
        artifactCount: artifacts.length,
        coverageStatus,
        ...(kind === "error" ? { safeErrorCode: "collector_failed" } : {}),
      },
    ];
    const ranges: TerminalRange[] =
      months.length === 0
        ? []
        : [
            {
              rangeKey: "statement-months",
              rangeKind: "declared_coverage",
              precision: "month",
              basis: "manifest",
              startValue: months[0]!,
              endValue: months.at(-1)!,
              unitKey: identity.unitKey ?? "run",
            },
          ];
    const reports: TerminalReport[] = [
      {
        reportRef: "terminal",
        reportKind: "terminal",
        scope: "run",
        outcome: providerOutcome,
        ...(kind === "error" ? { safeErrorCode: "collector_failed" } : {}),
      },
    ];

    return {
      run: {
        source: "vpass",
        producer: "vpass-json",
        producerVersion: VPASS_LEGACY_CONTRACT_VERSION,
        runId: identity.runId,
        attemptId: `legacy-${identity.runId}`,
        ...(identity.acquisitionSessionRef === undefined
          ? {}
          : { acquisitionSessionRef: identity.acquisitionSessionRef }),
        requestedScope: {
          scopeKind: "full_snapshot",
          startValue: null,
          endValue: null,
          unitKeys: [identity.unitKey ?? "run"],
        },
        startedAt,
        completedAt,
        providerOutcome,
        coverageStatus,
        persistenceComplete: true,
        ...(kind === "error" ? { safeErrorCode: "collector_failed" } : {}),
        units,
        ranges,
        reports,
        transformations,
      },
      artifacts,
    };
  },
};

function vpassMonths(record: Record<string, unknown>): string[] {
  const months = record.months;
  if (months === undefined || months === null) return [];
  if (typeof months !== "object" || Array.isArray(months)) {
    throw new LegacyAdapterError("vpass_months_invalid");
  }
  const keys = Object.keys(months as Record<string, unknown>);
  for (const key of keys) {
    if (!VPASS_MONTH.test(key)) throw new LegacyAdapterError("vpass_months_invalid");
  }
  return keys.map((key) => `${key.slice(0, 4)}-${key.slice(4)}`).sort();
}

export const LEGACY_ADAPTERS: readonly LegacyCollectionAdapter[] = [VPASS_LEGACY_ADAPTER];

/** The adapter whose layout claims this legacy key, if any. */
export function matchLegacyTerminal(
  key: string,
): { adapter: LegacyCollectionAdapter; identity: LegacyRunIdentity } | null {
  for (const adapter of LEGACY_ADAPTERS) {
    const identity = adapter.matchTerminalKey(key);
    if (identity) return { adapter, identity };
  }
  return null;
}
