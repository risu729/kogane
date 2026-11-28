// The wire shape of `GET /api/v2/reported-state` (docs/reported-state.md).
// Shape only: the client recalculates nothing, and an answer that adds a
// figure the contract does not name (a total, a subtotal, a net worth), claims
// complete liabilities or drops its coverage is refused rather than displayed.
import {
  FRESHNESS_STATES,
  IDENTITY_STATUSES,
  LIABILITY_GAPS,
  PAYABLE_STATUSES,
  REPORTED_STATE_EXCLUSIONS,
  REPORTED_STATE_SCHEMA,
  REPORTED_STATE_ZONE,
  SCHEDULED_PAYMENT_DUE_STATUSES,
  SCHEDULED_PAYMENT_KINDS,
  SCHEDULED_PAYMENTS_LISTING,
  STATEMENTS_BEFORE_WINDOW_REASONS,
} from "../../domain/src/reported-state.ts";
import {
  AGGREGATION_RULES,
  MEASUREMENT_KINDS,
  SIGN_MEANINGS,
  SUBJECT_KINDS,
} from "../../domain/src/metrics.ts";
import { validInstantText, validLocalDateText } from "../../domain/src/time.ts";
import { validQuantity } from "../../domain/src/values.ts";

const BOUND = 5000;
const REF = /^(?:artifact|position|valuation|balance):[1-9][0-9]*$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Exactly these fields: a figure the contract does not name is refused, not ignored. */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): boolean => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const member =
  (choices: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && choices.includes(value);
const ref = (value: unknown): boolean => typeof value === "string" && REF.test(value);
const list = <T>(value: unknown, each: (entry: unknown) => boolean): value is T[] =>
  Array.isArray(value) && value.length <= BOUND && value.every(each);
const date = (value: unknown): boolean => validLocalDateText(value);
const nullableDate = (value: unknown): boolean => value === null || date(value);

function validSnapshot(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "sourceId",
      "parserName",
      "dataset",
      "capturedAt",
      "captureDate",
      "ageDays",
      "freshness",
    ]) &&
    ref(value.ref) &&
    text(value.sourceId) &&
    text(value.parserName) &&
    text(value.dataset) &&
    validInstantText(value.capturedAt) &&
    date(value.captureDate) &&
    count(value.ageDays) &&
    member(FRESHNESS_STATES)(value.freshness)
  );
}

function validInstrument(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["instrumentId", "status"]) &&
    nullableText(value.instrumentId) &&
    member(IDENTITY_STATUSES)(value.status)
  );
}

function validValuation(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["ref", "metric", "amount", "providerText", "asOf"]) &&
    ref(value.ref) &&
    text(value.metric) &&
    validQuantity(value.amount) &&
    nullableText(value.providerText) &&
    nullableText(value.asOf)
  );
}

function validPosition(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "snapshotRef",
      "securityCode",
      "securityName",
      "market",
      "quantityText",
      "currency",
      "asOf",
      "instrument",
      "valuations",
    ]) &&
    ref(value.ref) &&
    ref(value.snapshotRef) &&
    text(value.securityCode) &&
    nullableText(value.securityName) &&
    nullableText(value.market) &&
    text(value.quantityText) &&
    nullableText(value.currency) &&
    nullableText(value.asOf) &&
    validInstrument(value.instrument) &&
    list(value.valuations, validValuation)
  );
}

function validMetric(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "metricId",
      "measurementKind",
      "subjectKind",
      "signMeaning",
      "aggregationRule",
      "overlapGroup",
      "definitionRelease",
    ]) &&
    text(value.metricId) &&
    member(MEASUREMENT_KINDS)(value.measurementKind) &&
    member(SUBJECT_KINDS)(value.subjectKind) &&
    member(SIGN_MEANINGS)(value.signMeaning) &&
    member(AGGREGATION_RULES)(value.aggregationRule) &&
    nullableText(value.overlapGroup) &&
    text(value.definitionRelease)
  );
}

