import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  artifactFilename,
  GLOBALPASS_SCHEMA_VERSION,
  assertCanonicalMonths,
  CONTAINER_PROBE_VARIANTS,
  parseContainerProbeVariant,
  parseMode,
  runPrefix,
  safeMonth,
  selectedMonthsForMode,
  strictCollectionStatus,
} from "../src/model";

describe("GLOBAL PASS collection model", () => {
  test("the deployed Worker reports the schema version its manifests carry", () => {
    // `/health` answers with the `COLLECTOR_SCHEMA_VERSION` var.
    const wrangler = readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8");
    expect(wrangler).toContain(`"COLLECTOR_SCHEMA_VERSION": "${GLOBALPASS_SCHEMA_VERSION}"`);
  });

  test("defaults to the bounded daily mode", () => {
    expect(parseMode(null)).toBe("daily");
    expect(parseMode("daily")).toBe("daily");
    expect(parseMode("backfill")).toBe("backfill");
    expect(() => parseMode("all")).toThrow();
  });

  test("accepts only canonical retained months", () => {
    expect(safeMonth("2026-08")).toBe("2026-08");
    expect(() => safeMonth("../../secret")).toThrow();
    expect(() => safeMonth("2026-13")).toThrow();
  });

  test("derives the exact selected month set for daily and backfill", () => {
    const available = ["2026-09", "2026-08", "2026-07"];
    expect(selectedMonthsForMode("daily", available)).toEqual(["2026-09", "2026-08"]);
    expect(selectedMonthsForMode("backfill", available)).toEqual(available);
    expect(artifactFilename("2026-09")).toBe("activity-2026-09.html");
  });

  test("rejects duplicate, unordered, discontinuous and oversized selectors", () => {
    expect(() => assertCanonicalMonths(["2026-09", "2026-09"], "months")).toThrow();
    expect(() => assertCanonicalMonths(["2026-08", "2026-09"], "months")).toThrow();
    expect(() => assertCanonicalMonths(["2026-09", "2026-07"], "months")).toThrow();
    expect(() => assertCanonicalMonths([], "months")).toThrow();
  });

  test("marks success only for the exact selected-artifact complement", () => {
    const stored = (month: string, page = 1) => ({
      dataset: "globalpass-activity" as const,
      month,
      page,
      key: `raw/prestia-globalpass/run/${artifactFilename(month, page)}`,
      mediaType: "text/html" as const,
      bytes: 10,
      sha256: "a".repeat(64),
    });
    expect(
      strictCollectionStatus([stored("2026-09"), stored("2026-08")], [], ["2026-09", "2026-08"]),
    ).toEqual({ status: "success", captureComplete: true });
    expect(
      strictCollectionStatus(
        [stored("2026-09")],
        [
          {
            operation: "contract",
            errorType: "CollectionContractError",
            errorCode: "selected_month_missing",
            artifactKey: "activity-2026-08.html",
          },
        ],
        ["2026-09", "2026-08"],
      ),
    ).toEqual({ status: "partial", captureComplete: false });
    expect(
      strictCollectionStatus(
        [],
        [
          {
            operation: "browser-collection",
            errorType: "Error",
            errorCode: "browser_collection_failed",
          },
        ],
        [],
      ),
    ).toEqual({ status: "failed", captureComplete: false });
    expect(() =>
      strictCollectionStatus([stored("2026-08"), stored("2026-09")], [], ["2026-09", "2026-08"]),
    ).toThrow("not in selected month order");
    // A month's pages, in walk order, then the next month.
    expect(
      strictCollectionStatus(
        [stored("2026-09"), stored("2026-09", 2), stored("2026-08")],
        [],
        ["2026-09", "2026-08"],
      ),
    ).toEqual({ status: "success", captureComplete: true });
    expect(() =>
      strictCollectionStatus([stored("2026-09", 2), stored("2026-09")], [], ["2026-09", "2026-08"]),
    ).toThrow("duplicate GLOBAL PASS artifact page");
    expect(() =>
      strictCollectionStatus(
        [stored("2026-09"), stored("2026-08"), stored("2026-09", 2)],
        [],
        ["2026-09", "2026-08"],
      ),
    ).toThrow("not in selected month order");
  });

  test("page 1 keeps the month's key; later pages are page-qualified", () => {
    expect(artifactFilename("2026-09")).toBe("activity-2026-09.html");
    expect(artifactFilename("2026-09", 1)).toBe("activity-2026-09.html");
    expect(artifactFilename("2026-09", 2)).toBe("activity-2026-09-p2.html");
    expect(() => artifactFilename("2026-09", 0)).toThrow();
    expect(() => artifactFilename("2026-09", 10)).toThrow();
    expect(() => artifactFilename("2026-09", 1.5)).toThrow();
  });

  test("uses the source-specific private R2 prefix", () => {
    expect(runPrefix("2026-08-27T12:00:00.000Z", "run-id")).toBe(
      "raw/prestia-globalpass/2026/08/27/run-id",
    );
  });

  test("accepts only the bounded container probe matrix", () => {
    for (const variant of CONTAINER_PROBE_VARIANTS) {
      expect(parseContainerProbeVariant(variant)).toBe(variant);
    }
    expect(() => parseContainerProbeVariant(null)).toThrow();
    expect(() => parseContainerProbeVariant("arbitrary-flags")).toThrow();
  });
});
