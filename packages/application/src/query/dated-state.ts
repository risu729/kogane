// Reported state on a date (docs/reported-state.md, ADR 0019): per account,
// what the provider last reported in a complete container snapshot captured
// before the end of the date, and the card statements due around it with where
// each stands, the older ones only counted, and the payments the provider's
// scheduled-payment page listed. One bounded read path; it never writes and
// never adds two amounts. A container without a snapshot is named in the
// coverage, never shown as a zero balance, and a statement without a readable
// due date is its own status, never a guess.
import { validCardSettlementFacts } from "../../../domain/src/card-settlement.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import { METRIC_REGISTRY_RELEASE, resolveMetric } from "../../../domain/src/metrics.ts";
import {
  DATED_STATE_FRESHNESS_POLICY,
  DATED_STATE_PERIMETER_POLICY,
  IDENTITY_STATUSES,
  liabilityGaps,
  payablesFromPaymentDate,
  payableStatus,
  REPORTED_STATE_EXCLUSIONS,
  REPORTED_STATE_SCHEMA,
  REPORTED_STATE_ZONE,
  reportedStateCutoff,
  SCHEDULED_PAYMENT_KINDS,
  scheduledPaymentDueStatus,
  snapshotFreshness,
  STATEMENTS_BEFORE_WINDOW_REASONS,
  UNDATED_STATEMENT_WINDOW_DAYS,
  type ExclusionReason,
  type IdentityStatus,
  type ManifestStatementsBeforeWindow,
  type ReportedAccount,
  type ReportedBalance,
  type ReportedInstrument,
  type ReportedPayable,
  type ReportedPosition,
  type ReportedScheduledPaymentCapture,
  type ReportedSettlement,
  type ReportedSnapshot,
  type ReportedState,
  type ReportedStateManifestRow,
  type ScheduledPaymentKind,
  type ScheduledPaymentsListing,
  type StatementsBeforeWindow,
  type StatementsBeforeWindowReason,
  type UncountedReportedState,
} from "../../../domain/src/reported-state.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import {
  absentQuantity,
  exactQuantity,
  normalizeDecimal,
  type Quantity,
} from "../../../domain/src/values.ts";
import {
  DATED_BALANCES_SQL,
  DATED_POSITIONS_SQL,
  DATED_SCHEDULED_PAYMENTS_SQL,
  DATED_SNAPSHOTS_SQL,
  DATED_STATE_ROW_BOUND,
  DATED_STATEMENTS_BEFORE_WINDOW_SQL,
  DATED_STATEMENTS_SQL,
  type DatedBalanceRow,
  type DatedPositionRow,
  type DatedScheduledPaymentRow,
  type DatedSnapshotRow,
  SCHEDULED_PAYMENT_PARSER,
  type DatedStatementRow,
  type DatedStatementsBeforeWindowRow,
} from "../../../read-model/src/dated-state.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { SETTLEMENT_SQL } from "./card-purchases.ts";

/** A read past `DATED_STATE_ROW_BOUND` rows is refused (413), never cut. */
export class DatedStateLimitError extends Error {
  constructor() {
    super("dated_state_limit_exceeded");
  }
}

export interface DatedStateInput {
  /** `YYYY-MM-DD`, a civil date in Asia/Tokyo. */
  date: string;
  /** Only this provider source. */
  source?: string;
  /** Only this resolved account id. */
  account?: string;
  /**
   * Only these resolved account ids (the reconstructed state's scope, ADR
   * 0116); not with `account`. A provider account is then listed once per
   * resolved account its rows map to, so no row of one account is listed
   * under another. A one-account list is read as `account`, so it answers
   * what `account` answers, context id included. A longer list is not among
   * the manifest's filters: the rows the manifest pins fix what it lists.
   */
  accounts?: readonly string[];
}

interface SettlementRow {
  account_id: string;
  source_id: string;
  period: string;
  id: string;
  facts_json: string;
  status: ReportedSettlement["reviewStatus"];
  decision_revision_id: string | null;
}