function validBalance(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "snapshotRef",
      "providerMetric",
      "metric",
      "amount",
      "providerText",
      "asOf",
      "instrument",
    ]) &&
    ref(value.ref) &&
    ref(value.snapshotRef) &&
    text(value.providerMetric) &&
    validMetric(value.metric) &&
    validQuantity(value.amount) &&
    nullableText(value.providerText) &&
    nullableText(value.asOf) &&
    validInstrument(value.instrument)
  );
}

function validAccount(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "sourceId",
      "sourceAccount",
      "accountId",
      "identityStatus",
      "snapshots",
      "positions",
      "balances",
    ]) &&
    text(value.sourceId) &&
    text(value.sourceAccount) &&
    nullableText(value.accountId) &&
    member(IDENTITY_STATUSES)(value.identityStatus) &&
    list(value.snapshots, validSnapshot) &&
    value.snapshots.length > 0 &&
    list(value.positions, validPosition) &&
    list(value.balances, validBalance)
  );
}

function validSettlement(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      exactKeys(value, ["proposalId", "reviewStatus", "debitDate"]) &&
      text(value.proposalId) &&
      member(["proposed", "accepted", "rejected", "withdrawn"])(value.reviewStatus) &&
      nullableDate(value.debitDate))
  );
}

function validPayable(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "sourceId",
      "sourceAccount",
      "accountId",
      "period",
      "capturedAt",
      "paymentDate",
      "amount",
      "status",
      "settlement",
    ]) &&
    ref(value.ref) &&
    text(value.sourceId) &&
    text(value.sourceAccount) &&
    nullableText(value.accountId) &&
    nullableText(value.period) &&
    validInstantText(value.capturedAt) &&
    nullableText(value.paymentDate) &&
    validQuantity(value.amount) &&
    member(PAYABLE_STATUSES)(value.status) &&
    validSettlement(value.settlement)
  );
}

const SCHEDULED_REF = /^scheduled-payment:[1-9][0-9]*$/u;
const ARTIFACT_REF = /^artifact:[1-9][0-9]*$/u;
const PARSE_RUN_REF = /^parse_run:[1-9][0-9]*$/u;

function validScheduledPayment(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "sourceAccount",
      "scheduleKind",
      "usageDate",
      "dueDate",
      "amount",
      "providerText",
      "counterparty",
      "asOf",
      "dueStatus",
    ]) &&
    typeof value.ref === "string" &&
    SCHEDULED_REF.test(value.ref) &&
    text(value.sourceAccount) &&
    member(SCHEDULED_PAYMENT_KINDS)(value.scheduleKind) &&
    date(value.usageDate) &&
    date(value.dueDate) &&
    validQuantity(value.amount) &&
    text(value.providerText) &&
    text(value.counterparty) &&
    date(value.asOf) &&
    member(SCHEDULED_PAYMENT_DUE_STATUSES)(value.dueStatus)
  );
}

function validScheduledCapture(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "ref",
      "sourceId",
      "parserName",
      "capturedAt",
      "captureDate",
      "ageDays",
      "freshness",
      "payments",
    ]) &&
    typeof value.ref === "string" &&
    ARTIFACT_REF.test(value.ref) &&
    text(value.sourceId) &&
    text(value.parserName) &&
    validInstantText(value.capturedAt) &&
    date(value.captureDate) &&
    count(value.ageDays) &&
    member(FRESHNESS_STATES)(value.freshness) &&
    list(value.payments, validScheduledPayment)
  );
}

const EXCLUSION_REASONS = [...new Set(REPORTED_STATE_EXCLUSIONS.map((entry) => entry.reasonCode))];

