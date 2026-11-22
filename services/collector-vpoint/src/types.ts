export type JsonObject = Record<string, unknown>;

export interface RawArtifact {
  dataset: string;
  filename: string;
  mediaType: string;
  body: string;
}

export interface StoredArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

export interface CollectionFailure {
  operation: string;
  errorType: string;
  message: string;
  stage?: string;
  failureCode?: string;
  httpStatus?: number;
  applicationCode?: string;
  reasonCode?: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "v-point";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  /**
   * The four history counts are present only when both history walks finished
   * and the collection returned them. A run that stopped earlier never learned
   * them, so they are absent, never 0 (INV05); its `failures` carry the reason.
   */
  historyTotal?: number;
  historyPageCount?: number;
  vMoneyHistoryTotal?: number;
  vMoneyHistoryPageCount?: number;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
  emailReconciliation?: {
    reportKey: string;
    emailEventCount: number;
    comparableCount: number;
    matchedCount: number;
    ambiguousCount: number;
    unmatchedCount: number;
    notComparableCount: number;
    appLedgerStatus: "unavailable-no-live-snapshot" | "available-not-compared";
  };
}
