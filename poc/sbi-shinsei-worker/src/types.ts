export type JsonObject = Record<string, unknown>;

export interface SbiShinseiCredential {
  branchNumber: string;
  accountNumber: string;
  powerDirectPassword: string;
}

export const READ_OPERATION_IDS = [
  "common.security-connect",
  "common.validate-token",
  "top.accounts-balance-and-activity",
  "top.balance-summary-and-stage",
  "common.exchange-rate",
  "common.application-information-list",
  "common.account-information-list",
  "common.product-description",
  "account.information-others",
  "account.casa-activity-specific-period",
  "account.account-list",
  "account.inbox-list",
  "common.uiux-flag",
  "email.address",
  "yen-deposit.product-details",
  "yen-deposit.account",
  "csv.download",
] as const;

export type ReadOperationId = (typeof READ_OPERATION_IDS)[number];

export interface ReadRoute {
  operation: ReadOperationId;
  method: "POST";
  origin: "https://bk.web.sbishinseibank.co.jp";
  path: string;
  evidence: "public-login-bundle" | "authenticated-capture";
  liveValidated: boolean;
  productionEnabled: boolean;
  responseSchema: ResponseSchemaId;
  maxResponseBytes: number;
}

export type ResponseSchemaId =
  | "unknown"
  | "sbi-shinsei-validate-token-v1"
  | "sbi-shinsei-top-balances-v1"
  | "sbi-shinsei-balance-summary-v1"
  | "sbi-shinsei-exchange-rate-v1"
  | "sbi-shinsei-yen-deposit-account-v1";

export interface ReadRequestDescriptor {
  operation: ReadOperationId;
  method: string;
  url: string;
}

export interface SessionStateStore {
  getAuthorization(): string | undefined;
  getCsrfToken(): string | undefined;
  rotateCsrfToken(nextToken: string): void;
}

export interface TransportRequest {
  operation: ReadOperationId;
  body?: JsonObject;
}

export interface NormalizedBalance {
  accountKey: string;
  product: "yen-savings" | "hyper-yokin" | "foreign-savings" | "term-deposit";
  currency: string;
  balance: string;
  yenEquivalent: string | null;
  asOf: string;
}

export interface NormalizedTransaction {
  accountKey: string;
  transactionDate: string;
  description: string;
  debit: string | null;
  credit: string | null;
  balance: string;
  currency: string;
}

export interface NormalizedSnapshot {
  schemaVersion: "sbi-shinsei-synthetic-v1";
  capturedAt: string;
  balances: NormalizedBalance[];
  transactions: NormalizedTransaction[];
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
  source: "sbi-shinsei";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  window: { from: string; to: string };
  liveReadsEnabled: boolean;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
}
