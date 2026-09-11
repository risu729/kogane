export type JsonObject = Record<string, unknown>;

export interface VPointPayCredential {
  refreshToken: string;
  deviceUuid: string;
}

export interface RawArtifact {
  dataset: string;
  filename: string;
  mediaType: "application/json";
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
  source: "v-point-pay";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  earliestMonth: string | null;
  latestMonth: string | null;
  transactionMonthCount: number;
  transactionCount: number;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  /** Where the run was persisted (unified plan U09). */
  target: "legacy" | "shared";
  /**
   * `legacy`: the collector manifest object key in the per-source bucket.
   * `shared`: `runs/v-point-pay/<runId>/terminal.json` in the DATA bucket.
   */
  manifestKey: string;
}

export interface ApiCollection {
  artifacts: RawArtifact[];
  earliestMonth: string;
  latestMonth: string;
  transactionMonthCount: number;
  transactionCount: number;
}
