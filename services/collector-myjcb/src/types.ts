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
  /**
   * The stage the connection stopped at, when it stopped: a closed code,
   * never provider text (ADR 0005's amendment). Absent for a connection that
   * ran to the end, including one that is `partial` only because it withheld
   * a month's rows.
   */
  readonly stopCode?: ConnectionStopCode;
  /** The `detailMonth` of the credit month the connection stopped at. */
  readonly stopPosition?: number;
  /** Credit months kept whole before the stop; set with every `stopCode`. */
  readonly capturedMonthCount?: number;
}

/**
 * The stage a MyJCB connection stopped at (ADR 0005's amendment). A closed
 * list: the collector manifest, the unit's `safeErrorCode` and the Worker's
 * response carry one of these and nothing else about the failure.
 */
export const CONNECTION_STOP_CODES = [
  "human_required",
  "login",
  "discovery",
  "credit_menu",
  "credit_first_detail",
  "credit_past_months",
  "month_fetch",
  "month_parse",
  "credit_statement_state",
  "credit_statement_period",
  "ledger_parse",
  "export_fetch",
  "debit",
  "no_route",
  "unclassified",
] as const;

export type ConnectionStopCode = (typeof CONNECTION_STOP_CODES)[number];

/** One stopped connection as the manifest records it: a code and a position. */
export interface CollectionFailure {
  readonly connectionId: string;
  readonly operation: "collect";
  readonly code: ConnectionStopCode;
  /** The `detailMonth` the connection stopped at; absent before the month loop. */
  readonly position?: number;
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
  | "credit-statement-state"
  | "credit-statement-period"
  | "collect-debit"
  | "collect-route"
  | "login";

export class StopConditionError extends Error {
  override readonly name = "StopConditionError";

  constructor(
    message: string,
    readonly code: StopConditionCode = "unknown-upstream-state",
  ) {
    super(message);
  }
}