const DAY_MS = 86_400_000;
const IDENTITY = new Set<string>(IDENTITY_STATUSES);
const REASONS = new Set<string>(STATEMENTS_BEFORE_WINDOW_REASONS);

function identityStatus(recorded: number, status: string | null): IdentityStatus {
  if (recorded !== 1) return "not-recorded";
  return status !== null && IDENTITY.has(status) ? (status as IdentityStatus) : "unresolved";
}

/** A stored decimal-v1 value, or the reason there is none; never a zero. */
function storedQuantity(
  unitRef: string,
  status: string | null,
  coefficient: string | null,
  scale: number | null,
): Quantity {
  if (status === "exact" && coefficient !== null && scale !== null)
    return exactQuantity(unitRef, normalizeDecimal(BigInt(coefficient), scale), "decimal-v1");
  if (status === "missing" || status === "unparsed" || status === "conflict")
    return absentQuantity(unitRef, status, `stored:${status}`);
  return absentQuantity(unitRef, "missing", "decimal_not_recorded");
}

const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/u;
const SCHEDULE_KINDS = new Set<string>(SCHEDULED_PAYMENT_KINDS);
const LOCAL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

/**
 * A scheduled payment's stored amount: `amount_text` is a canonical integer
 * at scale 0 (migration 0061's checks), read as an exact decimal; any other
 * text is kept as unparsed, never a zero.
 */
function scheduledAmount(text: string, scale: number, currency: string): Quantity {
  if (scale !== 0 || !CANONICAL_INTEGER.test(text))
    return absentQuantity(currency, "unparsed", "scheduled_amount_not_canonical");
  return exactQuantity(currency, normalizeDecimal(BigInt(text), 0));
}

/**
 * The scheduled-payment captures as of the cutoff, one per page, each with
 * the payments it listed in due-date order. A row that breaks the table's
 * own checks (a kind, a date or a text it refuses) throws rather than being
 * shown in a shape the answer does not admit.
 */
function scheduledPaymentCaptures(
  rows: readonly DatedScheduledPaymentRow[],
  date: string,
): ReportedScheduledPaymentCapture[] {
  const captures = new Map<number, ReportedScheduledPaymentCapture>();
  for (const row of rows) {
    let capture = captures.get(row.artifact_id);
    if (capture === undefined) {
      capture = {
        ref: `artifact:${row.artifact_id}`,
        sourceId: row.source_id,
        parserName: SCHEDULED_PAYMENT_PARSER,
        capturedAt: row.fetched_at,
        ...snapshotFreshness(row.fetched_at, date),
        payments: [],
      };
      captures.set(row.artifact_id, capture);
    }
    if (row.id === null) continue;
    if (
      row.source_account === null ||
      row.schedule_kind === null ||
      !SCHEDULE_KINDS.has(row.schedule_kind) ||
      row.usage_date === null ||
      !LOCAL_DATE.test(row.usage_date) ||
      row.due_date === null ||
      !LOCAL_DATE.test(row.due_date) ||
      row.amount_text === null ||
      row.amount_scale === null ||
      row.currency === null ||
      row.counterparty === null ||
      row.as_of === null ||
      !LOCAL_DATE.test(row.as_of)
    )
      throw new Error("scheduled_payment_row_invalid");
    capture.payments.push({
      ref: `scheduled-payment:${row.id}`,
      sourceAccount: row.source_account,
      scheduleKind: row.schedule_kind as ScheduledPaymentKind,
      usageDate: row.usage_date,
      dueDate: row.due_date,
      amount: scheduledAmount(row.amount_text, row.amount_scale, row.currency),
      providerText: row.amount_text,
      counterparty: row.counterparty,
      asOf: row.as_of,
      dueStatus: scheduledPaymentDueStatus(date, row.due_date),
    });
  }
  return [...captures.values()];
}

