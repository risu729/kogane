import { isDecisionOrigin } from "./decision-origin-contract.ts";
import {
  INSTRUMENT_HISTORY_PATH,
  validInstrumentHistoryRead,
} from "./instrument-history-contract.ts";
import { ACCOUNT_HISTORY_PATH, validAccountHistoryRead } from "./account-history-contract.ts";
import {
  INSTRUMENT_COVERAGE_PATH,
  validInstrumentCoverage,
} from "./instrument-coverage-contract.ts";
import { validRewardProviderExpirySection } from "../../domain/src/reward-expiry-observations.ts";
import { validQuantity } from "../../domain/src/values.ts";
import { validTemporalValue, validInstantText, validLocalDateText } from "../../domain/src/time.ts";
import type {
  RewardBucketRow,
  RewardHoldingRow,
  RewardExpiryRow,
  RewardReadExpiryRow,
  RewardPage,
  RewardReadExpiryPage,
  RewardReadExpiryWindowedPage,
  RewardExpirySummary,
  RewardExpirySummaryAmount,
  RewardExpirySummaryDisplay,
  RewardExpirySummaryLine,
  RewardExpirySummaryProgram,
  RewardExpirySummaryTotal,
  RewardExpiryWindow,
  RewardExpiryWindowCounts,
} from "./reward-contract.ts";
import {
  REWARD_EXPIRY_LEFT_OUT_REASONS,
  validRewardExpiryBasis,
  validRewardBucketKind,
} from "./reward-contract.ts";
// Runtime checks for the shared HTTP contract; no database or UI dependencies.
// Shape<T> requires a validator for every declared field when contracts evolve.
import { isDecimalMinorUnit } from "../../parsers/src/money.ts";
import { validFinancialResult } from "../../domain/src/result.ts";
import { validIdentityResponse } from "./identity-contract.ts";
import {
  ACCOUNT_CANDIDATES_PATH,
  validAccountCandidateReview,
} from "./account-candidates-contract.ts";
import {
  INSTRUMENT_CANDIDATES_PATH,
  validInstrumentCandidateReview,
} from "./instrument-candidates-contract.ts";
import { validCardOwnershipReview } from "./card-ownership-contract.ts";
import { AUDIT_PAGE_PATH, validAuditPage } from "./audit-contract.ts";
import { validCardPurchasePage } from "./card-purchase-contract.ts";
import { validReconstructedState } from "./reconstructed-state-contract.ts";
import {
  ECONOMIC_READINESS_PATH,
  validEconomicReadinessResult,
} from "./economic-readiness-contract.ts";
import { validReportedHoldingsChange } from "./reported-holdings-change-contract.ts";
import { validReportedState } from "./reported-state-contract.ts";
import { validReportResponse } from "./report-artifact-contract.ts";
import { validCollectionQualityResponse } from "./collection-quality-contract.ts";
import {
  OPERATION_LIST_PATH,
  OPERATION_RECORD_PATH_PREFIX,
  operationIdOfPath,
  validOperationListPage,
  validOperationRecord,
} from "./operation-contract.ts";
import {
  validCardSettlementReviewPage,
  validCardSettlementStatementPage,
} from "./card-settlement-contract.ts";
import {
  CARD_STATEMENTS_UNMATCHED_PATH,
  validUnmatchedCardStatementsReview,
} from "./card-statements-unmatched-contract.ts";
import {
  CARD_DEBIT_ACCOUNTS_PATH,
  validCardDebitAccountsReview,
} from "./card-debit-accounts-contract.ts";
import { validUpcomingCardBills } from "./card-upcoming-bills-contract.ts";
import { CHANGES_SINCE_PATH, validChangesSince } from "./changes-since-contract.ts";
import { validAccountConnection } from "./account-connection-contract.ts";
import { validFinancialProductClaimWire } from "./financial-products.ts";
import { validBalanceInterpretation } from "./balance-semantics.ts";
import {
  BALANCE_READ_MODELS,
  REWARD_READ_MODELS,
  IDENTITY_READ_MODES,
  MEASURE_VIEWS,
  OBSERVATION_API_CONTRACT_VERSION,
  PAGINATION_VERSIONS,
  validInterpretationContext,
  type ApiCapabilities,
  type InterpretationContext,
} from "./api-schema.ts";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "./organization-contract.ts";
import {
  BALANCE_HISTORY_REASONS,
  BALANCE_LIST_LATEST_REASONS,
  BALANCE_LIST_SUMMARY_LINES,
  OVERVIEW_FETCH_RUN_STATUSES,
  OVERVIEW_LINE_FAILURE_CODES,
  OVERVIEW_PARSE_RUN_STATUSES,
  OVERVIEW_SUMMARY_LINES,
} from "./api-contract.ts";
import type {
  ApiMetadata,
  ArtifactDetail,
  GlobalPassEmptyMonth,
  GlobalPassEmptyMonths,
  BalanceAdoption,
  BalanceEvidenceMember,
  BalanceHistoryItem,
  BalanceHistoryPage,
  BalanceHistorySummaryItem,
  BalanceHistorySummaryPage,
  BalanceListLatestLine,
  BalanceListPage,
  BalanceListSummaryMetric,
  BalanceListSummaryPage,
  KnownAssetsSubtotals,
  LatestBalanceItem,
  LatestBalancePage,
  LatestBalanceSummaryItem,
  LatestBalanceSummaryPage,
  SummaryAccount,
  SummaryAmount,
  SummaryMetric,
  MeasureDescriptor,
  ObservedQuantityWire,
  SnapshotDataCoverage,
  SnapshotPageInfo,
  TemporalReferenceWire,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  ObservationDetail,
  ObservationKind,
  ObservationRef,
  Overview,
  OverviewSummary,
  ParseRunDetail,
  PositionRow,
  PositionWithValuations,
  Provenance,
  TransactionRow,
  UnitUpdateSummary,
  ValuationRow,
  Warnings,
} from "./api-contract.ts";

