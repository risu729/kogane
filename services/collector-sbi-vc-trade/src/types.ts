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
  /**
   * `OK`, or `rejected` for any other gateway status. Closed on purpose: the
   * status string the provider sent is provider text and never reaches the
   * stored health record or a log line.
   */
  lastGatewayStatus: "OK" | "rejected" | null;
  lastCookieUpdateCount: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastReauthAttemptAt: string | null;
  lastReauthSuccessAt: string | null;
  lastReauthErrorCode: string | null;
  /**
   * The first `manual_agreement_required` refusal since the last successful
   * login; it bounds the hourly retries. Null until such a refusal, and again
   * after a successful login.
   */
  manualAgreementPendingSince: string | null;
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
  | "getCashflowList"
  | "tradeReportList"
  | "monthlyTradeReport"
  | "plCalcData";

export interface ProviderDocument {
  kind: "monthly-report" | "pnl-data";
  /** The provider's complete basisYmdDate, passed unchanged to downloads. */
  basisDate: string;
  mediaType: "application/pdf" | "application/zip";
}

export interface CollectorArtifact {
  dataset: string;
  body: string | Uint8Array;
  document?: ProviderDocument;
}

export interface StoredArtifact {
  dataset: string;
  key: string;
  sha256: string;
  bytes: number;
  artifactKey?: string;
  document?: ProviderDocument;
}

export interface CollectionFailure {
  operation: string;
  errorCode: string;
}

export interface CollectionUnit {
  unitKey:
    | "account"
    | "full-cashflows"
    | "report-annual-index"
    | `report-index-${number}`
    | `monthly-report-${string}`
    | `pnl-data-${string}`
    | `pnl-check-${string}`
    | "report-year-range";
  status: "success" | "partial" | "failed";
  errorCode?: string;
  observedCount?: number;
  expectedCount?: number;
  absenceMeaning?: "complete-empty" | "not-applicable";
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
  /** Absent on legacy manifests, whose whole run was one account unit. */
  units?: CollectionUnit[];
}

export interface CollectionSummary {
  runId: string;
  status: CollectionManifest["status"];
  artifactCount: number;
  failureCount: number;
  manifestKey: string;
  /** U09: what `persistRun` did in the DATA bucket. */
  shared?: SharedRunSummary;
}

/**
 * U09: the outcome of writing one run into the shared DATA bucket. It lives
 * here rather than in `shared-collection.ts` so the summary type and the
 * collection types stay one module, with no import cycle through the worker.
 */
export interface SharedRunSummary {
  readonly runId: string;
  readonly target: "shared";
  readonly outcome: "persisted" | "already_persisted" | "conflict" | "incomplete";
  readonly terminalKey: string;
  readonly terminalDigest: string;
  readonly objectCount: number;
  /**
   * Where the collector manifest is in DATA (`objects/<2 hex>/<sha256>`). It
   * takes the place of the staging manifest key in shared mode, where nothing
   * is staged. Empty until a terminal exists.
   */
  readonly manifestObjectKey: string;
  /** True when only a person can clear what stopped the run (12 §3). */
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}
