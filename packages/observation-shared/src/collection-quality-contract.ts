// The wire shape of `GET /api/collection-quality`,
// `GET /api/collection-quality/<sourceId>` (docs/evidence-browser.md, ADR 0045)
// and `GET /api/collection-quality/<sourceId>/accounts` (ADR 0088).
//
// What each collection stage of a source, and of each source × unit × dataset
// × period, last did, in codes. Nothing here is an amount or a merchant: every
// field is an identifier (fetch unit keys included, ADR 0045), a period, a
// capture or receipt time, a count of stored records, a code from a closed
// list, or a stored stage code of the safe-code shape (`unclassified` for any
// other stored text). The one stored label passed on as stored is a MyJCB
// period label the month rule does not read (`statement-slot` below). A
// state that is missing, unconfirmed or partial is a reason code, never a
// zero and never "complete" (INV05); a cell with no current capture is
// `no-current` with its reasons, not an empty success.
//
// Shape only: the client recalculates nothing, and an answer carrying a field
// the contract does not name is refused rather than displayed. The schemas
// are zod's (`zod/mini`, the tree-shakable build of the zod release services/app
// already pins), strict objects throughout, and the TypeScript types are
// inferred from them, so the shape is stated once.
import * as z from "zod/mini";
import {
  COLLECTION_FRESHNESS_POLICY,
  COLLECTION_FRESHNESS_STATES,
  collectionFreshness,
  consistentFreshness,
  tokyoDate,
} from "../../domain/src/collection-freshness.ts";
import { validInstantText } from "../../domain/src/time.ts";

export const COLLECTION_QUALITY_PATH = "/api/collection-quality";
export const COLLECTION_QUALITY_API_VERSION = 4;
/** Cells per page; the read fetches one more to report truncation. */
export const COLLECTION_QUALITY_PAGE = 500;
/** More schedules or sources than this in one summary is refused, never cut. */
export const COLLECTION_QUALITY_BOUND = 200;

/** `collection_schedules.kind` (CORE 0065). */
const SCHEDULE_KINDS = ["collection", "keepalive", "processor", "manual", "email"] as const;
/** `collection_schedule_occurrences.status` (CORE 0065). */
const OCCURRENCE_STATUSES = [
  "started",
  "completed",
  "failed",
  "uncertain",
  "not_dispatched",
] as const;
/** `collection_runs.provider_outcome`, the terminal's own claim (CORE 0039). */
const PROVIDER_OUTCOMES = ["success", "partial", "failed"] as const;
/** `collection_runs.coverage_status` (CORE 0039). */
const COVERAGE_STATUSES = ["complete", "partial", "unknown"] as const;
/**
 * Where a terminal named by a schedule receipt stands in CORE:
 * `registered` (its run is a visible fetch run), `pending` (seen, neither
 * registered nor blocked), `blocked` (seen and refused with a code),
 * `unrecorded` (no `collection_runs` row yet: the scan has not seen it).
 */
const REGISTRATION_STATES = ["registered", "pending", "blocked", "unrecorded"] as const;

/**
 * Which existing rule decides that a cell's capture is current:
 * SMBC request keys, MoneyForward account-months, V Point complete runs and
 * MyJCB connections compose Transactions/Balances' unchanged selections.
 * Capture membership is not a guarantee of full provider-history coverage;
 * missing published-parse claims are `coverage_not_recorded`.
 * `container-snapshot` the dataset snapshot policies (`completeSnapshotCandidates`),
 * `global-pass-month`, `vpass-card-month` and `myjcb-statement-slot` the
 * per-source snapshot CTEs of `packages/read-model/src/sql.ts`, and
 * `published-eligible` a published parse of a parse-eligible run
 * (`activeStateProjection`), the rule every other current list starts from.
 */
const CURRENT_RULES = [
  "container-snapshot",
  "global-pass-month",
  "vpass-card-month",
  "myjcb-statement-slot",
  "smbc-request-key",
  "moneyforward-account-month",
  "v-point-complete-run",
  "myjcb-connection",
  "published-eligible",
] as const;