type Check<T> = (value: unknown) => value is T;
type Shape<T> = { [K in keyof T]-?: Check<T[K]> };
const text: Check<string> = (value): value is string => typeof value === "string";
const number: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const identifier: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash: Check<string> = (value): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const boolean: Check<boolean> = (value): value is boolean => typeof value === "boolean";
const unknown: Check<unknown> = (_value): _value is unknown => true;
const record: Check<Record<string, unknown>> = (value): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function nullable<T>(check: Check<T>): Check<T | null> {
  return (value): value is T | null => value === null || check(value);
}
function optional<T>(check: Check<T>): Check<T | undefined> {
  return (value): value is T | undefined => value === undefined || check(value);
}
function array<T>(check: Check<T>): Check<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(check);
}
function literal<T extends string | number | boolean>(...choices: T[]): Check<T> {
  return (value): value is T => choices.some((choice) => choice === value);
}
function object<T>(shape: Shape<T>): Check<T> {
  return (value): value is T =>
    record(value) &&
    (Object.keys(shape) as (keyof T & string)[]).every((key) => shape[key](value[key]));
}
const nullableText = nullable(text);
const nullableNumber = nullable(number);
const nullableIdentifier = nullable(identifier);
const minorUnit = nullable(isDecimalMinorUnit);
const observationKind = literal<ObservationKind>("transaction", "balance", "position", "valuation");
const organizationAccountFields = {
  referenceId: text,
  targetId: text,
  label: text,
  status: literal("identified", "provider-local", "aggregate", "unresolved"),
  revision: (value: unknown): value is number => identifier(value) && value > 0,
  method: literal("rule", "manual"),
  decisionOrigin: optional(isDecisionOrigin),
  reason: text,
} satisfies Shape<Omit<OrganizedAccount, "connection">>;
const organizationShape = object<ObservationOrganization>({
  product: optional(validFinancialProductClaimWire),
  mappingRevision: optional((value: unknown): value is number => identifier(value) && value > 0),
  identityRelease: optional(text),
  state: literal("organized", "unavailable"),
  lineage: nullable(literal("current", "historical")),
  account: nullable(
    object<OrganizedAccount>({
      ...organizationAccountFields,
      connection: optional(validAccountConnection),
    }),
  ),
  instruments: array(
    object<OrganizedInstrument>({
      ...organizationAccountFields,
      role: literal("unit", "security", "trade-unit", "usage-unit"),
      namespace: text,
      scope: text,
      value: text,
      nameEvidence: optional(
        object<NonNullable<OrganizedInstrument["nameEvidence"]>>({
          reason: literal("manual", "provider-current", "observed-japanese-script"),
          decisionOrigin: optional(isDecisionOrigin),
          origin: nullable(object({ kind: observationKind, id: identifier })),
        }),
      ),
    }),
  ),
});
const organization: Check<ObservationOrganization> = (value): value is ObservationOrganization =>
  organizationShape(value) &&
  (value.state === "organized"
    ? value.account !== null &&
      value.lineage !== null &&
      new Set(value.instruments.map((i) => i.role)).size === value.instruments.length
    : value.account === null &&
      value.lineage === null &&
      value.instruments.length === 0 &&
      value.product === undefined);
