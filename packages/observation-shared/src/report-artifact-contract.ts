// The wire shape of the fixed report artifact routes
// (docs/calculation-and-reports.md §4, ADR 0072):
//
//   GET /api/v2/reports?offset=N            the catalogue, newest first
//   GET /api/v2/reports/{id}                one stored body, re-displayed
//   GET /api/v2/reports/{id}/explanation    its cached explanation node
//
// Shape only: the client recalculates nothing. Every object has exactly the
// fields the server writes, so an answer that carries a figure the contract
// does not name (a total, a recomputed value) is refused rather than shown;
// the body is checked by the domain's own `validReportBody`, so a partial or
// not-computable body can never present a whole-portfolio subtotal; and the
// capabilities a report states must be the ones its replayability implies,
// so a restricted report cannot claim it may still be explained.
import { REPLAYABILITY, type Replayability } from "../../domain/src/context.ts";
import { PRICE_KINDS, type PriceKind } from "../../domain/src/metrics.ts";
import {
  REPORT_EVENT_KINDS,
  REPORT_PURPOSES,
  replayCapabilities,
  reportStorageRef,
  validReportBody,
  type ReportBody,
  type ReportEventKind,
  type ReportPurpose,
} from "../../domain/src/reports.ts";
import { validInterpretationContext, type InterpretationContext } from "./api-schema.ts";

export const REPORTS_PATH = "/api/v2/reports";
/** The server's own identifier rule (`services/app/src/reports-api.ts`). */
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** The explanation node schema the report job writes. */
const REPORT_EXPLANATION_SCHEMA = "report-explanation-v1";
const REPORT_INPUT_MANIFEST_SCHEMA = "report-inputs-v1";
const CALCULATION_RUN_STATUSES = ["building", "complete", "failed"] as const;
const LIST_BOUND = 200;
const EVENT_BOUND = 200;
const ID_BOUND = 100_000;
const HEX64 = /^[0-9a-f]{64}$/u;

export interface ReportListItem {
  reportId: string;
  contextId: string;
  purpose: ReportPurpose;
  schemaVersion: string;
  contentDigest: string;
  createdBy: string;
  createdAt: string;
}

export interface ReportListPage {
  apiVersion: 2;
  items: ReportListItem[];
  /** The next page's offset as a decimal string, or null on the last page. No total. */
  nextCursor: string | null;
}

interface ReportCalculationRun {
  runId: string;
  policyRefs: string[];
  inputManifestDigest: string;
  status: (typeof CALCULATION_RUN_STATUSES)[number];
  startedAt: string;
  completedAt: string | null;
}

interface ReportCapabilities {
  explain: boolean;
  export: boolean;
  recompute: boolean;
  purgeCachedExplanations: boolean;
}

export interface ReportSummary {
  reportId: string;
  contextId: string;
  purpose: ReportPurpose;
  schemaVersion: string;
  contentDigest: string;
  storageRef: string;
  createdBy: string;
  createdAt: string;
  replayability: Replayability;
  capabilities: ReportCapabilities;
  calculationRun: ReportCalculationRun | null;
  operations: Record<
    "re-display" | "recompute-under-current-rules" | "share-corrected-version",
    string
  >;
}

/** A `report_events` row as the route returns it (column names as stored). */
export interface ReportEventRow {
  kind: ReportEventKind;
  actor: string;
  related_report_id: string | null;
  occurred_at: string;
}

export type ReportDetail =
  | {
      report: ReportSummary;
      interpretationContext: InterpretationContext;
      events: ReportEventRow[];
      view: "body";
      body: ReportBody;
    }
  | {
      /** The catalogue row survives, the stored body does not: nothing is rebuilt. */
      report: ReportSummary;
      interpretationContext: InterpretationContext;
      body: null;
    };

interface ReportInputManifest {
  schemaVersion: typeof REPORT_INPUT_MANIFEST_SCHEMA;
  perimeterRef: string;
  unitRef: string;
  /** Newest moment any included evidence was recorded, or "none". */
  knowledgeCutoffEffective: string;
  decimalPolicyRelease: string;
  instrumentValuationPolicyId: string;
  positionObservationIds: number[];
  valuationObservationIds: number[];
  priceObservationIds: string[];
}

interface ReportExplanationPrice {
  id: string;
  baseInstrumentRef: string;
  quoteUnitRef: string;
  priceKind: PriceKind;
  sourceClaimRef: string;
}

/** The cached explanation node: references only, no amount and no raw locator. */
export interface ReportExplanationNode {
  schemaVersion: typeof REPORT_EXPLANATION_SCHEMA;
  contextId: string;
  calculationRunId: string;
  inputManifest: ReportInputManifest;
  policyRefs: string[];
  prices: ReportExplanationPrice[];
}

