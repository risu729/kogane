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
