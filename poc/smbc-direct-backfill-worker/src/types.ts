export interface Credentials {
  branchNo: string;
  accountNo: string;
  password: string;
}

export interface CookieRecord {
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
}

export interface ChallengeState {
  createdAt: string;
  expiresAt: string;
  appUrl: string;
  cookies: CookieRecord[];
  confirmationForm: Record<string, string>;
  confirmationUrl: string;
}

export interface AuthenticatedSession {
  cookies: CookieRecord[];
  topPage: { html: string; url: string };
}

export interface EncryptedPayload {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface DateRange {
  start: string;
  end: string;
}

export type BackfillPhase =
  | "idle"
  | "waiting_for_approval"
  | "running"
  | "success"
  | "partial"
  | "failed";

export interface BackfillProgress {
  phase: BackfillPhase;
  createdAt: string | null;
  challengeExpiresAt: string | null;
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  from: string | null;
  to: string | null;
  nextRange: DateRange | null;
  completedChunks: number;
  totalChunks: number;
  transactionCount: number;
  artifactCount: number;
  retryCount: number;
  lastErrorCode: string | null;
  logoutSucceeded: boolean | null;
  manifestKey: string | null;
}

export interface StoredArtifact {
  dataset:
    | "balance-raw"
    | "balance-normalized"
    | "transactions-raw"
    | "transactions-normalized";
  key: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  range?: DateRange;
  transactionCount?: number;
}

export interface BackfillManifest {
  schemaVersion: string;
  source: "smbc-direct";
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  requestedRange: DateRange;
  completedChunks: number;
  totalChunks: number;
  transactionCount: number;
  artifacts: StoredArtifact[];
  failureCodes: string[];
  logoutSucceeded: boolean | null;
}

export interface StartChallengeResult {
  phase: "waiting_for_approval";
  qrSvgDataUrl: string;
  appUrl: string;
  expiresAt: string;
}

export interface FinishChallengeResult {
  phase: BackfillPhase;
  progress: BackfillProgress;
}