/**
 * How a cell's period is named: `latest` (one period, the newest capture),
 * `request-key` (SMBC's complete artifact key, an opaque request partition,
 * not a parsed date range), `account-month` (MoneyForward's existing key
 * substring), `connection` (MyJCB's existing key prefix, an opaque connection,
 * not a payment month),
 * `activity-month` (GLOBAL PASS `YYYY-MM`), `statement-month` (Vpass
 * `YYYYMM`), `statement-slot` (MyJCB payment month `YYYY-MM` with its
 * statement state, as `myjcbStatementSlot` reads it: a relative label no rule
 * places has no value, and any other label the month reading does not place
 * is its own slot and is shown as stored, as card usage's `statement_period`
 * shows it).
 */
const PERIOD_KINDS = [
  "latest",
  "activity-month",
  "statement-month",
  "statement-slot",
  "request-key",
  "account-month",
  "connection",
] as const;

/** `current`: the newest capture is current; `older-current`: an older one is; `no-current`: none is. */
const CELL_STATES = ["current", "older-current", "no-current"] as const;

/** Why a source is not shown as collected end to end. Each is read from a stored state. */
export const SOURCE_REASONS = [
  "no_collector",
  "no_schedule",
  "schedule_disabled",
  "schedule_unsupported",
  "schedule_never_ran",
  "occurrence_running",
  "occurrence_failed",
  "occurrence_uncertain",
  "occurrence_not_dispatched",
  "user_action_required",
  "lease_held",
  "terminal_unrecorded",
  "terminal_registration_pending",
  "terminal_registration_blocked",
  "acquisition_partial",
  "acquisition_failed",
  "coverage_partial",
  "coverage_unknown",
  "unregistered_terminals",
  "no_registered_run",
  "latest_run_not_successful",
  "dataset_withheld",
] as const;

/** Why a cell is not shown as current and complete. Each is read from a stored state. */
export const CELL_REASONS = [
  "unit_without_artifacts",
  "unit_outcome_unknown",
  "identity_unresolved",
  "identity_not_recorded",
  "published_without_observations",
  "retention_not_assessed",
  "run_not_successful",
  "unit_failed",
  "user_action_required",
  "raw_not_reachable",
  "parse_not_queued",
  "not_parse_eligible",
  "parse_pending",
  "parse_failed",
  "parser_rejected",
  "parse_unpublished",
  "coverage_incomplete",
  "coverage_not_recorded",
  "newer_capture_not_current",
  "no_current_capture",
  "period_unplaced",
  "query_rule_not_composed",
  "not_in_latest_run",
] as const;

/**
 * The data types a provider offers, in the vocabulary of the roadmap's layers
 * 0–5 (`provider-data-types-v1`, ADR 0087). A type names what the data is,
 * not where it is shown: `balance` (a deposit, cash, stored-value or margin
 * balance), `cash_movement` (bank, wallet or stored-value movements),
 * `card_usage` (card purchases and refunds), `card_statement` (statement and
 * payment amounts), `position` (security or crypto holdings), `execution`
 * (trades), `settlement_cash` (the cash account of a securities or crypto
 * broker and its movements, kept apart from bank deposits because it settles
 * trades),
 * `asset_transfer` (security or crypto moved in or out), `income`
 * (dividends, distributions, interest, staking or lending rewards),
 * `valuation_history` (the provider's own valuation and its history, realized
 * gains), `term_deposit` (term and other deposit contracts: principal,
 * maturity, rate), `document` (statements and reports the provider delivers
 * as files), `fx_rate` (the provider's exchange rates), and
 * `reward_balance`, `reward_activity`, `reward_expiry` (points).
 */
export const PROVIDER_DATA_TYPES = [
  "balance",
  "cash_movement",
  "card_usage",
  "card_statement",
  "position",
  "execution",
  "settlement_cash",
  "asset_transfer",
  "income",
  "valuation_history",
  "term_deposit",
  "document",
  "fx_rate",
  "reward_balance",
  "reward_activity",
  "reward_expiry",
] as const;
/**
 * `collected`: parsers publish it; `partial`: parsers publish part of it
 * and the rest is tracked by an issue; `not_collected`: an issue tracks it.
 */
export const DATA_TYPE_STATUSES = ["collected", "partial", "not_collected"] as const;
export const PROVIDER_DATA_TYPES_VERSION = "provider-data-types-v1";
export type ProviderDataType = (typeof PROVIDER_DATA_TYPES)[number];
export type DataTypeStatus = (typeof DATA_TYPE_STATUSES)[number];

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export type CurrentRule = (typeof CURRENT_RULES)[number];
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export type CellState = (typeof CELL_STATES)[number];
export type SourceReason = (typeof SOURCE_REASONS)[number];
export type CellReason = (typeof CELL_REASONS)[number];
export type {
  CollectionFreshness,
  CollectionFreshnessState,
} from "../../domain/src/collection-freshness.ts";

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;

