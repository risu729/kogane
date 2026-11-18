export type JsonObject = Record<string, unknown>;

export interface SonyBankCredential {
  branchNum: string;
  accountNum: string;
  loginPwd: string;
}

export interface RawArtifact {
  unitKey?: string;
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

/** A core step of one Sony session, in run order (`CORE_STEPS`, ADR 0099). */
export type CoreStep =
  | "login"
  | "gross-balance"
  | "monthly-history"
  | "retained-history"
  | "wallet";

/**
 * Where a core run stopped: the steps that finished (their artifacts are the
 * run's), the step that threw (none of its artifacts are kept) and the planned
 * steps that never ran. Closed step names only.
 */
export interface CoreStepOutcome {
  readonly completed: readonly CoreStep[];
  readonly failed: CoreStep;
  readonly notAttempted: readonly CoreStep[];
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "sony-bank";
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  window: { from: string | null; to: string | null };
  /** Null when the step that owns the canonical history did not finish (INV05). */
  transactionCount: number | null;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
  /** Present only on a core run that stopped at a step. */
  coreSteps?: CoreStepOutcome;
}