function snapshotKey(row: { parser_name: string; snapshot_artifact_id: number }): string {
  return `${row.parser_name}|artifact:${row.snapshot_artifact_id}`;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A row's pin in the manifest: its ref and the identity the answer shows for
 * it (the account and instrument mappings and their statuses, as `accountOf`
 * and `instrument` read them), so a later mapping revision or identity run
 * that changes what the answer shows changes the context id (INV09).
 */
function manifestRow(
  ref: string,
  row: DatedPositionRow | DatedBalanceRow,
): ReportedStateManifestRow {
  const recorded = row.identity_recorded === 1;
  return [
    ref,
    row.account_id,
    recorded ? identityStatus(1, row.account_status) : "not-recorded",
    row.instrument_id,
    recorded ? identityStatus(1, row.instrument_status) : "not-recorded",
  ];
}

function bounded<T>(rows: T[]): T[] {
  if (rows.length > DATED_STATE_ROW_BOUND) throw new DatedStateLimitError();
  return rows;
}

/** The bank debit date an accepted review states, or null. */
function debitDate(factsJson: string): string | null {
  let facts: unknown;
  try {
    facts = JSON.parse(factsJson);
  } catch {
    return null;
  }
  if (!validCardSettlementFacts(facts)) return null;
  const occurred = facts.bankDebit.occurred;
  return occurred.kind === "local-date" ? occurred.value : null;
}

/**
 * The reported state on `input.date`. It counts the statements the payable
 * window leaves out (`DATED_STATEMENTS_BEFORE_WINDOW_SQL`) into its coverage
 * and its manifest unless `includeStatementsBeforeWindow` is `false`: then it
 * skips that read and answers an `UncountedReportedState`, whose coverage and
 * manifest carry no count, for the reads that build on it and never show one
 * (the holdings change, the reconstructed state and the valuation on a date).
 */
export function queryDatedState(
  sql: SqlExecutor,
  input: DatedStateInput & { includeStatementsBeforeWindow: false },
): Promise<UncountedReportedState>;
export function queryDatedState(
  sql: SqlExecutor,
  input: DatedStateInput & { includeStatementsBeforeWindow?: true },
): Promise<ReportedState>;
export async function queryDatedState(
  sql: SqlExecutor,
  input: DatedStateInput & { includeStatementsBeforeWindow?: boolean },
): Promise<ReportedState | UncountedReportedState> {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input.date) || parseLocalDate(input.date) === null)
    throw new Error("invalid_date");
  const date = input.date;
  const cutoff = reportedStateCutoff(date);
  const fromPaymentDate = payablesFromPaymentDate(date);
  const undatedFrom = new Date(
    Date.parse(cutoff) - UNDATED_STATEMENT_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  const source = input.source ?? null;
  if ((input.account ?? null) !== null && input.accounts !== undefined)
    throw new Error("invalid_query");
  // A one-account list is the `account` read, its filters and so its context
  // id included (ADR 0116; the manifest pins the request's filters, INV09).
  const single = input.accounts?.length === 1 ? input.accounts[0]! : null;
  const account = input.account ?? single;
  const scope = input.accounts === undefined || single !== null ? null : new Set(input.accounts);
  const counted = input.includeStatementsBeforeWindow !== false;
  // A scheduled payment has no identity run, so no resolved account: under an
  // account filter none can match, and the coverage says they are not listed.
  const scheduledListing: ScheduledPaymentsListing =
    account === null && scope === null ? "listed" : "not_listed_account_filter";

  const [positionRows, balanceRows, perimeter, statementRows, omittedRows, scheduledRows] =
    await Promise.all([
      sql.all<DatedPositionRow>(DATED_POSITIONS_SQL, [cutoff]),
      sql.all<DatedBalanceRow>(DATED_BALANCES_SQL, [cutoff]),
      sql.all<DatedSnapshotRow>(DATED_SNAPSHOTS_SQL, [cutoff]),
      sql.all<DatedStatementRow>(DATED_STATEMENTS_SQL, [cutoff, fromPaymentDate, undatedFrom]),
      counted
        ? sql.all<DatedStatementsBeforeWindowRow>(DATED_STATEMENTS_BEFORE_WINDOW_SQL, [
            cutoff,
            fromPaymentDate,
            undatedFrom,
          ])
        : null,
      counted && scheduledListing === "listed"
        ? sql.all<DatedScheduledPaymentRow>(DATED_SCHEDULED_PAYMENTS_SQL, [cutoff])
        : null,
    ]);
  bounded(positionRows);
  bounded(balanceRows);
  bounded(statementRows);
  if (omittedRows !== null) bounded(omittedRows);
  if (scheduledRows !== null) bounded(scheduledRows);

  const wanted = (sourceId: string, accountId: string | null): boolean =>
    (source === null || sourceId === source) &&
    (account === null || accountId === account) &&
    (scope === null || (accountId !== null && scope.has(accountId)));

  // Every chosen snapshot, a complete-empty one included.
  const snapshots = new Map<string, ReportedSnapshot>();
  for (const row of perimeter) {
    if (row.snapshot_artifact_id === null || row.source_id === null || row.captured_at === null)
      continue;
    const key = snapshotKey({
      parser_name: row.parser_name,
      snapshot_artifact_id: row.snapshot_artifact_id,
    });
    if (snapshots.has(key)) continue;
    snapshots.set(key, {
      ref: `artifact:${row.snapshot_artifact_id}`,
      sourceId: row.source_id,
      parserName: row.parser_name,
      dataset: row.dataset,
      capturedAt: row.captured_at,
      ...snapshotFreshness(row.captured_at, date),
    });
  }

  const accounts = new Map<string, ReportedAccount>();
  const accountOf = (row: DatedPositionRow | DatedBalanceRow): ReportedAccount => {
    // One entry per resolved account a provider account's rows map to: an
    // identity can key a source account on more than the provider account,
    // so a provider account whose rows map to two accounts is two entries,
    // and no row is listed under an account its own mapping does not name.
    const key = JSON.stringify([row.source_id, row.source_account, row.account_id]);
    let entry = accounts.get(key);
    if (entry === undefined) {
      entry = {
        sourceId: row.source_id,
        sourceAccount: row.source_account,
        accountId: row.account_id,
        identityStatus:
          row.account_id === null
            ? "not-recorded"
            : identityStatus(row.identity_recorded, row.account_status),
        snapshots: [],
        positions: [],
        balances: [],
      };
      accounts.set(key, entry);
    }
    if (entry.identityStatus === "not-recorded" && row.identity_recorded === 1)
      entry.identityStatus = identityStatus(row.identity_recorded, row.account_status);
    // Four reads are four statements: a snapshot sealed between them is
    // still described from its own row rather than dropped.
    const chosenKey = snapshotKey(row);
    let snapshot = snapshots.get(chosenKey);
    if (snapshot === undefined) {
      snapshot = {
        ref: `artifact:${row.snapshot_artifact_id}`,
        sourceId: row.source_id,
        parserName: row.parser_name,
        dataset: row.dataset,
        capturedAt: row.captured_at,
        ...snapshotFreshness(row.captured_at, date),
      };
      snapshots.set(chosenKey, snapshot);
    }
    if (!entry.snapshots.includes(snapshot)) entry.snapshots.push(snapshot);
    return entry;
  };
  const instrument = (row: DatedPositionRow | DatedBalanceRow): ReportedInstrument => ({
    instrumentId: row.instrument_id,
    status: row.identity_recorded === 1 ? identityStatus(1, row.instrument_status) : "not-recorded",
  });

  // Every position and balance the answer lists or counts, with its identity.
  const pinnedRows: ReportedStateManifestRow[] = [];
  const positions = new Map<number, ReportedPosition>();
  for (const row of positionRows) {
    if (!wanted(row.source_id, row.account_id)) continue;
    let position = positions.get(row.id);
    if (position === undefined) {
      pinnedRows.push(manifestRow(`position:${row.id}`, row));
      position = {
        ref: `position:${row.id}`,
        snapshotRef: `artifact:${row.snapshot_artifact_id}`,
        securityCode: row.security_code,
        securityName: row.security_name,
        market: row.market,
        quantityText: row.quantity_text,
        currency: row.currency,
        asOf: row.as_of,
        instrument: instrument(row),
        valuations: [],
      };
      positions.set(row.id, position);
      accountOf(row).positions.push(position);
    }
    if (row.valuation_id !== null)
      position.valuations.push({
        ref: `valuation:${row.valuation_id}`,
        metric: row.valuation_metric!,
        amount: storedQuantity(
          row.valuation_currency!,
          row.valuation_value_status,
          row.valuation_coefficient,
          row.valuation_scale,
        ),
        providerText: row.valuation_amount_text,
        asOf: row.valuation_as_of,
      });
  }

  const excludedRows = new Map<ExclusionReason, number>();
  for (const row of balanceRows) {
    if (!wanted(row.source_id, row.account_id)) continue;
    pinnedRows.push(manifestRow(`balance:${row.id}`, row));
    const metric = resolveMetric({
      family: "balance",
      sourceId: row.source_id,
      parserName: row.parser_name,
      metric: row.metric,
      sourceAccount: row.source_account,
      amountBasis: null,
    });
    // A balance restated after each transaction and a reward unit are not
    // holdings on the date (ADR 0019, decision 2); they are counted, not listed.
    const excluded: ExclusionReason | null =
      metric.timeBasis === "event-reported"
        ? "balance_after_transaction"
        : metric.unitDimension === "reward"
          ? "reward_units"
          : null;
    if (excluded !== null) {
      excludedRows.set(excluded, (excludedRows.get(excluded) ?? 0) + 1);
      continue;
    }
    const balance: ReportedBalance = {
      ref: `balance:${row.id}`,
      snapshotRef: `artifact:${row.snapshot_artifact_id}`,
      providerMetric: row.metric,
      metric: {
        metricId: metric.metricId,
        measurementKind: metric.measurementKind,
        subjectKind: metric.subjectKind,
        signMeaning: metric.signMeaning,
        aggregationRule: metric.aggregationRule,
        overlapGroup: metric.overlapGroup,
        definitionRelease: metric.definitionRelease,
      },
      amount: storedQuantity(row.instrument, row.value_status, row.coefficient, row.scale),
      providerText: row.amount_text,
      asOf: row.as_of,
      instrument: instrument(row),
    };
    accountOf(row).balances.push(balance);
  }

  // Settlement reviews of the listed statements, one per (account, source,
  // period), accepted first (the purchases page's own read).
  const statements = statementRows.filter((row) => wanted(row.source_id, row.account_id));
  const keys = statements
    .filter((row) => row.account_id !== null && row.period !== null)
    .map((row) => [row.account_id, row.source_id, row.period]);
  const settlementRows =
    keys.length === 0 ? [] : await sql.all<SettlementRow>(SETTLEMENT_SQL, [JSON.stringify(keys)]);
  const settlements = new Map<string, SettlementRow>(
    settlementRows.map((row) => [JSON.stringify([row.account_id, row.source_id, row.period]), row]),
  );
  const payables: ReportedPayable[] = statements.map((row) => {
    const review =
      row.account_id === null || row.period === null
        ? undefined
        : settlements.get(JSON.stringify([row.account_id, row.source_id, row.period]));
    const settlement: ReportedSettlement | null =
      review === undefined
        ? null
        : {
            proposalId: review.id,
            reviewStatus: review.status,
            debitDate: debitDate(review.facts_json),
          };
    return {
      ref: `balance:${row.id}`,
      sourceId: row.source_id,
      sourceAccount: row.source_account,
      accountId: row.account_id,
      period: row.period,
      capturedAt: row.fetched_at,
      paymentDate: row.payment_date,
      amount: storedQuantity(row.unit_ref, row.value_status, row.coefficient, row.scale),
      status: payableStatus(date, row.payment_date, settlement),
      settlement,
    };
  });

  // The statements the window leaves out, counted under the same filters as
  // the payables (an unresolved statement has no account to match): per
  // source, resolved account and reason for the manifest, so that a changed
  // count gives a new context id, and per source and reason for the coverage.
  let counts: {
    manifest: ManifestStatementsBeforeWindow[];
    coverage: StatementsBeforeWindow[];
  } | null = null;
  if (omittedRows !== null) {
    const keyed = new Map<string, ManifestStatementsBeforeWindow>();
    const omitted = new Map<string, StatementsBeforeWindow>();
    for (const row of omittedRows) {
      if (!wanted(row.source_id, row.account_id)) continue;
      if (!REASONS.has(row.reason_code)) throw new Error("unknown_statement_window_reason");
      const reasonCode = row.reason_code as StatementsBeforeWindowReason;
      const manifestKey = JSON.stringify([row.source_id, row.account_id, reasonCode]);
      const manifestEntry = keyed.get(manifestKey) ?? {
        sourceId: row.source_id,
        accountId: row.account_id,
        reasonCode,
        count: 0,
      };
      manifestEntry.count += row.statements;
      keyed.set(manifestKey, manifestEntry);
      const key = JSON.stringify([row.source_id, reasonCode]);
      const entry = omitted.get(key) ?? { sourceId: row.source_id, reasonCode, count: 0 };
      entry.count += row.statements;
      omitted.set(key, entry);
    }
    counts = {
      manifest: [...keyed.values()].sort(
        (a, b) =>
          byText(a.sourceId, b.sourceId) ||
          (a.accountId === b.accountId
            ? 0
            : a.accountId === null
              ? -1
              : b.accountId === null
                ? 1
                : byText(a.accountId, b.accountId)) ||
          byText(a.reasonCode, b.reasonCode),
      ),
      coverage: [...omitted.values()].sort(
        (a, b) => a.sourceId.localeCompare(b.sourceId) || a.reasonCode.localeCompare(b.reasonCode),
      ),
    };
  }

  const chosen = [...snapshots.values()].filter(
    (snapshot) => source === null || snapshot.sourceId === source,
  );
  // Entries of one provider account follow their resolved account, an
  // unresolved one first, so the order never depends on row ids.
  const listedAccounts = [...accounts.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) ||
      a.sourceAccount.localeCompare(b.sourceAccount) ||
      (a.accountId === b.accountId
        ? 0
        : a.accountId === null
          ? -1
          : b.accountId === null
            ? 1
            : a.accountId < b.accountId
              ? -1
              : 1),
  );
  const containersWithoutSnapshot = perimeter
    .filter((row) => row.snapshot_artifact_id === null)
    .filter((row) => source === null || row.perimeter_source_id === source)
    .map((row) => ({
      sourceId: row.perimeter_source_id,
      parserName: row.parser_name,
      dataset: row.dataset,
      reasonCode: "no_complete_snapshot_before_cutoff" as const,
    }));
  // The manifest pins every input the answer reads (INV09): the request's
  // filters, the releases the code applies, the chosen snapshots and the
  // containers without one, each listed or counted row (its id names its
  // parse run) with the identity it was read under, each payable's account,
  // each settlement review at its decision and, when counted, the statements
  // the payable window leaves out and each scheduled-payment capture at its
  // parse with each payment it lists. Observations, candidates and decisions
  // are append-only, so these ids fix what they name. A state read without
  // the count records neither: its context id claims only the inputs it read
  // (ADR 0019, amendments of 2026-11-18 and 2026-11-21).
  const scheduledInScope = (scheduledRows ?? []).filter(
    (row) => source === null || row.source_id === source,
  );
  const scheduled = scheduledPaymentCaptures(scheduledInScope, date);
  const scheduledCaptureRefs = new Map<string, string>();
  for (const row of scheduledInScope)
    scheduledCaptureRefs.set(`artifact:${row.artifact_id}`, `parse_run:${row.parse_run_id}`);
  const manifest: UncountedReportedState["manifest"] & {
    statementsBeforeWindow?: ManifestStatementsBeforeWindow[];
    scheduledPaymentCaptures?: [string, string][];
    scheduledPaymentRefs?: string[];
  } = {
    schemaVersion: REPORTED_STATE_SCHEMA,
    date,
    cutoff,
    policies: [DATED_STATE_FRESHNESS_POLICY, DATED_STATE_PERIMETER_POLICY],
    metricRegistryRelease: METRIC_REGISTRY_RELEASE,
    filters: { source, account },
    snapshotRefs: [...new Set(chosen.map((snapshot) => snapshot.ref))].sort(),
    containersWithoutSnapshot: containersWithoutSnapshot
      .map((entry) => `${entry.sourceId}/${entry.parserName}/${entry.dataset}`)
      .sort(),
    rows: pinnedRows.sort((a, b) => byText(a[0], b[0])),
    statementRefs: payables.map((payable) => payable.ref).sort(),
    statementAccounts: payables
      .map((payable): [string, string | null] => [payable.ref, payable.accountId])
      .sort((a, b) => byText(a[0], b[0])),
    settlementRefs: settlementRows
      .map(
        (row) =>
          `card-settlement:${row.id}@${row.decision_revision_id === null ? "proposed" : `decision:${row.decision_revision_id}`}`,
      )
      .sort(),
    ...(counts === null
      ? {}
      : {
          statementsBeforeWindow: counts.manifest,
          scheduledPaymentCaptures: [...scheduledCaptureRefs].sort((a, b) => byText(a[0], b[0])),
          scheduledPaymentRefs: scheduled
            .flatMap((capture) => capture.payments.map((payment) => payment.ref))
            .sort(byText),
        }),
  };
  const state: UncountedReportedState = {
    schemaVersion: REPORTED_STATE_SCHEMA,
    date,
    cutoff,
    zone: REPORTED_STATE_ZONE,
    filters: { source, account },
    snapshots: chosen,
    accounts: listedAccounts,
    payables,
    coverage: {
      containersWithoutSnapshot,
      staleSnapshots: chosen
        .filter((snapshot) => snapshot.freshness === "stale")
        .map((snapshot) => ({
          ref: snapshot.ref,
          sourceId: snapshot.sourceId,
          parserName: snapshot.parserName,
          ageDays: snapshot.ageDays,
        })),
      excluded: REPORTED_STATE_EXCLUSIONS.map((entry) => ({ ...entry })),
      excludedRows: [...excludedRows]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reasonCode, count]) => ({ reasonCode, count })),
      liabilitiesCoverage: "partial",
      liabilitiesMissing: liabilityGaps(counts === null ? null : counts.coverage),
      payablesFromPaymentDate: fromPaymentDate,
      ...(counts === null ? {} : { statementsBeforeWindow: counts.coverage }),
      netAssets: "not-computed",
    },
    manifest,
    contextId: await canonicalDigest(manifest),
  };
  if (counts === null) return state;
  // The served answer: the same objects with the count and the scheduled
  // payments, the scheduled payments placed after the payables (the other
  // keys keep their order).
  return {
    schemaVersion: state.schemaVersion,
    date: state.date,
    cutoff: state.cutoff,
    zone: state.zone,
    filters: state.filters,
    snapshots: state.snapshots,
    accounts: state.accounts,
    payables: state.payables,
    scheduledPayments: scheduled,
    coverage: {
      ...state.coverage,
      statementsBeforeWindow: counts.coverage,
      scheduledPayments: scheduledListing,
    },
    manifest: {
      ...state.manifest,
      statementsBeforeWindow: counts.manifest,
      scheduledPaymentCaptures: manifest.scheduledPaymentCaptures!,
      scheduledPaymentRefs: manifest.scheduledPaymentRefs!,
    },
    contextId: state.contextId,
  };
}
