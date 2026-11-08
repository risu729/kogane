import { describe, expect, test } from "bun:test";
import { validFinancialResult } from "../../domain/src/result.ts";
import { contextIdOf, openContext } from "../src/context/open.ts";
import { executeQuery, type QueryData } from "../src/query/execute.ts";
import { encodeCursor } from "../src/query/cursor.ts";
import { parseQueryRequest, querySpecDigest, type QueryRequest } from "../src/query/spec.ts";
import { CONTEXT_INPUTS, grant, HOSTILE_DESCRIPTION, OVERVIEW, reader } from "./fixture.ts";
import type { Overview } from "../../../packages/observation-shared/src/api-contract.ts";
import type { Grant } from "../src/grants.ts";
import type { HoldingsProjection } from "../src/query/execute.ts";
import {
  type BalanceSnapshotRow,
  type ProjectionCoverageRow,
  SNAPSHOT_REFUSALS,
  type SnapshotRefusal,
  type SubtotalRow,
} from "../../read-model/src/index";

const anyData = (value: unknown): value is QueryData => value !== null && typeof value === "object";

function request(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return { intent: "coverage", filters: {}, cursor: null, limit: null, ...overrides };
}

async function run(
  grantValue: Grant,
  body: QueryRequest,
  rows = reader(),
  projection?: HoldingsProjection,
) {
  const opened = await openContext(grantValue, CONTEXT_INPUTS, { query: body });
  return executeQuery({
    grant: grantValue,
    opened,
    request: body,
    reader: rows,
    ...(projection === undefined ? {} : { projection }),
    overview: OVERVIEW,
  });
}

/**
 * A stand-in for A07's sealed projection. Only what `holdings` uses is
 * implemented: the servable snapshot (or its refusal) and the two snapshot
 * queries. A refused snapshot's rows throw if read, so the test proves the
 * refusal is answered before anything is summed.
 */
function projectionStub(options: {
  snapshot?: boolean;
  behind?: boolean;
  refusal?: SnapshotRefusal;
  rows?: SubtotalRow[];
  coverage?: ProjectionCoverageRow[];
  oversized?: boolean;
}): HoldingsProjection {
  const snapshot = {
    snapshot_id: "a".repeat(64),
    created_at: "2026-09-12T00:00:00Z",
    row_count: options.rows?.length ?? 0,
    input_manifest_json: "{}",
    projection_release: "balance-projection-v1",
  } as BalanceSnapshotRow;
  const refused = options.refusal;
  const guard = () => {
    if (refused !== undefined) throw new Error("a refused snapshot must not be read");
  };
  return {
    servable: async () =>
      refused !== undefined
        ? { refusal: refused }
        : options.snapshot === false
          ? null
          : { snapshot, behind: options.behind ?? false },
    reader: {
      coverage: async () => {
        guard();
        return options.coverage ?? [];
      },
      summableQuantities: async () => {
        guard();
        return options.oversized === true ? null : (options.rows ?? []);
      },
    },
  };
}

function adopted(overrides: Partial<SubtotalRow> = {}): SubtotalRow {
  return {
    unit_ref: "JPY",
    subject_scope_key: "source_account:synthetic:a",
    source_id: "fixture-a",
    source_account: "fixture-a:main",
    metric_id: "deposit.balance",
    quantity_coefficient: "60000",
    quantity_scale: 0,
    ...overrides,
  };
}