/** A safe code: what logs and stored records may carry, never provider text. */
const code = z.string().check(z.regex(CODE));
const sourceId = z.string().check(z.regex(SOURCE));
const text = z.string().check(z.minLength(1), z.maxLength(512));
const count = z.int().check(z.nonnegative());
const id = z.int().check(z.positive());
const instant = z.string().check(z.refine(validInstantText));
const date = z.string().check(z.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u));

/**
 * `collection-freshness-v1` (packages/domain/src/collection-freshness.ts): the
 * age in Asia/Tokyo civil days of the capture the data stands on, and its
 * state. The pair is checked against the policy, never taken on trust.
 */
const freshness = z
  .strictObject({
    state: z.enum(COLLECTION_FRESHNESS_STATES),
    ageDays: z.nullable(count),
  })
  .check(z.refine(consistentFreshness));

/** The instant every age of one answer is counted to, and its civil date. */
const freshnessAsOf = z
  .strictObject({
    policy: z.literal(COLLECTION_FRESHNESS_POLICY),
    at: instant,
    date,
  })
  .check(z.refine((value) => tokyoDate(value.at) === value.date));
/** An age is the civil days from its capture to the answer's as-of date (clamped at 0). */
function ageOf(
  capturedAt: string | null | undefined,
  asOfDate: string,
  ageDays: number | null,
): boolean {
  if (capturedAt == null) return ageDays === null;
  try {
    return collectionFreshness(capturedAt, asOfDate, null).ageDays === ageDays;
  } catch {
    return false;
  }
}
/** A list with no repeated entry: a reason or a code is stated once. */
const distinct = <T extends z.ZodMiniType<string>>(entry: T, bound = 100) =>
  z.array(entry).check(
    z.maxLength(bound),
    z.refine((values) => new Set(values).size === values.length),
  );

/** One terminal a schedule receipt names, as CORE has it. */
const terminal = z
  .strictObject({
    collector: sourceId,
    /** The terminal's own outcome; null while no `collection_runs` row validated it. */
    outcome: z.nullable(z.enum(PROVIDER_OUTCOMES)),
    coverage: z.nullable(z.enum(COVERAGE_STATUSES)),
    registration: z.enum(REGISTRATION_STATES),
    /** `collection_runs.blocked_code` or the newest `registered` stage failure code. */
    blockedCode: z.nullable(code),
    /** The visible CORE fetch run it became, for `/runs/...` links. */
    fetchRunId: z.nullable(id),
  })
  .check(
    // A validated terminal states both, an unvalidated one neither (CORE 0039).
    z.refine((value) => (value.outcome === null) === (value.coverage === null)),
    // Only a registered terminal links a fetch run.
    z.refine((value) => value.fetchRunId === null || value.registration === "registered"),
  );

const occurrence = z.strictObject({
  status: z.enum(OCCURRENCE_STATUSES),
  failureCode: z.nullable(code),
  nominalAt: instant,
  startedAt: instant,
  finishedAt: z.nullable(instant),
  terminals: z.array(terminal).check(z.maxLength(100)),
});

const schedule = z
  .strictObject({
    id: sourceId,
    kind: z.enum(SCHEDULE_KINDS),
    enabled: z.boolean(),
    supported: z.boolean(),
    nextNominalAt: z.nullable(instant),
    nextRunAt: z.nullable(instant),
    alarm: z
      .strictObject({
        status: z.enum(["observed", "unavailable"]),
        actualAt: z.nullable(instant),
      })
      .check(z.refine((value) => value.status === "observed" || value.actualAt === null)),
    /** A held execution lease: a collection is running or stopped without releasing it. */
    leaseStartedAt: z.nullable(instant),
    /** The newest receipt by nominal time; null when the job never ran. */
    latest: z.nullable(occurrence),
  })
  // An unsupported job is never enabled (CORE 0065's CHECK).
  .check(z.refine((value) => value.supported || !value.enabled));

const fetchRun = z.nullable(
  z.strictObject({
    id,
    /** `successfulFetchRuns`: terminal success with no unit failure or collector error. */
    succeeded: z.boolean(),
    completedAt: z.nullable(instant),
  }),
);