export interface ReportExplanation {
  reportId: string;
  contextId: string;
  replayability: Replayability;
  interpretationContext: InterpretationContext;
  explanation: ReportExplanationNode;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Exactly these fields: a field the contract does not name is refused, not ignored. */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const nullableText = (value: unknown, max = 512): boolean => value === null || text(value, max);
const member =
  <T extends readonly string[]>(choices: T) =>
  (value: unknown): value is T[number] =>
    typeof value === "string" && choices.includes(value);
const textList = (value: unknown, bound: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= bound &&
  value.every((entry) => text(entry)) &&
  new Set(value).size === value.length;
const idList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= ID_BOUND &&
  value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) &&
  new Set(value).size === value.length;

function validReportId(value: unknown): value is string {
  return typeof value === "string" && REPORT_ID.test(value);
}

function validListItem(value: unknown): value is ReportListItem {
  return (
    record(value) &&
    exactKeys(value, [
      "reportId",
      "contextId",
      "purpose",
      "schemaVersion",
      "contentDigest",
      "createdBy",
      "createdAt",
    ]) &&
    validReportId(value.reportId) &&
    text(value.contextId, 256) &&
    member(REPORT_PURPOSES)(value.purpose) &&
    text(value.schemaVersion, 64) &&
    typeof value.contentDigest === "string" &&
    HEX64.test(value.contentDigest) &&
    text(value.createdBy, 256) &&
    text(value.createdAt, 64)
  );
}

function validReportListPage(value: unknown): value is ReportListPage {
  return (
    record(value) &&
    exactKeys(value, ["apiVersion", "items", "nextCursor"]) &&
    value.apiVersion === 2 &&
    Array.isArray(value.items) &&
    value.items.length <= LIST_BOUND &&
    value.items.every(validListItem) &&
    new Set(value.items.map((item) => item.reportId)).size === value.items.length &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" && /^[1-9][0-9]{0,15}$/u.test(value.nextCursor)))
  );
}

function validCalculationRun(value: unknown): value is ReportCalculationRun {
  return (
    record(value) &&
    exactKeys(value, [
      "runId",
      "policyRefs",
      "inputManifestDigest",
      "status",
      "startedAt",
      "completedAt",
    ]) &&
    text(value.runId, 256) &&
    textList(value.policyRefs, 100) &&
    text(value.inputManifestDigest, 256) &&
    member(CALCULATION_RUN_STATUSES)(value.status) &&
    text(value.startedAt, 64) &&
    nullableText(value.completedAt, 64)
  );
}

function sameCapabilities(value: unknown, replayability: Replayability): boolean {
  const expected = replayCapabilities(replayability);
  return (
    record(value) &&
    exactKeys(value, Object.keys(expected)) &&
    Object.entries(expected).every(([key, allowed]) => value[key] === allowed)
  );
}

function validSummary(value: unknown): value is ReportSummary {
  return (
    record(value) &&
    exactKeys(value, [
      "reportId",
      "contextId",
      "purpose",
      "schemaVersion",
      "contentDigest",
      "storageRef",
      "createdBy",
      "createdAt",
      "replayability",
      "capabilities",
      "calculationRun",
      "operations",
    ]) &&
    validReportId(value.reportId) &&
    text(value.contextId, 256) &&
    member(REPORT_PURPOSES)(value.purpose) &&
    text(value.schemaVersion, 64) &&
    typeof value.contentDigest === "string" &&
    HEX64.test(value.contentDigest) &&
    value.storageRef === reportStorageRef(value.contentDigest) &&
    text(value.createdBy, 256) &&
    text(value.createdAt, 64) &&
    member(REPLAYABILITY)(value.replayability) &&
    sameCapabilities(value.capabilities, value.replayability) &&
    (value.calculationRun === null || validCalculationRun(value.calculationRun)) &&
    record(value.operations) &&
    exactKeys(value.operations, [
      "re-display",
      "recompute-under-current-rules",
      "share-corrected-version",
    ]) &&
    Object.values(value.operations).every((entry) => text(entry, 256))
  );
}

function validEventRow(value: unknown, reportId: string): value is ReportEventRow {
  return (
    record(value) &&
    exactKeys(value, ["kind", "actor", "related_report_id", "occurred_at"]) &&
    member(REPORT_EVENT_KINDS)(value.kind) &&
    text(value.actor, 256) &&
    // The related report is linked by id, so it must be one the API serves.
    (value.related_report_id === null || validReportId(value.related_report_id)) &&
    // A correction and a supersession name the other report; nothing else does.
    (value.kind === "corrected" || value.kind === "superseded") ===
      (value.related_report_id !== null) &&
    value.related_report_id !== reportId &&
    text(value.occurred_at, 64)
  );
}

/** The detail answer for the report the path asked for, and no other. */
function validReportDetail(value: unknown, reportId: string): value is ReportDetail {
  if (!record(value) || !validSummary(value.report) || value.report.reportId !== reportId)
    return false;
  if (!validInterpretationContext(value.interpretationContext)) return false;
  if (value.body === null)
    // Without a body the server says so, and nothing may claim to replay it.
    return (
      exactKeys(value, ["report", "interpretationContext", "body"]) &&
      value.report.replayability === "unavailable"
    );
  return (
    exactKeys(value, ["report", "interpretationContext", "events", "view", "body"]) &&
    value.view === "body" &&
    Array.isArray(value.events) &&
    value.events.length <= EVENT_BOUND &&
    value.events.every((event) => validEventRow(event, reportId)) &&
    validReportBody(value.body) &&
    value.body.contextId === value.report.contextId &&
    value.body.purpose === value.report.purpose &&
    value.body.schemaVersion === value.report.schemaVersion
  );
}

function validManifest(value: unknown): value is ReportInputManifest {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "perimeterRef",
      "unitRef",
      "knowledgeCutoffEffective",
      "decimalPolicyRelease",
      "instrumentValuationPolicyId",
      "positionObservationIds",
      "valuationObservationIds",
      "priceObservationIds",
    ]) &&
    value.schemaVersion === REPORT_INPUT_MANIFEST_SCHEMA &&
    text(value.perimeterRef) &&
    text(value.unitRef, 128) &&
    text(value.knowledgeCutoffEffective, 64) &&
    text(value.decimalPolicyRelease, 128) &&
    text(value.instrumentValuationPolicyId, 256) &&
    idList(value.positionObservationIds) &&
    idList(value.valuationObservationIds) &&
    textList(value.priceObservationIds, ID_BOUND)
  );
}