describe("query spec validation", () => {
  test("an unknown key is unsupported semantics, not a silently dropped filter", () => {
    const outcome = parseQueryRequest({ intent: "coverage", sql: "SELECT 1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unsupported_semantics");
  });

  test("a filter the intent does not accept is refused by name", () => {
    const outcome = parseQueryRequest({ intent: "coverage", filters: { q: "x" } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("unsupported_semantics");
      expect(outcome.refs).toEqual(["filter:q"]);
    }
  });

  test("an intent with no adopted semantics is refused rather than approximated", () => {
    for (const intent of ["net-worth", "performance", "income"]) {
      const outcome = parseQueryRequest({ intent });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("unsupported_semantics");
    }
  });

  test("an activity date range is calendar days in order, as the v1 route reads it", () => {
    const activity = (filters: Record<string, string>) =>
      parseQueryRequest({ intent: "activity", filters });
    expect(activity({ from: "2024-02-29", to: "2024-03-01" })).toMatchObject({ ok: true });
    expect(activity({ from: "2026-01-01", to: "2026-01-01" })).toMatchObject({ ok: true });
    for (const day of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10"]) {
      expect(activity({ from: day })).toEqual({
        ok: false,
        code: "invalid_query",
        refs: ["filter:from"],
      });
      expect(activity({ to: day })).toEqual({
        ok: false,
        code: "invalid_query",
        refs: ["filter:to"],
      });
    }
    expect(activity({ from: "2026-12-31", to: "2026-01-01" })).toEqual({
      ok: false,
      code: "invalid_query",
      refs: ["filter:from", "filter:to"],
    });
  });

  test("a malformed value of a known key is invalid_query naming that key, never dropped", () => {
    const refused = (body: unknown, ref: string) => {
      const outcome = parseQueryRequest(body);
      expect(outcome).toEqual({ ok: false, code: "invalid_query", refs: [ref] });
    };
    expect(parseQueryRequest(null)).toEqual({ ok: false, code: "invalid_query", refs: [] });
    refused({ intent: 7 }, "intent");
    refused({ intent: "activity", filters: [] }, "filters");
    for (const value of ["", "x".repeat(513), "a\u0000b", "a\u007fb", 1])
      refused({ intent: "activity", filters: { source: value } }, "filter:source");
    for (const value of ["2026-9-01", "2026-09-01T00:00:00Z", "yesterday"])
      refused({ intent: "activity", filters: { from: value } }, "filter:from");
    refused({ intent: "activity", filters: { to: "2026/09/30" } }, "filter:to");
    refused({ intent: "reported-state", filters: { view: "net-worth" } }, "filter:view");
    for (const cursor of [1, "c".repeat(2049)]) refused({ intent: "coverage", cursor }, "cursor");
    for (const limit of [0, 1001, 1.5, "10", Number.NaN])
      refused({ intent: "coverage", limit }, "limit");
  });

  test("an accepted request keeps exactly the filters it was given, with defaults made explicit", () => {
    expect(parseQueryRequest({ intent: "coverage" })).toEqual({
      ok: true,
      value: { intent: "coverage", filters: {}, cursor: null, limit: null },
    });
    expect(
      parseQueryRequest({
        intent: "activity",
        filters: { source: "fixture-a", from: "2026-09-01", to: "2026-09-30", q: "x".repeat(512) },
        cursor: "c".repeat(2048),
        limit: 1000,
      }),
    ).toEqual({
      ok: true,
      value: {
        intent: "activity",
        filters: { source: "fixture-a", from: "2026-09-01", to: "2026-09-30", q: "x".repeat(512) },
        cursor: "c".repeat(2048),
        limit: 1000,
      },
    });
    expect(
      parseQueryRequest({ intent: "reported-state", filters: { view: "summaries" }, limit: 1 }),
    ).toMatchObject({ ok: true, value: { filters: { view: "summaries" }, limit: 1 } });
  });

  test("no request can carry a URL, SQL or an ordering", () => {
    for (const body of [
      { intent: "activity", url: "https://provider.invalid" },
      { intent: "activity", orderBy: "id" },
      { intent: "activity", filters: { table: "parse_runs" } },
    ])
      expect(parseQueryRequest(body).ok).toBe(false);
  });
});

describe("contexts are re-derivable digests", () => {
  test("the id is the digest of its own manifest", async () => {
    const opened = await openContext(grant(), CONTEXT_INPUTS);
    expect(opened.context.contextId).toBe(await contextIdOf(opened.context));
    expect(opened.context.contextId).toMatch(/^ctx_[0-9a-f]{64}$/u);
  });

  test("a changed input yields a different context id", async () => {
    const a = await openContext(grant(), CONTEXT_INPUTS);
    const b = await openContext(grant(), {
      ...CONTEXT_INPUTS,
      publicationHighWater: "published-parse-runs@43",
    });
    expect(a.context.contextId).not.toBe(b.context.contextId);
  });

  test("defaults the server chose are reported, not applied silently", async () => {
    const opened = await openContext(grant(), CONTEXT_INPUTS);
    const keys = opened.unresolvedInputs.map((entry) => entry.key).sort();
    expect(keys).toEqual([
      "effectiveTime",
      "identityRead",
      "intent",
      "knowledgeCutoff",
      "valuation",
    ]);
    expect(opened.unresolvedInputs.find((entry) => entry.key === "valuation")?.reasonCode).toBe(
      "no_valuation_policy_adopted",
    );
  });
});

describe("coverage inside the granted scope", () => {
  test("the shared summary is a valid FinancialResult", async () => {
    const outcome = await run(grant(), request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(validFinancialResult(outcome.result, anyData)).toBe(true);
    const data = outcome.result.data as {
      sourceCount: number;
      artifactCount: number;
      collectionRunCount: number;
    };
    expect(data).toMatchObject({ sourceCount: 3, artifactCount: 3, collectionRunCount: 2 });
    expect(outcome.result.coverage.gaps).toEqual([
      { reasonCode: "no_artifacts_collected", scopeRef: "source:fixture-empty" },
    ]);
    expect(outcome.result.completeness).toBe("partial");
  });

  test("a narrower grant recomputes and never mentions a hidden source", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const outcome = await run(narrow, request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { sourceCount: number; artifactCount: number };
    expect(data).toMatchObject({ sourceCount: 1, artifactCount: 2 });
    expect(outcome.result.coverage.gaps).toEqual([]);
    const serialized = JSON.stringify(outcome.result);
    for (const hidden of ["fixture-b", "fixture-empty"]) expect(serialized).not.toContain(hidden);
  });
});

/**
 * The overview's run list is the newest 501 runs across every source. This
 * one is full of `source`'s runs, the shape a busy source outside the scope
 * gives it; coverage must not count inside it.
 */
function windowFullOf(source: string): Overview {
  return {
    ...OVERVIEW,
    fetchRuns: Array.from({ length: 501 }, (_, index) => ({
      id: 10_000 - index,
      source_id: source,
      tool: "fixture",
      external_run_id: null,
      status: "success",
      started_at: "2026-09-08T00:00:00Z",
      completed_at: "2026-09-08T00:01:00Z",
    })),
  };
}

async function coverageWith(
  grantValue: Grant,
  body: QueryRequest,
  overview: Overview,
  runTotals: Record<string, number>,
) {
  const rows = reader({ runTotals });
  const opened = await openContext(grantValue, CONTEXT_INPUTS, { query: body });
  const outcome = await executeQuery({
    grant: grantValue,
    opened,
    request: body,
    reader: rows,
    overview,
  });
  return { outcome, calls: rows.calls };
}

describe("coverage run counts are read inside the scope (out-of-scope activity side channel)", () => {
  test("a denied source's runs never reach or move an in-scope source's coverage answer", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const quiet = await coverageWith(narrow, request(), OVERVIEW, {
      "fixture-a": 1,
      "fixture-b": 1,
    });
    // The denied source then records more runs than the overview's window holds.
    const busy = await coverageWith(narrow, request(), windowFullOf("fixture-b"), {
      "fixture-a": 1,
      "fixture-b": 5_000,
    });
    expect(quiet.outcome.ok && busy.outcome.ok).toBe(true);
    if (!quiet.outcome.ok || !busy.outcome.ok) return;
    expect(JSON.stringify(busy.outcome.result)).toBe(JSON.stringify(quiet.outcome.result));
    expect(busy.outcome.result.data).toMatchObject({
      scopes: [{ sourceRef: "fixture-a", collectionRunCount: 1 }],
      collectionRunCount: 1,
    });
    expect(busy.outcome.result.completeness).toBe("complete");
    // The count read names only the in-scope source.
    expect(busy.calls).toEqual(["runCounts:fixture-a"]);
    expect(JSON.stringify(busy.outcome.result)).not.toContain("fixture-b");
  });

  test("a source filter narrower than the grant counts only the filtered source", async () => {
    for (const wide of [
      grant(),
      grant({ scopes: { sources: ["fixture-a", "fixture-b"], accounts: "*" } }),
    ]) {
      const body = request({ filters: { source: "fixture-a" } });
      const quiet = await coverageWith(wide, body, OVERVIEW, { "fixture-a": 1, "fixture-b": 1 });
      const busy = await coverageWith(wide, body, windowFullOf("fixture-b"), {
        "fixture-a": 1,
        "fixture-b": 5_000,
      });
      expect(quiet.outcome.ok && busy.outcome.ok).toBe(true);
      if (!quiet.outcome.ok || !busy.outcome.ok) return;
      expect(JSON.stringify(busy.outcome.result)).toBe(JSON.stringify(quiet.outcome.result));
      expect(busy.outcome.result.data).toMatchObject({
        scopes: [{ sourceRef: "fixture-a", collectionRunCount: 1 }],
        collectionRunCount: 1,
      });
      expect(busy.calls).toEqual(["runCounts:fixture-a"]);
    }
  });

  test("a count is exact over the source's whole history, not the overview's window", async () => {
    const { outcome } = await coverageWith(grant(), request(), windowFullOf("fixture-b"), {
      "fixture-a": 2,
      "fixture-b": 5_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.data).toMatchObject({
      scopes: [
        { sourceRef: "fixture-a", collectionRunCount: 2 },
        { sourceRef: "fixture-b", collectionRunCount: 5_000 },
        { sourceRef: "fixture-empty", collectionRunCount: 0 },
      ],
      collectionRunCount: 5_002,
    });
  });
});

describe("row intents", () => {
  test("provider text is returned as data and never as an instruction field", async () => {
    const outcome = await run(grant(), request({ intent: "activity" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { rows: { description: string | null }[] };
    expect(data.rows.some((row) => row.description === HOSTILE_DESCRIPTION)).toBe(true);
    const { data: _data, ...withoutData } = outcome.result;
    expect(JSON.stringify(withoutData)).not.toContain("auth token");
  });

  test("records.read is required; summary.read alone cannot read rows", async () => {
    const summaryOnly = grant({ capabilities: ["summary.read"] });
    const outcome = await run(summaryOnly, request({ intent: "activity" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unauthorized");
  });

  test("a narrower grant reads one source at a time and reports the rest as no gap", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const rows = reader();
    const outcome = await run(narrow, request({ intent: "activity" }), rows);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { rows: { sourceRef: string }[] };
    expect(data.rows.every((row) => row.sourceRef === "fixture-a")).toBe(true);
    expect(rows.calls).toEqual(["transactions:fixture-a/*"]);
    expect(JSON.stringify(outcome.result)).not.toContain("fixture-b");
  });

  test("a filter naming a source outside the grant is restricted, not answered", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const outcome = await run(
      narrow,
      request({ intent: "activity", filters: { source: "fixture-b" } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("evidence_restricted");
  });

  test("a source whose rows lie past the rows read is not reported as having none", async () => {
    // 600 newer rows of fixture-a fill the first reader page of the
    // whole-store read; fixture-b's one older row is past it.
    const newer = Array.from({ length: 600 }, (_, index) => ({
      id: 1000 + index,
      source_id: "fixture-a",
      source_account: "account-a",
      as_of: "2026-09-20",
      amount_minor: "100",
      amount_text: "1.00",
      currency: "XTS",
      description: "synthetic line",
      counterparty: null,
      external_id: `ext-${String(1000 + index)}`,
      status: null,
      parser: "fixture-parser@1",
    }));
    const older = { ...newer[0]!, id: 1, source_id: "fixture-b", source_account: "account-b" };
    const rows = reader({ transactions: [...newer, { ...older, as_of: "2026-09-01" }] });
    const outcome = await run(grant(), request({ intent: "activity", limit: 10 }), rows);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.nextCursor).not.toBeNull();
    expect(outcome.result.completeness).toBe("partial");
    expect(outcome.result.coverage.gaps).not.toContainEqual({
      reasonCode: "no_rows_in_scope",
      scopeRef: "source:fixture-b",
    });
  });

  test("a partial page carries a cursor instead of being silently cut", async () => {
    const outcome = await run(grant(), request({ intent: "activity", limit: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.nextCursor).not.toBeNull();
    expect(outcome.result.completeness).toBe("partial");
    expect(outcome.result.warnings).toEqual([{ code: "more_rows_available", severity: "info" }]);
    const next = await run(
      grant(),
      request({ intent: "activity", limit: 2, cursor: outcome.result.nextCursor }),
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect((next.result.data as { rows: unknown[] }).rows).toHaveLength(1);
    expect(next.result.nextCursor).toBeNull();
  });

  test("numeric quality follows the stored decimal state", async () => {
    const outcome = await run(grant(), request({ intent: "reported-state" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.quality.numeric.state).toBe("partial");
    expect(outcome.result.quality.numeric.reasonCodes).toEqual(["amount_text_only"]);
    expect(outcome.result.quality.freshness.state).toBe("partial");
  });
});

describe("holdings without the adopted projection", () => {
  test("is unavailable with a reason, never a total computed from raw rows", async () => {
    const outcome = await run(grant(), request({ intent: "holdings" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.completeness).toBe("unavailable");
    expect(outcome.result.coverage.gaps).toEqual([
      { reasonCode: "projection_not_built", scopeRef: outcome.result.resolvedQuery.perimeterRef },
    ]);
    expect(outcome.result.warnings).toEqual([
      { code: "projection_not_built", severity: "blocking" },
    ]);
  });

  test("a projection with no sealed snapshot yet is the same answer", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({ snapshot: false }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.completeness).toBe("unavailable");
  });
});

describe("holdings over a refused snapshot", () => {
  // 05 §7: a snapshot built under another CORE epoch, before a use
  // restriction changed, or in a READ database of another contract is refused
  // whole. Filtering rows out of it would leave every figure at its old value.
  for (const refusal of SNAPSHOT_REFUSALS) {
    test(`${refusal} is unavailable with that code, never a figure`, async () => {
      const outcome = await run(
        grant(),
        request({ intent: "holdings" }),
        reader(),
        projectionStub({ refusal, rows: [adopted()] }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(validFinancialResult(outcome.result, anyData)).toBe(true);
      expect(outcome.result.completeness).toBe("unavailable");
      if (outcome.result.data.intent !== "holdings") throw new Error("unreachable");
      expect(outcome.result.data.units).toEqual([]);
      expect(outcome.result.coverage.gaps).toEqual([
        { reasonCode: refusal, scopeRef: outcome.result.resolvedQuery.perimeterRef },
      ]);
      expect(outcome.result.quality.numeric).toEqual({
        state: "not-applicable",
        reasonCodes: [refusal],
        evidenceRefs: [],
      });
      expect(outcome.result.warnings).toEqual([{ code: refusal, severity: "blocking" }]);
    });
  }
});

describe("holdings from the adopted projection", () => {
  for (const behind of [false, true]) {
    for (const stale of [false, true]) {
      test(`snapshot behind=${behind}, scope stale=${stale} reports every freshness reason`, async () => {
        const outcome = await run(
          grant(),
          request({ intent: "holdings" }),
          reader(),
          projectionStub({
            behind,
            rows: [adopted()],
            coverage: stale
              ? [
                  {
                    state: "stale",
                    reason_code: "no_new_observation",
                    freshness: "stale",
                    count: 1,
                  },
                ]
              : [],
          }),
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(validFinancialResult(outcome.result, anyData)).toBe(true);
        expect(outcome.result.completeness).toBe(behind || stale ? "partial" : "complete");
        expect(outcome.result.quality.freshness.state).toBe(
          behind || stale ? "partial" : "verified",
        );
        const expected = [
          ...(behind ? ["snapshot:behind_published_evidence"] : []),
          ...(stale ? ["scope_not_re_observed"] : []),
          ...(!behind && !stale ? ["snapshot_current"] : []),
        ];
        expect(outcome.result.quality.freshness.reasonCodes).toEqual(expected);
        expect(
          outcome.result.coverage.gaps.some(
            (gap) => gap.reasonCode === "snapshot:behind_published_evidence",
          ),
        ).toBe(behind);
        if (outcome.result.data.intent !== "holdings") throw new Error("unreachable");
        expect(outcome.result.data.units).toEqual([
          { unitRef: "JPY", coefficient: "60000", scale: 0, adoptedCount: 1 },
        ]);
        expect(outcome.result.quality.numeric.state).toBe("verified");
      });
    }
  }

  test("sums the adopted set per unit, exactly, and never across units", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({
        rows: [
          adopted(),
          adopted({
            subject_scope_key: "source_account:synthetic:b",
            quantity_coefficient: "1005",
            quantity_scale: 1,
          }),
          adopted({
            subject_scope_key: "source_account:synthetic:c",
            unit_ref: "USD",
            quantity_coefficient: "25",
          }),
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.result.data.intent !== "holdings") throw new Error("unreachable");
    // 60,000 + 100.5 in JPY, 25 in USD: two units, never one number.
    expect(outcome.result.data.units).toEqual([
      { unitRef: "JPY", coefficient: "601005", scale: 1, adoptedCount: 2 },
      { unitRef: "USD", coefficient: "25", scale: 0, adoptedCount: 1 },
    ]);
    // No net worth, and the liability coverage says it is unknown.
    expect(outcome.result.data.liabilitiesCoverage).toBe("unknown");
    expect(JSON.stringify(outcome.result)).not.toContain("netWorth");
    expect(outcome.result.completeness).toBe("complete");
    expect(outcome.result.quality.numeric.state).toBe("verified");
    expect(outcome.result.quality.valuation.state).toBe("not-applicable");
    expect(outcome.result.nextCursor).toBeNull();
  });

  test("an unresolved or stale measure makes the answer partial and says which", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({
        rows: [adopted()],
        coverage: [
          { state: "unresolved", reason_code: "overlap_unknown", freshness: "current", count: 1 },
          { state: "stale", reason_code: "no_new_observation", freshness: "stale", count: 1 },
          { state: "adopted", reason_code: null, freshness: "current", count: 1 },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.completeness).toBe("partial");
    expect(outcome.result.coverage.gaps.map((gap) => gap.reasonCode)).toEqual([
      "stale:no_new_observation",
      "unresolved:overlap_unknown",
    ]);
    expect(outcome.result.quality.freshness.state).toBe("partial");
    expect(outcome.result.warnings).toEqual([{ code: "measures_unresolved", severity: "warning" }]);
  });

  test("one subject reached twice is refused rather than counted twice", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({ rows: [adopted(), adopted()] }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("incomplete_evidence");
  });

  test("one subject holding several units counts once in each unit", async () => {
    // An exchange account's cash per asset, or a broker's foreign cash per
    // currency: one subject scope, one adopted measurement per unit.
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({
        rows: [
          adopted({ metric_id: "exchange.cash-balance" }),
          adopted({
            metric_id: "exchange.cash-balance",
            unit_ref: "BTC",
            quantity_coefficient: "5",
            quantity_scale: 1,
          }),
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.result.data.intent !== "holdings") throw new Error("unreachable");
    expect(outcome.result.data.units).toEqual([
      { unitRef: "BTC", coefficient: "5", scale: 1, adoptedCount: 1 },
      { unitRef: "JPY", coefficient: "60000", scale: 0, adoptedCount: 1 },
    ]);
  });

  test("one subject twice in the same unit is refused even under two metrics", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({
        rows: [adopted(), adopted({ metric_id: "broker.foreign-cash-deposit" })],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("incomplete_evidence");
  });

  test("a scope larger than the subtotal bound is refused, never partially summed", async () => {
    const outcome = await run(
      grant(),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({ oversized: true }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("budget_exceeded");
  });

  test("a row outside the grant is not summed, and its existence is not reported", async () => {
    const outcome = await run(
      grant({ scopes: { sources: ["fixture-a"], accounts: "*" } }),
      request({ intent: "holdings" }),
      reader(),
      projectionStub({
        rows: [
          adopted(),
          adopted({
            subject_scope_key: "source_account:synthetic:hidden",
            source_id: "fixture-b",
            quantity_coefficient: "999999",
          }),
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.result.data.intent !== "holdings") throw new Error("unreachable");
    expect(outcome.result.data.units).toEqual([
      { unitRef: "JPY", coefficient: "60000", scale: 0, adoptedCount: 1 },
    ]);
    expect(JSON.stringify(outcome.result)).not.toContain("999999");
    expect(JSON.stringify(outcome.result)).not.toContain("fixture-b");
  });
});

describe("cursors and budgets", () => {
  test("a cursor from another context is stale, never answered from the newest rows", async () => {
    const body = request({ intent: "activity", limit: 1 });
    const opened = await openContext(grant(), CONTEXT_INPUTS, { query: body });
    const other = await openContext(grant(), {
      ...CONTEXT_INPUTS,
      publicationHighWater: "published-parse-runs@99",
    });
    const foreign = encodeCursor({
      basisRef: other.pagingBasisRef,
      queryDigest: await querySpecDigest(opened.resolvedQuery),
      offset: 1,
    });
    const outcome = await run(grant(), { ...body, cursor: foreign });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });

  test("a cursor pages on a later request over the same pinned inputs", async () => {
    // Every request opens its context at its own clock (the adapters pass the
    // request's second), so the next page is always asked for at a later one.
    const body = request({ intent: "activity", limit: 2 });
    const first = await run(grant(), body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.nextCursor).not.toBeNull();
    const later = { ...CONTEXT_INPUTS, now: "2026-09-09T00:00:01Z" };
    const next = { ...body, cursor: first.result.nextCursor };
    const outcome = await executeQuery({
      grant: grant(),
      opened: await openContext(grant(), later, { query: next }),
      request: next,
      reader: reader(),
      overview: OVERVIEW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rows = (outcome.result.data as { rows: { observationRef: string }[] }).rows;
    expect(rows.map((row) => row.observationRef)).toEqual(["observation:transaction:1"]);
    expect(outcome.result.nextCursor).toBeNull();
    // A pinned input that moved is still another context.
    const moved = { ...later, publicationHighWater: "published-parse-runs@43" };
    const stale = await executeQuery({
      grant: grant(),
      opened: await openContext(grant(), moved, { query: next }),
      request: next,
      reader: reader(),
      overview: OVERVIEW,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_context" } });
  });

  test("a cursor from another query on the same context is stale too", async () => {
    const body = request({ intent: "activity", limit: 1 });
    const first = await run(grant(), body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const outcome = await run(
      grant(),
      request({ intent: "reported-state", limit: 1, cursor: first.result.nextCursor }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });

  test("a page past the budget is refused, not truncated", async () => {
    const tight = grant({ budget: { maxRows: 2, maxProposalTargets: 2, maxExplainDepth: 2 } });
    const outcome = await run(tight, request({ intent: "activity", limit: 2 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("budget_exceeded");
      expect(outcome.error.message).not.toContain("SELECT");
    }
  });

  test("an invented cursor value is refused", async () => {
    const outcome = await run(grant(), request({ intent: "activity", cursor: "not-a-cursor" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });
});