const parserName = z.string().check(z.regex(/^[a-z][a-z0-9-]{0,99}$/u));
/** One data type of the provider-offered catalogue and whether it is collected. */
const dataType = z
  .strictObject({
    type: z.enum(PROVIDER_DATA_TYPES),
    status: z.enum(DATA_TYPE_STATUSES),
    /** The parsers that publish it (registered parser names); none when not collected. */
    parsers: distinct(parserName, 20),
    /** The issue that tracks what is not collected; null when it is all collected. */
    issue: z.nullable(id),
  })
  .check(
    z.refine((value) =>
      value.status === "collected"
        ? value.parsers.length > 0 && value.issue === null
        : value.status === "partial"
          ? value.parsers.length > 0 && value.issue !== null
          : value.parsers.length === 0 && value.issue !== null,
    ),
  );
/** A catalogued source's data types, once each; null for a source the catalogue does not describe. */
const dataTypes = z.nullable(
  z.array(dataType).check(
    z.minLength(1),
    z.maxLength(PROVIDER_DATA_TYPES.length),
    z.refine((values) => new Set(values.map((value) => value.type)).size === values.length),
  ),
);

const unregistered = z.strictObject({
  collector: sourceId,
  blockedCode: z.nullable(code),
  runs: id,
  newestSeenAt: instant,
});

const source = z
  .strictObject({
    sourceId,
    /** Collector (terminal) sources that register under this CORE source. */
    collectors: distinct(sourceId),
    schedules: z.array(schedule).check(z.maxLength(COLLECTION_QUALITY_BOUND)),
    latestFetchRun: fetchRun,
    unregistered: z.array(unregistered).check(z.maxLength(100)),
    reasons: distinct(z.enum(SOURCE_REASONS)),
    /** The age of `latestFetchRun` (whatever its outcome) and what the source waits on. */
    freshness,
    /** What the provider offers and whether each type is collected (`provider-data-types-v1`). */
    dataTypes,
  })
  .check(
    // An age is that of the newest fetch run's completion, and only of it.
    z.refine(
      (value) => (value.freshness.ageDays === null) === (value.latestFetchRun?.completedAt == null),
    ),
  );

const summary = z
  .strictObject({
    apiVersion: z.literal(COLLECTION_QUALITY_API_VERSION),
    freshnessAsOf,
    dataTypesVersion: z.literal(PROVIDER_DATA_TYPES_VERSION),
    sources: z.array(source).check(
      z.maxLength(COLLECTION_QUALITY_BOUND),
      z.refine((values) => new Set(values.map((value) => value.sourceId)).size === values.length),
    ),
    /** Jobs whose source registers under no CORE source (the Processor tick has none). */
    otherSchedules: z.array(schedule).check(z.maxLength(COLLECTION_QUALITY_BOUND)),
  })
  .check(
    z.refine((value) =>
      value.sources.every((entry) =>
        ageOf(entry.latestFetchRun?.completedAt, value.freshnessAsOf.date, entry.freshness.ageDays),
      ),
    ),
  );

const period = z
  .strictObject({
    kind: z.enum(PERIOD_KINDS),
    value: z.nullable(text),
    /** MyJCB statement state (`confirmed`/`unconfirmed`); null elsewhere. */
    state: z.nullable(text),
  })
  .check(
    // `latest` names no period; only a MyJCB slot carries a state. A named
    // period whose label no rule places has no value, and the cell says so
    // (`period_unplaced`).
    z.refine((value) =>
      value.kind === "latest"
        ? value.value === null && value.state === null
        : value.kind === "statement-slot" || value.state === null,
    ),
  );

/**
 * Where the newest capture's artifacts stand. A parser's cell counts its
 * artifacts by the state of that parser's parse; a cell with no parser counts
 * them by why no parse job names them.
 */
const parses = z.strictObject({
  published: count,
  pending: count,
  failed: count,
  /** A recorded parse that is not published, and no job is pending or failed. */
  unpublished: count,
  /** No parse job or recorded parse names the artifact, on a parse-eligible run. */
  notQueued: count,
  /** No parse job names the artifact because its run (or unit) is not parse-eligible. */
  notEligible: count,
});

const capture = z.strictObject({ fetchRunId: id, capturedAt: instant });

