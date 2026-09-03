export interface SbiArtifactManifest {
  dataset: string;
  key: string;
  sha256: string;
  bytes: number;
  window?: { from: string; to: string };
}

export interface SbiFailure {
  scope: "domestic" | "foreign";
  operation: string;
  errorType: string;
  message: string;
}

export interface SbiManifest {
  schemaVersion: "sbi-worker-poc-v1";
  source: "sbi-securities";
  runId: string;
  scope: "all" | "domestic" | "foreign";
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  artifacts: SbiArtifactManifest[];
  failures: SbiFailure[];
}

export interface CentralInventoryItem {
  artifactKey: string;
  sha256: string;
  descriptorSha256: string;
}

export interface SbiVcArtifactManifest {
  dataset: string;
  key: string;
  sha256: string;
  bytes: number;
}

export interface SbiVcFailure {
  operation: string;
  errorCode: string;
}

export interface SbiVcManifest {
  schemaVersion: "sbi-vc-trade-worker-poc-v1";
  source: "sbi-vc-trade";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  artifacts: SbiVcArtifactManifest[];
  failures: SbiVcFailure[];
}

export interface SonyArtifactManifest {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

export interface SonyFailure {
  operation: string;
  errorType: string;
  message: string;
}

export interface SonyManifest {
  schemaVersion: "sony-bank-worker-poc-v2";
  source: "sony-bank";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  window: { from: string; to: string };
  transactionCount: number;
  artifacts: SonyArtifactManifest[];
  failures: SonyFailure[];
}
