export interface PasswordCredential {
  readonly connectionId: string;
  readonly bootstrapMode: "password";
  readonly userId: string;
  readonly password: string;
}

export interface SessionCredential {
  readonly connectionId: string;
  readonly bootstrapMode: "session";
  readonly userAgent: string;
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain?: string;
    readonly path?: string;
    readonly secure?: boolean;
    readonly expires?: number;
  }[];
}

export interface PasskeyCredential {
  readonly connectionId: string;
  readonly bootstrapMode: "passkey";
  readonly credentialId: string;
  readonly privateKey: string;
  readonly rpId: "my.jcb.co.jp" | "jcb.co.jp";
  readonly userHandle: string;
  readonly counter: 0;
  readonly discoverable: true;
  readonly userName?: string;
  readonly userDisplayName?: string;
}

export type MyJcbCredential = PasswordCredential | SessionCredential | PasskeyCredential;

export type StatementState = "confirmed" | "unconfirmed" | "debit" | "unknown";

export interface DiscoveredCard {
  readonly localId: string;
  readonly productHint?: string;
  readonly issuerHint?: string;
  readonly switchCandidate: boolean;
}

export interface DiscoveredPeriod {
  readonly sequence?: number;
  readonly label: string;
  readonly state: StatementState;
  readonly exportKinds: readonly ("csv" | "pdf" | "ofx")[];
}

export interface RawArtifact {
  readonly dataset: string;
  readonly filename: string;
  readonly body: string | ArrayBuffer;
  readonly mediaType: string;
  readonly statementState?: StatementState;
  readonly period?: string;
}

export interface StoredArtifact {
  readonly dataset: string;
  readonly key: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly statementState?: StatementState;
  readonly period?: string;
}

export interface ConnectionSummary {
  readonly connectionId: string;
  readonly bootstrapMode: MyJcbCredential["bootstrapMode"];
  readonly status: "success" | "partial" | "failed" | "human-required";
  readonly cardCount: number;
  readonly periodCount: number;
  readonly artifactCount: number;
  readonly blocker?: string;
}

export interface CollectionFailure {
  readonly connectionId: string;
  readonly operation: string;
  readonly errorType: string;
  readonly message: string;
}

export interface CollectionManifest {
  readonly schemaVersion: string;
  readonly source: "myjcb";
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "partial" | "failed";
  readonly trigger: "scheduled" | "manual";
  readonly connections: readonly ConnectionSummary[];
  readonly artifacts: readonly StoredArtifact[];
  readonly failures: readonly CollectionFailure[];
}

export class HumanRequiredError extends Error {
  override readonly name = "HumanRequiredError";

  constructor(readonly reason: string) {
    super(`MyJCB requires human authentication: ${reason}`);
  }
}

export type StopConditionCode =
  | "unknown-upstream-state"
  | "passkey-browser-setup"
  | "passkey-cdp-enable"
  | "passkey-authenticator-add"
  | "passkey-credential-add"
  | "passkey-login-page"
  | "passkey-control"
  | "passkey-trigger"
  | "passkey-assertion"
  | "passkey-landing"
  | "passkey-session-import"
  | "collect-discovery"
  | "collect-credit"
  | "collect-credit-menu"
  | "collect-credit-first-detail"
  | "collect-credit-past-months"
  | "collect-credit-month-fetch"
  | "collect-credit-month-parse"
  | "collect-credit-export"
  | "credit-ledger-headers"
  | "credit-ledger-item-cell"
  | "credit-ledger-cell-count"
  | "collect-debit";

export class StopConditionError extends Error {
  override readonly name = "StopConditionError";

  constructor(
    message: string,
    readonly code: StopConditionCode = "unknown-upstream-state",
  ) {
    super(message);
  }
}