const newest = z
  .strictObject({
    fetchRunId: id,
    capturedAt: instant,
    runSucceeded: z.boolean(),
    unitFailed: z.boolean(),
    unitFailureCode: z.nullable(code),
    artifacts: count,
    /** Stored rows of published parses; zero never asserts provider-history emptiness. */
    observations: count,
    /** Current sealed interpretation of the newest capture, without account identifiers. */
    unresolvedIdentities: count,
    /** Artifacts whose raw object is reachable (`evidenceExists`). */
    rawStored: count,
    parses,
    /** Failure codes of the failed parses, as stored (a hyphen read as `_`) when safe codes, else `unclassified`. */
    failureCodes: distinct(code),
    /** Published parses whose coverage claim is not complete. */
    incompleteCoverage: count,
    coverageCauses: distinct(code),
  })
  .check(
    z.refine((value) => value.rawStored <= value.artifacts),
    z.refine((value) => value.unitFailureCode === null || value.unitFailed),
    z.refine((value) => value.failureCodes.length === 0 || value.parses.failed > 0),
  );

const cell = z
  .strictObject({
    dataset: z.nullable(text),
    /** The parser the cell is about; null for a newest capture no parse job or parse names. */
    parser: z.nullable(text),
    unitKey: z.nullable(text),
    period,
    currentRule: z.enum(CURRENT_RULES),
    newest,
    current: z.nullable(capture),
    state: z.enum(CELL_STATES),
    reasons: distinct(z.enum(CELL_REASONS)),
    /** The age of `current` (none: no current capture) and what the source waits on. */
    freshness,
  })
  .check(
    // A declared attempt with no artifacts is never a current empty capture.
    z.refine(
      (value) =>
        value.newest.artifacts > 0 ||
        (value.parser === null &&
          value.dataset === null &&
          value.current === null &&
          value.newest.observations === 0 &&
          value.newest.unresolvedIdentities === 0 &&
          value.reasons.includes("unit_without_artifacts")),
    ),
    // Every artifact of the capture is counted once, under the cell's own kind.
    z.refine((value) => {
      const n = value.newest.parses;
      const parsed = n.published + n.pending + n.failed + n.unpublished;
      const waiting = n.notQueued + n.notEligible;
      return value.parser === null
        ? parsed === 0 && waiting === value.newest.artifacts
        : waiting === 0 && parsed === value.newest.artifacts;
    }),
    // An age is that of the current capture, and only of it.
    z.refine((value) => (value.freshness.ageDays === null) === (value.current === null)),
    // The state is what the two captures say, never asserted on its own.
    z.refine((value) =>
      value.current === null
        ? value.state === "no-current"
        : value.state ===
          (value.current.fetchRunId === value.newest.fetchRunId ? "current" : "older-current"),
    ),
  );

const cells = z
  .strictObject({
    apiVersion: z.literal(COLLECTION_QUALITY_API_VERSION),
    freshnessAsOf,
    sourceId,
    latestFetchRun: fetchRun,
    cells: z.array(cell).check(z.maxLength(COLLECTION_QUALITY_PAGE)),
    coverage: z
      .strictObject({
        limit: z.literal(COLLECTION_QUALITY_PAGE),
        truncated: z.boolean(),
        nextOffset: z.nullable(count),
      })
      .check(z.refine((value) => (value.nextOffset === null) === !value.truncated)),
  })
  .check(
    z.refine((value) =>
      value.cells.every((entry) =>
        ageOf(entry.current?.capturedAt, value.freshnessAsOf.date, entry.freshness.ageDays),
      ),
    ),
  );

/**
 * `GET /api/collection-quality/<sourceId>/accounts` (ADR 0088); version 3
 * dates every named capture and includes its provider data type catalogue.
 */
export const ACCOUNT_COVERAGE_API_VERSION = 3;
export const ACCOUNT_COVERAGE_SUFFIX = "/accounts";
/** More cells than this in one source is refused (413), never cut. */
export const ACCOUNT_COVERAGE_CELL_BOUND = 2_000;
/** More account period entries than this in one answer is refused (413), never cut. */
export const ACCOUNT_COVERAGE_ENTRY_BOUND = 10_000;
/** `account_mappings.status` (CORE 0018), the current mapping of each source account. */
export const MAPPING_STATUSES = [
  "identified",
  "provider-local",
  "aggregate",
  "unresolved",
] as const;
/** `identity_observations.kind` (CORE 0018). */
export const OBSERVATION_KINDS = ["transaction", "balance", "position", "valuation"] as const;
/**
 * Which of a cell's captures names the account: `current` (the current
 * capture, which is the newest), `older-current` (the current capture, while
 * a newer one is not current) or `newest-not-current` (only the newest
 * capture, which is not, or not wholly, current).
 */