const warnings = object<Warnings>({
  list: array(text),
  raw: nullableText,
  parsed: boolean,
});
/** A distinct list of members drawn from a closed set of names. */
function subset<T extends string>(choices: readonly T[]): Check<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) &&
    value.every((member) => choices.includes(member)) &&
    new Set(value).size === value.length;
}
/** A connection name is an identifier for labels; it never selects behaviour. */
const sourceKind: Check<string> = (value): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
export const validApiCapabilities: Check<ApiCapabilities> = object<ApiCapabilities>({
  contractVersion: literal(OBSERVATION_API_CONTRACT_VERSION),
  readOnly: literal(true),
  rawEvidence: literal(true),
  liveCollectors: literal(false),
  measureViews: subset(MEASURE_VIEWS),
  identityReadModes: subset(IDENTITY_READ_MODES),
  paginationVersion: literal(...PAGINATION_VERSIONS),
  balancesV2: boolean,
  balancesV2Pagination: literal(...PAGINATION_VERSIONS),
  balancesV2ReadModel: literal(...BALANCE_READ_MODELS),
  rewardsV2ReadModel: literal(...REWARD_READ_MODELS),
  collectionFilters: boolean,
  organizedDisplay: boolean,
  financialProducts: boolean,
  evidenceHistory: boolean,
  sharedQuery: boolean,
  rewardsV2: boolean,
  commands: boolean,
  eventsV2: boolean,
  cardSettlementReconciliation: optional(boolean),
  cardOwnershipReview: optional(boolean),
  cardPurchaseRecognition: optional(boolean),
  reportedStateOnDate: optional(boolean),
  reconstructedStateOnDate: optional(boolean),
  reportArtifacts: optional(boolean),
  opsApi: boolean,
});
const globalPassEmptyMonth = object<GlobalPassEmptyMonth>({
  source: text,
  month: (value): value is string => typeof value === "string" && /^\d{4}-\d{2}$/u.test(value),
  currentFetchRunId: identifier,
  supersededFetchRunId: identifier,
  supersededRuns: (value): value is number => identifier(value) && value > 0,
});
const metadata = object<ApiMetadata>({
  parsingHealth: optional(
    object<NonNullable<ApiMetadata["parsingHealth"]>>({
      pending: identifier,
      running: identifier,
      failed: identifier,
    }),
  ),
  globalPassEmptyMonths: optional(
    object<GlobalPassEmptyMonths>({ months: array(globalPassEmptyMonth), truncated: boolean }),
  ),
  apiVersion: literal(1),
  source: object<ApiMetadata["source"]>({
    kind: sourceKind,
    classification: literal("unknown", "synthetic", "financial"),
  }),
  capabilities: validApiCapabilities,
});
function ownProduct<T extends { id: number; organization?: ObservationOrganization }>(
  kind: ObservationKind,
  shape: Check<T>,
): Check<T> {
  return (value): value is T =>
    shape(value) &&
    (value.organization?.product === undefined ||
      (value.organization.product.origin.kind === kind &&
        value.organization.product.origin.id === value.id));
}
import { validActivityMeaning } from "./activity-semantics.ts";
import { validNormalizedDecimal } from "./normalized-decimal.ts";
const transaction = ownProduct(
  "transaction",
  object<TransactionRow>({
    normalized: optional(validNormalizedDecimal),
    interpretation: optional(validActivityMeaning),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    as_of: nullableText,
    amount_minor: minorUnit,
    amount_text: nullableText,
    currency: nullableText,
    description: nullableText,
    counterparty: nullableText,
    external_id: nullableText,
    status: nullableText,
    parser: text,
  }),
);
const balanceFields = {
  normalized: optional(validNormalizedDecimal),
  interpretation: optional(validBalanceInterpretation),
  organization: optional(organization),
  id: identifier,
  source_id: text,
  source_account: text,
  metric: text,
  instrument: text,
  amount_minor: minorUnit,
  amount_text: nullableText,
  as_of: nullableText,
  observed_at: nullableText,
  parser: text,
} satisfies Shape<BalanceRow>;
function ownBalanceInterpretation<T extends BalanceRow>(shape: Check<T>): Check<T> {
  return (value): value is T =>
    shape(value) &&
    (value.interpretation === undefined ||
      value.interpretation.evidence.some(
        (evidence) => evidence.id === value.id && evidence.metric === value.metric,
      ));
}
const balance = ownBalanceInterpretation(ownProduct("balance", object<BalanceRow>(balanceFields)));
const balanceHistory = ownBalanceInterpretation(
  ownProduct(
    "balance",
    object<BalanceHistoryRow>({
      ...balanceFields,
      superseded_by_parse_run_id: nullableIdentifier,
      parse_status: text,
    }),
  ),
);
const position = ownProduct(
  "position",
  object<PositionRow>({
    normalized: optional(validNormalizedDecimal),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    security_code: text,
    security_name: nullableText,
    market: nullableText,
    quantity_text: text,
    quantity_scale: number,
    currency: nullableText,
    as_of: nullableText,
    parser: text,
  }),
);
const valuation = ownProduct(
  "valuation",
  object<ValuationRow>({
    normalized: optional(validNormalizedDecimal),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    subject: text,
    metric: text,
    amount_minor: minorUnit,
    amount_text: nullableText,
    currency: text,
    as_of: nullableText,
    parser: text,
  }),
);
const positionWithValuations = object<PositionWithValuations>({
  position,
  valuations: array(valuation),
});
const artifact = object<ArtifactRow>({
  id: identifier,
  source_id: text,
  dataset: nullableText,
  url: nullableText,
  mime: text,
  fetched_at: text,
  sha256: hash,
  parse_run_count: number,
  transaction_count: number,
  balance_count: number,
  position_count: number,
  valuation_count: number,
});
const parseFields = {
  id: identifier,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  status: text,
  warnings,
  error: nullableText,
  superseded_by_parse_run_id: nullableIdentifier,
};
const overview = object<Overview>({
  counts: array(object<Overview["counts"][number]>({ table: text, rows: number })),
  // D13/PR-14: absent unless a partial run refreshed some units of a dataset
  // on the `unit` eligibility scope. Counts and identifiers only.
  unitUpdates: optional(
    array(
      object<UnitUpdateSummary>({
        source_id: text,
        dataset: text,
        fetch_run_id: identifier,
        fetched_at: text,
        updated_units: identifier,
        stale_units: identifier,
      }),
    ),
  ),
  sources: array(
    object<Overview["sources"][number]>({
      id: text,
      provider: text,
      ingestion: text,
      artifact_count: number,
    }),
  ),
  fetchRuns: array(
    object<Overview["fetchRuns"][number]>({
      id: identifier,
      source_id: text,
      tool: text,
      external_run_id: nullableText,
      status: text,
      started_at: text,
      completed_at: nullableText,
    }),
  ),
  parseRuns: array(
    object<Overview["parseRuns"][number]>({
      ...parseFields,
      fetch_artifact_id: identifier,
    }),
  ),
});
// The summary detail of the overview (ADR 0123, amendment 2026-11-19): every
// status is one of the closed set and listed once, a line per source or
// parser names a status other than the success one, each list is capped, and
// its lines with the ones it left out count exactly the runs of their status.
type OverviewFetchLine = OverviewSummary["fetchRuns"]["byStatus"][number];
/** A closed failure code, as `safeCode` in the collection quality read writes one. */
const failureCode: Check<string> = (value): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
type OverviewParseLine = OverviewSummary["parseRuns"]["byStatus"][number];
const overviewSummaryShape = object<OverviewSummary>({
  detail: literal("summary"),
  counts: array(object<Overview["counts"][number]>({ table: text, rows: number })),
  sources: array(
    object<OverviewSummary["sources"][number]>({ sourceIds: array(text), artifacts: number }),
  ),
  fetchRuns: object<OverviewSummary["fetchRuns"]>({
    byStatus: array(
      object<OverviewFetchLine>({
        status: literal(...OVERVIEW_FETCH_RUN_STATUSES),
        runs: identifier,
        sources: identifier,
        newest: object<OverviewFetchLine["newest"]>({
          id: identifier,
          sourceId: text,
          startedAt: text,
          completedAt: nullableText,
        }),
      }),
    ),
    notSuccessful: array(
      object<OverviewSummary["fetchRuns"]["notSuccessful"][number]>({
        sourceId: text,
        status: literal(...OVERVIEW_FETCH_RUN_STATUSES.filter((status) => status !== "success")),
        runs: identifier,
        newest: object<OverviewSummary["fetchRuns"]["notSuccessful"][number]["newest"]>({
          id: identifier,
          startedAt: text,
          completedAt: nullableText,
        }),
      }),
    ),
    notSuccessfulOmitted: array(
      object<OverviewSummary["fetchRuns"]["notSuccessfulOmitted"][number]>({
        status: literal(...OVERVIEW_FETCH_RUN_STATUSES.filter((status) => status !== "success")),
        lines: identifier,
        runs: identifier,
      }),
    ),
  }),
  parseRuns: object<OverviewSummary["parseRuns"]>({
    byStatus: array(
      object<OverviewParseLine>({
        status: literal(...OVERVIEW_PARSE_RUN_STATUSES),
        runs: identifier,
        superseded: number,
        withWarnings: number,
        unreadableWarnings: number,
        parsers: identifier,
        failureCodes: array(failureCode),
        newest: object<OverviewParseLine["newest"]>({
          id: identifier,
          artifactId: identifier,
          parser: text,
          parsedAt: text,
        }),
      }),
    ),
    notOk: array(
      object<OverviewSummary["parseRuns"]["notOk"][number]>({
        parser: text,
        status: literal(...OVERVIEW_PARSE_RUN_STATUSES.filter((status) => status !== "ok")),
        runs: identifier,
        superseded: number,
        failureCodes: array(failureCode),
        moreFailureCodes: identifier,
        newest: object<OverviewSummary["parseRuns"]["notOk"][number]["newest"]>({
          id: identifier,
          artifactId: identifier,
          parsedAt: text,
        }),
      }),
    ),
    notOkOmitted: array(
      object<OverviewSummary["parseRuns"]["notOkOmitted"][number]>({
        status: literal(...OVERVIEW_PARSE_RUN_STATUSES.filter((status) => status !== "ok")),
        lines: identifier,
        runs: identifier,
      }),
    ),
  }),
  unitUpdatesOmitted: optional(
    object<NonNullable<OverviewSummary["unitUpdatesOmitted"]>>({
      lines: identifier,
      runs: identifier,
    }),
  ),
  unitUpdates: optional(
    array(
      object<NonNullable<OverviewSummary["unitUpdates"]>[number]>({
        sourceId: text,
        dataset: text,
        runs: identifier,
        newest: object<NonNullable<OverviewSummary["unitUpdates"]>[number]["newest"]>({
          fetchRunId: identifier,
          fetchedAt: text,
          updatedUnits: number,
          staleUnits: number,
        }),
      }),
    ),
  ),
  coverage: object<OverviewSummary["coverage"]>({ limit: number, truncated: boolean }),
});
/**
 * Each status once; a capped list holds at most `OVERVIEW_SUMMARY_LINES`
 * lines and leaves lines out only when full, each status's omitted entry
 * once; and a status's per-source or per-parser lines with its omitted ones
 * count exactly its runs and its sources or parsers (`distinct`), one line
 * each.
 */
