export type JsonObject = Record<string, unknown>;

export interface SonyBankCredential {
  branchNum: string;
  accountNum: string;
  loginPwd: string;
}

export interface RawArtifact {
  dataset: string;
  filename: string;
  mediaType: string;
  body: string | ArrayBuffer;
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
  source: "sony-bank";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  window: { from: string; to: string };
  transactionCount: number;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
}