const ACCOUNT_STANDINGS = ["current", "older-current", "newest-not-current"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export type AccountStanding = (typeof ACCOUNT_STANDINGS)[number];

/** One cell the account's observations are in, under one observation kind. */
const accountPeriod = z
  .strictObject({
    unitKey: z.nullable(text),
    period,
    currentRule: z.enum(CURRENT_RULES),
    cellState: z.enum(CELL_STATES),
    standing: z.enum(ACCOUNT_STANDINGS),
    /** The capture that names the account: the current one, else the newest. */
    capture,
    /** The account's observations of this kind in that capture; never zero. */
    observations: id,
    /** The cell's own reasons, as the cell page states them. */
    reasons: distinct(z.enum(CELL_REASONS)),
    /**
     * The age of this named capture. Standing independently states whether
     * that capture contributes to current data.
     */
    freshness,
  })
  .check(
    z.refine((value) =>
      value.standing === "newest-not-current" ? true : value.standing === value.cellState,
    ),
    z.refine((value) => value.freshness.ageDays !== null),
  );

/** A group's value must belong to a newest named capture, including its wait state. */
function newestFreshnessMatches(
  periods: readonly {
    capture: { capturedAt: string };
    freshness: { state: string; ageDays: number | null };
  }[],
  value: { state: string; ageDays: number | null },
): boolean {
  const newest = Math.max(...periods.map((entry) => Date.parse(entry.capture.capturedAt)));
  return periods.some(
    (entry) =>
      Date.parse(entry.capture.capturedAt) === newest &&
      entry.freshness.state === value.state &&
      entry.freshness.ageDays === value.ageDays,
  );
}

const accountDataType = z
  .strictObject({
    dataset: z.nullable(text),
    parser: text,
    providerTypes: distinct(z.enum(PROVIDER_DATA_TYPES), PROVIDER_DATA_TYPES.length),
    kind: z.enum(OBSERVATION_KINDS),
    periods: z
      .array(accountPeriod)
      .check(z.minLength(1), z.maxLength(ACCOUNT_COVERAGE_ENTRY_BOUND)),
    /** That of its newest named capture, with that period's wait state. */
    freshness,
  })
  .check(z.refine((value) => newestFreshnessMatches(value.periods, value.freshness)));

const coveredAccount = z
  .strictObject({
    accountId: text,
    /** The account's own label (`accounts.label`), as the identities page shows it. */
    label: z.string().check(z.maxLength(512)),
    /** The current mapping statuses of the source accounts that name it here. */
    statuses: distinct(z.enum(MAPPING_STATUSES)).check(z.minLength(1)),
    dataTypes: z.array(accountDataType).check(z.minLength(1), z.maxLength(1_000)),
    /** That of its freshest period over every data type. */
    freshness,
  })
  .check(
    z.refine((value) =>
      newestFreshnessMatches(
        value.dataTypes.flatMap((entry) => entry.periods),
        value.freshness,
      ),
    ),
  );

/** A cell neither of whose captures names an account, with the cell's own reasons. */
const unattributed = z.strictObject({
  dataset: z.nullable(text),
  parser: z.nullable(text),
  unitKey: z.nullable(text),
  period,
  currentRule: z.enum(CURRENT_RULES),
  state: z.enum(CELL_STATES),
  reasons: distinct(z.enum(CELL_REASONS)),
});

const accountCoverage = z
  .strictObject({
    apiVersion: z.literal(ACCOUNT_COVERAGE_API_VERSION),
    freshnessAsOf,
    dataTypesVersion: z.literal(PROVIDER_DATA_TYPES_VERSION),
    dataTypes,
    sourceId,
    latestFetchRun: fetchRun,
    /** Every cell of the source was read: no page, no cut. */
    cells: count,
    accounts: z.array(coveredAccount).check(
      z.maxLength(ACCOUNT_COVERAGE_ENTRY_BOUND),
      z.refine((values) =>
        values.every(
          (value, index) => index === 0 || values[index - 1]!.accountId < value.accountId,
        ),
      ),
    ),
    unattributed: z.array(unattributed).check(z.maxLength(ACCOUNT_COVERAGE_CELL_BOUND)),
  })
  .check(
    z.refine((value) => value.cells <= ACCOUNT_COVERAGE_CELL_BOUND),
    z.refine((value) => value.unattributed.length <= value.cells),
    z.refine(
      (value) =>
        value.accounts.reduce(
          (sum, account) =>
            sum + account.dataTypes.reduce((inner, type) => inner + type.periods.length, 0),
          0,
        ) <= ACCOUNT_COVERAGE_ENTRY_BOUND,
    ),
    // A period's age is that of the capture it names, counted to the answer's date.
    z.refine((value) =>
      value.accounts.every((account) =>
        account.dataTypes.every((type) =>
          type.periods.every((entry) =>
            ageOf(entry.capture.capturedAt, value.freshnessAsOf.date, entry.freshness.ageDays),
          ),
        ),
      ),
    ),
    // Reverse membership is checked against this answer's self-contained catalogue.
    z.refine((value) =>
      value.accounts.every((account) =>
        account.dataTypes.every((type) => {
          const expected = (value.dataTypes ?? [])
            .filter((entry) => entry.parsers.includes(type.parser))
            .map((entry) => entry.type);
          return (
            expected.length === type.providerTypes.length &&
            expected.every((entry, index) => entry === type.providerTypes[index])
          );
        }),
      ),
    ),
  );

export type CollectionQualityTerminal = z.output<typeof terminal>;
export type CollectionQualityOccurrence = z.output<typeof occurrence>;
export type CollectionQualitySchedule = z.output<typeof schedule>;
const alarms = z.strictObject({
  alarms: z
    .array(
      z.strictObject({
        id: sourceId,
        enabled: z.boolean(),
        nextNominalAt: z.nullable(instant),
        nextRunAt: z.nullable(instant),
        alarm: z
          .strictObject({
            status: z.enum(["observed", "unavailable"]),
            actualAt: z.nullable(instant),
          })
          .check(z.refine((value) => value.status === "observed" || value.actualAt === null)),
      }),
    )
    .check(
      z.maxLength(COLLECTION_QUALITY_BOUND),
      z.refine((values) => new Set(values.map((value) => value.id)).size === values.length),
    ),
});
export type CollectionQualityAlarms = z.output<typeof alarms>;
export function validCollectionQualityAlarms(value: unknown): value is CollectionQualityAlarms {
  return alarms.safeParse(value).success;
}
export type CollectionQualityFetchRun = NonNullable<z.output<typeof fetchRun>>;
export type CollectionQualitySource = z.output<typeof source>;
export type ProviderDataTypeEntry = z.output<typeof dataType>;
export type CollectionQualitySummary = z.output<typeof summary>;
export type CollectionQualityPeriod = z.output<typeof period>;
export type CollectionQualityCell = z.output<typeof cell>;
export type CollectionQualityCells = z.output<typeof cells>;
export type AccountCoveragePeriod = z.output<typeof accountPeriod>;
export type AccountCoverageAccount = z.output<typeof coveredAccount>;
export type AccountCoverage = z.output<typeof accountCoverage>;

/** `GET /api/collection-quality`. */
function validCollectionQualitySummary(value: unknown): value is CollectionQualitySummary {
  return summary.safeParse(value).success;
}

/** `GET /api/collection-quality/<sourceId>`. */
export function validCollectionQualityCells(value: unknown): value is CollectionQualityCells {
  return cells.safeParse(value).success;
}

/** `GET /api/collection-quality/<sourceId>/accounts`. */
export function validAccountCoverage(value: unknown): value is AccountCoverage {
  return accountCoverage.safeParse(value).success;
}

/** The three routes, by path; any other path under the prefix is not this contract. */
export function validCollectionQualityResponse(path: string, value: unknown): boolean {
  if (path === COLLECTION_QUALITY_PATH) return validCollectionQualitySummary(value);
  const accounts = /^\/api\/collection-quality\/([^/]+)\/accounts$/u.exec(path);
  if (accounts !== null) return validAccountCoverage(value) && value.sourceId === accounts[1];
  const match = /^\/api\/collection-quality\/([^/]+)$/u.exec(path);
  return match !== null && validCollectionQualityCells(value) && value.sourceId === match[1];
}