function linesCountStatus<Line extends { status: string; runs: number }>(
  byStatus: readonly Line[],
  distinct: (line: Line) => number,
  lines: readonly { status: string; runs: number }[],
  omitted: readonly { status: string; lines: number; runs: number }[],
  success: string,
): boolean {
  const statuses = byStatus.map((line) => line.status);
  if (new Set(statuses).size !== statuses.length) return false;
  if (!capped(lines.length, omitted)) return false;
  if (new Set(omitted.map((entry) => entry.status)).size !== omitted.length) return false;
  const listed = (status: string) => lines.filter((entry) => entry.status === status);
  const left = (status: string) => omitted.find((entry) => entry.status === status);
  return (
    byStatus.every(
      (line) =>
        line.status === success ||
        (listed(line.status).reduce((sum, entry) => sum + entry.runs, 0) +
          (left(line.status)?.runs ?? 0) ===
          line.runs &&
          listed(line.status).length + (left(line.status)?.lines ?? 0) === distinct(line)),
    ) && [...lines, ...omitted].every((entry) => statuses.includes(entry.status))
  );
}
/** At most the cap listed, and lines left out only from a full list, each counting its runs. */
function capped(listed: number, omitted: readonly { lines: number; runs: number }[]): boolean {
  return (
    listed <= OVERVIEW_SUMMARY_LINES &&
    omitted.every((entry) => entry.lines > 0 && entry.runs >= entry.lines) &&
    (omitted.length === 0 || listed === OVERVIEW_SUMMARY_LINES)
  );
}
/**
 * A failing parser's line lists at most `OVERVIEW_LINE_FAILURE_CODES` codes,
 * counts the rest only when it is full, and each of its codes is on its
 * status's line, which lists each code once.
 */
function failureCodesKept(summary: OverviewSummary): boolean {
  const byStatus = new Map(
    summary.parseRuns.byStatus.map((line) => [line.status, line.failureCodes]),
  );
  return (
    summary.parseRuns.byStatus.every(
      (line) => new Set(line.failureCodes).size === line.failureCodes.length,
    ) &&
    summary.parseRuns.notOk.every(
      (line) =>
        line.failureCodes.length <= OVERVIEW_LINE_FAILURE_CODES &&
        new Set(line.failureCodes).size === line.failureCodes.length &&
        (line.moreFailureCodes === 0 || line.failureCodes.length === OVERVIEW_LINE_FAILURE_CODES) &&
        line.failureCodes.every((code) => byStatus.get(line.status)?.includes(code)) &&
        (byStatus.get(line.status)?.length ?? 0) >=
          line.failureCodes.length + line.moreFailureCodes,
    )
  );
}
/** `unitUpdatesOmitted` is present exactly with `unitUpdates`, and bounds it as the run lists. */
function unitUpdatesCapped(summary: OverviewSummary): boolean {
  if (summary.unitUpdates === undefined) return summary.unitUpdatesOmitted === undefined;
  if (summary.unitUpdatesOmitted === undefined) return false;
  const { lines, runs } = summary.unitUpdatesOmitted;
  return lines === 0
    ? runs === 0 && summary.unitUpdates.length <= OVERVIEW_SUMMARY_LINES
    : capped(summary.unitUpdates.length, [{ lines, runs }]);
}
const overviewSummary: Check<OverviewSummary> = (value): value is OverviewSummary =>
  overviewSummaryShape(value) &&
  linesCountStatus(
    value.fetchRuns.byStatus,
    (line) => line.sources,
    value.fetchRuns.notSuccessful,
    value.fetchRuns.notSuccessfulOmitted,
    "success",
  ) &&
  linesCountStatus(
    value.parseRuns.byStatus,
    (line) => line.parsers,
    value.parseRuns.notOk,
    value.parseRuns.notOkOmitted,
    "ok",
  ) &&
  failureCodesKept(value) &&
  unitUpdatesCapped(value);

const observationRef = object<ObservationRef>({
  kind: observationKind,
  id: identifier,
  summary: text,
});
const parseRun = object<ParseRunDetail>({
  ...parseFields,
  observations: array(observationRef),
});
const provenanceFields = {
  source_id: text,
  dataset: nullableText,
  url: nullableText,
  mime: text,
  fetched_at: text,
  sha256: hash,
  size: number,
  content_type: text,
  fetch_run_id: identifier,
  tool: text,
  external_run_id: nullableText,
  fetch_status: text,
  started_at: text,
  completed_at: nullableText,
};
const artifactDetail = object<ArtifactDetail>({
  artifact: object<ArtifactDetail["artifact"]>({
    ...provenanceFields,
    id: identifier,
    method: nullableText,
    http_status: nullableNumber,
  }),
  parseRuns: array(parseRun),
});
const provenance = object<Provenance>({
  ...provenanceFields,
  parse_run_id: identifier,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  parse_status: text,
  error: nullableText,
  warnings,
  superseded_by_parse_run_id: nullableIdentifier,
  artifact_id: identifier,
});
const observation = object<ObservationDetail>({
  normalized: optional(validNormalizedDecimal),
  organization: optional(organization),
  interpretationContext: optional(validInterpretationContext),
  kind: observationKind,
  row: (value): value is Record<string, unknown> =>
    record(value) &&
    identifier(value.id) &&
    (!Object.hasOwn(value, "amount_minor") || minorUnit(value.amount_minor)),
  extra: unknown,
  extraRaw: text,
  extraParsed: boolean,
  provenance: optional(provenance),
});

// ── v2 balance read model ────────────────────────────────────────────────
//
// The envelope keeps two facts apart: `page` describes this page of the fixed
// snapshot, `dataCoverage` describes the data behind it. A response is
// rejected if it carries a `netWorth` field: an asset subtotal with unknown
// liability coverage must never be presented as a completed net worth
// (addendum 05 section 5).
const observedQuantity = object<ObservedQuantityWire>({
  normalized: validNormalizedDecimal,
  unitReference: nullableText,
  sourceRepresentation: object<ObservedQuantityWire["sourceRepresentation"]>({
    amountText: nullableText,
    legacyMinorUnits: minorUnit,
    legacyMinorUnitExponent: nullable(identifier),
  }),
});
const measureDescriptor = object<MeasureDescriptor>({
  metricId: text,
  definitionRelease: text,
  measurementKind: text,
  aggregationRule: text,
});
const evidenceMember = object<BalanceEvidenceMember>({
  ref: text,
  observationId: identifier,
  metric: text,
});
const temporalReference = object<TemporalReferenceWire>({ role: text, time: record });
const adoption: Check<BalanceAdoption> = (value): value is BalanceAdoption =>
  object<BalanceAdoption>({
    state: literal("adopted", "excluded", "unresolved", "conflict", "stale"),
    reasonCode: nullableText,
    memberEvidence: array(evidenceMember),
    evidenceCount: identifier,
  })(value) && value.evidenceCount === value.memberEvidence.length;