function validCoverage(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "containersWithoutSnapshot",
      "staleSnapshots",
      "excluded",
      "excludedRows",
      "liabilitiesCoverage",
      "liabilitiesMissing",
      "payablesFromPaymentDate",
      "statementsBeforeWindow",
      "scheduledPayments",
      "netAssets",
    ]) &&
    list(
      value.containersWithoutSnapshot,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["sourceId", "parserName", "dataset", "reasonCode"]) &&
        text(entry.sourceId) &&
        text(entry.parserName) &&
        text(entry.dataset) &&
        entry.reasonCode === "no_complete_snapshot_before_cutoff",
    ) &&
    list(
      value.staleSnapshots,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["ref", "sourceId", "parserName", "ageDays"]) &&
        ref(entry.ref) &&
        text(entry.sourceId) &&
        text(entry.parserName) &&
        count(entry.ageDays),
    ) &&
    list(
      value.excluded,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["scope", "reasonCode"]) &&
        text(entry.scope) &&
        member(EXCLUSION_REASONS)(entry.reasonCode),
    ) &&
    list(
      value.excludedRows,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["reasonCode", "count"]) &&
        member(EXCLUSION_REASONS)(entry.reasonCode) &&
        count(entry.count),
    ) &&
    // A reported state never claims to know every liability.
    value.liabilitiesCoverage === "partial" &&
    list(value.liabilitiesMissing, member(LIABILITY_GAPS)) &&
    value.liabilitiesMissing.length > 0 &&
    date(value.payablesFromPaymentDate) &&
    list<Record<string, unknown>>(
      value.statementsBeforeWindow,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["sourceId", "reasonCode", "count"]) &&
        text(entry.sourceId) &&
        member(STATEMENTS_BEFORE_WINDOW_REASONS)(entry.reasonCode) &&
        count(entry.count) &&
        entry.count > 0,
    ) &&
    // One entry per source and reason.
    new Set(
      value.statementsBeforeWindow.map((entry) =>
        JSON.stringify([entry["sourceId"], entry["reasonCode"]]),
      ),
    ).size === value.statementsBeforeWindow.length &&
    // The gap is named exactly when the answer leaves a statement out.
    value.liabilitiesMissing.includes("statements_before_window") ===
      value.statementsBeforeWindow.length > 0 &&
    member(SCHEDULED_PAYMENTS_LISTING)(value.scheduledPayments) &&
    value.netAssets === "not-computed"
  );
}

const ROW_REF = /^(?:position|balance):[1-9][0-9]*$/u;
const identity = member(IDENTITY_STATUSES);

/** `[ref, accountId, accountIdentity, instrumentId, instrumentIdentity]`. */
function validManifestRow(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    typeof value[0] === "string" &&
    ROW_REF.test(value[0]) &&
    nullableText(value[1]) &&
    identity(value[2]) &&
    nullableText(value[3]) &&
    identity(value[4])
  );
}

function validManifest(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "date",
      "cutoff",
      "policies",
      "metricRegistryRelease",
      "filters",
      "snapshotRefs",
      "containersWithoutSnapshot",
      "rows",
      "statementRefs",
      "statementAccounts",
      "settlementRefs",
      "statementsBeforeWindow",
      "scheduledPaymentCaptures",
      "scheduledPaymentRefs",
    ]) &&
    value.schemaVersion === REPORTED_STATE_SCHEMA &&
    date(value.date) &&
    validInstantText(value.cutoff) &&
    list(value.policies, text) &&
    text(value.metricRegistryRelease) &&
    record(value.filters) &&
    exactKeys(value.filters, ["source", "account"]) &&
    nullableText(value.filters.source) &&
    nullableText(value.filters.account) &&
    list(value.snapshotRefs, ref) &&
    list(value.containersWithoutSnapshot, text) &&
    // Positions and balances are each bounded; both together, twice the bound.
    Array.isArray(value.rows) &&
    value.rows.length <= 2 * BOUND &&
    value.rows.every(validManifestRow) &&
    list(value.statementRefs, ref) &&
    list(
      value.statementAccounts,
      (entry) =>
        Array.isArray(entry) && entry.length === 2 && ref(entry[0]) && nullableText(entry[1]),
    ) &&
    list(value.settlementRefs, text) &&
    list<Record<string, unknown>>(
      value.statementsBeforeWindow,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["sourceId", "accountId", "reasonCode", "count"]) &&
        text(entry.sourceId) &&
        nullableText(entry.accountId) &&
        member(STATEMENTS_BEFORE_WINDOW_REASONS)(entry.reasonCode) &&
        count(entry.count) &&
        entry.count > 0,
    ) &&
    // One entry per source, resolved account and reason.
    new Set(
      value.statementsBeforeWindow.map((entry) =>
        JSON.stringify([entry["sourceId"], entry["accountId"], entry["reasonCode"]]),
      ),
    ).size === value.statementsBeforeWindow.length &&
    list(
      value.scheduledPaymentCaptures,
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        ARTIFACT_REF.test(entry[0]) &&
        typeof entry[1] === "string" &&
        PARSE_RUN_REF.test(entry[1]),
    ) &&
    list(
      value.scheduledPaymentRefs,
      (entry) => typeof entry === "string" && SCHEDULED_REF.test(entry),
    )
  );
}

