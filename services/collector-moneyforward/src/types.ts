export interface MoneyForwardCredential {
  rpId: "id.moneyforward.com";
  origin: "https://id.moneyforward.com";
  credentialId: string;
  keyValue: string;
  userHandle?: string;
  counter: number;
}

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
  reasonCode?: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "moneyforward-me";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  /**
   * Present only when the collection finished and returned them. A run that
   * stopped earlier never learned them, so they are absent, never 0 (INV05);
   * its `failures` carry the reason.
   */
  accountDetailCount?: number;
  monthlyFragmentCount?: number;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}
