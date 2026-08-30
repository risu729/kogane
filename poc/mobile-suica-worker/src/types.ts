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
  operation: string;
  errorType: string;
  message: string;
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
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
}
