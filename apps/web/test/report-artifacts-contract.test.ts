// The wire contract of the fixed report routes as the web client checks it
// (packages/observation-shared/src/report-artifact-contract.ts): a valid
// answer passes, and an answer that adds a figure, zero-fills a missing value,
// claims a whole total for a partial report, answers for another report or
// keeps explaining a restricted one is refused rather than displayed.
import { describe, expect, test } from "bun:test";
import {
  CENTRAL_STORE_CAPABILITIES,
  LOCAL_STORE_CAPABILITIES,
} from "../../../packages/observation-shared/src/api-schema.ts";
import {
  validApiCapabilities,
  validApiResponse,
} from "../../../packages/observation-shared/src/api-validation.ts";
import { clientFeatures } from "../src/capabilities.ts";
import { formatAmount } from "../src/money.ts";
import { reportAmountMinor } from "../src/report-display.tsx";
import { matchRoute } from "../src/router.tsx";
import {
  completeDetail,
  explanationOf,
  listPage,
  missingDetail,
  MISSING_ID,
  PARTIAL_ID,
  partialDetail,
} from "./report-fixture.ts";

const LIST = "/api/v2/reports";
const detailPath = (id: string) => `${LIST}/${encodeURIComponent(id)}`;

function mutated<T>(value: T, change: (copy: any) => void): unknown {
  const copy = structuredClone(value) as any;
  change(copy);
  return copy;
}

describe("report list contract", () => {
  test("a page of catalogue rows with a next offset and no total", () => {
    const page = listPage(0, 60);
    expect(validApiResponse(LIST, page)).toBe(true);
    expect(validApiResponse(LIST, listPage(50, 60))).toBe(true);
    expect(validApiResponse(LIST, listPage(0, 0))).toBe(true);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.total = 60)),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.items[0].subtotal = "1")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.nextCursor = "0")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.nextCursor = 50)),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.items[0].contentDigest = "ABC")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.items[0].createdAt = "")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.items[0].reportId = "../x")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.items[1] = copy.items[0])),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        LIST,
        mutated(page, (copy) => (copy.apiVersion = 1)),
      ),
    ).toBe(false);
  });
});

describe("report detail contract", () => {
  const detail = partialDetail();
  const path = detailPath(PARTIAL_ID);

  test("the stored body of the report the path names", () => {
    expect(validApiResponse(path, detail)).toBe(true);
    expect(validApiResponse(detailPath(completeDetail().report.reportId), completeDetail())).toBe(
      true,
    );
    expect(validApiResponse(detailPath(MISSING_ID), missingDetail())).toBe(true);
    // Another report's answer is never shown under this id.
    expect(validApiResponse(detailPath("rpt-other"), detail)).toBe(false);
    expect(validApiResponse(`${LIST}/%E0%A4%A`, detail)).toBe(false);
  });

  test("missing values stay reasons and partial results never become totals", () => {
    // An unvalued holding that also carries a zero, or a reason outside the list.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.rows[2].value = { coefficient: "0", scale: 0 })),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.rows[2].unvaluedReason = "zero")),
      ),
    ).toBe(false);
    // A blank or floating amount is malformed, not zero.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.rows[0].value.coefficient = "")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.rows[0].value = 1200000)),
      ),
    ).toBe(false);
    // Nothing valued, yet a subtotal: refused.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.partition = "not-computable")),
      ),
    ).toBe(false);
    // A figure the contract does not name.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.total = "1")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.netWorth = "1")),
      ),
    ).toBe(false);
  });

  test("the summary, the body and the events agree", () => {
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.body.contextId = "ctx-other")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.report.storageRef = "reports/x")),
      ),
    ).toBe(false);
    // A restricted report may not say it can still be explained or exported.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.report.replayability = "restricted")),
      ),
    ).toBe(false);
    expect(validApiResponse(path, partialDetail(PARTIAL_ID, "restricted"))).toBe(true);
    // A body that is gone cannot claim to be replayable.
    expect(
      validApiResponse(
        detailPath(MISSING_ID),
        mutated(missingDetail(), (copy) => {
          copy.report.replayability = "replayable";
          copy.report.capabilities = {
            explain: true,
            export: true,
            recompute: true,
            purgeCachedExplanations: false,
          };
        }),
      ),
    ).toBe(false);
    // A correction names the other report; a generation names none.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.events[1].related_report_id = null)),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.events[0].related_report_id = "rpt-other")),
      ),
    ).toBe(false);
    // The related report is linked, so it follows the API's own id rule.
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.events[1].related_report_id = "../summaries")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.events[0].kind = "regenerated")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(detail, (copy) => (copy.view = "export")),
      ),
    ).toBe(false);
  });
});

