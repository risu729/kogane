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
    value.netAssets === "not-computed"
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
      "snapshotRefs",
      "statementRefs",
      "settlementRefs",
    ]) &&
    value.schemaVersion === REPORTED_STATE_SCHEMA &&
    date(value.date) &&
    validInstantText(value.cutoff) &&
    list(value.policies, text) &&
    list(value.snapshotRefs, ref) &&
    list(value.statementRefs, ref) &&
    list(value.settlementRefs, text)
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
    validCoverage(value.coverage) &&
    validManifest(value.manifest) &&
    typeof value.contextId === "string" &&
    /^[0-9a-f]{64}$/u.test(value.contextId)
  );
}
