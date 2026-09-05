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
  historyTotal: number;
  historyPageCount: number;
  vMoneyHistoryTotal: number;
  vMoneyHistoryPageCount: number;
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
    appLedgerStatus:
      | "unavailable-no-live-snapshot"
      | "available-not-compared";
  };
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
  central: RawEvidenceImportResult;
}

export interface RawEvidenceImportResult {
  source: "v-point";
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  allObjectsReused: boolean;
}

export interface RawEvidenceBackfillPageResult {
  source: "v-point";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  deferredManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  result?: RawEvidenceImportResult;
}
