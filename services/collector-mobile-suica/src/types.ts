export interface SessionEnvelope {
  capturedAt?: string;
  cookieHeader: string;
  formBody: string;
  userAgent: string;
}

export interface HistoryRow {
  date: string;
  typeFrom: string;
  placeFrom: string;
  typeTo: string;
  placeTo: string;
  balanceText: string;
  amountText: string;
  balance: number | null;
  amount: number | null;
  kind: "rail" | "bus" | "payment" | "charge" | "carryover" | "other";
}

export interface RawArtifact {
  dataset: string;
  filename: string;
  mediaType: string;
  body: string | Uint8Array;
}

export interface StoredArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

export interface CollectionFailure {
  operation: "collect" | "pagination" | "r2";
  errorType: string;
  errorCode: "collection_failed" | "history_boundary_unproven" | "artifact_store_failed";
  artifactKey?: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "mobile-suica";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  asOfDateJst: string;
  capturedSessionAt?: string;
  transactionCount: number;
  pageCount: number;
  complete: boolean;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
  central: RawEvidenceImportResult;
}

export interface RawEvidenceImportResult {
  source: "mobile-suica";
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export interface RawEvidenceBackfillPageResult {
  source: "mobile-suica";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  deferredManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  failedManifestKey?: string;
  result?: RawEvidenceImportResult;
}
