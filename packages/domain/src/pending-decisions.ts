// The closed vocabulary of the pending-decisions summary (ADR 0126,
// packages/application/src/query/pending-decisions.ts): the kinds it counts,
// the queues it leaves out and why, the page and tool that handle each kind,
// its bounds and the answer's shape. The wire contract
// (packages/observation-shared/src/pending-decisions-contract.ts) and the
// ホーム page read the same lists.

/**
 * Every kind of open proposal the summary counts, in the order it lists
 * them. A closed list: a kind is added here, with its read, or not at all.
 */
export const PENDING_DECISION_KINDS = [
  "card-settlement.statement",
  "card-ownership.account",
  "account-candidate.open",
  "account-candidate.held",
  "instrument-candidate.open",
  "instrument-candidate.held",
  "pending-posted.link",
  "maintenance-survey.proposal",
  "change-plan.open",
] as const;
export type PendingDecisionKind = (typeof PENDING_DECISION_KINDS)[number];

/**
 * Proposals the summary does not count, each with the closed reason why
 * (ADR 0126): nobody can decide them yet, or no list reads them.
 */
export const PENDING_DECISIONS_NOT_COVERED = [
  // Own-transfer and economic-event proposals: no planner is registered
  // (`ECONOMIC_EVENT_PLANNERS` is empty), so no one can decide them yet.
  { kind: "economic-event.proposal", reason: "no_decision_path" },
  // Card purchase reviews (exclude, refund, installment): refused until a
  // planner exists; nothing proposes them.
  { kind: "card-purchase.review", reason: "no_decision_path" },
  // Relations an agent recorded with `kogane.reconcile.propose`: no page or
  // tool lists them, and `entity_relations` has no index on status.
  { kind: "relation.agent-proposal", reason: "no_list" },
  // Unresolved account mappings: nothing proposes a mapping; the identity
  // coverage read counts them.
  { kind: "identity.unresolved-mapping", reason: "no_proposal" },
] as const;

/** Ids listed per line at most. */
export const PENDING_DECISIONS_IDS_SHOWN = 5;
/** Bytes of ids (their UTF-8 length) one line lists at most; later ids are not listed. */
export const PENDING_DECISIONS_ID_BYTES = 640;
/** Rows the index-range lines count at most; `complete: false` past it. */
export const PENDING_DECISIONS_COUNT_BOUND = 1000;
/** The answer's size bound, which `PENDING_DECISIONS_ID_BYTES` keeps (ADR 0126). */
export const PENDING_DECISIONS_MAX_BYTES = 8192;

/** Why a line has no count: its own read refused, the grant, or the deployment. */
export const PENDING_DECISION_UNAVAILABLE = [
  "budget_exceeded",
  "unauthorized",
  "not_served",
] as const;
export type PendingDecisionUnavailable = (typeof PENDING_DECISION_UNAVAILABLE)[number];

/** Who decides a line's items. */
export const PENDING_DECISION_PATHS = [
  "kogane.command.plan",
  "kogane.command.approve",
  "kogane.schedules.survey.decide",
] as const;

/**
 * Where a line's items are read and decided. `page` and `tool` are the
 * existing ones; `{id}` in `page` and `idArgument` say where one listed id
 * goes, and `arguments` are the tool's fixed arguments.
 */
export interface PendingDecisionHandler {
  page: string;
  tool: string;
  idArgument: string | null;
  arguments: Record<string, string>;
  decidedBy: (typeof PENDING_DECISION_PATHS)[number];
}

export const PENDING_DECISION_HANDLERS: Record<PendingDecisionKind, PendingDecisionHandler> = {
  "card-settlement.statement": {
    page: "/reconciliation/{id}",
    tool: "kogane.card-settlements.read",
    idArgument: "proposalId",
    arguments: {},
    decidedBy: "kogane.command.plan",
  },
  "card-ownership.account": {
    page: "/reconciliation/{id}/ownership",
    tool: "kogane.card-settlements.ownership",
    idArgument: "proposalId",
    arguments: {},
    decidedBy: "kogane.command.plan",
  },
  "account-candidate.open": {
    page: "/identities/account-candidates",
    tool: "kogane.accounts.candidates",
    idArgument: null,
    arguments: { view: "open" },
    decidedBy: "kogane.command.plan",
  },
  "account-candidate.held": {
    page: "/identities/account-candidates",
    tool: "kogane.accounts.candidates",
    idArgument: null,
    arguments: { view: "held" },
    decidedBy: "kogane.command.plan",
  },
  "instrument-candidate.open": {
    page: "/identities/instrument-candidates",
    tool: "kogane.instruments.candidates",
    idArgument: null,
    arguments: { view: "open" },
    decidedBy: "kogane.command.plan",
  },
  "instrument-candidate.held": {
    page: "/identities/instrument-candidates",
    tool: "kogane.instruments.candidates",
    idArgument: null,
    arguments: { view: "held" },
    decidedBy: "kogane.command.plan",
  },
  "pending-posted.link": {
    page: "/purchases",
    tool: "kogane.purchases.explain",
    idArgument: null,
    arguments: {},
    decidedBy: "kogane.command.plan",
  },
  "maintenance-survey.proposal": {
    page: "/schedules",
    tool: "kogane.schedules.survey.read",
    idArgument: null,
    arguments: {},
    decidedBy: "kogane.schedules.survey.decide",
  },
  "change-plan.open": {
    page: "/confirm/{id}",
    tool: "kogane.command.simulate",
    idArgument: "planId",
    arguments: {},
    decidedBy: "kogane.command.approve",
  },
};

/** Whether a line's time is a recorded creation time or none is recorded. */
export const PENDING_DECISION_TIME_BASES = ["created", "not_recorded"] as const;

export interface PendingDecisionLine {
  kind: PendingDecisionKind;
  state: "counted" | "unavailable";
  /** Null when `unavailable`. */
  reason: PendingDecisionUnavailable | null;
  /** Items waiting; null when `unavailable`. A lower bound when `complete` is false. */
  count: number | null;
  /** False when the count reached `PENDING_DECISIONS_COUNT_BOUND` or the line is unavailable. */
  complete: boolean;
  /** The first ids, in the line's order (ADR 0126); fewer than the count when the id bound is met. */
  ids: string[];
  /** The oldest item's creation time; null when none waits or none is recorded. */
  oldestAt: string | null;
  timeBasis: (typeof PENDING_DECISION_TIME_BASES)[number];
  handler: PendingDecisionHandler;
}

export interface PendingDecisions {
  schemaVersion: "kogane-pending-decisions-v1";
  /** The instant the plans line was judged at. */
  asOf: string;
  bounds: { idsShown: number; idBytes: number; countBound: number; maxBytes: number };
  /** One line per kind, in `PENDING_DECISION_KINDS` order. */
  kinds: PendingDecisionLine[];
  notCovered: typeof PENDING_DECISIONS_NOT_COVERED;
  /** Every item is decided elsewhere; this answer changes nothing. */
  decisions: "elsewhere";
}
