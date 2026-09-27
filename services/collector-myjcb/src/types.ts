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
  /**
   * Credit months whose page was kept but whose rows no parser reads, each
   * with its closed reason (ADR 0005's second amendment, ADR 0026). Absent
   * when every kept month was read.
   */
  readonly unreadMonths?: readonly UnreadMonth[];
  /**
   * The export links each credit month's page offered, as closed kinds. The
   * Worker records them and does not fetch them (ADR 0005's second
   * amendment). Absent when no page offered one.
   */
  readonly exportOffers?: readonly ExportOffer[];
  /**
   * The menu positions grouped under 「ボーナス#回払い・ショッピングスキップ払い」
   * (payment schedule pages, not statement months), each with its closed
   * outcome (ADR 0005's amendment (c)). They never count in `periodCount`,
   * `capturedMonthCount` or `unreadMonths`. Absent when the menu listed none.
   */
  readonly schedulePages?: readonly SchedulePage[];
  /** The schedule pages stored (entries coded `scheduled_payments_page`); set with `schedulePages`. */
  readonly schedulePageCount?: number;
}

/** An export a credit month's page links to. */
export type CreditExportKind = "csv" | "pdf" | "ofx";

/**
 * Why a kept credit month's rows are not read (ADR 0005's second amendment):
 *
 * - `rows_unstated`: the page shows rows but does not state its statement
 *   state (no heading, position 2 or later), as before;
 * - `scheduled_payments_page`: a ledger carries the observed header
 *   `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` and has rows. That
 *   header was observed on the ショッピングスキップ払い schedule page, a menu
 *   position that is a payment schedule and not a statement month; what its
 *   rows mean has not been confirmed, so they are not read (ADR 0004). Since
 *   amendment (c) the menu's schedule positions are `schedulePages`, never
 *   months; this code is left for a MONTH position showing that header with
 *   rows, which has not been observed.
 *
 * Entries are `detailMonth` positions, not calendar months.
 */
export const UNREAD_MONTH_CODES = ["rows_unstated", "scheduled_payments_page"] as const;

export type UnreadMonthCode = (typeof UNREAD_MONTH_CODES)[number];

export interface UnreadMonth {
  /** The month's `detailMonth`. */
  readonly position: number;
  readonly code: UnreadMonthCode;
}

/**
 * What became of one schedule page the credit menu listed (ADR 0005's
 * amendment (c)):
 *
 * - `scheduled_payments_page`: fetched and stored, redacted, with state
 *   `unknown`: as `credit-skip-payment-NN.html` when its h1 is the observed
 *   ショッピングスキップ払い heading, which `myjcb-skip-payment-schedule` reads
 *   (amendment (e)), otherwise as `credit-schedule-NN.html`, which nothing
 *   reads;
 * - `schedule_page_fetch`: the fetch or the decoding failed and nothing was
 *   stored. It is not a stop and does not make the connection `partial`,
 *   because a schedule page is not part of the months the unit covers; the
 *   reason is recorded here instead (INV05).
 */
export const SCHEDULE_PAGE_CODES = ["scheduled_payments_page", "schedule_page_fetch"] as const;

export type SchedulePageCode = (typeof SCHEDULE_PAGE_CODES)[number];

export interface SchedulePage {
  /** The page's `detailMonth` position in the menu, not a calendar month. */
  readonly position: number;
  readonly code: SchedulePageCode;
}

export interface ExportOffer {
  /** The month's `detailMonth`. */
  readonly position: number;
  readonly kinds: readonly CreditExportKind[];
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
  "credit_menu_group_unrecognized",
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
  | "credit-menu-group"
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
