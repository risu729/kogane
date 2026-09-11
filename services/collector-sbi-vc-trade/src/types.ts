export interface SessionMaterial {
  cookies: {
    vctBffSid: string;
    jSessionId: string;
    awsAlbApp: [string, string, string, string];
    awsAlb: string;
    awsAlbCors: string;
  };
  secureKey: string;
}

export interface EncryptedSession {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface HealthState {
  initializedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastHttpStatus: number | null;
  lastGatewayStatus: string | null;
  lastCookieUpdateCount: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastReauthAttemptAt: string | null;
  lastReauthSuccessAt: string | null;
  lastReauthErrorCode: string | null;
}

export interface GatewayMeta {
  status: string;
  secureKey?: string;
}

export interface PasskeyCredential {
  credentialId: string;
  keyValue: string;
  rpId: "sbivc.co.jp";
  userHandle: string;
  counter: 0;
  keyAlgorithm: "ECDSA";
  keyCurve: "P-256";
}

export type ReadEvent =
  | "cashBalanceList"
  | "accountMargin"
  | "positionSummaryList"
  | "executionList"
  | "getCashflowList";

export interface CollectorArtifact {
  dataset: string;
  body: string;
}

export interface StoredArtifact {
  dataset: string;
  key: string;
  sha256: string;
  bytes: number;
}

export interface CollectionFailure {
  operation: string;
  errorCode: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "sbi-vc-trade";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionSummary {
  runId: string;
  status: CollectionManifest["status"];
  artifactCount: number;
  failureCount: number;
  manifestKey: string;
  /** Legacy mode only: the central importer's answer, or why it was deferred. */
  central?: RawEvidenceImportResult | RawEvidenceDeferredResult;
  /** Shared mode only (U09): what `persistRun` did in the DATA bucket. */
  shared?: SharedRunSummary;
}

/**
 * U09: the outcome of writing one run into the shared DATA bucket. It lives
 * here rather than in `shared-collection.ts` so the summary type and the
 * collection types stay one module, with no import cycle through the worker.
 */
export interface SharedRunSummary {
  readonly target: "shared";
  readonly outcome: "persisted" | "already_persisted" | "conflict" | "incomplete";
  readonly terminalKey: string;
  readonly terminalDigest: string;
  readonly objectCount: number;
  /** True when only a person can clear what stopped the run (12 §3). */
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}

export interface RawEvidenceDeferredResult {
  deferred: true;
  reason: "worker-invocation-chain-limit";
  artifactCount: number;
}

export interface RawEvidenceImportResult {
  source: "sbi-vc-trade";
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: boolean;
  allObjectsReused: boolean;
}

export interface RawEvidenceBackfillPageResult {
  source: "sbi-vc-trade";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  deferredManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  deferredReason?: "sync_import_worker_chain_limit";
  result?: RawEvidenceImportResult;
}
