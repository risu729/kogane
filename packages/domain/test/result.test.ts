import { describe, expect, test } from "bun:test";
import {
  FINANCIAL_ERROR_CODES,
  validFinancialError,
  validFinancialResult,
  validPage,
  validQuerySpec,
  type FinancialResult,
  type QuerySpec,
} from "../src/result.ts";
import { validQuantity, type Quantity } from "../src/values.ts";
import { q } from "./helpers.ts";

const query: QuerySpec = {
  schemaVersion: "query-spec-v1",
  intent: "holdings",
  perimeterRef: "perimeter:self",
  effectiveTime: { kind: "local-date", value: "2026-08-31", zone: "Asia/Tokyo", basis: "derived" },
  basisRefs: { settlement: "basis:executed" },
  filters: { unit: "JPY" },
  limit: 100,
};
const dimension = { state: "verified" as const, reasonCodes: [], evidenceRefs: [] };
const result: FinancialResult<Quantity> = {
  schemaVersion: "financial-result-v1",
  contextId: "ctx:1",
  resolvedQuery: query,
  completeness: "partial",
  data: q("JPY", "160000"),
  coverage: {
    scopeRef: "scope:perimeter:self",
    coveredRef: "scope:covered:1",
    gaps: [{ reasonCode: "overlap_unknown", scopeRef: "scope:mf:bank-total" }],
    truncated: false,
  },
  quality: {
    identity: {
      state: "partial",
      reasonCodes: ["mf_terminal_account_unresolved"],
      evidenceRefs: [],
    },
    freshness: dimension,
    numeric: dimension,
    reconciliation: dimension,
    valuation: { state: "not-applicable", reasonCodes: [], evidenceRefs: [] },
  },
  nextCursor: null,
  explanationRefs: ["explain:1"],
  warnings: [{ code: "possible_duplicate_route", severity: "warning" }],
};

describe("shared result contract", () => {
  test("query specs and results validate as closed shapes with typed data", () => {
    expect(validQuerySpec(query)).toBe(true);
    expect(validQuerySpec({ ...query, intent: "total" })).toBe(false);
    expect(validQuerySpec({ ...query, sql: "select" })).toBe(false);
    expect(validQuerySpec({ ...query, limit: 0 })).toBe(false);
    expect(validFinancialResult(result, validQuantity)).toBe(true);
    expect(validFinancialResult({ ...result, data: 160000 }, validQuantity)).toBe(false);
    expect(validFinancialResult({ ...result, total: 160000 }, validQuantity)).toBe(false);
    expect(validFinancialResult({ ...result, completeness: "ok" }, validQuantity)).toBe(false);
    expect(
      validFinancialResult(
        { ...result, warnings: [{ code: "x", severity: "fatal" }] },
        validQuantity,
      ),
    ).toBe(false);
    expect(
      validFinancialResult(
        { ...result, quality: { ...result.quality, price: dimension } },
        validQuantity,
      ),
    ).toBe(false);
  });

  test("pages carry data coverage and errors use the documented machine codes", () => {
    expect(
      validPage(
        { items: [q("JPY", "1")], nextCursor: "cursor:opaque", dataCoverage: result.coverage },
        validQuantity,
      ),
    ).toBe(true);
    expect(validPage({ items: [q("JPY", "1")], nextCursor: null }, validQuantity)).toBe(false);
    for (const code of [
      "needs_scope_resolution",
      "incomplete_evidence",
      "unsupported_semantics",
      "needs_rule_verification",
      "stale_context",
      "approval_required",
      "idempotency_conflict",
      "budget_exceeded",
      "evidence_restricted",
      "context_expired",
    ])
      expect([...FINANCIAL_ERROR_CODES] as string[]).toContain(code);
    expect(
      validFinancialError({
        schemaVersion: "financial-error-v1",
        code: "stale_context",
        requestId: "req:1",
        message: "The plan was built on revision 7; the target is now at revision 8.",
        refs: ["ctx:2"],
      }),
    ).toBe(true);
    expect(
      validFinancialError({
        schemaVersion: "financial-error-v1",
        code: "stale_context",
        requestId: "req:1",
        message: "x",
        refs: [],
        stack: "",
      }),
    ).toBe(false);
    expect(
      validFinancialError({
        schemaVersion: "financial-error-v1",
        code: "internal_error",
        requestId: "req:1",
        message: "x",
        refs: [],
      }),
    ).toBe(false);
  });
});