const pageInfo = object<SnapshotPageInfo>({
  limit: identifier,
  hasMore: boolean,
  nextCursor: nullableText,
  snapshotId: text,
  paginationVersion: literal("keyset-v2"),
});
const snapshotCoverage = object<SnapshotDataCoverage>({
  completeness: literal("complete", "partial", "unknown"),
  stale: boolean,
  reasons: array(text),
});
const subtotals = object<KnownAssetsSubtotals>({
  policyRelease: text,
  knownAssetsSubtotal: nullable(
    array(
      object<{ unitRef: string; coefficient: string; scale: number; adoptedCount: number }>({
        unitRef: text,
        coefficient: text,
        scale: identifier,
        adoptedCount: identifier,
      }),
    ),
  ),
  liabilitiesCoverage: literal("unknown"),
  reasonCode: nullableText,
});
const latestItem: Check<LatestBalanceItem> = (value): value is LatestBalanceItem =>
  object<LatestBalanceItem>({
    observationId: identifier,
    row: balance,
    quantity: observedQuantity,
    metric: measureDescriptor,
    adoption,
    temporal: temporalReference,
    freshness: object<LatestBalanceItem["freshness"]>({
      state: literal("current", "stale", "unknown"),
      reasonCode: nullableText,
    }),
  })(value) && value.row.id === value.observationId;
const historyItem: Check<BalanceHistoryItem> = (value): value is BalanceHistoryItem =>
  object<BalanceHistoryItem>({
    observationId: identifier,
    row: balanceHistory,
    quantity: observedQuantity,
    metric: measureDescriptor,
    temporal: temporalReference,
  })(value) && value.row.id === value.observationId;
/** No response of this contract may carry a completed net worth. */
function withoutNetWorth(value: unknown): boolean {
  return !record(value) || !Object.hasOwn(value, "netWorth");
}
const latestBalancePage: Check<LatestBalancePage> = (value): value is LatestBalancePage =>
  object<LatestBalancePage>({
    schemaVersion: literal("snapshot-page-v1"),
    items: array(latestItem),
    page: pageInfo,
    dataCoverage: snapshotCoverage,
    subtotals,
    interpretationContext: validInterpretationContext,
  })(value) &&
  withoutNetWorth(value) &&
  withoutNetWorth(value.subtotals) &&
  value.items.length <= value.page.limit;
const balanceHistoryPage: Check<BalanceHistoryPage> = (value): value is BalanceHistoryPage =>
  object<BalanceHistoryPage>({
    schemaVersion: literal("snapshot-page-v1"),
    items: array(historyItem),
    page: pageInfo,
    dataCoverage: snapshotCoverage,
    interpretationContext: validInterpretationContext,
  })(value) &&
  withoutNetWorth(value) &&
  value.items.length <= value.page.limit;

// The summary detail of the same pages (ADR 0123): one line per row, the page,
// coverage and subtotals as the full page has them. A value that is not exact
// carries no value and no scale, only its status (INV05).
const summaryAmount: Check<SummaryAmount> = (value): value is SummaryAmount =>
  object<SummaryAmount>({
    value: nullableText,
    unit: nullableText,
    status: literal("exact", "missing", "unparsed", "conflict"),
    scale: nullable(identifier),
  })(value) &&
  (value.status === "exact"
    ? value.value !== null && value.scale !== null
    : value.value === null && value.scale === null);
const summaryAccount: Check<SummaryAccount> = (value): value is SummaryAccount =>
  object<SummaryAccount>({
    ref: text,
    source: text,
    sourceAccount: text,
    account: nullableText,
    label: nullableText,
    status: nullable(literal("identified", "provider-local", "aggregate", "unresolved")),
    lineage: nullable(literal("current", "historical")),
  })(value) &&
  // An organized row names all four; an unavailable organization none.
  (value.account === null
    ? value.label === null && value.status === null && value.lineage === null
    : value.label !== null && value.status !== null && value.lineage !== null);
const summaryMetric = object<SummaryMetric>({
  ref: text,
  source: text,
  metric: text,
  providerMetric: text,
});
const historySummaryFields = {
  observationId: identifier,
  account: text,
  metric: text,
  amount: summaryAmount,
  asOf: nullableText,
};
const historySummaryItem = object<BalanceHistorySummaryItem>({
  ...historySummaryFields,
  // Closed codes, each at most once: a parse status outside the closed set
  // is not a reason the line can carry.
  reasons: (value): value is BalanceHistorySummaryItem["reasons"] =>
    subset(BALANCE_HISTORY_REASONS)(value),
});
const latestSummaryItem = object<LatestBalanceSummaryItem>({
  ...historySummaryFields,
  freshness: literal("current", "stale", "unknown"),
  adoption: literal("adopted", "excluded", "unresolved", "conflict", "stale"),
  reasons: array(text),
});
/**
 * Every line names an account and a metric of its page, every one is named,
 * and each entry is listed once: no two refs name the same entry.
 */
function refsNamed(entries: readonly { ref: string }[], named: readonly string[]): boolean {
  const refs = entries.map((entry) => entry.ref);
  const contents = entries.map(({ ref: _ref, ...entry }) => JSON.stringify(entry));
  return (
    new Set(refs).size === refs.length &&
    new Set(contents).size === contents.length &&
    named.every((ref) => refs.includes(ref)) &&
    refs.every((ref) => named.includes(ref))
  );
}
function accountsNamed(value: {
  accounts: SummaryAccount[];
  metrics: readonly { ref: string }[];
  items: { account: string; metric: string }[];
}): boolean {
  return (
    refsNamed(
      value.accounts,
      value.items.map((item) => item.account),
    ) &&
    refsNamed(
      value.metrics,
      value.items.map((item) => item.metric),
    )
  );
}
const latestBalanceSummaryPage: Check<LatestBalanceSummaryPage> = (
  value,
): value is LatestBalanceSummaryPage =>
  object<LatestBalanceSummaryPage>({
    schemaVersion: literal("snapshot-page-v1"),
    detail: literal("summary"),
    accounts: array(summaryAccount),
    metrics: array(summaryMetric),
    items: array(latestSummaryItem),
    page: pageInfo,
    dataCoverage: snapshotCoverage,
    subtotals,
  })(value) &&
  withoutNetWorth(value) &&
  withoutNetWorth(value.subtotals) &&
  accountsNamed(value) &&
  value.items.length <= value.page.limit;
