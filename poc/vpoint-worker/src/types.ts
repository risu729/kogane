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
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
}