function validPrice(value: unknown): value is ReportExplanationPrice {
  return (
    record(value) &&
    exactKeys(value, ["id", "baseInstrumentRef", "quoteUnitRef", "priceKind", "sourceClaimRef"]) &&
    text(value.id, 256) &&
    text(value.baseInstrumentRef, 256) &&
    text(value.quoteUnitRef, 128) &&
    member(PRICE_KINDS)(value.priceKind) &&
    text(value.sourceClaimRef)
  );
}

/** The node the report job caches beside a body (`reports/<digest>.explanation`). */
export function validReportExplanationNode(value: unknown): value is ReportExplanationNode {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "contextId",
      "calculationRunId",
      "inputManifest",
      "policyRefs",
      "prices",
    ]) &&
    value.schemaVersion === REPORT_EXPLANATION_SCHEMA &&
    text(value.contextId, 256) &&
    text(value.calculationRunId, 256) &&
    validManifest(value.inputManifest) &&
    textList(value.policyRefs, 100) &&
    Array.isArray(value.prices) &&
    value.prices.length <= ID_BOUND &&
    value.prices.every(validPrice) &&
    new Set(value.prices.map((price) => price.id)).size === value.prices.length
  );
}

function validReportExplanation(value: unknown, reportId: string): value is ReportExplanation {
  return (
    record(value) &&
    exactKeys(value, [
      "reportId",
      "contextId",
      "replayability",
      "interpretationContext",
      "explanation",
    ]) &&
    value.reportId === reportId &&
    text(value.contextId, 256) &&
    member(REPLAYABILITY)(value.replayability) &&
    // The server refuses to explain a restricted or unavailable report.
    replayCapabilities(value.replayability).explain &&
    validInterpretationContext(value.interpretationContext) &&
    validReportExplanationNode(value.explanation) &&
    value.explanation.contextId === value.contextId
  );
}

/** The report id a detail or explanation path names, or null. */
function pathReportId(encoded: string): string | null {
  try {
    const id = decodeURIComponent(encoded);
    return validReportId(id) ? id : null;
  } catch {
    return null;
  }
}

/** Dispatch for `validApiResponse`: every report path, or null for any other path. */
export function validReportResponse(path: string, value: unknown): boolean | null {
  if (path === REPORTS_PATH) return validReportListPage(value);
  const match = /^\/api\/v2\/reports\/([^/]+)(\/explanation)?$/u.exec(path);
  if (!match) return null;
  const id = pathReportId(match[1]!);
  if (id === null) return false;
  return match[2] === undefined ? validReportDetail(value, id) : validReportExplanation(value, id);
}
