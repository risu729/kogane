export type JsonObject = Record<string, unknown>;

export interface SbiShinseiCredential {
  branchNumber: string;
  accountNumber: string;
  powerDirectPassword: string;
}

export interface JscMaterial {
  jsc: string;
  userAgent: string;
  sourceOrigin: "https://bk.web.sbishinseibank.co.jp";
}

export interface JscProvider {
  readonly name: string;
  acquire(): Promise<JscMaterial>;
}

export interface LoginSession {
  authorization: string;
  csrfToken: string;
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
  | "sbi-shinsei-security-connect-v1"
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

export type ReadExecutionProfile =
  | "worker-production"
  | "direct-http-diagnostic"
  | "local-captured-validation";

export interface TransportRequest {
  operation: ReadOperationId;
  body?: JsonObject;
}

export interface ReadTransportResult {
  data: JsonObject;
  rawBody: string;
  mediaType: string;
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
  schemaVersion: "sbi-shinsei-v1";
  capturedAt: string;
  balances: NormalizedBalance[];
  transactions: NormalizedTransaction[];
}

export interface RawArtifact {
  dataset: string;
  filename: string;
  mediaType: string;
  body: string | ArrayBuffer;
  /**
   * How many person-name fields were replaced with the marker before `body`
   * was built (ADR 0029, amendment 2026-09-27). Set on every provider
   * capture, 0 when there was nothing to remove; absent on derived artifacts.
   */
  redactedFieldCount?: number;
}

export interface StoredArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  /** The artifact's `redactedFieldCount`, a count only, never a value. */
  redactedFieldCount?: number;
}

export interface CollectionFailure {
  operation: string;
  errorType: string;
  message: string;
  diagnostics?: {
    stage: string;
    httpStatus?: number;
    authenticationAttempted?: boolean;
    responseReason?: string;
  };
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "sbi-shinsei";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  liveReadsEnabled: boolean;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export interface CollectionResult extends CollectionManifest {
  manifestKey: string;
}
