// The wire check of `GET /api/collection-quality/<sourceId>/accounts`
// (ADR 0088): the shape it accepts and what it refuses. Synthetic values only.
import { describe, expect, test } from "bun:test";
import {
  validAccountCoverage,
  validCollectionQualityResponse,
} from "../src/collection-quality-contract.ts";

const period = {
  unitKey: "synthetic-unit",
  period: { kind: "statement-month", value: "209901", state: null },
  currentRule: "vpass-card-month",
  cellState: "current",
  standing: "current",
  capture: { fetchRunId: 7, capturedAt: "2099-01-01T00:00:00.000Z" },
  observations: 2,
  reasons: ["retention_not_assessed"],
};
const account = (accountId: string, periods: unknown[] = [period]) => ({
  accountId,
  label: "Synthetic account",
  statuses: ["identified"],
  dataTypes: [
    { dataset: "statement-page", parser: "vpass-statement-page", kind: "transaction", periods },
  ],
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 1,
  sourceId: "vpass",
  latestFetchRun: { id: 7, succeeded: true, completedAt: "2099-01-01T00:00:00.000Z" },
  cells: 2,
  accounts: [account("synthetic-a")],
  unattributed: [
    {
      dataset: null,
      parser: null,
      unitKey: "synthetic-unit-b",
      period: { kind: "latest", value: null, state: null },
      currentRule: "published-eligible",
      state: "no-current",
      reasons: ["unit_without_artifacts", "no_current_capture"],
    },
  ],
  ...overrides,
});

describe("account coverage wire check", () => {
  test("accepts the shape, under the path of its own source only", () => {
    expect(validAccountCoverage(answer())).toBe(true);
    expect(validCollectionQualityResponse("/api/collection-quality/vpass/accounts", answer())).toBe(
      true,
    );
    expect(validCollectionQualityResponse("/api/collection-quality/myjcb/accounts", answer())).toBe(
      false,
    );
    // The cells route's path never accepts this shape.
    expect(validCollectionQualityResponse("/api/collection-quality/vpass", answer())).toBe(false);
  });

  test("refuses what the read never answers", () => {
    for (const bad of [
      answer({ apiVersion: 2 }),
      answer({ extra: true }),
      answer({ cells: 0 }),
      answer({ cells: 2_001 }),
      answer({ accounts: [account("synthetic-b"), account("synthetic-a")] }),
      answer({ accounts: [account("synthetic-a"), account("synthetic-a")] }),
      answer({ accounts: [account("synthetic-a", [])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, observations: 0 }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, cellState: "older-current" }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, standing: "unknown" }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, reasons: ["not_a_reason"] }])] }),
      answer({ accounts: [{ ...account("synthetic-a"), statuses: [] }] }),
      answer({ accounts: [{ ...account("synthetic-a"), statuses: ["resolved"] }] }),
    ])
      expect(validAccountCoverage(bad)).toBe(false);
  });

  test("a newest-not-current period may sit in a cell of any state", () => {
    for (const cellState of ["current", "older-current", "no-current"])
      expect(
        validAccountCoverage(
          answer({
            accounts: [
              account("synthetic-a", [{ ...period, cellState, standing: "newest-not-current" }]),
            ],
          }),
        ),
      ).toBe(true);
  });
});