/**
 * The manifest pins exactly the scheduled-payment captures and payments the
 * body lists, and none is listed under an account filter.
 */
function scheduledAgree(body: Record<string, unknown>): boolean {
  const captures = body["scheduledPayments"] as {
    ref: string;
    payments: { ref: string }[];
  }[];
  const coverage = body["coverage"] as Record<string, unknown>;
  const manifest = body["manifest"] as Record<string, unknown>;
  const pinned = manifest["scheduledPaymentCaptures"] as [string, string][];
  const refs = manifest["scheduledPaymentRefs"] as string[];
  const listed = captures.flatMap((capture) => capture.payments.map((payment) => payment.ref));
  return (
    (coverage["scheduledPayments"] === "listed" || captures.length === 0) &&
    pinned.length === captures.length &&
    captures.every((capture) => pinned.some(([ref]) => ref === capture.ref)) &&
    new Set(listed).size === listed.length &&
    refs.length === listed.length &&
    listed.every((ref) => refs.includes(ref))
  );
}

/**
 * The coverage's counts are the manifest's, added per source and reason: the
 * context id records every count the answer shows.
 */
function countsAgree(coverage: unknown, manifest: unknown): boolean {
  if (!record(coverage) || !record(manifest)) return false;
  const shown = coverage.statementsBeforeWindow as Record<string, unknown>[];
  const recorded = manifest.statementsBeforeWindow as Record<string, unknown>[];
  const sums = new Map<string, number>();
  for (const entry of recorded) {
    const key = JSON.stringify([entry["sourceId"], entry["reasonCode"]]);
    sums.set(key, (sums.get(key) ?? 0) + (entry["count"] as number));
  }
  return (
    sums.size === shown.length &&
    shown.every(
      (entry) =>
        sums.get(JSON.stringify([entry["sourceId"], entry["reasonCode"]])) === entry["count"],
    )
  );
}

/** The API body: `apiVersion` 2 and the reported state, nothing else. */
export function validReportedState(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "apiVersion",
      "schemaVersion",
      "date",
      "cutoff",
      "zone",
      "filters",
      "snapshots",
      "accounts",
      "payables",
      "scheduledPayments",
      "coverage",
      "manifest",
      "contextId",
    ]) &&
    value.apiVersion === 2 &&
    value.schemaVersion === REPORTED_STATE_SCHEMA &&
    date(value.date) &&
    validInstantText(value.cutoff) &&
    value.zone === REPORTED_STATE_ZONE &&
    record(value.filters) &&
    exactKeys(value.filters, ["source", "account"]) &&
    nullableText(value.filters.source) &&
    nullableText(value.filters.account) &&
    list(value.snapshots, validSnapshot) &&
    list(value.accounts, validAccount) &&
    list(value.payables, validPayable) &&
    list(value.scheduledPayments, validScheduledCapture) &&
    validCoverage(value.coverage) &&
    validManifest(value.manifest) &&
    countsAgree(value.coverage, value.manifest) &&
    scheduledAgree(value) &&
    // The manifest pins the filters the body was answered under.
    (value.manifest as { filters: Record<string, unknown> }).filters.source ===
      value.filters.source &&
    (value.manifest as { filters: Record<string, unknown> }).filters.account ===
      value.filters.account &&
    typeof value.contextId === "string" &&
    /^[0-9a-f]{64}$/u.test(value.contextId)
  );
}