const balanceHistorySummaryPage: Check<BalanceHistorySummaryPage> = (
  value,
): value is BalanceHistorySummaryPage =>
  object<BalanceHistorySummaryPage>({
    schemaVersion: literal("snapshot-page-v1"),
    detail: literal("summary"),
    accounts: array(summaryAccount),
    metrics: array(summaryMetric),
    items: array(historySummaryItem),
    page: pageInfo,
    dataCoverage: snapshotCoverage,
  })(value) &&
  withoutNetWorth(value) &&
  accountsNamed(value) &&
  value.items.length <= value.page.limit;
/** A full page carries no `detail`; a summary page says it is one. */
const fullPage =
  <T>(check: Check<T>): Check<T> =>
  (value): value is T =>
    check(value) && !Object.hasOwn(value as object, "detail");

// The v1 grouped balance list (`GET /api/balances`) in full and as its
// summary (ADR 0123, amendment of 2026-11-20).
// The full list is checked as before: the local store's carries no coverage
// record (it does not page), the central store's does.
const balanceList = fullPage(
  object<Omit<BalanceListPage, "coverage">>({
    latest: array(balance),
    history: array(balanceHistory),
    interpretationContext: optional(validInterpretationContext),
  }),
);
const balanceListSummaryMetric = object<BalanceListSummaryMetric>({
  ref: text,
  source: text,
  providerMetric: text,
  kind: literal("asset", "liability", "statement", "aggregate", "period_total", "other"),
  measurementKind: nullable(
    literal(
      "balance",
      "aggregate_balance",
      "period_total",
      "statement_amount",
      "capacity",
      "unknown",
    ),
  ),
  assetClass: nullable(literal("cash", "prepaid", "reward", "mixed", "unknown")),
  timeBasis: nullable(
    literal(
      "reported_snapshot",
      "event_report",
      "previous_calendar_month",
      "statement_month",
      "unknown",
    ),
  ),
});
const balanceListLatestLine: Check<BalanceListLatestLine> = (
  value,
): value is BalanceListLatestLine =>
  object<BalanceListLatestLine>({
    ...historySummaryFields,
    duplicates: array(identifier),
    reasons: (reasons): reasons is BalanceListLatestLine["reasons"] =>
      subset(BALANCE_LIST_LATEST_REASONS)(reasons),
  })(value) &&
  // A group folds in one other witness at most, never its own id, and a
  // conflict keeps its witnesses apart (`validBalanceInterpretation`).
  value.duplicates.length <= 1 &&
  !value.duplicates.includes(value.observationId) &&
  (value.duplicates.length === 0 || value.reasons.length === 0);
const balanceListSummary: Check<BalanceListSummaryPage> = (
  value,
): value is BalanceListSummaryPage =>
  object<BalanceListSummaryPage>({
    detail: literal("summary"),
    accounts: array(summaryAccount),
    metrics: array(balanceListSummaryMetric),
    latest: array(balanceListLatestLine),
    history: array(historySummaryItem),
    coverage: object<BalanceListSummaryPage["coverage"]>({
      limit: literal(BALANCE_LIST_SUMMARY_LINES),
      truncated: boolean,
      nextOffset: nullableIdentifier,
      latestNextOffset: nullableIdentifier,
    }),
  })(value) &&
  value.latest.length <= value.coverage.limit &&
  value.history.length <= value.coverage.limit &&
  value.coverage.truncated ===
    (value.coverage.nextOffset !== null || value.coverage.latestNextOffset !== null) &&
  // Accounts and metrics are named once per page, across both lists.
  accountsNamed({
    accounts: value.accounts,
    metrics: value.metrics,
    items: [...value.latest, ...value.history],
  });

const rewardBucket = object<RewardBucketRow>({
  bucketRef: text,
  kind: validRewardBucketKind,
  restrictionRefs: array(text),
  unitRef: text,
  quantity: validQuantity,
  observedExpiry: nullable(validTemporalValue),
  observedAt: validTemporalValue,
  sourceFactRefs: array(text),
});
const rewardHolding = object<RewardHoldingRow>({
  pointHistoryCoverage: optional(
    object<NonNullable<RewardHoldingRow["pointHistoryCoverage"]>>({
      state: literal("current", "stale", "unavailable"),
      reasonCode: nullable(literal("history_not_current")),
      observedAt: nullable(text),
      sourceFactRefs: array(text),
    }),
  ),
  programId: text,
  programRef: text,
  institutionRef: text,
  sourceId: text,
  holdingRef: text,
  holdingKind: literal("reward-points", "prepaid-balance"),
  unitRef: text,
  termsEvidenceRefs: array(text),
  consumable: validQuantity,
  byKind: array(
    object<RewardHoldingRow["byKind"][number]>({
      kind: validRewardBucketKind,
      quantity: validQuantity,
      bucketRefs: array(text),
    }),
  ),
  excluded: array(
    object<RewardHoldingRow["excluded"][number]>({
      bucketRef: text,
      kind: validRewardBucketKind,
      reasonCode: text,
    }),
  ),
  buckets: array(rewardBucket),
  qualificationMeasures: array(
    object<RewardHoldingRow["qualificationMeasures"][number]>({
      measureRef: text,
      metricRef: text,
      quantity: validQuantity,
      period: validTemporalValue,
      consumable: literal(false),
    }),
  ),
  membership: array(
    object<RewardHoldingRow["membership"][number]>({
      tier: text,
      valid: validTemporalValue,
      source: text,
      evidenceRefs: array(text),
    }),
  ),
  valueModel: object<RewardHoldingRow["valueModel"]>({
    netAssetEligible: literal(false),
    cashLikeRedemptionEstimate: (v): v is null => v === null,
    reasonCode: text,
  }),
});
const rewardState = literal("computed", "partial", "conflict", "needs-rule-verification");
const rewardBasis = literal("provider-observed", "policy-estimated", "unknown");
const rewardExpiry = object<RewardExpiryRow>({
  holdingRef: text,
  programId: text,
  ruleRef: text,
  family: text,
  verification: text,
  state: rewardState,
  uncertaintyCodes: array(text),
  deadlineZone: text,
  deadlineZoneBasis: text,
  rows: array(
    object<RewardExpiryRow["rows"][number]>({
      bucketRef: text,
      quantity: validQuantity,
      deadline: validTemporalValue,
      basis: rewardBasis,
      providerObserved: nullable(validTemporalValue),
      policyEstimated: nullable(validTemporalValue),
      reasonCodes: array(text),
    }),
  ),
  sourceExpiryRefs: array(text),
});
function rewardPage<T>(row: Check<T>): Check<RewardPage<T>> {
  return object<RewardPage<T>>({
    rows: array(row),
    coverage: object<RewardPage<T>["coverage"]>({
      limit: identifier,
      truncated: boolean,
      nextOffset: nullableIdentifier,
    }),
  });
}
const rewardReadExpiry = object<RewardReadExpiryRow>({
  holdingRef: text,
  programId: text,
  bucketRef: text,
  bucketKind: validRewardBucketKind,
  ruleRef: text,
  state: rewardState,
  basis: rewardBasis,
  expiresOn: nullable(validLocalDateText),
  quantity: validQuantity,
  providerObserved: nullable(validTemporalValue),
  policyEstimated: nullable(validTemporalValue),
  reasonCodes: array(text),
  uncertaintyCodes: array(text),
  basisRefs: array(text),
  // ADR 0049: a basis must pass the domain's exact-key check; null is "not
  // recorded"; an absent key is a response from an App before the field.
  expiryBasis: optional(nullable(validRewardExpiryBasis)),
});
const rewardSnapshot = object<RewardReadExpiryPage["snapshot"]>({
  snapshotId: hash,
  evaluatedAt: validInstantText,
  evaluationCalendar: text,
  ruleSetDigest: hash,
  ruleCount: identifier,
  claimsRelease: text,
  claimsHighWater: identifier,
  release: text,
});
// ADR 0049, amendment of 2026-11-19: the window a windowed page or a summary
// was read over, and how the rest fell.
const rewardExpiryWindow = object<RewardExpiryWindow>({
  from: validLocalDateText,
  before: nullable(validLocalDateText),
  fromBasis: literal("request", "today"),
  today: validLocalDateText,
  calendar: literal("Asia/Tokyo"),
});
const rewardWindowCounts = object<RewardExpiryWindowCounts>({
  inWindow: identifier,
  beforeWindow: identifier,
  afterWindow: identifier,
  leftOut: array(
    object<RewardExpiryWindowCounts["leftOut"][number]>({
      reasonCode: literal(...REWARD_EXPIRY_LEFT_OUT_REASONS),
      count: identifier,
    }),
  ),
});
const decimalText: Check<string> = (value): value is string =>
  typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
