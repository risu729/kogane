export interface SbiCredential {
  rpId: string;
  origin: string;
  credentialId: string;
  keyValue: string;
  userHandle?: string;
  counter: number;
}

export interface SbiHandshakeKey {
  publicKeyParam: string;
  privateKeyPem: string;
}

export interface WebAuthnRequest {
  challenge: string;
  rpId: string;
  csrfToken?: string;
}

export interface WebAuthnAssertion {
  id: string;
  rawId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string;
}

export interface SbiEndpoints {
  authEntryUrl: string;
  mtsBaseUrl: string;
  foreignStockBaseUrl: string;
  mainSiteBaseUrl?: string;
}

export interface DomesticSession {
  sessionId: string;
  branchCode: string;
  accountNumber: string;
  accountHash: string;
  mtsBaseUrl: string;
}

export interface ForeignSession {
  sessionId: string;
  accountId: string;
  restUrl: string;
  graphqlBffUrl: string;
  graphqlIntUrl: string;
  userAgent: string;
  marketPriceHash: string;
}

export interface Artifact {
  dataset: string;
  mediaType: "application/json";
  body: unknown;
  window?: { from: string; to: string };
}

export interface ArtifactManifest {
  dataset: string;
  key: string;
  sha256: string;
  bytes: number;
  window?: { from: string; to: string };
}

export interface CollectionFailure {
  scope: "domestic" | "foreign";
  operation: string;
  errorType: string;
  message: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "sbi-securities";
  runId: string;
  scope: CollectionScope;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  artifacts: ArtifactManifest[];
  failures: CollectionFailure[];
}

export type CollectionScope = "all" | "domestic" | "foreign";
