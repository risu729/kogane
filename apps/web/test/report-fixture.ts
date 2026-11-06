// Synthetic answers of the fixed report routes, in the exact shapes
// `services/app/src/reports-api.ts` writes (its own test checks the real
// answers against the same contract). Every identifier and figure is made up.
import { replayCapabilities } from "../../../packages/domain/src/reports.ts";
import type { Replayability } from "../../../packages/domain/src/context.ts";
import type {
  ReportDetail,
  ReportExplanation,
  ReportListItem,
  ReportListPage,
} from "../../../packages/observation-shared/src/report-artifact-contract.ts";

export const PARTIAL_ID = "rpt-synthetic-partial";
export const COMPLETE_ID = "rpt-synthetic-complete";
export const RESTRICTED_ID = "rpt-synthetic-restricted";
export const MISSING_ID = "rpt-synthetic-missing";
export const MISMATCH_ID = "rpt-synthetic-mismatch";
export const UNEXPLAINED_ID = "rpt-synthetic-unexplained";

const digest = (seed: number) => seed.toString(16).padStart(64, "a");

const interpretationContext = {
  mode: "as-recorded",
  snapshotId: null,
  identityRelease: "identity-none",
  productCatalogueRelease: "product-catalogue-v1",
  productResolverRelease: "product-resolver-v1",
  measurePolicyRelease: "measure-policy-v1",
  decimalPolicyRelease: "decimal-v1",
} as const;

function listItem(index: number, reportId = `rpt-synthetic-${String(index)}`): ReportListItem {
  return {
    reportId,
    contextId: `ctx-synthetic-${String(index)}`,
    purpose: "holdings-view",
    schemaVersion: "report-holdings-v1",
    contentDigest: digest(index),
    createdBy: "report-job",
    // Newest first, as the server orders the catalogue.
    createdAt: new Date(Date.parse("2026-09-30T00:00:00.000Z") - index * 3_600_000).toISOString(),
  };
}

/** `count` stored reports from `offset`, newest first, paged by `size`. */
export function listPage(offset: number, count: number, size = 50): ReportListPage {
  const ids = [PARTIAL_ID, COMPLETE_ID, RESTRICTED_ID, MISSING_ID, MISMATCH_ID, UNEXPLAINED_ID];
  const all = Array.from({ length: count }, (_, index) => listItem(index + 1, ids[index]));
  return {
    apiVersion: 2,
    items: all.slice(offset, offset + size),
    nextCursor: offset + size < count ? String(offset + size) : null,
  };
}

function summary(reportId: string, index: number, replayability: Replayability) {
  return {
    reportId,
    contextId: `ctx-synthetic-${String(index)}`,
    purpose: "holdings-view" as const,
    schemaVersion: "report-holdings-v1",
    contentDigest: digest(index),
    storageRef: `reports/${digest(index)}`,
    createdBy: "report-job",
    createdAt: "2026-09-21T00:00:00.000Z",
    replayability,
    capabilities: replayCapabilities(replayability),
    calculationRun: {
      runId: `run-synthetic-${String(index)}`,
      policyRefs: ["decimal-v1", "instrument-valuation-v1"],
      inputManifestDigest: "c".repeat(64),
      status: "complete" as const,
      startedAt: "2026-09-21T00:00:00.000Z",
      completedAt: "2026-09-21T00:00:01.000Z",
    },
    operations: {
      "re-display": "GET /api/v2/reports/{reportId}",
      "recompute-under-current-rules": "command (A09); not served by this reader",
      "share-corrected-version": "command (A09); not served by this reader",
    },
  };
}