// An amount or a total that is not exact carries no value (INV05).
const rewardSummaryAmount: Check<RewardExpirySummaryAmount> = (
  value,
): value is RewardExpirySummaryAmount =>
  record(value) &&
  (value["status"] === "exact"
    ? decimalText(value["value"])
    : literal("missing", "unparsed", "conflict")(value["status"]) &&
      value["value"] === null &&
      text(value["reasonCode"]));
const rewardSummaryTotal: Check<RewardExpirySummaryTotal> = (
  value,
): value is RewardExpirySummaryTotal =>
  record(value) &&
  (value["status"] === "exact"
    ? decimalText(value["value"])
    : value["status"] === "not-exact" &&
      value["value"] === null &&
      array(text)(value["reasonCodes"]) &&
      (value["reasonCodes"] as string[]).length > 0);
const rewardExpirySummary = object<RewardExpirySummary>({
  detail: literal("summary"),
  window: nullable(rewardExpiryWindow),
  programs: array(
    object<RewardExpirySummaryProgram>({
      programId: text,
      unitRef: text,
      buckets: identifier,
      total: rewardSummaryTotal,
      lines: array(
        object<RewardExpirySummaryLine>({
          holdingRef: text,
          bucketRef: text,
          kind: validRewardBucketKind,
          expiresOn: validLocalDateText,
          basis: literal("provider-observed", "policy-estimated"),
          amount: rewardSummaryAmount,
        }),
      ),
    }),
  ),
  providerDisplays: array(
    object<RewardExpirySummaryDisplay>({
      programId: text,
      holdingRef: text,
      parentBucketRef: text,
      displayRef: text,
      unitRef: text,
      expiresOn: validLocalDateText,
      amount: rewardSummaryAmount,
    }),
  ),
  counts: object<RewardExpirySummary["counts"]>({
    buckets: rewardWindowCounts,
    providerDisplays: rewardWindowCounts,
  }),
  lineLimit: object<RewardExpirySummary["lineLimit"]>({
    buckets: identifier,
    providerDisplays: identifier,
  }),
  snapshot: rewardSnapshot,
});
const rewardReadPage = object<RewardReadExpiryPage & { window?: unknown }>({
  providerDisplaySections: optional(array(validRewardProviderExpirySection)),
  rows: array(rewardReadExpiry),
  page: object<RewardReadExpiryPage["page"]>({
    limit: identifier,
    hasMore: boolean,
    nextCursor: nullableText,
  }),
  // Present exactly when the request named a window.
  window: optional(
    (value): value is RewardReadExpiryWindowedPage["window"] =>
      rewardExpiryWindow(value) && record(value) && rewardWindowCounts(value["rows"]),
  ),
  snapshot: rewardSnapshot,
});

// A response may say which interpretation it was computed under; when it does,
// the context must be well-formed.
const context = optional(validInterpretationContext);
const endpoints: Record<string, Check<unknown>> = {
  "/api/v2/rewards/holdings": rewardPage(rewardHolding),
  "/api/v2/rewards/expiry": (value): value is unknown =>
    record(value) &&
    (value["detail"] === "summary"
      ? rewardExpirySummary(value)
      : "snapshot" in value
        ? rewardReadPage(value)
        : rewardPage(rewardExpiry)(value)),
  "/api/meta": metadata,
  "/api/overview": (value): value is Overview | OverviewSummary =>
    fullPage(overview)(value) || overviewSummary(value),
  "/api/transactions": object<{
    transactions: TransactionRow[];
    interpretationContext?: InterpretationContext;
  }>({ transactions: array(transaction), interpretationContext: context }),
  // The central store answers its summary unless asked for `full`; the local
  // store answers its full list only.
  "/api/balances": (value): value is BalanceListPage | BalanceListSummaryPage =>
    balanceList(value) || balanceListSummary(value),
  "/api/positions": object<{
    positions: PositionWithValuations[];
    interpretationContext?: InterpretationContext;
  }>({ positions: array(positionWithValuations), interpretationContext: context }),
  "/api/artifacts": object<{ artifacts: ArtifactRow[] }>({
    artifacts: array(artifact),
  }),
  "/api/v2/balances/latest": (value): value is LatestBalancePage | LatestBalanceSummaryPage =>
    fullPage(latestBalancePage)(value) || latestBalanceSummaryPage(value),
  "/api/v2/balances/history": (value): value is BalanceHistoryPage | BalanceHistorySummaryPage =>
    fullPage(balanceHistoryPage)(value) || balanceHistorySummaryPage(value),
};

/** Each detail's own check of the balance pages and the overview (ADR 0123). */
const pagesByDetail: Record<string, Record<ReadDetail, Check<unknown>>> = {
  "/api/v2/balances/latest": {
    full: fullPage(latestBalancePage),
    summary: latestBalanceSummaryPage,
  },
  "/api/v2/balances/history": {
    full: fullPage(balanceHistoryPage),
    summary: balanceHistorySummaryPage,
  },
  "/api/overview": { full: fullPage(overview), summary: overviewSummary },
  "/api/balances": { full: balanceList, summary: balanceListSummary },
};

