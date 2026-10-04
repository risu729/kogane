// Reported state on a date (docs/reported-state.md, ADR 0019): per account,
// what the provider last reported in a complete container snapshot captured
// before the end of the date, and the card statements due around it with where
// each stands. One bounded read path; it never writes and never adds two
// amounts. A container without a snapshot is named in the coverage, never
// shown as a zero balance, and a statement without a readable due date is its
// own status, never a guess.
import { validCardSettlementFacts } from "../../../domain/src/card-settlement.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import { resolveMetric } from "../../../domain/src/metrics.ts";
import {
  DATED_STATE_FRESHNESS_POLICY,
  DATED_STATE_PERIMETER_POLICY,
  IDENTITY_STATUSES,
  LIABILITY_GAPS,
  payablesFromPaymentDate,
  payableStatus,
  REPORTED_STATE_EXCLUSIONS,
  REPORTED_STATE_SCHEMA,
  REPORTED_STATE_ZONE,
  reportedStateCutoff,
  snapshotFreshness,
  UNDATED_STATEMENT_WINDOW_DAYS,
  type ExclusionReason,
  type IdentityStatus,
  type ReportedAccount,
  type ReportedBalance,
  type ReportedInstrument,
  type ReportedPayable,
  type ReportedPosition,
  type ReportedSettlement,
  type ReportedSnapshot,
  type ReportedState,
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
  DATED_SNAPSHOTS_SQL,
  DATED_STATE_ROW_BOUND,
  DATED_STATEMENTS_SQL,
  type DatedBalanceRow,
  type DatedPositionRow,
  type DatedSnapshotRow,
  type DatedStatementRow,
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
}

interface SettlementRow {
  account_id: string;
  source_id: string;
  period: string;
  id: string;
  facts_json: string;
  status: ReportedSettlement["reviewStatus"];
}

const DAY_MS = 86_400_000;
const IDENTITY = new Set<string>(IDENTITY_STATUSES);

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

function snapshotKey(row: { parser_name: string; snapshot_artifact_id: number }): string {
  return `${row.parser_name}|artifact:${row.snapshot_artifact_id}`;
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

export async function queryDatedState(
  sql: SqlExecutor,
  input: DatedStateInput,
): Promise<ReportedState> {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input.date) || parseLocalDate(input.date) === null)
    throw new Error("invalid_date");
  const date = input.date;
  const cutoff = reportedStateCutoff(date);
  const fromPaymentDate = payablesFromPaymentDate(date);
  const undatedFrom = new Date(
    Date.parse(cutoff) - UNDATED_STATEMENT_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  const source = input.source ?? null;
  const account = input.account ?? null;

  const [positionRows, balanceRows, perimeter, statementRows] = await Promise.all([
    sql.all<DatedPositionRow>(DATED_POSITIONS_SQL, [cutoff]),
    sql.all<DatedBalanceRow>(DATED_BALANCES_SQL, [cutoff]),
    sql.all<DatedSnapshotRow>(DATED_SNAPSHOTS_SQL, [cutoff]),
    sql.all<DatedStatementRow>(DATED_STATEMENTS_SQL, [cutoff, fromPaymentDate, undatedFrom]),
  ]);
  bounded(positionRows);
  bounded(balanceRows);
  bounded(statementRows);

  const wanted = (sourceId: string, accountId: string | null): boolean =>
    (source === null || sourceId === source) && (account === null || accountId === account);

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
    const key = JSON.stringify([row.source_id, row.source_account]);
    let entry = accounts.get(key);
    if (entry === undefined) {
      entry = {
        sourceId: row.source_id,
        sourceAccount: row.source_account,
        accountId: null,
        identityStatus: "not-recorded",
        snapshots: [],
        positions: [],
        balances: [],
      };
      accounts.set(key, entry);
    }
    if (entry.accountId === null && row.account_id !== null) {
      entry.accountId = row.account_id;
      entry.identityStatus = identityStatus(row.identity_recorded, row.account_status);
    } else if (entry.identityStatus === "not-recorded" && row.identity_recorded === 1)
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

  const positions = new Map<number, ReportedPosition>();
  for (const row of positionRows) {
    if (!wanted(row.source_id, row.account_id)) continue;
    let position = positions.get(row.id);
    if (position === undefined) {
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

  const chosen = [...snapshots.values()].filter(
    (snapshot) => source === null || snapshot.sourceId === source,
  );
  const listedAccounts = [...accounts.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) || a.sourceAccount.localeCompare(b.sourceAccount),
  );
  const manifest = {
    schemaVersion: REPORTED_STATE_SCHEMA,
    date,
    cutoff,
    policies: [DATED_STATE_FRESHNESS_POLICY, DATED_STATE_PERIMETER_POLICY],
    snapshotRefs: [...new Set(chosen.map((snapshot) => snapshot.ref))].sort(),
    statementRefs: payables.map((payable) => payable.ref).sort(),
    settlementRefs: settlementRows.map((row) => `card-settlement:${row.id}`).sort(),
  } as const;
  return {
    schemaVersion: REPORTED_STATE_SCHEMA,
    date,
    cutoff,
    zone: REPORTED_STATE_ZONE,
    filters: { source, account },
    snapshots: chosen,
    accounts: listedAccounts,
    payables,
    coverage: {
      containersWithoutSnapshot: perimeter
        .filter((row) => row.snapshot_artifact_id === null)
        .filter((row) => source === null || row.perimeter_source_id === source)
        .map((row) => ({
          sourceId: row.perimeter_source_id,
          parserName: row.parser_name,
          dataset: row.dataset,
          reasonCode: "no_complete_snapshot_before_cutoff" as const,
        })),
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
      liabilitiesMissing: [...LIABILITY_GAPS],
      payablesFromPaymentDate: fromPaymentDate,
      netAssets: "not-computed",
    },
    manifest: { ...manifest, policies: [...manifest.policies] },
    contextId: await canonicalDigest(manifest),
  };
}