describe("report explanation contract", () => {
  const detail = partialDetail();
  const explanation = explanationOf(detail);
  const path = `${detailPath(PARTIAL_ID)}/explanation`;

  test("references only, for an explainable report", () => {
    expect(validApiResponse(path, explanation)).toBe(true);
    expect(validApiResponse(`${detailPath("rpt-other")}/explanation`, explanation)).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(explanation, (copy) => (copy.replayability = "restricted")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(explanation, (copy) => (copy.explanation.prices[0].quoteAmount = "1500")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(
          explanation,
          (copy) => (copy.explanation.inputManifest.positionObservationIds = ["901"]),
        ),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(
          explanation,
          (copy) => delete copy.explanation.inputManifest.knowledgeCutoffEffective,
        ),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(explanation, (copy) => (copy.explanation.contextId = "ctx-other")),
      ),
    ).toBe(false);
    expect(
      validApiResponse(
        path,
        mutated(explanation, (copy) => (copy.explanation.schemaVersion = "report-explanation-v2")),
      ),
    ).toBe(false);
  });
});

describe("report capability, feature and routes", () => {
  test("advertised only where the server says so", () => {
    expect(validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, reportArtifacts: true })).toBe(
      true,
    );
    expect(clientFeatures(CENTRAL_STORE_CAPABILITIES).reportArtifacts).toBe(false);
    expect(clientFeatures(LOCAL_STORE_CAPABILITIES).reportArtifacts).toBe(false);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, reportArtifacts: true }).reportArtifacts,
    ).toBe(true);
  });

  test("the list and one report by the API's own id rule", () => {
    expect(matchRoute("/reports")).toEqual({ name: "reports" });
    const id = `rpt-${"0".repeat(64)}`;
    expect(matchRoute(`/reports/${id}`)).toEqual({ name: "report", reportId: id });
    expect(matchRoute("/reports/ctx%3Aa.b")).toEqual({ name: "report", reportId: "ctx:a.b" });
    for (const path of ["/reports/-x", "/reports/a%2Fb", "/reports/%E0%A4%A", "/reports/a/b"])
      expect(matchRoute(path).name).toBe("notFound");
  });
});

describe("report amounts through the shared formatter", () => {
  const shown = (coefficient: string, scale: number, unit: string) => {
    const minor = reportAmountMinor({ coefficient, scale }, unit);
    return minor === null ? null : formatAmount(minor, unit);
  };

  test("widened to minor units by string work, never rounded", () => {
    expect(shown("1234567", 0, "JPY")).toBe("1,234,567 JPY");
    expect(shown("123450", 2, "USD")).toBe("1,234.50 USD");
    expect(shown("12345", 0, "USD")).toBe("12,345.00 USD");
    expect(shown("-5", 1, "USD")).toBe("-0.50 USD");
    // Trailing zeros only: 100.00 JPY is 100 JPY.
    expect(shown("10000", 2, "JPY")).toBe("100 JPY");
    // A place the minor unit cannot hold is not rounded away: shown verbatim.
    expect(reportAmountMinor({ coefficient: "12345675", scale: 1 }, "JPY")).toBeNull();
    expect(reportAmountMinor({ coefficient: "5", scale: 3 }, "USD")).toBeNull();
    // An unknown unit has no minor unit to guess.
    expect(reportAmountMinor({ coefficient: "100", scale: 0 }, "XYZ")).toBeNull();
    // A large value stays exact.
    expect(shown("123456789012345678901234", 0, "JPY")).toBe("123,456,789,012,345,678,901,234 JPY");
  });
});