/**
 * The shared query response (`GET /api/v2/query`, `@kogane/application`). The
 * result itself is checked by the domain contract, so the browser and the
 * agent API validate one definition of `financial-result-v1`.
 */
function validSharedQueryResponse(value: unknown): boolean {
  return (
    record(value) &&
    value.schemaVersion === "kogane-query-response-v1" &&
    text(value.contextId) &&
    text(value.resultRef) &&
    Array.isArray(value.unresolvedInputs) &&
    value.unresolvedInputs.every(
      (entry) =>
        record(entry) &&
        text(entry.key) &&
        text(entry.question) &&
        text(entry.chosen) &&
        text(entry.reasonCode),
    ) &&
    validFinancialResult(value.result, record) &&
    value.result.contextId === value.contextId
  );
}

/** `summary` or `full` (ADR 0123): the detail a request asked for. */
type ReadDetail = "summary" | "full";

/**
 * The `detail` a request's query asks for when it names one the reads offer,
 * for `validApiResponse`'s third argument; absent or anything else is
 * `undefined` (either shape).
 */
export function requestedDetail(search: string): ReadDetail | undefined {
  const detail = new URLSearchParams(search).get("detail");
  return detail === "summary" || detail === "full" ? detail : undefined;
}

/**
 * Additive fields are allowed; required fields and their nullability are
 * checked. `detail` names the detail the request asked for (ADR 0123): the
 * paths that answer one (the v2 balance pages, the overview and the
 * collection quality summary and cells) then accept that shape only; without
 * it they accept either.
 */
export function validApiResponse(path: string, value: unknown, detail?: ReadDetail): boolean {
  if (detail !== undefined && Object.hasOwn(pagesByDetail, path))
    return pagesByDetail[path]![detail](value);
  if (path === AUDIT_PAGE_PATH) return validAuditPage(value);
  if (path === "/api/v2/reconciliation/card-settlements/ownership")
    return validCardOwnershipReview(value);
  if (path === "/api/v2/reconciliation/card-settlements/statements")
    return validCardSettlementStatementPage(value);
  if (path === "/api/v2/reconciliation/card-settlements")
    return validCardSettlementReviewPage(value);
  if (path === CARD_STATEMENTS_UNMATCHED_PATH) return validUnmatchedCardStatementsReview(value);
  // The same path serves the upcoming view (`?view=upcoming`), which says so.
  if (path === CARD_DEBIT_ACCOUNTS_PATH)
    return (value as { view?: unknown } | null)?.view === "upcoming"
      ? validUpcomingCardBills(value)
      : validCardDebitAccountsReview(value);
  if (path === CHANGES_SINCE_PATH) return validChangesSince(value);
  if (path === "/api/v2/card-purchases") return validCardPurchasePage(value);
  if (path === "/api/v2/reported-state") return validReportedState(value);
  if (path === "/api/v2/reported-holdings-change") return validReportedHoldingsChange(value);
  if (path === "/api/v2/reconstructed-state") return validReconstructedState(value);
  if (path === ECONOMIC_READINESS_PATH) return validEconomicReadinessResult(value);
  if (path === "/api/v2/reports" || path.startsWith("/api/v2/reports/"))
    return validReportResponse(path, value) ?? false;
  if (path.startsWith("/api/collection-quality"))
    return validCollectionQualityResponse(path, value, detail);
  if (path === INSTRUMENT_CANDIDATES_PATH) return validInstrumentCandidateReview(value);
  if (path === ACCOUNT_CANDIDATES_PATH) return validAccountCandidateReview(value);
  if (path === INSTRUMENT_HISTORY_PATH) return validInstrumentHistoryRead(value);
  if (path === ACCOUNT_HISTORY_PATH) return validAccountHistoryRead(value);
  if (path === INSTRUMENT_COVERAGE_PATH) return validInstrumentCoverage(value);
  if (path === OPERATION_LIST_PATH) return validOperationListPage(value);
  if (path.startsWith(OPERATION_RECORD_PATH_PREFIX)) {
    // The record of exactly the operation the path names, or nothing.
    const operationId = operationIdOfPath(path);
    return operationId !== null && validOperationRecord(value, operationId);
  }
  if (path.startsWith("/api/identity/")) return validIdentityResponse(path, value);
  if (path === "/api/v2/query") return validSharedQueryResponse(value);
  if (path === "/api/filter-options") {
    return (
      record(value) &&
      Array.isArray(value.sources) &&
      value.sources.every(text) &&
      Array.isArray(value.instruments) &&
      value.instruments.every(text) &&
      Array.isArray(value.metrics) &&
      value.metrics.every(text) &&
      Array.isArray(value.accounts) &&
      value.accounts.every(
        (row) =>
          record(row) &&
          text(row.source_id) &&
          text(row.source_account) &&
          optional(nullableText)(row.display_name) &&
          optional(boolean)(row.organization_ambiguous),
      )
    );
  }
  if (record(value) && Object.hasOwn(value, "coverage")) {
    const c = value.coverage;
    if (
      !record(c) ||
      !identifier(c.limit) ||
      !boolean(c.truncated) ||
      !(
        c.nextOffset === undefined ||
        c.nextOffset === null ||
        (Number.isSafeInteger(c.nextOffset) &&
          typeof c.nextOffset === "number" &&
          c.nextOffset >= 0)
      ) ||
      !(
        c.latestNextOffset === undefined ||
        c.latestNextOffset === null ||
        (Number.isSafeInteger(c.latestNextOffset) &&
          typeof c.latestNextOffset === "number" &&
          c.latestNextOffset >= 0)
      ) ||
      !(
        c.nextCursor === undefined ||
        c.nextCursor === null ||
        (typeof c.nextCursor === "string" && /^[1-9]\d*$/.test(c.nextCursor))
      )
    )
      return false;
  }
  const check = Object.hasOwn(endpoints, path) ? endpoints[path] : undefined;
  if (check) return check(value);
  if (/^\/api\/artifacts\/\d+$/u.test(path)) {
    const id = Number(path.split("/")[3]);
    return identifier(id) && artifactDetail(value) && value.artifact.id === id;
  }
  if (/^\/api\/observations\/(transaction|balance|position|valuation)\/\d+$/u.test(path)) {
    const id = Number(path.split("/")[4]);
    return (
      identifier(id) &&
      observation(value) &&
      value.kind === path.split("/")[3] &&
      value.row.id === id &&
      (value.organization?.product === undefined ||
        (value.organization.product.origin.kind === value.kind &&
          value.organization.product.origin.id === id &&
          (!value.provenance ||
            (value.organization.product.origin.parseRunId === value.provenance.parse_run_id &&
              value.organization.product.origin.artifactId === value.provenance.artifact_id))))
    );
  }
  return false;
}
