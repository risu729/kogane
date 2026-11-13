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

export interface CsvValidationDiagnostics {
  csvFailure?: "media_type" | "charset" | "decode" | "parse" | "header" | "columns";
  csvExpectedColumnCount?: number;
  csvHeaderColumnCount?: number;
  csvMinColumnCount?: number;
  csvMaxColumnCount?: number;
  csvInvalidRowCount?: number;
}

export interface CollectionFailure {
  operation: string;
  errorType: string;
  message: string;
  diagnostics?: CsvValidationDiagnostics & {
    stage: string;
    reason: string;
    providerOperation?: string;
    currency?: string;
    httpStatus?: number;
    providerErrorCount?: number;
  };
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "sony-bank";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  window: { from: string | null; to: string };
  transactionCount: number;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}
