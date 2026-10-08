// The official-site maintenance re-survey contract (ADR 0050): closed codes and
// the read view the schedule page shows. It never carries provider text or a
// page body; a page is referred to by its URL, fetch time and SHA-256 only.
import type { MaintenancePattern, MaintenanceRule } from "./schedule-model";

/**
 * Why one survey attempt did not yield a usable reading. Each is a failure
 * with its freshness kept visible, never "no maintenance": an empty page, a
 * failed fetch and a page with no recognisable window all leave the adopted
 * rules exactly as they were.
 */
export const SURVEY_FAILURE_CODES = [
  "network_error",
  "timeout",
  "http_error",
  "redirected",
  "too_large",
  "unsupported_content_type",
  "empty_body",
  "store_failed",
  "decode_failed",
  "no_window_recognized",
  "too_many_windows",
] as const;
export type SurveyFailureCode = (typeof SURVEY_FAILURE_CODES)[number];
/** `extracted` is the only success: at least one window was read from the page. */
export type SurveyOutcome = "extracted" | SurveyFailureCode;

/**
 * Why a proposal needs a reviewer's judgement beyond the comparison itself. A
 * proposal without a reason is `proposed`; with any it is `review_pending`.
 * Either way nothing is adopted until an operator accepts it.
 */
export const PROPOSAL_REASONS = [
  /** The page states no year and no weekday that would pin it. */
  "year_inferred",
  /** The stated weekday is not the weekday of the stated date. */
  "weekday_mismatch",
  /** The end time is not after the start and no next-day marker says so. */
  "end_next_day_inferred",
  /** The page states a time zone other than the target's. */
  "timezone_mismatch",
  /** Exception wording (holidays excluded, "however", …) on the same line. */
  "exception_stated",
  /** Wording that the time may move or be extended. */
  "may_change",
  /** Wording that the window was cancelled or postponed. */
  "cancellation_stated",
  /** Wording that only part of the service stops. */
  "partial_service",
  /** A dated window longer than three days. */
  "long_window",
  /** The same page states different times for the same recurrence. */
  "contradictory_windows",
  /** More than one current rule could be the one this window revises. */
  "ambiguous_rule_match",
  /** The window equals a rule the operator disabled. */
  "rule_disabled_by_operator",
  /** A current rule from this page was not found on it. */
  "rule_absent_from_page",
] as const;
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];
/** A window not in the rules, a revision of one rule, or one rule the page no longer states. */
export type ProposalKind = "new" | "changed" | "absent";

export interface MaintenanceSurveyTargetView {
  id: string;
  source: string;
  url: string;
  /** The scope a `new` proposal starts with; a `changed` one keeps its rule's. */
  scope: MaintenanceRule["scope"];
  cadenceHours: number;
  /** Whether the reviewed configuration lets the lane fetch this page. */
  fetch: "enabled" | "disabled";
  terms: "unconfirmed" | "confirmed";
  /**
   * `disabled`: never fetched automatically. `never`: enabled, no success yet.
   * `stale`: the last success is older than twice the cadence. `fresh`: not.
   */
  freshness: "disabled" | "never" | "fresh" | "stale";
  nextDueAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: SurveyFailureCode | null;
  consecutiveFailures: number;
  /** The last success whose page bytes differed from the success before it. */
  lastChangedAt: string | null;
}
export interface MaintenanceSurveyProposalView {
  id: number;
  targetId: string;
  source: string;
  kind: ProposalKind;
  ruleId: string | null;
  baseRevision: number;
  /** False once the rule has moved past `baseRevision`: it can only be rejected. */
  current: boolean;
  timezone: string;
  pattern: MaintenancePattern;
  enabled: boolean;
  scope: MaintenanceRule["scope"];
  status: "proposed" | "review_pending";
  reasons: ProposalReason[];
  /** The page it was read from and when; the bytes are stored under `sha256`. */
  referenceUrl: string;
  fetchedAt: string;
  sha256: string;
  createdAt: string;
}
export interface MaintenanceSurveyView {
  /** Whether the lane runs at all (`MAINTENANCE_SURVEY_ENABLED`). */
  enabled: boolean;
  targets: MaintenanceSurveyTargetView[];
  /** Undecided proposals, oldest first. A decided proposal is history, not shown. */
  proposals: MaintenanceSurveyProposalView[];
  /** The number of undecided proposals: the only thing that asks for attention. */
  attention: number;
}