/** Two holdings valued (one with a decimal place), one unvalued: a partial report. */
export function partialDetail(
  reportId = PARTIAL_ID,
  replayability: Replayability = "replayable",
): Extract<ReportDetail, { view: "body" }> {
  const report = summary(reportId, 1, replayability);
  return {
    report,
    interpretationContext,
    events: [
      {
        kind: "generated",
        actor: "report-job",
        related_report_id: null,
        occurred_at: "2026-09-21T00:00:01.000Z",
      },
      {
        kind: "corrected",
        actor: "operator:synthetic",
        related_report_id: COMPLETE_ID,
        occurred_at: "2026-09-22T00:00:00.000Z",
      },
    ],
    view: "body",
    body: {
      schemaVersion: "report-holdings-v1",
      purpose: "holdings-view",
      contextId: report.contextId,
      calculationRunId: report.calculationRun.runId,
      policyRefs: ["decimal-v1", "instrument-valuation-v1"],
      unitRef: "JPY",
      partition: "partial-verified-scope",
      subtotal: { coefficient: "12345675", scale: 1 },
      rows: [
        {
          subjectRef: "instrument:synthetic-broker:TSE:1111",
          scopeRef: "scope:synthetic-broker:acct-a",
          metric: "holdings.valuation",
          unitRef: "JPY",
          valued: true,
          value: { coefficient: "1200000", scale: 0 },
        },
        {
          subjectRef: "instrument:synthetic-broker:TSE:2222",
          scopeRef: "scope:synthetic-broker:acct-a",
          metric: "holdings.valuation",
          unitRef: "JPY",
          valued: true,
          value: { coefficient: "345675", scale: 1 },
        },
        {
          subjectRef: "instrument:synthetic-broker:NASDAQ:SYN",
          scopeRef: "scope:synthetic-broker:acct-b",
          metric: "holdings.valuation",
          unitRef: "JPY",
          valued: false,
          unvaluedReason: "missing-price",
        },
      ],
      coverage: {
        scopeRef: "perimeter:all-visible-evidence",
        coveredRef: "positions:3",
        truncated: false,
      },
    },
  };
}

/** Every holding valued: the subtotal is the report's whole figure. */
export function completeDetail(): Extract<ReportDetail, { view: "body" }> {
  const detail = partialDetail(COMPLETE_ID);
  detail.report = summary(COMPLETE_ID, 2, "artifact-preserved");
  detail.events = [detail.events[0]!];
  detail.body = {
    ...detail.body,
    contextId: detail.report.contextId,
    partition: "complete",
    subtotal: { coefficient: "1200000", scale: 0 },
    rows: [detail.body.rows[0]!],
    coverage: { ...detail.body.coverage, coveredRef: "positions:1", truncated: true },
  };
  return detail;
}

/** The catalogue row survives; the stored body does not. */
export function missingDetail(): ReportDetail {
  return {
    report: summary(MISSING_ID, 4, "unavailable"),
    interpretationContext,
    body: null,
  };
}

export function explanationOf(detail: Extract<ReportDetail, { view: "body" }>): ReportExplanation {
  return {
    reportId: detail.report.reportId,
    contextId: detail.report.contextId,
    replayability: detail.report.replayability,
    interpretationContext,
    explanation: {
      schemaVersion: "report-explanation-v1",
      contextId: detail.report.contextId,
      calculationRunId: detail.body.calculationRunId,
      inputManifest: {
        schemaVersion: "report-inputs-v1",
        perimeterRef: "perimeter:all-visible-evidence",
        unitRef: "JPY",
        knowledgeCutoffEffective: "2026-09-20T23:59:00.000Z",
        decimalPolicyRelease: "decimal-v1",
        instrumentValuationPolicyId: "instrument-valuation-v1",
        positionObservationIds: [901, 902, 903],
        valuationObservationIds: [951],
        priceObservationIds: ["price_synthetic_1"],
      },
      policyRefs: ["decimal-v1", "instrument-valuation-v1"],
      prices: [
        {
          id: "price_synthetic_1",
          baseInstrumentRef: "instrument:synthetic-broker:TSE:1111",
          quoteUnitRef: "JPY",
          priceKind: "reference",
          sourceClaimRef: "valuation_observations/951#$.current_price",
        },
      ],
    },
  };
}
